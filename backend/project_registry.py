"""项目注册表：谁在册、哪一个正在看、每个项目留下的现场。

为什么要这份文件：projects.py 原先只拿一个模块级变量当"当前项目"，于是
"打开项目"＝覆盖上一个、"关闭项目"＝抹掉、重启＝全丢（注释自己写着"内存态，重启丢失"）。
多项目管理要的不是"更多个当前项目"，而是把三件事分开：

  · 在册（这份文件）——开过的项目都留着，随时一键回来；
  · 视野（active）——任何时刻只有一个"正在看的那一个"，文件/Git/终端仍沿用单根语义；
  · 现场（每个项目的 prefs）——上次停在哪儿、草稿、看板、默认模型。

身份用宿主目录绝对路径派生（不是随机 UUID）：重开同一个文件夹必须落回同一个 id，
"查表失败另起一个身份"会让历史会话散成两堆。代价是目录一搬 id 就变——所以条带
aliases，用户手工"把这批未归类会话归到某项目"时把旧 id 记进去，查询按 id∪aliases 展开。

配置本体仍在仓库里的 `<项目>/.slate/config.json`（宪法要跟着代码走）；这里只放索引，
SLATE 私有的每项目数据（worktree 等）放 data/projects/<id>/，绝不写进用户仓库。
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

from backend.data_io import atomic_write_json, backup_corrupt

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
REGISTRY_PATH = DATA_DIR / "projects.json"
PROJECT_DATA_DIR = DATA_DIR / "projects"

REGISTRY_VERSION = 1
MAX_DRAFT_CHARS = 2000          # 草稿只是"回来接着打字"，不是无限暂存区
MAX_PROJECTS = 200              # 在册上限：到顶先淘汰最久未开的归档项，绝不动固定项


def normalize_path(raw: Any) -> str:
    """规整成可比较的绝对路径；解析不了就原样返回去空白串（不抛异常）。

    Windows 上大小写不敏感，所以比较与派生 id 都按 lower 走；显示仍用原样路径。
    """
    text = str(raw or "").strip()
    if not text:
        return ""
    try:
        text = str(Path(text).expanduser().resolve())
    except OSError:
        pass
    return text.rstrip("\\/") or text


def project_id_for(path: Any) -> str:
    """由宿主目录派生的稳定 id。"""
    real = normalize_path(path).replace("\\", "/").lower()
    if not real:
        return ""
    return "p_" + hashlib.sha1(real.encode("utf-8")).hexdigest()[:10]


def data_dir_for(project_id: str) -> Path:
    """SLATE 私有的每项目目录（worktree、隔离现场等放这里）。"""
    return PROJECT_DATA_DIR / (project_id or "_none")


def project_id_for_path(doc: dict[str, Any], path: Any) -> str:
    """反查"这个目录属于哪个在册项目"：按路径前缀取最长匹配。

    为什么按前缀而不是全等：后台任务的 work_dir 是项目里的某个子目录，
    定时任务的 watch_paths 也常在子目录里；归属看的是"在谁的地盘上"。
    最长匹配而不是第一个匹配：工作区宿主目录和它的成员目录可能同时在册，
    短的那个会把深的路径抢走。
    """
    text = normalize_path(path).replace("\\", "/").lower()
    if not text:
        return ""
    best_id, best_len = "", -1
    for e in doc.get("projects") or []:
        for cand in [e.get("path"), *(e.get("aliases") or [])]:
            norm = normalize_path(cand).replace("\\", "/").lower()
            if not norm:
                continue
            if text == norm or text.startswith(norm + "/"):
                if len(norm) > best_len:
                    best_id, best_len = str(e.get("id") or ""), len(norm)
                break
    return best_id


def _blank() -> dict[str, Any]:
    return {"version": REGISTRY_VERSION, "active": "", "projects": []}


def load_registry() -> dict[str, Any]:
    """读注册表。文件不存在/读坏/结构不对都回落到空表——绝不因为索引坏了就打不开项目。"""
    if not REGISTRY_PATH.exists():
        return _blank()
    try:
        raw = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _blank()
    if not isinstance(raw, dict) or not isinstance(raw.get("projects"), list):
        return _blank()
    projects = [e for e in raw["projects"] if isinstance(e, dict) and e.get("id") and e.get("path")]
    active = str(raw.get("active") or "")
    if active and not any(e["id"] == active for e in projects):
        # active 指向一个已经不存在的条目：按"最近打开的那一个"回落，而不是清空视野
        newest = sorted(projects, key=lambda e: float(e.get("last_opened_at") or 0))
        active = str(newest[-1]["id"]) if newest else ""
    return {"version": REGISTRY_VERSION, "active": active, "projects": projects}


def save_registry(doc: dict[str, Any]) -> dict[str, Any]:
    """原子落盘。写坏前先把原件挪成 .corrupt，别让半截 JSON 覆盖掉全部在册记录。"""
    clean = _blank()
    if isinstance(doc, dict):
        clean["active"] = str(doc.get("active") or "")
        clean["projects"] = [e for e in (doc.get("projects") or []) if isinstance(e, dict) and e.get("id")]
    try:
        if REGISTRY_PATH.exists():
            try:
                json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                backup_corrupt(REGISTRY_PATH)
    except OSError:
        pass
    atomic_write_json(REGISTRY_PATH, clean)
    return clean


def entry_of(doc: dict[str, Any], project_id: str) -> dict[str, Any] | None:
    for e in doc.get("projects") or []:
        if e.get("id") == project_id:
            return e
    return None


def find_entry(doc: dict[str, Any], key: Any) -> dict[str, Any] | None:
    """按 id / 路径 / 别名 / 唯一的项目名找回一条记录。

    名字只用于显示，不做身份：只有"这个名字在册里唯一"时才允许按名字命中，
    重名时必须回落到 id 或路径——否则两个同名项目会被归成一个，历史串成一堆。
    """
    text = str(key or "").strip()
    if not text:
        return None
    projects = doc.get("projects") or []
    for e in projects:
        if e.get("id") == text:
            return e
    norm = normalize_path(text).replace("\\", "/").lower()
    for e in projects:
        if normalize_path(e.get("path")).replace("\\", "/").lower() == norm:
            return e
    for e in projects:
        if text in (e.get("aliases") or []):
            return e
    named = [e for e in projects if str(e.get("name") or "") == text]
    return named[0] if len(named) == 1 else None


def ids_of(entry: dict[str, Any] | None) -> list[str]:
    """一条记录的全部身份（自身 id + 别名），给按项目过滤会话用。"""
    if not entry:
        return []
    out = [str(entry["id"])]
    for alias in entry.get("aliases") or []:
        if alias and alias not in out:
            out.append(str(alias))
    return out


def register(doc: dict[str, Any], path: Any, *, kind: str = "", name: str = "") -> tuple[dict[str, Any], bool]:
    """登记（或touch）一条记录，返回 (entry, 是否新建)。"""
    real = normalize_path(path)
    if not real:
        return {}, False
    pid = project_id_for(real)
    existing = entry_of(doc, pid)
    now = time.time()
    if existing:
        existing["last_opened_at"] = now
        if kind:
            existing["kind"] = kind
        if name:
            existing["name"] = name
        return existing, False
    entry = {
        "id": pid,
        "path": real,
        "name": name or Path(real).name,
        "kind": kind or "folder",
        "added_at": now,
        "last_opened_at": now,
        "pinned": False,
        "archived": False,
        "aliases": [],
        "prefs": {},
    }
    doc["projects"].append(entry)
    _prune(doc)
    return entry, True


def _prune(doc: dict[str, Any]) -> None:
    """在册条目封顶：先删最久没开过的归档项，再删最久没开的普通项，固定项永不淘汰。

    封顶是为了让 GET /projects/registry 的响应和侧栏都能保持在一屏之内；
    淘汰只摘索引，不碰 `.slate/config.json`，也不碰 data/projects/<id>/。
    """
    projects = doc.get("projects") or []
    if len(projects) <= MAX_PROJECTS:
        return
    def rank(e: dict[str, Any]) -> tuple:
        return (bool(e.get("pinned")), not bool(e.get("archived")), float(e.get("last_opened_at") or 0))
    keep = sorted(projects, key=rank, reverse=True)[:MAX_PROJECTS]
    doc["projects"] = keep


def set_active(doc: dict[str, Any], project_id: str) -> dict[str, Any] | None:
    entry = entry_of(doc, project_id) if project_id else None
    doc["active"] = str(project_id or "")
    if entry:
        entry["last_opened_at"] = time.time()
    return entry


def patch_prefs(entry: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """只认白名单字段；草稿按长度截断（prefs 会进共享状态，别把 2MB 文本同步出去）。"""
    prefs = dict(entry.get("prefs") or {})
    for key in ("last_conversation_id", "board_id", "model_id", "constitution_scope", "scroll"):
        if key in patch:
            prefs[key] = str(patch[key])[:200] if key != "scroll" else _clamp_float(patch[key])
    if "draft" in patch:
        prefs["draft"] = str(patch.get("draft") or "")[:MAX_DRAFT_CHARS]
    if "muted" in patch:
        prefs["muted"] = bool(patch.get("muted"))
    entry["prefs"] = prefs
    return prefs


def _clamp_float(value: Any) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


def public_entry(doc: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
    """给前端的一条记录（active 标记单独带，省得前端再比一次）。"""
    return {
        "id": entry.get("id"),
        "path": entry.get("path"),
        "name": entry.get("name"),
        "kind": entry.get("kind") or "folder",
        "added_at": entry.get("added_at") or 0,
        "last_opened_at": entry.get("last_opened_at") or 0,
        "pinned": bool(entry.get("pinned")),
        "archived": bool(entry.get("archived")),
        "aliases": list(entry.get("aliases") or []),
        "prefs": dict(entry.get("prefs") or {}),
        "active": doc.get("active") == entry.get("id"),
    }


def registry_view(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """按"固定 → 最近打开 → 其余"排好序给侧栏用，前端不再各排各的。"""
    entries = list(doc.get("projects") or [])
    entries.sort(key=lambda e: (not bool(e.get("pinned")), -float(e.get("last_opened_at") or 0)))
    return [public_entry(doc, e) for e in entries]
