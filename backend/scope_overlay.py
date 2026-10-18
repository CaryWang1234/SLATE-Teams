"""分项目作用域覆盖（P4）：全局一份 + 项目覆盖一份，生效值现算。

口径照 `effectiveConstitution()`：项目里那份存在就用它，删掉自动回落全局，
两份各存各的落点，谁也不覆写谁。三样东西的覆盖粒度按各自的形态定：

  · Actions——**同 id 覆盖**：`<项目>/.slate/actions/<id>.yml` 顶掉
    `data/actions/<id>.yml`，其余全局项照常在册。流程说明书跟着代码走，
    把仓库交给同事还在，这是它该进 `.slate/` 的理由。
  · 知识库——**同 title 覆盖 + 合并优先**：项目自己那批文档排在前面并顶掉同名的
    全局文档，但全局语料不会因为"项目有文档"就整体失效。知识库是攒下来的数据，
    不是配置，屏蔽掉等于让用户的东西凭空消失；bulk 数据也存在 data/ 里，不进用户仓库。
  · MCP——**掩码覆盖**：项目里只记 `{服务器 id: {enabled, tools}}`，
    URL 与密钥绝不落进用户目录（那是 `data/mcp_servers.json` 的事），
    删掉掩码即回到全局的 enabled。

`project_id` 为空＝没在项目视野里，三份都直接返回全局那一份。注册表坏了、
目录搬走了都按"没有覆盖"处理：宁可多用一次全局默认，也不能因为覆盖读不到就
把整个面板打不开。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from backend import project_registry as registry

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
GLOBAL_ACTIONS_DIR = DATA_DIR / "actions"


def _contained(base: Path, target: Path) -> Path | None:
    """target 解析后必须仍在 base 里，挡住 `../` 与符号链接外逃。"""
    try:
        real_base = base.resolve()
        real = target.resolve()
    except OSError:
        return None
    return real if real == real_base or real_base in real.parents else None


def host_dir_of(project_id: Any) -> Path | None:
    """在册项目的宿主目录；不在册、或目录已经不在了，返回 None（不猜、不重建）。

    按 find_entry 找回而不是只认 id：前端手上的身份可能是别名（目录搬过一次，
    旧 id 记在 aliases 里），按 id 直查会把同一个项目认成"没覆盖"。
    """
    text = str(project_id or "").strip()
    if not text:
        return None
    entry = registry.find_entry(registry.load_registry(), text)
    if not entry or not entry.get("path"):
        return None
    host = Path(str(entry["path"]))
    return host if host.is_dir() else None


def slate_dir_of(project_id: Any) -> Path | None:
    host = host_dir_of(project_id)
    return host / ".slate" if host else None


def project_actions_dir(project_id: Any) -> Path | None:
    """<项目>/.slate/actions —— 只在项目在册时存在。"""
    slate = slate_dir_of(project_id)
    return slate / "actions" if slate else None


def read_slate_config(project_id: Any) -> dict[str, Any]:
    host = host_dir_of(project_id)
    if not host:
        return {}
    path = host / ".slate" / "config.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def mcp_mask_of(project_id: Any) -> dict[str, Any]:
    """项目的 MCP 掩码：`{"<server id>": {"enabled": bool, "tools": [名字]}}`。

    空字典＝没有覆盖，调用方按全局 enabled 走。写错了形状（不是 dict）也按没有覆盖处理，
    宁可用全局默认，也不能拿一份读不懂的掩码去把用户连好的服务器全关掉。
    """
    raw = read_slate_config(project_id).get("mcp")
    if not isinstance(raw, dict):
        return {}
    servers = raw.get("servers")
    if not isinstance(servers, dict):
        return {}
    return {str(k): v for k, v in servers.items() if isinstance(v, dict)}


def server_enabled(project_id: Any, server_id: str, default: bool = True) -> bool:
    entry = mcp_mask_of(project_id).get(str(server_id or ""))
    if not entry:
        return default
    value = entry.get("enabled")
    return default if value is None else bool(value)


def tool_allowed(project_id: Any, server_id: str, tool_name: str) -> bool:
    """白名单缺省＝全放行：只有项目明确写了 tools 列表才收窄。"""
    entry = mcp_mask_of(project_id).get(str(server_id or "")) or {}
    tools = entry.get("tools")
    if not isinstance(tools, list) or not tools:
        return True
    return str(tool_name or "") in {str(t) for t in tools}


def effective_action_files(project_id: Any) -> list[tuple[str, Path, str]]:
    """返回 [(文件名消毒后的 id, 路径, 落点 global|project)]，项目版排在同名全局版之前。

    同名只留一条：全局那份此时不进目录，用户看到的"这一份从哪来"就是这里定的。
    """
    out: list[tuple[str, Path, str]] = []
    seen: set[str] = set()

    local = project_actions_dir(project_id)
    if local and local.is_dir():
        for entry in sorted(local.glob("*.yml")):
            contained = _contained(local, entry)
            if not contained:
                continue
            name = entry.stem
            out.append((name, contained, "project"))
            seen.add(name)

    if GLOBAL_ACTIONS_DIR.is_dir():
        for entry in sorted(GLOBAL_ACTIONS_DIR.glob("*.yml")):
            contained = _contained(GLOBAL_ACTIONS_DIR, entry)
            if not contained:
                continue
            name = entry.stem
            if name in seen:
                continue
            out.append((name, contained, "global"))
            seen.add(name)
    return out


def action_target_path(project_id: Any, clean_id: str, scope: str) -> Path | None:
    """写入落点：scope=project 必须项目在册，否则 None（调用方回错误，不许偷偷写到全局去）。"""
    if not clean_id:
        return None
    if scope == "project":
        base = project_actions_dir(project_id)
        if not base:
            return None
        return _contained(base, base / f"{clean_id}.yml")
    return _contained(GLOBAL_ACTIONS_DIR, GLOBAL_ACTIONS_DIR / f"{clean_id}.yml")


def action_scope_of(project_id: Any, clean_id: str) -> str:
    """这一份 Action 当前生效的是哪一份：有项目版就是 project。"""
    base = project_actions_dir(project_id)
    if base and clean_id and (base / f"{clean_id}.yml").is_file():
        return "project"
    return "global"


def canonical_project_id(project_id: Any) -> str:
    """归成注册表里那条记录的主 id（别名并进来）。

    知识库的归属要写进库：按别名原样存的话，目录搬过一次之后同一项目的文档会散成两堆，
    检索时按主 id 过滤就再也找不到它们。读不到在册记录时原样返回（无项目视野＝空串）。
    """
    text = str(project_id or "").strip()
    if not text:
        return ""
    entry = registry.find_entry(registry.load_registry(), text)
    return str(entry["id"]) if entry and entry.get("id") else text


def set_server_mask(project_id: Any, server_id: str, mask: dict[str, Any] | None) -> bool:
    """写项目对某台 MCP 服务器的掩码；mask=None 表示摘掉这一项（回到跟全局）。

    只改 `mcp.servers.<id>` 那一格，其余配置原样留着：`.slate/config.json` 里还住着
    宪法和工作区成员，整份覆盖写下去会把别人写的东西抹掉。
    """
    host = host_dir_of(project_id)
    if not host or not server_id:
        return False
    config = read_slate_config(project_id)
    mcp = config.get("mcp") if isinstance(config.get("mcp"), dict) else {}
    servers = mcp.get("servers") if isinstance(mcp.get("servers"), dict) else {}
    key = str(server_id)
    if mask is None:
        servers.pop(key, None)
    else:
        servers[key] = mask
    mcp["servers"] = servers
    config["mcp"] = mcp
    from backend.data_io import atomic_write_json   # 就地引：避免模块级循环依赖
    try:
        slate = host / ".slate"
        slate.mkdir(parents=True, exist_ok=True)
        atomic_write_json(slate / "config.json", config)
    except OSError:
        return False
    return True
