"""项目管理路由：打开本地目录作为项目，每个项目拥有独立的宪法、配置和文件上下文。

项目有两种：单目录项目（path 就是那个目录）与工作区（一个宿主目录存配置，
成员是若干彼此无关的文件夹）。工作区任何时刻只"当前"一个根，切根即换 path，
文件、Git、终端的语义和单目录项目完全一致，不额外发明一套路径口径。

多项目管理的口径（backend/project_registry.py）：**在册**的项目全部留在
`data/projects.json`，**正在看的那一个**（active）仍是唯一的——所以本模块下面那些
"取当前根"的文件/Git/终端逻辑一行都不用改语义；变的只是"打开"不再覆盖上一个、
"关闭"不再抹掉、重启后 active 能自己回来，以及每个路由都能按 project 参数寻址到
别的项目（缺省＝活动项，老前端不传也照旧）。
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from backend import project_registry as registry
from backend import round_snapshots
from backend.data_io import atomic_write_json
from backend.subprocess_utils import hidden_subprocess_kwargs
from backend.skills.text_io import read_text_file, write_text_file

router = APIRouter(prefix="/projects", tags=["projects"])

# 与其余 routers/*.py 同一个口径（三层 parent.parent.parent＝仓库 data/）。
# 这里原先写的是 parent.parent，于是开发态跑起来工作区宿主会落到 backend/data/，
# 而打包态有 SLATE_DATA_DIR 兜着看不出问题——注册表也建在这个路径上，先把它对齐。
DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
WORKSPACE_DIR = DATA_DIR / "workspaces"

# 活动项目的进程内缓存：真源是 projects.json 的 active 字段。
# 只许通过 _active_info() 读、_set_active() 写（_is_active() 是唯一的例外读）。
# 多项目之后"当前"只是一个视野，散落各处直接读写它就没法按别的项目寻址了。
_current_project: dict[str, Any] | None = None

IGNORE_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv", "env",
    ".idea", ".vscode", "dist", "build", ".next", ".nuxt", "target",
    ".slate",
}
TEXT_EXTS = {
    ".txt", ".md", ".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css",
    ".json", ".yaml", ".yml", ".xml", ".sh", ".bat", ".ps1", ".toml",
    ".ini", ".cfg", ".env", ".log", ".csv", ".sql", ".rs", ".go", ".java",
    ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt",
}
TEXT_NAMES = {
    ".env", ".env.example", ".gitignore", ".gitattributes", ".dockerignore",
    ".editorconfig", ".npmrc", ".python-version", ".node-version",
}


def _read_slate_config(project_dir: Path) -> dict:
    """读取 .slate/config.json"""
    config_path = project_dir / ".slate" / "config.json"
    if config_path.exists():
        try:
            return json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _norm_dir(raw: str) -> str:
    """把用户给的目录路径规整成可比较的绝对路径；不存在或不是目录返回 ""。"""
    p = Path(str(raw or "")).expanduser()
    try:
        p = p.resolve()
    except OSError:
        return ""
    return str(p) if p.is_dir() else ""


def _write_config(host_dir: Path, config: dict) -> None:
    slate_dir = host_dir / ".slate"
    slate_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_json(slate_dir / "config.json", config)


def _workspace_roots(host_dir: Path, config: dict) -> list[str]:
    """工作区成员：绝对路径、真实存在的目录、去重、保序。

    相对路径按宿主目录解析——这样把整个工作区目录连同配置拷到别处也不会散架。
    """
    roots: list[str] = []
    for raw in config.get("folders") or []:
        p = Path(str(raw)).expanduser()
        if not p.is_absolute():
            p = host_dir / p
        try:
            p = p.resolve()
        except OSError:
            continue
        if p.is_dir() and str(p) not in roots:
            roots.append(str(p))
    return roots


def _active_root(host_dir: Path, roots: list[str], config: dict) -> str:
    """当前根：配置里记的那一个，失效就退回第一个成员，都没有就退回宿主目录。"""
    wanted = str(config.get("root") or "")
    if wanted and wanted in roots:
        return wanted
    return roots[0] if roots else str(host_dir)


def _project_info(project_dir: Path, config: dict) -> dict:
    """把宿主目录 + 配置整理成前端要的项目对象。

    工作区的 path 是"当前根"而不是宿主目录：文件、Git、终端工作目录全部沿用单根语义，
    配置的读写位置另用 workspace_dir 记住。
    """
    is_workspace = config.get("kind") == "workspace"
    roots = _workspace_roots(project_dir, config) if is_workspace else [str(project_dir)]
    path = _active_root(project_dir, roots, config) if is_workspace else str(project_dir)
    info = {
        "path": path,
        "name": project_dir.name,
        "config": config,
        "constitution": config.get("constitution"),
        # MCP 的项目掩码与宪法同住一份 config.json，同样在这里带出去（P4）：
        # 前端按 run 的项目现场过滤远程工具，一次 info 请求就够，不必每场再生成一次请求。
        "mcp": config.get("mcp"),
        "has_slate_dir": (project_dir / ".slate").is_dir(),
        "kind": "workspace" if is_workspace else "folder",
        "roots": roots,
    }
    if is_workspace:
        info["workspace_dir"] = str(project_dir)
    return info


def _host_dir_of(info: dict[str, Any]) -> Path:
    """配置读写的位置：工作区是宿主目录，单目录项目就是它自己。"""
    return Path(str(info.get("workspace_dir") or info.get("path") or ""))


def _info_for(entry: dict[str, Any] | None) -> dict[str, Any] | None:
    """按注册表条目现读一份项目对象；目录已经不在了就返回 None（不猜、不重建）。"""
    if not entry or not entry.get("path"):
        return None
    host = Path(str(entry["path"]))
    if not host.is_dir():
        return None
    info = _project_info(host, _read_slate_config(host))
    info["project_id"] = str(entry.get("id") or "")
    return info


def _set_active(info: dict[str, Any] | None) -> dict[str, Any] | None:
    global _current_project
    _current_project = info
    return info


def _active_info() -> dict[str, Any] | None:
    """当前视野的项目。缓存空了（进程刚起来）就按注册表的 active 自愈一次——
    以前"重启丢失"就是这么来的：注册表里有记录，内存里没有，前端得重放一遍。"""
    if _current_project:
        return _current_project
    doc = registry.load_registry()
    info = _info_for(registry.entry_of(doc, str(doc.get("active") or "")))
    return _set_active(info)


def _resolve_project(key: Any = None) -> dict[str, Any] | None:
    """把 id / 路径 / 唯一名称解析成项目对象；不传就是当前视野的那一个。

    名称只在"册内唯一"时才认（registry.find_entry 里判的）：两个同名项目必须回落到
    id 或路径，否则历史会被归到一个头上——这正是原来拿项目名当外键的毛病。
    """
    text = str(key or "").strip()
    if not text:
        return _active_info()
    doc = registry.load_registry()
    return _info_for(registry.find_entry(doc, text))


def _is_active(info: dict[str, Any]) -> bool:
    return bool(_current_project) and _current_project.get("project_id") == info.get("project_id")


def _register_active(info: dict[str, Any], doc: dict[str, Any]) -> dict[str, Any]:
    """把一份项目对象登记进册并设为视野，返回带 project_id 的对象。"""
    kind = str(info.get("kind") or "folder")
    name = str(info.get("name") or "")
    entry, _created = registry.register(doc, _host_dir_of(info), kind=kind, name=name)
    registry.set_active(doc, str(entry.get("id") or ""))
    registry.save_registry(doc)
    info["project_id"] = str(entry.get("id") or "")
    return _set_active(info)


def _safe_file_size(path: Path) -> int | None:
    try:
        return path.stat().st_size if path.is_file() else None
    except OSError:
        return None


def _normalize_project_subpath(path: str | None) -> str:
    """Keep real dot-prefixed names while treating empty, dot, and dot-slash as project root."""
    raw = (path or "").strip().replace("\\", "/")
    return "" if raw in {"", ".", "./"} else raw


def _is_ignored_project_entry(path: Path) -> bool:
    """Hide only explicit noisy/generated directories; keep project dotfiles such as .github."""
    return path.is_dir() and path.name in IGNORE_DIRS


def _is_text_project_file(path: Path) -> bool:
    return path.suffix.lower() in TEXT_EXTS or path.name.lower() in TEXT_NAMES


def _run_git(project_dir: Path, args: list[str], timeout: int = 10) -> tuple[int, str, str]:
    result = subprocess.run(
        ["git", *args],
        cwd=project_dir,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        **hidden_subprocess_kwargs(),
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def _split_git_record(line: str) -> list[str]:
    return line.split("\x1f")


def _parse_porcelain_status(text: str) -> dict[str, list[dict[str, str]]]:
    staged: list[dict[str, str]] = []
    unstaged: list[dict[str, str]] = []
    untracked: list[dict[str, str]] = []
    for raw in text.splitlines():
        if not raw or raw.startswith("##"):
            continue
        xy = raw[:2]
        path = raw[3:].strip()
        if not path:
            continue
        item = {"status": xy.strip() or "?", "path": path}
        if xy == "??":
            untracked.append(item)
            continue
        if xy[0] != " ":
            staged.append({"status": xy[0], "path": path})
        if xy[1] != " ":
            unstaged.append({"status": xy[1], "path": path})
    return {"staged": staged, "unstaged": unstaged, "untracked": untracked}


def _parse_worktrees(text: str) -> list[dict[str, str | bool]]:
    worktrees: list[dict[str, str | bool]] = []
    current: dict[str, str | bool] = {}
    for line in [*text.splitlines(), ""]:
        if not line:
            if current:
                worktrees.append(current)
                current = {}
            continue
        if line.startswith("worktree "):
            current["path"] = line.removeprefix("worktree ").strip()
        elif line.startswith("HEAD "):
            current["head"] = line.removeprefix("HEAD ").strip()[:12]
        elif line.startswith("branch "):
            current["branch"] = line.removeprefix("branch ").strip().removeprefix("refs/heads/")
        elif line == "bare":
            current["bare"] = True
        elif line == "detached":
            current["detached"] = True
    return worktrees


# ── 请求模型 ──────────────────────────────────

class OpenProjectRequest(BaseModel):
    path: str


class UpdateConfigRequest(BaseModel):
    config: dict
    project: str = ""


class BrowseRequest(BaseModel):
    path: str = ""
    project: str = ""


class FindRequest(BaseModel):
    query: str
    limit: int = 30
    project: str = ""


class SwitchRootRequest(BaseModel):
    path: str
    project: str = ""


class CreateWorkspaceRequest(BaseModel):
    name: str
    folders: list[str] = []


class WorkspaceFoldersRequest(BaseModel):
    action: str
    path: str
    project: str = ""


class ActiveProjectRequest(BaseModel):
    project: str


class RegistryPatchRequest(BaseModel):
    """只认这几个字段：None 表示"这次不动它"，所以布尔字段必须可空。"""
    pinned: bool | None = None
    archived: bool | None = None
    muted: bool | None = None
    last_conversation_id: str | None = None
    draft: str | None = None
    scroll: float | None = None
    board_id: str | None = None
    model_id: str | None = None
    constitution_scope: str | None = None


class AddAliasRequest(BaseModel):
    aliases: list[str] = []


# ── 路由 ──────────────────────────────────────

@router.post("/open")
async def open_project(req: OpenProjectRequest):
    """打开本地目录作为项目：登记在册 + 设为视野。

    和以前的区别：打开新项目不再把上一个"顶掉"——上一个仍在注册表里，
    它的会话、宪法、后台任务、上次停在哪一条都还在，一键就能回来。
    """
    p = Path(req.path).resolve()
    if not p.exists():
        return {"code": 1, "message": f"目录不存在: {p}"}
    if not p.is_dir():
        return {"code": 1, "message": "路径不是目录"}

    config = _read_slate_config(p)
    info = _project_info(p, config)
    info = _register_active(info, registry.load_registry())
    return {"code": 0, "data": info}


@router.get("/current")
async def get_current_project():
    """获取当前视野里的项目（没有就回 None，语义与以前一致）。"""
    return {"code": 0, "data": _active_info()}


@router.post("/close")
async def close_project():
    """收起当前视野：项目留在册上，会话 / 宪法 / 后台任务一律不动。

    以前这颗"×"直接把服务端状态抹成 None，于是"关闭"和"丢了"没法区分；
    现在关闭只是不看了，从切换器点回来即可。
    """
    doc = registry.load_registry()
    if _active_info():
        doc["active"] = ""
        registry.save_registry(doc)
    return {"code": 0, "data": _set_active(None)}


@router.get("/registry")
async def get_registry():
    """在册清单（含 active 标记与各项目现场），项目切换器与侧栏都读这一份。"""
    doc = registry.load_registry()
    return {"code": 0, "data": {"active": doc.get("active") or "", "projects": registry.registry_view(doc)}}


@router.get("/registry/{project_id}/info")
async def get_registry_project_info(project_id: str):
    """按在册 id 现读一份项目现场（path/name/roots/宪法），**不改视野**。

    为什么需要它：并行时后台那一场属于另一个项目，它的文件、终端、Git 都要落在
    它自己项目的根上。前端只有注册表清单（id/path/name），拿不到工作区的"当前根"
    与项目宪法，那两样只有服务端读得到——所以由这里给，而不是让前端猜。
    """
    doc = registry.load_registry()
    entry = registry.entry_of(doc, project_id)
    if not entry:
        return {"code": 1, "message": "该项目不在册"}
    info = _info_for(entry)
    if not info:
        return {"code": 1, "message": f"项目目录已经不在了：{entry.get('path') or ''}"}
    return {"code": 0, "data": info}


@router.post("/active")
async def set_active_project(req: ActiveProjectRequest):
    """把某个在册项目设为"正在看的那一个"：只改视野，不碰任何在跑的东西。

    路径不在册时按"打开"处理一次（切换器里点最近项目却目录已被登记过别的形态，
    不该报"找不到项目"）。
    """
    doc = registry.load_registry()
    entry = registry.find_entry(doc, req.project)
    if not entry and str(req.project or "").strip():
        wanted = Path(str(req.project)).expanduser()
        if wanted.is_dir():
            info = _project_info(wanted, _read_slate_config(wanted))
            info = _register_active(info, doc)
            return {"code": 0, "data": {"project": info, "registry": registry.registry_view(doc)}}
        return {"code": 1, "message": "该项目不在册，请先打开目录"}
    info = _info_for(entry)
    if not info:
        return {"code": 1, "message": f"项目目录已经不在了：{(entry or {}).get('path') or ''}"}
    registry.set_active(doc, str(entry["id"]))
    registry.save_registry(doc)
    _set_active(info)
    return {"code": 0, "data": {"project": info, "registry": registry.registry_view(doc)}}


@router.patch("/registry/{project_id}")
async def patch_registry_entry(project_id: str, req: RegistryPatchRequest):
    """改一条在册记录：固定 / 归档 / 静音 / 现场（上次会话、草稿、滚动、看板、默认模型）。"""
    doc = registry.load_registry()
    entry = registry.entry_of(doc, project_id)
    if not entry:
        return {"code": 1, "message": "该项目不在册"}
    if req.pinned is not None:
        entry["pinned"] = bool(req.pinned)
    if req.archived is not None:
        entry["archived"] = bool(req.archived)
    prefs_patch: dict[str, Any] = {}
    if req.muted is not None:
        prefs_patch["muted"] = bool(req.muted)
    for key in ("last_conversation_id", "draft", "scroll", "board_id", "model_id", "constitution_scope"):
        value = getattr(req, key, None)
        if value is not None:
            prefs_patch[key] = value
    if prefs_patch:
        registry.patch_prefs(entry, prefs_patch)
    registry.save_registry(doc)
    return {"code": 0, "data": registry.public_entry(doc, entry)}


@router.delete("/registry/{project_id}")
async def remove_registry_entry(project_id: str, forget: bool = False):
    """从册上移除一条记录。

    移除与删数据是两件事，界面上不许合成一个按钮：默认只摘索引，`.slate/config.json`
    与会话历史都留在原地；只有显式 `?forget=true` 才连带删 SLATE 私有的
    data/projects/<id>/（worktree 等），且只允许删这个前缀下面的路径。
    """
    doc = registry.load_registry()
    entry = registry.entry_of(doc, project_id)
    if not entry:
        return {"code": 1, "message": "该项目不在册"}
    doc["projects"] = [e for e in doc["projects"] if e.get("id") != project_id]
    if doc.get("active") == project_id:
        doc["active"] = ""
        _set_active(None)
    registry.save_registry(doc)
    removed_data = False
    if forget:
        target = registry.data_dir_for(project_id).resolve()
        allowed = registry.PROJECT_DATA_DIR.resolve()
        if target.is_dir() and str(target).startswith(str(allowed)):
            import shutil
            shutil.rmtree(target, ignore_errors=True)
            removed_data = True
    return {"code": 0, "data": {"removed": True, "data_removed": removed_data,
                               "registry": registry.registry_view(doc)}}


@router.post("/registry/{project_id}/alias")
async def add_registry_alias(project_id: str, req: AddAliasRequest):
    """把一批旧 id 记成别名，用于"把这些未归类会话归到本项目"这类手工归位。"""
    doc = registry.load_registry()
    entry = registry.entry_of(doc, project_id)
    if not entry:
        return {"code": 1, "message": "该项目不在册"}
    aliases = list(entry.get("aliases") or [])
    for raw in req.aliases:
        text = str(raw or "").strip()
        if text and text != entry["id"] and text not in aliases:
            aliases.append(text)
    entry["aliases"] = aliases
    registry.save_registry(doc)
    return {"code": 0, "data": registry.public_entry(doc, entry)}


@router.put("/config")
async def update_project_config(req: UpdateConfigRequest):
    """更新项目配置（写入 .slate/config.json）"""
    info = _resolve_project(req.project)
    if not info:
        return {"code": 1, "message": "未打开项目"}

    # 工作区的配置写在宿主目录，不写进某个成员仓库：成员各自的 .slate 不该被串改
    project_dir = _host_dir_of(info)
    slate_dir = project_dir / ".slate"
    slate_dir.mkdir(parents=True, exist_ok=True)

    config_path = slate_dir / "config.json"
    atomic_write_json(config_path, req.config)

    updated = _project_info(project_dir, req.config)
    updated["project_id"] = str(info.get("project_id") or "")
    if not req.project or _is_active(info):
        _set_active(updated)
    return {"code": 0, "data": updated}


@router.post("/root")
async def switch_project_root(req: SwitchRootRequest):
    """工作区切当前根：只认成员目录，切完文件/Git/终端都跟着换。"""
    info = _resolve_project(req.project)
    if not info or info.get("kind") != "workspace":
        return {"code": 1, "message": "当前项目不是工作区"}
    wanted = _norm_dir(req.path)
    if wanted not in info.get("roots", []):
        return {"code": 1, "message": "该目录不在工作区内"}
    host = Path(info["workspace_dir"])
    config = {**info.get("config", {}), "root": wanted}
    _write_config(host, config)
    updated = _project_info(host, config)
    updated["project_id"] = str(info.get("project_id") or "")
    if not req.project or _is_active(info):
        _set_active(updated)
    return {"code": 0, "data": updated}


@router.post("/workspace")
async def create_workspace(req: CreateWorkspaceRequest):
    """新建工作区：宿主目录落在 data/workspaces/<name>，成员是任意已有文件夹。

    宿主放本机数据目录而不是让用户另挑一处：他要选的只有"哪些文件夹参与"，
    多一个"这个工作区该存哪"的问题只会变成随手点默认值。
    """
    name = (req.name or "").strip()
    if not name or len(name) > 64 or any(sep in name for sep in "\\/:*?\"<>|"):
        return {"code": 1, "message": "工作区名称不能为空，且不能包含路径分隔符或 : ? * \" < > |"}
    folders_wanted: list[str] = []
    for raw in req.folders:
        p = _norm_dir(raw)
        if not p:
            return {"code": 1, "message": f"文件夹不存在：{raw}"}
        if p not in folders_wanted:
            folders_wanted.append(p)
    if not folders_wanted:
        return {"code": 1, "message": "至少选择一个文件夹"}

    host = WORKSPACE_DIR / name
    existing = _read_slate_config(host)
    if existing.get("kind") == "workspace":
        # 同名再建一次 = 补充成员，不是推倒重来：宪法、当前根这些已有设置不该被吃掉
        folders = [f for f in (existing.get("folders") or []) if f not in folders_wanted]
        config = {**existing, "kind": "workspace", "folders": [*folders, *folders_wanted]}
    else:
        config = {"kind": "workspace", "folders": folders_wanted, "root": folders_wanted[0]}
    host.mkdir(parents=True, exist_ok=True)
    _write_config(host, config)
    info = _register_active(_project_info(host, config), registry.load_registry())
    return {"code": 0, "data": info}


@router.post("/workspace/folders")
async def edit_workspace_folders(req: WorkspaceFoldersRequest):
    """给某个工作区加/减成员目录；减掉正当前的根时，当前根退回第一个成员。"""
    info = _resolve_project(req.project)
    if not info or info.get("kind") != "workspace":
        return {"code": 1, "message": "当前项目不是工作区"}
    host = Path(info["workspace_dir"])
    config = dict(info.get("config") or {})
    folders = list(config.get("folders") or [])
    target = _norm_dir(req.path)
    if req.action == "add":
        if not target:
            return {"code": 1, "message": "文件夹不存在"}
        if target not in folders:
            folders.append(target)
    elif req.action == "remove":
        folders = [f for f in folders if f != target]
    else:
        return {"code": 1, "message": f"未知操作: {req.action}"}
    if not folders:
        return {"code": 1, "message": "工作区至少要留一个文件夹"}
    config["folders"] = folders
    # 只在当前根被减掉时才回落到首成员；减别的成员不该顺手把用户正在看的目录换掉
    if config.get("root") and config["root"] not in folders:
        config.pop("root", None)
    _write_config(host, config)
    updated = _project_info(host, config)
    updated["project_id"] = str(info.get("project_id") or "")
    if not req.project or _is_active(info):
        _set_active(updated)
    return {"code": 0, "data": updated}


@router.post("/browse")
async def browse_files(req: BrowseRequest):
    """浏览项目目录（默认根目录）"""
    info = _resolve_project(req.project)
    if not info:
        return {"code": 1, "message": "未打开项目"}

    project_dir = Path(info["path"])
    sub = _normalize_project_subpath(req.path)

    if sub:
        target = (project_dir / sub).resolve()
    else:
        target = project_dir

    # 安全检查：防止目录穿越
    try:
        target.relative_to(project_dir)
    except ValueError:
        return {"code": 1, "message": "路径超出项目范围"}

    if not target.exists():
        return {"code": 1, "message": "路径不存在"}

    if target.is_file():
        # 返回文件内容（文本文件）
        if _is_text_project_file(target) or target.suffix.lower() in {".svg"}:
            try:
                content = target.read_text(encoding="utf-8", errors="replace")
                return {
                    "code": 0,
                    "data": {
                        "type": "file",
                        "name": target.name,
                        "path": str(target.relative_to(project_dir)),
                        "size": _safe_file_size(target),
                        "content": content[:50000],
                    },
                }
            except Exception as e:
                return {"code": 1, "message": f"读取失败: {e}"}
        return {"code": 1, "message": "非文本文件"}

    # 目录列表
    entries = []
    try:
        items = sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
    except OSError:
        return {"code": 1, "message": "无权限访问"}

    for item in items:
        if _is_ignored_project_entry(item):
            continue
        entries.append({
            "name": item.name,
            "type": "dir" if item.is_dir() else "file",
            "path": str(item.relative_to(project_dir)),
            "size": _safe_file_size(item),
        })

    return {
        "code": 0,
        "data": {
            "type": "dir",
            "name": target.name,
            "path": str(target.relative_to(project_dir)) if target != project_dir else ".",
            "entries": entries,
        },
    }


# ── Code Review：Git Diff 读取与解析 ──────────

class ReviewDiffRequest(BaseModel):
    mode: str = "unstaged"           # staged | unstaged | commit
    from_commit: str = ""            # for mode=commit
    to_commit: str = "HEAD"          # for mode=commit
    max_lines: int = 8000            # safety cap
    project: str = ""


def _parse_unified_diff(diff_text: str) -> list[dict]:
    """Parse unified diff into structured per-file data with line numbers."""
    files: list[dict] = []
    current_file: dict | None = None
    current_chunk: dict | None = None
    old_line = 0
    new_line = 0

    for raw_line in diff_text.splitlines():
        # File header
        if raw_line.startswith("diff --git"):
            current_file = None
            current_chunk = None
            continue
        if raw_line.startswith("--- "):
            # 新增文件的旧侧是 /dev/null，同样要创建条目（+++ 行会补上真实文件名）
            current_file = {"file": raw_line[6:], "changes": []}
            if current_file["file"] == "dev/null":
                current_file["file"] = ""
            files.append(current_file)
            continue
        if raw_line.startswith("+++ b/"):
            if current_file:
                current_file["file"] = raw_line[6:]
            continue

        # Hunk header
        if raw_line.startswith("@@"):
            if current_file is None:
                continue
            parts = raw_line.split("@@")
            if len(parts) >= 3:
                ranges = parts[1].strip().split()
                old_start = int(ranges[0].split(",")[0].lstrip("-")) if ranges else 1
                new_start = int(ranges[1].split(",")[0].lstrip("+")) if len(ranges) > 1 else 1
                old_line = old_start
                new_line = new_start
                current_chunk = {
                    "old_start": old_start,
                    "new_start": new_start,
                    "lines": [],
                }
                current_file["changes"].append(current_chunk)
            continue

        # Diff content lines
        if current_chunk is None:
            continue
        if raw_line.startswith("+"):
            current_chunk["lines"].append({"type": "add", "old_line": None, "new_line": new_line, "content": raw_line[1:]})
            new_line += 1
        elif raw_line.startswith("-"):
            current_chunk["lines"].append({"type": "del", "old_line": old_line, "new_line": None, "content": raw_line[1:]})
            old_line += 1
        elif raw_line.startswith(" "):
            current_chunk["lines"].append({"type": "ctx", "old_line": old_line, "new_line": new_line, "content": raw_line[1:]})
            old_line += 1
            new_line += 1

    return files


@router.post("/review/diff")
async def review_diff(req: ReviewDiffRequest):
    """Read git diff from project directory and return structured parse result."""
    info = _resolve_project(req.project)
    if not info:
        return {"code": 1, "message": "未打开项目"}
    project_dir = Path(info["path"])

    # Verify it's a git repo
    try:
        subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            cwd=project_dir, capture_output=True, timeout=10, check=True,
            **hidden_subprocess_kwargs(),
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return {"code": 1, "message": "该项目不是 Git 仓库"}

    # Build git diff command
    if req.mode == "staged":
        cmd = ["git", "diff", "--cached", "-U3"]
    elif req.mode == "commit":
        if not req.from_commit:
            return {"code": 1, "message": "commit 模式需要指定 from_commit"}
        cmd = ["git", "diff", "-U3", req.from_commit, req.to_commit or "HEAD"]
    else:  # unstaged
        cmd = ["git", "diff", "-U3"]

    try:
        result = subprocess.run(
            cmd, cwd=project_dir, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
            **hidden_subprocess_kwargs(),
        )
        diff_text = result.stdout
    except subprocess.TimeoutExpired:
        return {"code": 1, "message": "git diff 超时（30s）"}
    except Exception as e:
        return {"code": 1, "message": f"git diff 失败: {e}"}

    # 退出码非 0 就是 git 报了错（SHA 拼错、仓库还没有提交、index 被锁……）。
    # 这时候 stdout 是空的，但它不是"没有变更"——把失败说成干净，用户就再也不信这个面板了。
    if result.returncode != 0:
        first_line = (result.stderr or "").strip().splitlines()
        return {"code": 1, "message": f"git diff 失败: {first_line[0] if first_line else f'退出码 {result.returncode}'}"}

    if not diff_text.strip():
        return {"code": 0, "data": {"files": [], "raw": "", "total_changes": 0, "message": "无变更"}, "message": "ok"}

    # Safety cap
    lines = diff_text.splitlines()
    truncated = len(lines) > req.max_lines
    if truncated:
        diff_text = "\n".join(lines[:req.max_lines])

    files = _parse_unified_diff(diff_text)

    # Count changes
    total_add = sum(
        1 for f in files for c in f["changes"] for ln in c["lines"] if ln["type"] == "add"
    )
    total_del = sum(
        1 for f in files for c in f["changes"] for ln in c["lines"] if ln["type"] == "del"
    )

    return {
        "code": 0,
        "data": {
            "files": files,
            "raw": diff_text[:200000],
            "total_files": len(files),
            "total_add": total_add,
            "total_del": total_del,
            "total_changes": total_add + total_del,
            "truncated": truncated,
            "mode": req.mode,
        },
        "message": "ok",
    }


@router.get("/git/graph")
async def git_graph(project: str = "") -> dict[str, Any]:
    """Return a read-only Git graph for a project (default: the one in view)."""
    info = _resolve_project(project)
    if not info:
        return {"code": 1, "message": "未打开项目"}
    project_dir = Path(info["path"])

    try:
        code, root, err = _run_git(project_dir, ["rev-parse", "--show-toplevel"])
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return {"code": 1, "message": "该项目不是 Git 仓库"}
    if code != 0:
        return {"code": 1, "message": f"该项目不是 Git 仓库: {err or project_dir}"}

    repo_dir = Path(root)
    _code, current_branch, _err = _run_git(repo_dir, ["rev-parse", "--abbrev-ref", "HEAD"])
    _code, head_full, _err = _run_git(repo_dir, ["rev-parse", "HEAD"])
    _code, status_text, _err = _run_git(repo_dir, ["status", "--porcelain=v1", "-b"])
    status = _parse_porcelain_status(status_text)

    _code, branch_text, _err = _run_git(
        repo_dir,
        [
            "branch",
            "--format=%(refname:short)\x1f%(objectname:short)\x1f%(upstream:short)\x1f%(upstream:trackshort)\x1f%(HEAD)",
        ],
    )
    branches = []
    for line in branch_text.splitlines():
        parts = _split_git_record(line)
        if len(parts) < 5:
            continue
        branches.append({
            "name": parts[0],
            "hash": parts[1],
            "upstream": parts[2],
            "track": parts[3],
            "current": parts[4] == "*",
        })

    _code, remote_branch_text, _err = _run_git(
        repo_dir,
        ["branch", "-r", "--format=%(refname:short)\x1f%(objectname:short)"],
    )
    remote_branches = []
    for line in remote_branch_text.splitlines():
        parts = _split_git_record(line)
        if len(parts) >= 2 and "HEAD" not in parts[0]:
            remote_branches.append({"name": parts[0], "hash": parts[1]})

    _code, remote_text, _err = _run_git(repo_dir, ["remote", "-v"])
    remotes: dict[str, dict[str, str]] = {}
    for line in remote_text.splitlines():
        parts = line.split()
        if len(parts) >= 3:
            entry = remotes.setdefault(parts[0], {})
            direction = parts[2].strip("()")
            entry[direction] = parts[1]

    _code, tag_text, _err = _run_git(
        repo_dir,
        ["for-each-ref", "refs/tags", "--sort=-creatordate", "--format=%(refname:short)\x1f%(objectname:short)\x1f%(creatordate:short)"],
    )
    tags = []
    for line in tag_text.splitlines()[:40]:
        parts = _split_git_record(line)
        if len(parts) >= 2:
            tags.append({"name": parts[0], "hash": parts[1], "date": parts[2] if len(parts) > 2 else ""})

    _code, stash_text, _err = _run_git(repo_dir, ["stash", "list", "--format=%gd\x1f%h\x1f%cr\x1f%s"])
    stashes = []
    for line in stash_text.splitlines()[:20]:
        parts = _split_git_record(line)
        if len(parts) >= 4:
            stashes.append({"name": parts[0], "hash": parts[1], "date": parts[2], "subject": parts[3]})

    _code, worktree_text, _err = _run_git(repo_dir, ["worktree", "list", "--porcelain"])
    worktrees = _parse_worktrees(worktree_text)

    _code, log_text, _err = _run_git(
        repo_dir,
        [
            "log",
            "--all",
            "--decorate=short",
            "--date=format:%Y-%m-%d %H:%M",
            "--pretty=format:%h\x1f%H\x1f%p\x1f%D\x1f%an\x1f%ad\x1f%s",
            "--max-count=40",
        ],
        timeout=20,
    )
    commits = []
    for line in log_text.splitlines():
        parts = _split_git_record(line)
        if len(parts) < 7:
            continue
        commits.append({
            "hash": parts[0],
            "full_hash": parts[1],
            "parents": [p[:7] for p in parts[2].split() if p],
            "refs": parts[3],
            "author": parts[4],
            "date": parts[5],
            "subject": parts[6],
        })

    upstream = ""
    ahead = behind = 0
    unpushed = []
    code, upstream_text, _err = _run_git(repo_dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    if code == 0 and upstream_text:
        upstream = upstream_text
        code, counts, _err = _run_git(repo_dir, ["rev-list", "--left-right", "--count", f"{upstream}...HEAD"])
        if code == 0:
            vals = counts.split()
            if len(vals) >= 2:
                behind = int(vals[0] or 0)
                ahead = int(vals[1] or 0)
        code, unpushed_text, _err = _run_git(
            repo_dir,
            [
                "log",
                f"{upstream}..HEAD",
                "--date=format:%Y-%m-%d %H:%M",
                "--pretty=format:%h\x1f%H\x1f%an\x1f%ad\x1f%s",
                "--max-count=20",
            ],
        )
        if code == 0:
            for line in unpushed_text.splitlines():
                parts = _split_git_record(line)
                if len(parts) >= 5:
                    unpushed.append({
                        "hash": parts[0],
                        "full_hash": parts[1],
                        "author": parts[2],
                        "date": parts[3],
                        "subject": parts[4],
                    })

    return {
        "code": 0,
        "message": "ok",
        "data": {
            "repo": str(repo_dir),
            "project_path": str(project_dir),
            "current_branch": current_branch,
            "head": head_full[:12],
            "upstream": upstream,
            "ahead": ahead,
            "behind": behind,
            "branches": branches,
            "remote_branches": remote_branches,
            "remotes": remotes,
            "tags": tags,
            "stashes": stashes,
            "worktrees": worktrees,
            "status": status,
            "unpushed": unpushed,
            "commits": commits,
        },
    }


@router.post("/find")
async def find_files(req: FindRequest):
    """按文件名或相对路径查找项目文件"""
    info = _resolve_project(req.project)
    if not info:
        return {"code": 1, "message": "未打开项目"}

    query = (req.query or "").strip().lower()
    if not query:
        return {"code": 1, "message": "缺少查询条件"}

    project_dir = Path(info["path"])
    limit = max(1, min(req.limit or 30, 100))
    matches = []

    stack = [project_dir]
    while stack and len(matches) < limit:
        current = stack.pop()
        try:
            children = sorted(current.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            continue
        for path in children:
            if len(matches) >= limit:
                break
            if _is_ignored_project_entry(path):
                continue
            rel = path.relative_to(project_dir).as_posix()
            name = path.name.lower()
            rel_lower = rel.lower()
            if query == name or query in name or query in rel_lower:
                matches.append({
                    "name": path.name,
                    "type": "dir" if path.is_dir() else "file",
                    "path": rel,
                    "size": _safe_file_size(path),
                })
            if path.is_dir():
                stack.append(path)

    return {"code": 0, "data": {"query": req.query, "matches": matches}}


@router.get("/drives")
async def list_drives():
    """列出系统磁盘（Windows）或根目录（Linux/macOS）"""
    import os
    import string

    drives = []
    if os.name == "nt":
        for letter in string.ascii_uppercase:
            drive = Path(f"{letter}:\\")
            if drive.exists():
                drives.append({"path": str(drive), "name": f"{letter}:"})
    else:
        drives.append({"path": "/", "name": "/"})
        home = Path.home()
        if home.exists():
            drives.append({"path": str(home), "name": "~ (Home)"})

    return {"code": 0, "data": drives}


# ── 文件编辑（接受 diff） ───────────────────────

class ApplyEditRequest(BaseModel):
    file_path: str
    content: str
    project: str = ""
    run_id: str = ""


@router.post("/apply-edit")
async def apply_file_edit(req: ApplyEditRequest):
    """将编辑后的内容写入文件（用户点击「接受」时调用）"""
    info = _resolve_project(req.project)
    if not info:
        return {"code": 1, "message": "未打开项目"}

    project_dir = Path(info["path"])
    target = Path(req.file_path)

    # 安全检查：确保文件在项目范围内
    try:
        target.resolve().relative_to(project_dir.resolve())
    except ValueError:
        return {"code": 1, "message": "文件路径超出项目范围"}

    if not target.is_file():
        return {"code": 1, "message": "文件不存在"}

    # 写之前先取这一轮的原文：拿不到快照也照常写入，只是这一项进不了「本轮总结」。
    snap = round_snapshots.begin_write(project_dir, req.run_id, target, mode="edit", tool="apply-edit")
    try:
        existing = read_text_file(target)
        written = write_text_file(target, req.content, existing.encoding)
        round_snapshots.finish_write(snap)
        return {
            "code": 0,
            "data": {
                "file": str(target.relative_to(project_dir)),
                "encoding": written.encoding,
                "encoding_changed": written.encoding_changed,
            },
            "message": "ok",
        }
    except Exception as e:
        return {"code": 1, "message": f"写入失败: {e}"}


# ── 创建新文件 ─────────────────────────────

class CreateFileRequest(BaseModel):
    file_path: str
    content: str
    project: str = ""
    run_id: str = ""


@router.post("/create-file")
async def create_file(req: CreateFileRequest):
    """创建新文件（用户点击「接受」时调用）"""
    info = _resolve_project(req.project)
    if not info:
        return {"code": 1, "message": "未打开项目"}

    project_dir = Path(info["path"])
    target = Path(req.file_path)

    # 安全检查：确保文件在项目范围内
    try:
        target.resolve().relative_to(project_dir.resolve())
    except ValueError:
        return {"code": 1, "message": "文件路径超出项目范围"}

    if target.exists():
        return {"code": 1, "message": "文件已存在"}

    try:
        # 自动创建父目录
        snap = round_snapshots.begin_write(project_dir, req.run_id, target, mode="create", tool="create-file")
        target.parent.mkdir(parents=True, exist_ok=True)
        written = write_text_file(target, req.content, "utf-8")
        round_snapshots.finish_write(snap)
        return {
            "code": 0,
            "data": {
                "file": str(target.relative_to(project_dir)),
                "encoding": written.encoding,
                "encoding_changed": written.encoding_changed,
            },
            "message": "ok",
        }
    except Exception as e:
        return {"code": 1, "message": f"创建失败: {e}"}


# ── 追加内容到已有文件（超长文件分段写入 / 截断续写兜底） ─────


class AppendFileRequest(BaseModel):
    file_path: str
    content: str
    project: str = ""
    run_id: str = ""


@router.post("/append-file")
async def append_file(req: AppendFileRequest):
    """向已有文件末尾追加内容（用户点击「接受」时调用）"""
    info = _resolve_project(req.project)
    if not info:
        return {"code": 1, "message": "未打开项目"}

    project_dir = Path(info["path"])
    target = Path(req.file_path)

    # 安全检查：确保文件在项目范围内
    try:
        target.resolve().relative_to(project_dir.resolve())
    except ValueError:
        return {"code": 1, "message": "文件路径超出项目范围"}

    if not target.exists():
        return {"code": 1, "message": "文件不存在，请先用 file_create 创建"}

    snap = round_snapshots.begin_write(project_dir, req.run_id, target, mode="append", tool="append-file")
    try:
        existing = read_text_file(target)
        written = write_text_file(target, existing.content + req.content, existing.encoding)
        round_snapshots.finish_write(snap)
        return {
            "code": 0,
            "data": {
                "file": str(target.relative_to(project_dir)),
                "encoding": written.encoding,
                "encoding_changed": written.encoding_changed,
            },
            "message": "ok",
        }
    except Exception as e:
        return {"code": 1, "message": f"追加失败: {e}"}


# ── 本轮总结：这一轮改了哪些文件 / 差异 / 整轮撤回 ────────
#
# 这三个端点只读上面三个写端点留下的清单，自己一个字节都不写项目。
# 之所以不走 git：项目可能根本不是仓库，而且在跑的 git 仓库里 `checkout .` 会把
# 用户自己未提交的修改一起抹掉——撤回只能还原到「这一轮开始之前」，多做一寸都不行。

class RoundRevertRequest(BaseModel):
    run_id: str
    project: str = ""


def _round_project(project: str = "") -> Path | None:
    info = _resolve_project(project)
    return Path(info["path"]) if info and info.get("path") else None


@router.get("/round-files")
async def get_round_files(run_id: str = "", project: str = ""):
    """本轮被写端点改过的文件与行数合计：「本轮总结」卡片的数据源。"""
    project_dir = _round_project(project)
    if project_dir is None:
        return {"code": 1, "message": "未打开项目"}
    return {"code": 0, "data": round_snapshots.round_files(project_dir, run_id)}


@router.get("/round-diff")
async def get_round_diff(run_id: str = "", path: str = "", project: str = ""):
    """单个文件的差异（本轮首次原文 ↔ 当前内容）。当前内容以磁盘为准，
    所以本轮之后用户又改过的文件，这里看到的是「包括自己改动」的差异。"""
    project_dir = _round_project(project)
    if project_dir is None:
        return {"code": 1, "message": "未打开项目"}
    if not path:
        return {"code": 1, "message": "缺少 path"}
    return {"code": 0, "data": round_snapshots.round_diff(project_dir, run_id, path)}


@router.post("/round-revert")
async def post_round_revert(req: RoundRevertRequest):
    """整轮撤回：还原本轮写端点改过的文件。现场对不上的一律跳过并在 data.skipped 里回报。"""
    project_dir = _round_project(req.project)
    if project_dir is None:
        return {"code": 1, "message": "未打开项目"}
    result = round_snapshots.revert(project_dir, req.run_id)
    if not result.get("ok"):
        return {"code": 1, "message": result.get("reason") or "撤回失败", "data": result}
    return {"code": 0, "data": result, "message": "ok"}


# ── Better Project Understanding：项目扫描 ─────

class ScanRequest(BaseModel):
    level: str = "balanced"  # brief | balanced | detailed
    project: str = ""


# 三档扫描预算（写死）：目录深度 / 树条目上限 / 精读文件数 / 每文件行数
SCAN_LEVELS = {
    "brief":    {"depth": 2, "scan_depth": 5, "max_tree": 300,  "max_files": 6,  "head_lines": 40},
    "balanced": {"depth": 3, "scan_depth": 7, "max_tree": 600,  "max_files": 16, "head_lines": 70},
    "detailed": {"depth": 5, "scan_depth": 9, "max_tree": 1200, "max_files": 36, "head_lines": 110},
}

KEY_NAMES = {
    "readme.md", "readme", "readme.txt", "readme.rst",
    "package.json", "requirements.txt", "pyproject.toml", "setup.py", "setup.cfg",
    "cargo.toml", "go.mod", "pom.xml", "build.gradle", "makefile", "cmakelists.txt",
    "dockerfile", "docker-compose.yml", "docker-compose.yaml", ".env.example",
    "rules.md", "qoder.md", "constitution.json", "slate.spec",
    "tsconfig.json", "vite.config.js", "vite.config.ts", "webpack.config.js",
    "index.html", "main.py", "app.py", "desktop.py", "main.js", "app.js", "index.js",
}

KEY_PATH_PARTS = (
    "frontend/js/components",
    "frontend/js/services",
    "frontend/js/store",
    "backend/routers",
    "backend/skills",
    "scripts",
)

UNDERSTAND_PATH_HINTS = (
    "understand",
    "project_bar",
    "projects.py",
    "i18n",
    "markdown",
    "api.js",
    "store.js",
)


def _file_priority(rel: str, name: str, ext: str) -> int:
    """精读优先级：越小越重要"""
    low = name.lower()
    rel_low = rel.lower()
    if rel_low.endswith("frontend/js/components/understand.js"):
        return 0
    if rel_low.endswith("backend/routers/projects.py"):
        return 1
    if low.startswith("readme"):
        return 2
    if any(hint in rel_low for hint in UNDERSTAND_PATH_HINTS):
        return 3
    if low in KEY_NAMES:
        return 4
    if any(part in rel_low for part in KEY_PATH_PARTS):
        return 5
    if ext in (".md", ".json", ".toml", ".yaml", ".yml", ".cfg", ".ini"):
        return 6
    if ext in TEXT_EXTS or low in TEXT_NAMES:
        return 7
    return 9


@router.post("/understand/scan")
async def scan_project(req: ScanRequest):
    """全量扫描项目：目录树 + 关键文件头部内容，供 AI 生成导览与规则"""
    info = _resolve_project(req.project)
    if not info:
        return {"code": 1, "message": "未打开项目"}
    budget = SCAN_LEVELS.get(req.level, SCAN_LEVELS["balanced"])
    project_dir = Path(info["path"])

    tree_lines: list[str] = []
    files: list[tuple[str, str, str, int]] = []  # (rel, name, ext, size)
    truncated = False

    def walk(d: Path, depth: int, prefix: str) -> None:
        nonlocal truncated
        if depth > budget["scan_depth"]:
            return
        try:
            entries = sorted(d.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
        except OSError:
            return
        visible = [
            e for e in entries
            if not _is_ignored_project_entry(e)
        ]
        emit_tree = depth <= budget["depth"]
        for i, entry in enumerate(visible):
            last = i == len(visible) - 1
            next_prefix = prefix
            if emit_tree and len(tree_lines) < budget["max_tree"]:
                branch = "└─ " if last else "├─ "
                tree_lines.append(f"{prefix}{branch}{entry.name}{'/' if entry.is_dir() else ''}")
                next_prefix = prefix + ("   " if last else "│  ")
            elif emit_tree:
                truncated = True

            if entry.is_dir():
                walk(entry, depth + 1, next_prefix)
            elif entry.is_file():
                size = _safe_file_size(entry) or 0
                if size <= 2 * 1024 * 1024:  # 跳过超大文件
                    files.append(
                        (entry.relative_to(project_dir).as_posix(), entry.name, entry.suffix.lower(), size)
                    )

    tree_lines.append(project_dir.name + "/")
    walk(project_dir, 1, "")

    # 按优先级选出精读文件；同等优先级下短路径优先，避免深层生成物挤掉入口文件。
    files.sort(key=lambda f: (_file_priority(f[0], f[1], f[2]), len(f[0]), f[0]))
    heads: list[dict] = []
    for rel, name, ext, size in files:
        if len(heads) >= budget["max_files"]:
            break
        if ext not in TEXT_EXTS and name.lower() not in TEXT_NAMES:
            continue
        try:
            content = (project_dir / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = content.splitlines()
        head_lines = budget["head_lines"]
        head = "\n".join(lines[:head_lines])
        truncated_head = len(lines) > head_lines
        if truncated_head:
            head += f"\n…（共 {len(lines)} 行，已截取开头）"
        heads.append({
            "path": rel,
            "content": head[:6000],
            "size": size,
            "lines": len(lines),
            "head_lines": min(len(lines), head_lines),
            "truncated": truncated_head or len(head) > 6000,
        })

    return {
        "code": 0,
        "data": {
            "project": info["name"],
            "level": req.level if req.level in SCAN_LEVELS else "balanced",
            "tree": "\n".join(tree_lines),
            "truncated": truncated,
            "total_files": len(files),
            "heads": heads,
        },
    }
