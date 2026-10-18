# -*- coding: utf-8 -*-
"""自进化（工具工厂）产物的存放与装载：data/evolved/<name>.py + 同名清单。

以前 mcp_factory 把生成的模块直接写进 backend/skills/，那是源码目录，三件事同时坏：
① 升级（重装安装包）覆盖整棵 _internal/backend/skills，用户攒下的自生产工具一夜消失，
   连"它存在过"都看不出来；
② 写源码树等于程序改自己，绕过"零自主修改"；
③ 注册只改内存里的 BUILTIN_SKILLS，重启即失，也没有任何地方能关掉它。
所以产物一律落 data/evolved/：一工具两份文件（源码 + 清单），启用/停用/留底/回滚/删除
全按文件算——升级覆盖不到这里，重启后清单照读。

冲突口径：同名时内置工具优先（内置那条路先命中，自进化那份被顶掉）。清单里把它标成
shadowed 交给界面说明，用户可以随时停用或撤销，不必跟新版内置较劲。

失败不抛 500：所有入口回 {code:-1, message:中文}，与 actions 路由同一口径。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import logging
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.data_io import atomic_write_text

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
EVOLVED_DIR = DATA_DIR / "evolved"
HISTORY_DIR = EVOLVED_DIR / ".history"
HISTORY_KEEP = 5
# 留底时间戳定宽，字典序即时序（与 actions 同一格式）
HISTORY_TS_RE = re.compile(r"^\d{8}T\d{6}(?:-\d{1,2})?$")
# 工具名就是文件名：小写字母开头，只允许 a-z0-9_
TOOL_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
MAX_SOURCE_BYTES = 64 * 1024

# 装载缓存：工具名 -> {digest, module}。改过源码（回滚也算）摘要就变，下次调用重新装载，
# 免得"界面已经回滚了、模型还在跑旧逻辑"这种只有重启才好得奇的状况。
_LOADED: dict[str, dict[str, Any]] = {}


def clean_name(raw: Any) -> str:
    """先消毒再拼路径：不合法直接返回空串，绝不拿去 join。"""
    text = str(raw or "").strip().lower()
    return text if TOOL_NAME_RE.match(text) else ""


def _tool_path(base: Path, clean: str, suffix: str = ".py") -> Path | None:
    """解析后必须仍在 data/evolved 内，挡住 ../ 与符号链接外逃。"""
    if not clean:
        return None
    root = base.resolve()
    target = (root / f"{clean}{suffix}").resolve()
    return target if target.parent == root else None


def _history_path(base: Path, clean: str, raw_ts: str, suffix: str) -> Path | None:
    ts = str(raw_ts or "").strip()
    if not clean or not HISTORY_TS_RE.match(ts):
        return None
    root = base.resolve()
    target = (root / f"{clean}.{ts}{suffix}").resolve()
    return target if target.parent == root else None


def _read_text(path: Path) -> str:
    if path.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError(f"文件超过 {MAX_SOURCE_BYTES} 字节上限")
    return path.read_text(encoding="utf-8", errors="replace")


def read_manifest(clean: str) -> dict[str, Any] | None:
    path = _tool_path(EVOLVED_DIR, clean, ".json")
    if not path or not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _manifest_digest(source_text: str) -> str:
    return hashlib.sha256(source_text.encode("utf-8")).hexdigest()[:16]


def check_source(source: str) -> str:
    """不执行地判个生死：语法过不了或缺 execute 就不该进目录。

    只 compile 不 exec——列一次清单绝不该把用户生成的代码跑一遍。
    """
    if not source.strip():
        return "源码为空"
    try:
        compile(source, "evolved.py", "exec")
    except SyntaxError as exc:
        line = f"（第 {exc.lineno} 行）" if exc.lineno else ""
        return f"语法错误{line}：{exc.msg}"
    if not re.search(r"^def execute\(", source, re.M):
        return "缺少 execute 函数，模型没法调用"
    return ""


def builtin_names() -> list[str]:
    """内置工具名（惰性导入，避开 skills 路由 ↔ 本模块的循环）。"""
    try:
        from backend.routers.skills import BUILTIN_SKILLS
        return list(BUILTIN_SKILLS.keys())
    except Exception:  # noqa: BLE001 - 拿不到就当没有，宁可少标一个冲突也别拖垮清单
        return []


def describe(item: dict[str, Any]) -> str:
    """给模型看的一行：说明 + 参数签名，让 skill_search 一次就够写出调用。"""
    desc = str(item.get("description") or item.get("name") or "").strip()
    hints = [
        f"{p.get('name')}:{p.get('type') or 'str'}"
        for p in (item.get("params") or [])
        if isinstance(p, dict) and p.get("name")
    ]
    sig = f"（参数：{', '.join(hints)}）" if hints else "（无参数）"
    return f"[自进化] {desc}{sig}"


def _item_for(clean: str) -> dict[str, Any] | None:
    src = _tool_path(EVOLVED_DIR, clean)
    manifest = read_manifest(clean)
    if not src or not src.is_file():
        return None
    entry: dict[str, Any] = {
        "name": clean,
        "description": str((manifest or {}).get("description") or "").strip() or "（清单缺失或已损坏）",
        "params": (manifest or {}).get("params") or [],
        "enabled": bool((manifest or {}).get("enabled", True)) if manifest else False,
        "created_at": str((manifest or {}).get("created_at") or ""),
        "updated_at": str((manifest or {}).get("updated_at") or ""),
        "path": str(src),
        "bytes": 0,
        "error": "清单缺失或已损坏，先停用再重建" if manifest is None else "",
    }
    try:
        source = _read_text(src)
        entry["bytes"] = len(source.encode("utf-8"))
        if not entry["error"]:
            entry["error"] = check_source(source)
    except (OSError, ValueError) as exc:
        entry["error"] = f"源码读取失败：{exc}"
        source = ""
    entry["digest"] = _manifest_digest(source) if source else ""
    entry["versions"] = len(history_versions(clean))
    # 同名顶掉在这里判，不放 list_items：load_module 也走 _item_for，
    # 两处各判一次的话，"清单说它被顶掉了、装载却照样跑"这种不一致迟早冒出来。
    entry["shadowed"] = clean in set(builtin_names())
    return entry


def list_items() -> list[dict[str, Any]]:
    """盘上全部自进化工具（含已停用与坏掉的），新条目按名字排序。

    坏掉的一定要出现在清单里：只把它从目录里抹掉，用户看到的是"工具凭空消失"，
    而不是"这份生成代码有语法错误"——后者才知道下一步做什么。
    """
    if not EVOLVED_DIR.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for clean in sorted(p.name[:-3] for p in EVOLVED_DIR.glob("*.py") if p.is_file()):
        if not TOOL_NAME_RE.match(clean):
            continue
        item = _item_for(clean)
        if item is not None:
            out.append(item)
    return out


def usable(item: dict[str, Any]) -> bool:
    """进得了模型目录的条件：启用、没坏、也没被内置同名顶掉。"""
    return bool(item.get("enabled")) and not item.get("error") and not item.get("shadowed")


def catalog() -> dict[str, str]:
    return {item["name"]: describe(item) for item in list_items() if usable(item)}


def load_module(clean: str) -> tuple[Any, str]:
    """按文件装载模块；失败回 (None, 原因)。内置同名优先，这里不越权。"""
    if not clean or not TOOL_NAME_RE.match(clean):
        return None, f"无效的工具名称: {clean}"
    item = _item_for(clean)
    if item is None:
        return None, f"自进化工具不存在: {clean}"
    if not item["enabled"]:
        return None, f"自进化工具 {clean} 已被停用，请到「扩展 → 新功能」里重新启用"
    if item["error"]:
        return None, f"自进化工具 {clean} 不可用：{item['error']}"
    if item["shadowed"]:
        return None, f"自进化工具 {clean} 与内置工具同名，已由内置那一份接管"
    src = _tool_path(EVOLVED_DIR, clean)
    cached = _LOADED.get(clean)
    if cached and cached.get("digest") == item["digest"]:
        return cached["module"], ""
    try:
        spec = importlib.util.spec_from_file_location(f"slate_evolved_{clean}", str(src))
        if spec is None or spec.loader is None:
            return None, f"自进化工具 {clean} 装载失败：无法建立模块规格"
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    except Exception as exc:  # noqa: BLE001 - 生成代码里的异常不该掀翻后端
        sys.modules.pop(f"slate_evolved_{clean}", None)
        return None, f"自进化工具 {clean} 装载失败：{exc}"
    if not hasattr(module, "execute"):
        return None, f"自进化工具 {clean} 缺少 execute 函数"
    _LOADED[clean] = {"digest": item["digest"], "module": module}
    return module, ""


# ── 留底 ─────────────────────────────────────

def history_versions(clean: str) -> list[dict[str, Any]]:
    """成对留底（源码 + 清单）里源码在的那一份才算一个版本，最新在前。"""
    if not clean or not HISTORY_DIR.is_dir():
        return []
    prefix = f"{clean}."
    out: list[dict[str, Any]] = []
    for entry in HISTORY_DIR.iterdir():
        if not entry.is_file() or not entry.name.endswith(".py") or not entry.name.startswith(prefix):
            continue
        ts = entry.name[:-3][len(prefix):]
        if not HISTORY_TS_RE.match(ts):
            continue
        try:
            size = entry.stat().st_size
        except OSError:
            continue
        out.append({"ts": ts, "bytes": size, "has_manifest": (HISTORY_DIR / f"{clean}.{ts}.json").is_file()})
    out.sort(key=lambda x: x["ts"], reverse=True)
    return out


def _prune_history(clean: str) -> None:
    for entry in history_versions(clean)[HISTORY_KEEP:]:
        for suffix in (".py", ".json"):
            path = _history_path(HISTORY_DIR, clean, entry["ts"], suffix)
            try:
                if path:
                    path.unlink(missing_ok=True)
            except OSError as exc:
                logger.warning("自进化工具 %s 旧留底清理失败: %s", clean, exc)


def _snapshot(clean: str) -> str:
    """覆盖/删除前留底，返回留底时间戳（没有旧文件则空串）。

    留底失败不绑住写入：用户点了创建就该落盘，但也不假装留了底。
    """
    src = _tool_path(EVOLVED_DIR, clean)
    if not src or not src.is_file():
        return ""
    try:
        source = _read_text(src)
    except (OSError, ValueError) as exc:
        logger.warning("自进化工具 %s 留底读取失败: %s", clean, exc)
        return ""
    try:
        HISTORY_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        # 裁掉的留底会把名字腾出来，直接复用那个名字装"最新一份"就反了：
        # 字典序里裸时间戳排在 -01 之前，最新这份立刻被当成最旧的裁掉，回滚退回去的是旧版。
        # 所以新号必须比现存的最大值更靠后。序号补零到两位，同一秒连存 10 次以上时
        # "-10" 与 "-2" 的字典序才不会反过来。
        newest = max((v["ts"] for v in history_versions(clean)), default="")
        ts, seq = stamp, 1
        while (HISTORY_DIR / f"{clean}.{ts}.py").exists() or ts <= newest:
            ts = f"{stamp}-{seq:02d}"
            seq += 1
        atomic_write_text(HISTORY_DIR / f"{clean}.{ts}.py", source)
        manifest = _tool_path(EVOLVED_DIR, clean, ".json")
        if manifest and manifest.is_file():
            atomic_write_text(HISTORY_DIR / f"{clean}.{ts}.json",
                              manifest.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError) as exc:
        logger.warning("自进化工具 %s 留底写入失败: %s", clean, exc)
        return ""
    _prune_history(clean)
    return ts


# ── 写入口 ───────────────────────────────────

def save_tool(name: str, description: str, params: list[dict], body: str,
              *, note: str = "已保存") -> dict[str, Any]:
    """工厂创建/覆盖的唯一落盘路径：消毒 → 编译自检 → 留底 → 原子写两份。

    一次生成两条入口（面板重建与工具工厂）若各写一遍，早晚会有一遍少做一次语法自检。
    """
    clean = clean_name(name)
    if not clean:
        return {"code": -1, "data": None, "message": "工具名不合法：小写字母开头，只允许 a-z0-9_，长度 ≤48"}
    if not str(description or "").strip():
        return {"code": -1, "data": None, "message": "description 不能为空"}
    if not str(body or "").strip():
        return {"code": -1, "data": None, "message": "body 不能为空，请提供工具的核心逻辑代码"}

    source = str(body)
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        return {"code": -1, "data": None,
                "message": f"生成的源码 {len(source.encode('utf-8'))} 字节，超过 {MAX_SOURCE_BYTES} 字节上限"}
    syntax_error = check_source(source)
    if syntax_error:
        return {"code": -1, "data": None, "message": f"生成的代码没有落盘：{syntax_error}"}

    src_path = _tool_path(EVOLVED_DIR, clean)
    mf_path = _tool_path(EVOLVED_DIR, clean, ".json")
    if not src_path or not mf_path:
        return {"code": -1, "data": None, "message": "工具路径不合法"}

    old = read_manifest(clean)
    created = old is None
    backed_up = _snapshot(clean)
    now = datetime.now().isoformat(timespec="seconds")
    manifest = {
        "name": clean,
        "description": str(description).strip(),
        "params": params if isinstance(params, list) else [],
        "enabled": True if created else bool(old.get("enabled", True)),
        "created_at": str((old or {}).get("created_at") or now),
        "updated_at": now,
        "digest": _manifest_digest(source),
    }
    try:
        EVOLVED_DIR.mkdir(parents=True, exist_ok=True)
        atomic_write_text(src_path, source)
        atomic_write_text(mf_path, json.dumps(manifest, ensure_ascii=False, indent=2))
    except OSError as exc:
        return {"code": -1, "data": None, "message": f"写入失败：{exc.__class__.__name__}"}
    _LOADED.pop(clean, None)
    return {
        "code": 0,
        "data": {
            "tool_name": clean,
            "file_path": str(src_path),
            "description": manifest["description"],
            "params_count": len(manifest["params"]),
            "created": created,
            "backed_up": backed_up,
        },
        "message": note,
    }


def set_enabled(name: str, enabled: bool) -> dict[str, Any]:
    clean = clean_name(name)
    mf_path = _tool_path(EVOLVED_DIR, clean, ".json") if clean else None
    if not mf_path or not mf_path.is_file():
        return {"code": -1, "data": None, "message": f"自进化工具不存在: {name}"}
    manifest = read_manifest(clean)
    if manifest is None:
        return {"code": -1, "data": None, "message": f"清单已损坏，改不了: {clean}"}
    manifest["enabled"] = bool(enabled)
    manifest["updated_at"] = datetime.now().isoformat(timespec="seconds")
    try:
        atomic_write_text(mf_path, json.dumps(manifest, ensure_ascii=False, indent=2))
    except OSError as exc:
        return {"code": -1, "data": None, "message": f"写入失败：{exc.__class__.__name__}"}
    _LOADED.pop(clean, None)
    return {"code": 0, "data": {"tool_name": clean, "enabled": manifest["enabled"]},
            "message": "已启用" if enabled else "已停用"}


def delete_tool(name: str) -> dict[str, Any]:
    """撤销一个自进化工具：先留底再删两份文件。

    留底是这里唯一的退路——删的是模型写的代码，用户事后想比对"当初生成了什么"得能翻出来。
    """
    clean = clean_name(name)
    src = _tool_path(EVOLVED_DIR, clean) if clean else None
    if not src or not src.is_file():
        return {"code": -1, "data": None, "message": f"自进化工具不存在: {name}"}
    backed_up = _snapshot(clean)
    try:
        src.unlink(missing_ok=True)
        mf = _tool_path(EVOLVED_DIR, clean, ".json")
        if mf:
            mf.unlink(missing_ok=True)
    except OSError as exc:
        return {"code": -1, "data": None, "message": f"删除失败：{exc.__class__.__name__}"}
    _LOADED.pop(clean, None)
    return {"code": 0, "data": {"removed": clean, "backed_up": backed_up}, "message": "已撤销"}


def read_source(name: str) -> dict[str, Any]:
    clean = clean_name(name)
    src = _tool_path(EVOLVED_DIR, clean) if clean else None
    if not src or not src.is_file():
        return {"code": -1, "data": None, "message": f"自进化工具不存在: {name}"}
    try:
        source = _read_text(src)
    except (OSError, ValueError) as exc:
        return {"code": -1, "data": None, "message": f"源码读取失败：{exc}"}
    return {"code": 0, "data": {"tool_name": clean, "content": source,
                                "bytes": len(source.encode("utf-8"))}, "message": "ok"}


def read_history_source(name: str, ts: str) -> dict[str, Any]:
    clean = clean_name(name)
    path = _history_path(HISTORY_DIR, clean, ts, ".py") if clean else None
    if not path or not path.is_file():
        return {"code": -1, "data": None, "message": f"历史版本不存在: {clean or name} @ {ts}"}
    try:
        source = _read_text(path)
    except (OSError, ValueError) as exc:
        return {"code": -1, "data": None, "message": f"历史版本读取失败：{exc}"}
    return {"code": 0, "data": {"tool_name": clean, "ts": ts, "content": source,
                                "bytes": len(source.encode("utf-8"))}, "message": "ok"}


def restore_history(name: str, ts: str) -> dict[str, Any]:
    """回滚到某个留底。回滚也是写：编译不过的旧版本不许盖回去。"""
    clean = clean_name(name)
    src = _history_path(HISTORY_DIR, clean, ts, ".py") if clean else None
    if not src or not src.is_file():
        return {"code": -1, "data": None, "message": f"历史版本不存在: {clean or name} @ {ts}"}
    try:
        source = _read_text(src)
    except (OSError, ValueError) as exc:
        return {"code": -1, "data": None, "message": f"历史版本读取失败：{exc}"}
    if check_source(source):
        return {"code": -1, "data": None, "message": f"该历史版本已无法使用，不回滚：{check_source(source)}"}
    manifest = read_manifest(clean) or {}
    mf_path = _history_path(HISTORY_DIR, clean, ts, ".json")
    if mf_path and mf_path.is_file():
        try:
            archived = json.loads(mf_path.read_text(encoding="utf-8", errors="replace"))
            if isinstance(archived, dict):
                manifest = archived
        except (OSError, json.JSONDecodeError):
            pass
    result = save_tool(clean, manifest.get("description") or clean,
                       manifest.get("params") or [], source, note="已回滚")
    if result["code"] == 0:
        result["data"]["restored_ts"] = ts
    return result


# ── 旧产物迁移 ───────────────────────────────

# 工具工厂生成的模块首行 docstring 里有这句，只有它标出来的文件才搬，
# 免得把 backend/skills/ 里的正牌内置工具当成"上次生成的"给迁走。
LEGACY_MARKER = "由工具工厂自动生成"


def migrate_legacy(skills_dir: Path | None = None) -> list[str]:
    """把历史版本遗留在 backend/skills/ 里的生成物搬进 data/evolved/。

    复制而不是剪切：安装包目录下 _internal/ 归程序所有，运行时往里删东西不是
    "改用户数据"而是"改程序自己"。搬完那份留在原处也不会被注册（它不在 BUILTIN_SKILLS 里，
    任何一条路都 import 不到它）。

    skills_dir 可指名扫哪个目录（自检用），缺省扫真正的那份 backend/skills。
    """
    root = skills_dir or Path(__file__).resolve().parent / "skills"
    if not root.is_dir():
        return []
    moved: list[str] = []
    known = {item["name"] for item in list_items()}
    for path in sorted(root.glob("*.py")):
        clean = clean_name(path.stem)
        if not clean or clean in known or clean in builtin_names():
            continue
        try:
            source = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if LEGACY_MARKER not in source[:400]:
            continue
        if check_source(source):
            continue
        desc_match = re.search(r'^"""(.*)', source, re.M)
        description = (desc_match.group(1).strip() if desc_match else "") or clean
        params = [{"name": m.group(1), "type": m.group(2) or "str"}
                  for m in re.finditer(r"(\w+): (str|int|float|bool|list|dict)", _signature(source))]
        if save_tool(clean, description, params, source, note="已从旧目录迁入")["code"] == 0:
            moved.append(clean)
    return moved


def _signature(source: str) -> str:
    """取 execute(...) 的参数表，只用于给旧产物补一份参数说明。"""
    start = source.find("def execute(")
    if start < 0:
        return ""
    end = source.find(") ->", start)
    return source[start:end] if end > start else ""
