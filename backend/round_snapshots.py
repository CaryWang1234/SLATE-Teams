"""本轮文件快照：「本轮总结 · 可撤回」的唯一事实源。

口径只有三条，其余实现都是它们的推论：

1. 一次任务（一个账本 run）对同一个项目文件的多次写入，只留**第一次写入前**的
   原文。于是「撤回」= 把这一轮开始前的样子放回去，而不是退回某个中间态——
   中间态放回去只会得到一个哪一步都不是的结果。
2. 快照只发生在三个真落盘的端点里（apply-edit / create-file / append-file）。
   终端、构建脚本这类绕过端点的改动这里看不见，所以卡片宁可少报也不虚报：
   报出来的每一项都保证能还原，报不出的明说不在撤回范围内。
3. 撤回前逐条比对「当前内容 == 本轮写入后的内容」。不相等说明用户在本轮之后
   又动过这个文件，这一项就跳过并回报原因——撤回绝不能把别人的修改吃掉。

记账分两步是有原因的：begin 只把原文落成 blob，finish 才写进清单。写入失败时
清单上一个字都不会多，否则卡片会报一件其实没发生的事。原文按内容哈希命名，
于是同一轮里反复写同一份内容也只占一份磁盘。

清单（manifest）按 run 分目录存在 data/round_snapshots/ 下，卡片就是它的投影；
运行期与刷新后读到的都是同一份，不存在「前端记一份、后端记一份」的口径分裂。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
from difflib import unified_diff
from pathlib import Path
from typing import Any

from backend.data_io import atomic_write_json

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
SNAPSHOT_DIR = DATA_DIR / "round_snapshots"

# run_id 直接当目录名用，所以先收口成白名单字符集：客户端传什么都不可能在
# 路径上做出 `..` 或绝对路径。账本侧的 id 形如 run_xxxx，天然落在这个集合里。
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")

MAX_FILE_BYTES = 2 * 1024 * 1024      # 超过就不快照：撤回要靠这份原文，大文件先保磁盘
MAX_FILES_PER_RUN = 200               # 一轮改几百个文件时，快照目录本身不该变成新麻烦
KEEP_RUNS = 30                        # 三条清理线取先满足者：天数 / 条数 / 总占用
KEEP_DAYS = 7
MAX_TOTAL_BYTES = 200 * 1024 * 1024
DIFF_MAX_LINES = 400                  # 审阅面板的硬顶，超出只给前若干行并标 truncated

_LOCK = threading.Lock()
_PRUNE_INTERVAL = 60.0        # 秒；清理快照目录的节流窗口
_last_prune = 0.0


def _safe_run_dir(run_id: Any) -> Path | None:
    text = str(run_id or "").strip()
    if not _RUN_ID_RE.match(text) or text in (".", ".."):
        return None
    return SNAPSHOT_DIR / text


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _manifest_path(run_dir: Path) -> Path:
    return run_dir / "manifest.json"


def _load_manifest(run_dir: Path) -> dict[str, Any] | None:
    path = _manifest_path(run_dir)
    if not path.is_file():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return doc if isinstance(doc, dict) else None


def _project_ok(doc: dict[str, Any], project_dir: Path) -> bool:
    """清单是绑定项目的，读端点和撤回也要再认一次：拿着别的项目的目录来问同一轮，
    清单里的相对路径会指向那个项目里不存在（或完全不同）的文件——报出来的每一项
    都保证能还原，这条口径在读取侧同样成立，所以直接当「没有这一轮」而不是合并。"""
    stored = doc.get("project")
    if not stored:
        return False
    try:
        return Path(stored).resolve() == project_dir.resolve()
    except OSError:
        return False


def _rel_key(project_dir: Path, target: Path) -> str | None:
    """把待写文件折算成「项目内相对路径」。围栏在这里再判一次：端点已经判过，
    但清单里的键一旦越界，撤回就会往项目外写文件，不能只信调用方。"""
    try:
        return target.resolve().relative_to(project_dir.resolve()).as_posix()
    except ValueError:
        return None


def _dir_bytes(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                pass
    return total


def _prune() -> None:
    """按「7 天内 / 最近 30 个 run / 总量 200MB」三条线取先满足者清理。
    快照是磁盘上的第二份代码，无界增长本身就是事故，宁可少留几轮可撤回。

    但每次写入都全量走一遍快照目录，会让「改十个文件」变成十次磁盘扫描（Windows
    上 stat 并不便宜），所以按 _PRUNE_INTERVAL 节流：清理上限宽松一分钟无关紧要。
    """
    global _last_prune
    now = time.time()
    if now - _last_prune < _PRUNE_INTERVAL:
        return
    _last_prune = now
    if not SNAPSHOT_DIR.is_dir():
        return
    entries: list[tuple[float, Path]] = []
    for child in SNAPSHOT_DIR.iterdir():
        if not child.is_dir():
            continue
        try:
            entries.append((child.stat().st_mtime, child))
        except OSError:
            continue
    entries.sort(key=lambda item: item[0])                      # 旧 → 新
    cutoff = time.time() - KEEP_DAYS * 86400
    alive = [child for mtime, child in entries if mtime >= cutoff]
    if len(alive) > KEEP_RUNS:
        alive = alive[-KEEP_RUNS:]
    kept = set(alive)
    for _mtime, child in entries:
        if child not in kept:
            shutil.rmtree(child, ignore_errors=True)
    total = sum(_dir_bytes(child) for child in alive)
    while alive and total > MAX_TOTAL_BYTES:
        oldest = alive.pop(0)
        total -= _dir_bytes(oldest)
        shutil.rmtree(oldest, ignore_errors=True)


def _store_pre(rid: Path, raw: bytes) -> str:
    blob_dir = rid / "pre"
    blob_dir.mkdir(parents=True, exist_ok=True)
    name = _sha(raw)[:16] + ".bin"
    blob = blob_dir / name
    if not blob.is_file():                      # 同一份原文只存一次
        blob.write_bytes(raw)
    return name


def _read_pre(rid: Path, entry_or_name: Any) -> bytes | None:
    name = entry_or_name.get("pre_file") if isinstance(entry_or_name, dict) else entry_or_name
    if not name:
        return None
    try:
        return (rid / "pre" / str(name)).read_bytes()
    except OSError:
        return None


def _count_diff(pre_raw: bytes | None, post_raw: bytes) -> tuple[int, int]:
    """行数按「本轮第一次写入前的原文」与当前内容比，多轮写入不重复累计。"""
    pre_text = (pre_raw or b"").decode("utf-8", errors="replace").splitlines()
    post_text = post_raw.decode("utf-8", errors="replace").splitlines()
    added = removed = 0
    for line in unified_diff(pre_text, post_text, lineterm="", n=0):
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return added, removed


def begin_write(project_dir: Path, run_id: Any, target: Path, *, mode: str, tool: str = "") -> dict[str, Any]:
    """写入前调用：取（并首次落盘）这一轮的原始内容。

    返回 handle。handle["ok"] 为假时调用方照常写入——快照失败绝不阻断写入
    （与 Actions 的备份取舍一致），差别只是这一项进不了可撤回清单。"""
    rid = _safe_run_dir(run_id)
    if rid is None:
        return {"ok": False, "reason": "no-run"}
    rel = _rel_key(project_dir, target)
    if rel is None:
        return {"ok": False, "reason": "out-of-scope"}
    with _LOCK:
        _prune()
        doc = _load_manifest(rid)
        if doc and not _project_ok(doc, project_dir):
            # 同一个 run 只属于一个项目：对不上说明拿来了别场的 run_id，混记会让
            # 撤回跨项目写文件，所以整项拒掉而不是合并清单。
            return {"ok": False, "reason": "project-mismatch"}
        files = (doc or {}).get("files") or {}
        entry = files.get(rel)
        if entry:
            if not entry.get("revertible", False):
                return {"ok": False, "reason": str(entry.get("reason") or "not-revertible")}
            return {"ok": True, "rid": rid, "rel": rel, "project": project_dir,
                    "pre_file": entry.get("pre_file"), "pre_sha": entry.get("pre_sha256"),
                    "created": bool(entry.get("created")), "mode": str(entry.get("mode") or mode),
                    "tool": tool}
        if len(files) >= MAX_FILES_PER_RUN:
            return {"ok": False, "reason": "too-many"}
        created = not target.is_file()
        pre_file: str | None = None
        pre_sha: str | None = None
        revertible = True
        reason = ""
        if not created:
            try:
                if target.stat().st_size > MAX_FILE_BYTES:
                    revertible = False
                    reason = "too-large"
                else:
                    raw = target.read_bytes()
                    pre_sha = _sha(raw)
                    pre_file = _store_pre(rid, raw)
            except OSError:
                revertible = False
                reason = "unreadable"
        if not revertible:
            return {"ok": False, "reason": reason}
        return {"ok": True, "rid": rid, "rel": rel, "project": project_dir,
                "pre_file": pre_file, "pre_sha": pre_sha, "created": created,
                "mode": mode, "tool": tool}


def finish_write(handle: dict[str, Any]) -> None:
    """写入成功后调用：这一刻才在清单上记账。"""
    if not handle.get("ok"):
        return
    rid: Path = handle["rid"]
    rel: str = handle["rel"]
    with _LOCK:
        doc = _load_manifest(rid) or {
            "run_id": rid.name,
            "project": str(handle["project"]),
            "started_at": int(time.time()),
            "reverted_at": None,
            "files": {},
        }
        files = doc.setdefault("files", {})
        entry = files.get(rel)
        if entry is None:
            entry = {
                "seq": len(files) + 1,
                "rel": rel,
                "mode": handle.get("mode") or "",
                "tool": handle.get("tool") or "",
                "calls": 0,
                "created": bool(handle.get("created")),
                "pre_file": handle.get("pre_file"),
                "pre_sha256": handle.get("pre_sha"),
                "post_sha256": None,
                "lines_added": 0,
                "lines_removed": 0,
                "revertible": True,
                "reason": "",
                "reverted": None,
            }
            files[rel] = entry
        entry["calls"] = int(entry.get("calls") or 0) + 1
        entry["reverted"] = None            # 撤回之后又写了文件 = 这一轮重新可撤回
        target = Path(handle["project"]) / rel
        try:
            post_raw = target.read_bytes() if target.is_file() else None
        except OSError:
            post_raw = None
        if post_raw is None:
            entry["post_sha256"] = None
            entry["revertible"] = False
            entry["reason"] = "gone"
        else:
            entry["post_sha256"] = _sha(post_raw)
            added, removed = _count_diff(_read_pre(rid, entry), post_raw)
            entry["lines_added"] = added
            entry["lines_removed"] = removed
        atomic_write_json(_manifest_path(rid), doc)


def _entry_state(project_dir: Path, entry: dict[str, Any]) -> dict[str, Any]:
    """清单条目 + 现场判定：文件还在不在、是不是又被别人改过。"""
    target = project_dir / str(entry.get("rel"))
    out = dict(entry)
    exists = target.is_file()
    out["exists"] = exists
    drifted = False
    if exists and entry.get("post_sha256"):
        try:
            drifted = _sha(target.read_bytes()) != entry["post_sha256"]
        except OSError:
            drifted = True
    out["drifted"] = drifted
    return out


def round_files(project_dir: Path, run_id: Any) -> dict[str, Any]:
    """本轮改了哪些文件：卡片的数据源，也是撤回前的体检。"""
    rid = _safe_run_dir(run_id)
    empty = {"run_id": "", "files": [], "totals": {"files": 0, "added": 0, "removed": 0}, "reverted_at": None}
    if rid is None:
        return empty
    doc = _load_manifest(rid)
    if not doc or not _project_ok(doc, project_dir):
        return empty
    items = [
        _entry_state(project_dir, entry)
        for entry in sorted(doc.get("files", {}).values(), key=lambda e: int(e.get("seq") or 0))
    ]
    return {
        "run_id": rid.name,
        "files": items,
        "totals": {
            "files": len(items),
            "added": sum(int(item.get("lines_added") or 0) for item in items),
            "removed": sum(int(item.get("lines_removed") or 0) for item in items),
        },
        "reverted_at": doc.get("reverted_at"),
    }


def round_diff(project_dir: Path, run_id: Any, rel: str) -> dict[str, Any]:
    """审阅用的单文件差异：本轮首次原文 ↔ 当前内容。"""
    rid = _safe_run_dir(run_id)
    miss = {"diff": "", "truncated": False, "reason": "not-found"}
    if rid is None:
        return miss
    doc = _load_manifest(rid)
    if not doc:
        return miss
    if not _project_ok(doc, project_dir):
        return {"diff": "", "truncated": False, "reason": "project-mismatch"}
    key = str(rel or "").replace("\\", "/")
    entry = doc.get("files", {}).get(key)
    if not entry:
        return miss
    if not entry.get("pre_file") and not entry.get("created"):
        return {"diff": "", "truncated": False, "reason": "pre-missing"}
    pre_raw = _read_pre(rid, entry)
    if pre_raw is None and not entry.get("created"):
        return {"diff": "", "truncated": False, "reason": "pre-missing"}
    target = project_dir / key
    try:
        post_raw = target.read_bytes() if target.is_file() else b""
    except OSError:
        post_raw = b""
    lines = list(unified_diff(
        (pre_raw or b"").decode("utf-8", errors="replace").splitlines(),
        post_raw.decode("utf-8", errors="replace").splitlines(),
        fromfile=f"a/{key}",
        tofile=f"b/{key}",
        lineterm="",
    ))
    return {
        "diff": "\n".join(lines[:DIFF_MAX_LINES]),
        "truncated": len(lines) > DIFF_MAX_LINES,
        "reason": "",
    }


def revert(project_dir: Path, run_id: Any) -> dict[str, Any]:
    """整轮撤回：逐条比对现场后还原，对不上的一律跳过并回报原因。"""
    rid = _safe_run_dir(run_id)
    if rid is None:
        return {"ok": False, "reason": "no-run", "restored": [], "deleted": [], "skipped": []}
    with _LOCK:
        doc = _load_manifest(rid)
        if not doc:
            return {"ok": False, "reason": "not-found", "restored": [], "deleted": [], "skipped": []}
        if not _project_ok(doc, project_dir):
            return {"ok": False, "reason": "project-mismatch", "restored": [], "deleted": [], "skipped": []}
        backup_dir = rid / "revert"
        restored: list[str] = []
        deleted: list[str] = []
        skipped: list[dict[str, str]] = []
        entries = sorted(doc.get("files", {}).values(), key=lambda e: -int(e.get("seq") or 0))
        for entry in entries:
            rel = str(entry.get("rel"))
            target = project_dir / rel
            if entry.get("reverted") in ("restored", "deleted"):
                continue                      # 已经撤过的不重复处理
            if not entry.get("revertible", False):
                entry["reverted"] = "skipped"
                skipped.append({"rel": rel, "reason": str(entry.get("reason") or "not-revertible")})
                continue
            state = _entry_state(project_dir, entry)
            if state["drifted"]:
                entry["reverted"] = "skipped"
                skipped.append({"rel": rel, "reason": "drifted"})
                continue
            if not state["exists"]:
                if entry.get("created"):
                    entry["reverted"] = "deleted"      # 本轮建的文件已经不在了，目标状态达成
                    continue
                entry["reverted"] = "skipped"
                skipped.append({"rel": rel, "reason": "missing"})
                continue
            # 还原前先留一份「撤回时的现场」：撤回本身也是写入，出错时人工还得捞得回来。
            try:
                backup_dir.mkdir(parents=True, exist_ok=True)
                (backup_dir / f"{int(entry.get('seq') or 0):04d}.cur").write_bytes(target.read_bytes())
            except OSError:
                pass
            if entry.get("created"):
                try:
                    target.unlink()
                    entry["reverted"] = "deleted"
                    deleted.append(rel)
                except OSError:
                    entry["reverted"] = "skipped"
                    skipped.append({"rel": rel, "reason": "delete-failed"})
                continue
            pre_raw = _read_pre(rid, entry)
            if pre_raw is None:
                entry["reverted"] = "skipped"
                skipped.append({"rel": rel, "reason": "pre-missing"})
                continue
            try:
                target.write_bytes(pre_raw)
                entry["reverted"] = "restored"
                restored.append(rel)
            except OSError:
                entry["reverted"] = "skipped"
                skipped.append({"rel": rel, "reason": "write-failed"})
        doc["reverted_at"] = int(time.time())
        atomic_write_json(_manifest_path(rid), doc)
    return {"ok": True, "reason": "", "restored": restored, "deleted": deleted, "skipped": skipped}
