"""技能路由：内置工具 + SKILL.md 技能，支持执行、上传与本地导入。

通用插件适配：支持 SKILL.md 开放标准（Codex CLI / Claude Code / Cursor 等）。
标准 MCP 协议端点见 backend/routers/mcp.py（JSON-RPC 2.0）。
"""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from backend import evolution
from backend.skills import plugin_adapter
from backend.skills.call_ctx import CallCancelled, CallContext
from backend.skills.sandbox import validate_skill_params, sanitize_param, MAX_PARAM_LENGTH

router = APIRouter(prefix="/skills", tags=["skills"])
logger = logging.getLogger(__name__)

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"
DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
USER_SKILLS_DIR = DATA_DIR / "skills"

# 内置工具注册表（原"MCP 工具"，现统一称"工具"）
BUILTIN_SKILLS: dict[str, str] = {
    "file_tree": "扫描目录树（支持递归、glob 过滤、快速模式）",
    "file_peek": "读取文件内容（支持多编码 gbk/gb2312、行范围、tail 模式、自动检测编码）",
    "terminal": "终端会话：支持多会话管理、状态保持（cd / $env: 跨命令保持）、进程管理，高危命令双层拦截；Windows 每条命令一个 PowerShell 进程，多行块与 &&/|| 均可用",
    "bg_task": "后台终端任务：用于长耗时命令（实验服务器、编译、训练），不占用对话。start 启动后立即返回，模型无需轮询；status/log/list 按需查看输出与状态（log 带 since_offset 仅取新增）；stop 终止整棵进程树；trigger 可挂接事件（on=exit 结束 / on=match 命中正则），配 notify=true 时命中即回传消息唤醒模型，中间不输出以节省 token",
    "html_render": "生成纯黑白 HTML 骨架",
    "css_color": "基于描述生成 CSS 配色方案（支持暖色/冷色/自然/深色等多种风格）",
    "doc_write": "生成 Markdown 格式技术文档或需求说明",
    "ppt_create": "生成 .pptx 演示文稿（标题页+内容页，支持主题大纲与自定义配色）",
    "word_create": "生成 .docx Word 文档（标题层级、段落、列表排版）",
    "file_edit": "文件编辑（view 带行号查看 / replace 精确唯一替换 / edit diff / read / insert / delete / copy / paste / cut）",
    "file_create": "创建新文件（预览后确认写入）",
    "code_search": "全局代码搜索：在当前项目中按文本/正则搜索（类似 Ctrl+Shift+F，默认全局=项目根，scope 可缩小到子目录）",
    "text_summarize": "文本摘要与关键词提取",
    "json_tool": "JSON 校验、格式化、压缩与路径读取",
    "regex_test": "正则表达式测试与匹配结果预览",
    "repo_stats": "项目文件类型、体积与数量统计",
    "todo_scan": "扫描项目中的 TODO/FIXME/待办标记",
    "web_search": "网络搜索/网页抓取，获取实时信息（免 Key，Bing + DuckDuckGo 双引擎）",
    "web_fetch": "获取指定网页内容：提取标题/描述/正文，支持 JS 渲染与 PDF（免 Key 直连）",
    "chart_create": "生成 SVG 图表（柱状/条形/折线/饼图），零依赖纯 Python，返回文件路径与预览链接",
    "qrcode_create": "生成 SVG 二维码（文本或 URL），返回文件路径与预览链接",
    "python_api_extract": "提取 Python 库/模块的公共 API 文档（函数签名、类方法、属性），输出 JSON/Markdown",
    "html_bundle": "将 html 及相对路径的 css/js 内联合并为单个 html 文件（便携分发）",
    "code_scan": "代码安全扫描（检测硬编码密钥/SQL注入/XSS/弱加密/调试残留等）",
    "doc_scan": "文档安全扫描（检测文档中的 PII/凭证/财务数据/机密标记/内网信息等，支持 md/docx/pptx/xlsx/pdf）",
    "mcp_factory": "工具工厂：根据描述自动生成新工具，产物存放于 data/evolved/（可在「扩展 → 新功能」停用/回滚/撤销），让 SLATE 自行生产适配自身的工具",
    "system_info": "系统元认知：获取本机日期时间、CPU/内存/GPU/存储配置、电池电量、网络连接状态",
    "browser_automation": "浏览器自动化：基于 Playwright 控制 Chromium 浏览器（导航/截图/点击/输入/执行JS）",
    "computer_use": "桌面自动化：基于 pyautogui 控制鼠标键盘与窗口（快速截图/点击/输入/按键/剪贴板/窗口管理/图像定位）",
    "excel_tool": "Excel/CSV 办公表格：生成 .xlsx、读取表格内容、csv↔xlsx 互转",
    "pdf_tool": "PDF 办公文档：获取元信息、提取文本内容与表格数据",
    "git_tool": "Git 仓库只读信息：分支状态/提交日志/diff 统计/分支与远程列表",
    "screenshot_to_code": "截图转代码：读取图片编码为 base64，AI 视觉分析生成 HTML/CSS 还原截图内容",
    "image_gen": "AI 图片生成：基于描述生成图片（OpenAI 兼容 images/generations，需在设置中配置模型与 API Key），返回本地文件与预览链接",
    "video_gen": "AI 视频生成：基于描述生成短视频（OpenAI 兼容 /videos/generations，支持同步返回或异步任务轮询，需在设置中配置模型与 API Key），返回本地文件与预览链接",
}


def _list_md_skills() -> dict[str, str]:
    """扫描 SKILL.md 组成的自定义技能。"""
    custom_skills: dict[str, str] = {}
    if USER_SKILLS_DIR.is_dir():
        for skill_md in USER_SKILLS_DIR.glob("*/SKILL.md"):
            skill_name = skill_md.parent.name
            try:
                text = skill_md.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                text = ""
            # 提取 description 字段作为描述
            desc = skill_name
            for line in text.split("\n"):
                stripped = line.strip()
                if stripped.startswith("description:"):
                    desc = stripped.split(":", 1)[1].strip()
                    break
            custom_skills[skill_name] = desc
    return custom_skills


@router.get("")
async def list_skills(project: str = "") -> dict[str, Any]:
    """列出所有可用能力：内置工具 + 自进化工具 + SKILL.md 技能 + 远程 MCP 工具。

    带 project 时远程那部分按该项目的掩码收窄——面板上看不见的工具，注入给模型的
    schema 里也不该有。

    自进化那份单独给一个 key，不并进 mcp：模型目录里要分清"程序自带的"与"自己长出来的"，
    后者用户能停用、能回滚、能撤销，混进内置就再也找不回来。
    """
    from backend import mcp_client
    remote_tools = mcp_client.get_all_remote_tools(project)
    remote_dict: dict[str, str] = {}
    for t in remote_tools:
        # 远程工具名称加 server 前缀防止冲突
        key = f"mcp__{t['serverId']}__{t['name']}"
        remote_dict[key] = f"[MCP:{t['server']}] {t['description']}"
    return {
        "code": 0,
        "data": {
            "mcp": BUILTIN_SKILLS,
            "evolved": evolution.catalog(),
            "skills": _list_md_skills(),
            "remote": remote_dict,
            "remoteTools": remote_tools,
        },
        "message": "ok",
    }


@router.post("/execute")
async def execute_skill(body: dict[str, Any]) -> dict[str, Any]:
    """执行指定技能。"""
    skill_name = body.get("skill", "")
    params = body.get("params", {})

    # 参数大小限制（防止恶意超大参数撑爆内存）
    param_error = validate_skill_params(params)
    if param_error:
        return {"code": -1, "data": None, "message": param_error}

    # 查找内置技能
    if skill_name in BUILTIN_SKILLS:
        try:
            module = importlib.import_module(f"backend.skills.{skill_name}")
        except ImportError:
            return {"code": -1, "data": None, "message": f"技能模块 {skill_name} 加载失败"}

        if not hasattr(module, "execute"):
            return {"code": -1, "data": None, "message": f"技能 {skill_name} 缺少 execute 函数"}

        try:
            result = await run_in_threadpool(module.execute, **params)
            return {"code": 0, "data": result, "message": "ok"}
        except Exception as e:
            return {"code": -1, "data": None, "message": f"技能执行失败: {e}"}

    # 自进化工具（data/evolved/）：内置那条路已经先走过，同名时内置赢
    clean_evolved = evolution.clean_name(skill_name)
    if clean_evolved and evolution.read_manifest(clean_evolved):
        module, load_error = evolution.load_module(clean_evolved)
        if module is None:
            return {"code": -1, "data": None, "message": load_error}
        try:
            result = await run_in_threadpool(module.execute, **params)
            return {"code": 0, "data": result, "message": "ok"}
        except Exception as e:
            return {"code": -1, "data": None, "message": f"技能执行失败: {e}"}

    # 查找自定义技能（技能名先消毒，防止目录穿越读取任意 SKILL.md）
    clean_skill = _sanitize_skill_name(skill_name)
    if not clean_skill or clean_skill != skill_name:
        return {"code": -1, "data": None, "message": f"无效的技能名称: {skill_name}"}
    custom_skill_dir = USER_SKILLS_DIR / clean_skill
    if custom_skill_dir.is_dir():
        skill_md = custom_skill_dir / "SKILL.md"
        if skill_md.is_file():
            content = skill_md.read_text(encoding="utf-8")
            return {
                "code": 0,
                "data": {"type": "custom_skill", "content": content},
                "message": "ok",
            }

    # 查找远程 MCP 工具（格式: mcp__serverId__toolName）
    if skill_name.startswith("mcp__"):
        parts = skill_name.split("__", 2)
        if len(parts) == 3:
            from backend import mcp_client
            server_id, tool_name = parts[1], parts[2]
            result = await mcp_client.call_remote_tool(server_id, tool_name, params, str(body.get("project") or ""))
            if "error" in result:
                return {"code": -1, "data": None, "message": result["error"]}
            return {"code": 0, "data": result, "message": "ok"}
        return {"code": -1, "data": None, "message": f"无效的远程工具名称: {skill_name}"}

    return {"code": -1, "data": None, "message": f"未知技能: {skill_name}"}


_STREAM_POLL_S = 0.25  # 断连探测节律（关流即取消的落地方式）
_CANCEL_GRACE_S = 1.0  # 关流后等待已接入工具吐出终态帧的上限


def _sse_frame(envelope: dict[str, Any]) -> str:
    return f"data: {json.dumps(envelope, ensure_ascii=False, default=str)}\n\n"


def _resolve_stream_target(skill_name: str, params: dict[str, Any]) -> tuple[str, Any, str]:
    """定位执行体。返回 (kind, target, error)，kind ∈ builtin / custom / mcp / ''。

    自进化工具也按 builtin 这条路回（都是"一个带 execute 的模块"），区别只在装载方式：
    前者从 data/evolved/ 按文件装载，后者从源码树 import。分流写在下面，装载失败
    必须原样回原因——"停用中"与"代码有语法错"对用户是两件完全不同的事。
    """
    if skill_name in BUILTIN_SKILLS:
        try:
            module = importlib.import_module(f"backend.skills.{skill_name}")
        except ImportError:
            return "builtin", None, f"技能模块 {skill_name} 加载失败"
        if not hasattr(module, "execute") and not hasattr(module, "run_stream"):
            return "builtin", None, f"技能 {skill_name} 缺少 execute 函数"
        return "builtin", module, ""

    clean_evolved = evolution.clean_name(skill_name)
    if clean_evolved and evolution.read_manifest(clean_evolved):
        module, load_error = evolution.load_module(clean_evolved)
        if module is None:
            return "builtin", None, load_error
        return "builtin", module, ""

    if skill_name.startswith("mcp__"):
        parts = skill_name.split("__", 2)
        if len(parts) != 3:
            return "mcp", None, f"无效的远程工具名称: {skill_name}"
        return "mcp", (parts[1], parts[2]), ""

    clean_skill = _sanitize_skill_name(skill_name)
    if not clean_skill or clean_skill != skill_name:
        return "", None, f"无效的技能名称: {skill_name}"
    skill_md = USER_SKILLS_DIR / clean_skill / "SKILL.md"
    if skill_md.is_file():
        return "custom", skill_md, ""
    return "", None, f"未知技能: {skill_name}"


@router.post("/stream")
async def stream_skill(request: Request, body: dict[str, Any]) -> Any:
    """砚流·一笔一流：执行一个技能并把进度/输出流式回传。

    取消通道：客户端关闭本响应流 == 取消该笔调用（§4.6）。ASGI 侧的断连被桥接成
    ctx.cancelled，由已接入 run_stream 的工具在循环里自行退出（terminal 会 kill 子进程）。
    /execute 原样保留，两者最终帧载荷同形（{code, data, message}）。
    """
    skill_name = str(body.get("skill", "") or "")
    params = body.get("params", {}) or {}
    if not isinstance(params, dict):
        params = {}
    call_id = str(body.get("callId") or f"cal_{uuid.uuid4().hex[:8]}")
    run_id = str(body.get("runId") or "")
    # 远程 MCP 工具要按这一场所属项目的掩码复验；不传就是没有项目视野，全放行。
    project_id = str(body.get("project") or "")

    param_error = validate_skill_params(params)
    kind, target, resolve_error = ("", None, "")
    if not param_error:
        kind, target, resolve_error = _resolve_stream_target(skill_name, params)
        param_error = resolve_error

    def _envelope(seq: int, event_type: str, data: dict[str, Any]) -> dict[str, Any]:
        return {
            "v": 1,
            "seq": seq,
            "ts": int(time.time() * 1000),
            "runId": run_id or None,
            "callId": call_id,
            "parentCallId": None,
            "type": event_type,
            "data": data,
        }

    async def _failure_stream(message: str) -> Any:
        yield _sse_frame(_envelope(1, "call.error", {"code": "bad_request", "message": message, "retryable": False}))
        yield "data: [DONE]\n\n"

    if param_error:
        return StreamingResponse(_failure_stream(param_error), media_type="text/event-stream")

    async def _invoke(ctx: CallContext) -> dict[str, Any]:
        """返回与 /execute 完全同形的结果信封。"""
        if kind == "builtin":
            runner = getattr(target, "run_stream", None)
            try:
                if runner is not None:
                    result = await run_in_threadpool(runner, ctx, **params)
                else:
                    result = await run_in_threadpool(target.execute, **params)
                return {"code": 0, "data": result, "message": "ok"}
            except CallCancelled:
                raise
            except Exception as e:  # noqa: BLE001 - 与 /execute 一致的兜底文案
                return {"code": -1, "data": None, "message": f"技能执行失败: {e}"}

        if kind == "mcp":
            from backend import mcp_client

            server_id, tool_name = target
            result = await mcp_client.call_remote_tool(server_id, tool_name, params, project_id)
            if "error" in result:
                return {"code": -1, "data": None, "message": result["error"]}
            return {"code": 0, "data": result, "message": "ok"}

        content = target.read_text(encoding="utf-8")
        return {"code": 0, "data": {"type": "custom_skill", "content": content}, "message": "ok"}

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def _emit(event_type: str, data: dict[str, Any]) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, ("event", (event_type, data)))

    ctx = CallContext(call_id, _emit)
    if kind == "mcp":
        fidelity = "FX"
    elif kind == "builtin" and getattr(target, "run_stream", None) is not None:
        fidelity = "F2"
    else:
        fidelity = "F1"

    async def _generate() -> Any:
        seq = 0

        def frame(event_type: str, data: dict[str, Any]) -> str:
            nonlocal seq
            seq += 1
            return _sse_frame(_envelope(seq, event_type, data))

        async def _worker() -> None:
            """将终态与 ctx 事件排在同一条 FIFO 通道上，保证终帧最后到达。"""
            try:
                payload = await _invoke(ctx)
            except CallCancelled:
                await queue.put(("cancelled", None))
                return
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - 兜底，不让任务异常静默
                await queue.put(("result", {"code": -1, "data": None, "message": f"技能执行失败: {e}"}))
                return
            await queue.put(("result", payload))

        yield frame("call.started", {
            "invocationId": call_id,
            "endpoint": "skill",
            "skill": skill_name,
            "fidelity": fidelity,
        })

        task = asyncio.ensure_future(_worker())
        result: dict[str, Any] | None = None
        cancelled_by_tool = False

        try:
            while True:
                try:
                    tag, payload = await asyncio.wait_for(queue.get(), timeout=_STREAM_POLL_S)
                except asyncio.TimeoutError:
                    if not await request.is_disconnected():
                        continue
                    ctx.cancel()
                    # §4.5 规则 1：先到终态者胜。结果可能已经产出，
                    # 不因关流而隐瞒已经发生的副作用。
                    try:
                        await asyncio.wait_for(asyncio.shield(task), timeout=_CANCEL_GRACE_S)
                    except (asyncio.TimeoutError, TimeoutError):
                        pass
                    except Exception as e:  # noqa: BLE001 - 终帧仍按已入队内容处理
                        logger.warning(f"[skills/stream] 终态等待异常 {call_id}: {e}")
                    while not queue.empty():
                        tag2, payload2 = queue.get_nowait()
                        if tag2 == "result":
                            result = payload2
                        elif tag2 == "cancelled":
                            cancelled_by_tool = True
                        else:
                            yield frame(*payload2)
                    break
                if tag == "result":
                    result = payload
                    break
                if tag == "cancelled":
                    cancelled_by_tool = True
                    break
                yield frame(*payload)
        except asyncio.CancelledError:
            ctx.cancel()
            task.cancel()
            raise
        finally:
            ctx.cancel()
            task.cancel()

        if result is not None:
            status = "done" if result.get("code") == 0 else "error"
            yield frame("call.finished" if status == "done" else "call.error", {
                "status": status,
                "result": result,
                "durationMs": ctx.duration_ms,
                "fidelity": fidelity,
            })
        elif cancelled_by_tool:
            yield frame("call.cancelled", {"by": "tool", "durationMs": ctx.duration_ms, "fidelity": fidelity})
        else:
            yield frame("call.cancelled", {"by": "user", "durationMs": ctx.duration_ms, "fidelity": fidelity})
        yield "data: [DONE]\n\n"

    return StreamingResponse(_generate(), media_type="text/event-stream")


@router.post("/upload")
async def upload_skill(
    files: list[UploadFile] = File(...),
    skill_name: str = "",
    skill_desc: str = "",
) -> dict[str, Any]:
    """上传自定义技能文件。"""
    clean_name = _sanitize_skill_name(skill_name)
    if not clean_name or clean_name != skill_name:
        return {"code": -1, "data": None, "message": "技能名称包含非法字符"}
    skill_name = clean_name

    skill_dir = USER_SKILLS_DIR / skill_name
    skill_dir.mkdir(parents=True, exist_ok=True)

    saved_files = []
    for f in files:
        # 文件名消毒：去除路径分隔符和特殊字符
        safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', f.filename or 'unnamed')
        safe_name = safe_name.strip('. ')  # 去除首尾点和空格
        if not safe_name:
            safe_name = 'unnamed'
        dest = skill_dir / safe_name
        content = await f.read()
        # 上传文件大小限制（5MB）
        if len(content) > 5 * 1024 * 1024:
            return {"code": -1, "data": None, "message": f"文件 {safe_name} 过大（最大 5MB）"}
        dest.write_bytes(content)
        saved_files.append(safe_name)

    # 如果没有 SKILL.md，自动生成一个
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        skill_md.write_text(
            f"# {skill_name}\n\ndescription: {skill_desc or skill_name}\n",
            encoding="utf-8",
        )

    return {
        "code": 0,
        "data": {"skill": skill_name, "files": saved_files},
        "message": "ok",
    }


class ImportSkillRequest(BaseModel):
    path: str
    name: str = ""


def _sanitize_skill_name(name: str) -> str:
    """技能名只保留安全字符，防止路径穿越。"""
    cleaned = re.sub(r"[^\w\u4e00-\u9fff.-]", "-", name.strip()).strip(".")
    return cleaned[:64]


@router.post("/import")
async def import_skill(req: ImportSkillRequest) -> dict[str, Any]:
    """从本地路径导入 SKILL.md 技能。

    支持两种形式：
    1. 目录：目录内必须包含 SKILL.md，整个目录被复制导入
    2. 单个 .md 文件：以文件名（或指定 name）建立技能目录
    """
    src = Path(os.path.expanduser(req.path.strip()))
    if not src.exists():
        return {"code": 1, "message": f"路径不存在: {req.path}"}

    try:
        if src.is_dir():
            skill_md = src / "SKILL.md"
            if not skill_md.is_file():
                return {"code": 1, "message": "目录中未找到 SKILL.md，无法导入"}
            skill_name = _sanitize_skill_name(req.name or src.name)
            if not skill_name:
                return {"code": 1, "message": "无效的技能名称"}
            dest = USER_SKILLS_DIR / skill_name
            USER_SKILLS_DIR.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(src.resolve(), dest)
            file_count = sum(1 for _ in dest.rglob("*") if _.is_file())
        else:
            if src.suffix.lower() not in (".md", ".markdown"):
                return {"code": 1, "message": "单文件导入仅支持 .md 文件"}
            default_name = src.stem if src.name.lower() != "skill.md" else src.parent.name
            skill_name = _sanitize_skill_name(req.name or default_name)
            if not skill_name:
                return {"code": 1, "message": "无效的技能名称"}
            dest = USER_SKILLS_DIR / skill_name
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src.resolve(), dest / "SKILL.md")
            file_count = 1
    except OSError as e:
        return {"code": 1, "message": f"导入失败: {e}"}

    return {
        "code": 0,
        "data": {"skill": skill_name, "files": file_count, "path": str(dest)},
        "message": "ok",
    }


@router.delete("/{skill_name}")
async def delete_skill(skill_name: str) -> dict[str, Any]:
    """删除自定义 SKILL.md 技能（不影响内置工具）。"""
    clean = _sanitize_skill_name(skill_name)
    if clean != skill_name or not clean:
        return {"code": 1, "message": "无效的技能名称"}
    target = USER_SKILLS_DIR / clean
    if not target.is_dir():
        return {"code": 1, "message": f"技能不存在: {skill_name}"}
    try:
        shutil.rmtree(target)
    except OSError as e:
        return {"code": 1, "message": f"删除失败: {e}"}
    return {"code": 0, "data": None, "message": "ok"}


# ── 通用插件适配接口 ─────────────────────────────────

@router.get("/sources")
async def list_sources() -> dict[str, Any]:
    """列出所有可用的技能来源（本地已安装 + Codex 插件）。"""
    sources = plugin_adapter.list_available_sources()
    return {"code": 0, "data": sources, "message": "ok"}


class ImportFromPathRequest(BaseModel):
    path: str
    name: str = ""


@router.post("/import-path")
async def import_from_path(req: ImportFromPathRequest) -> dict[str, Any]:
    """从本地路径导入技能（支持 SKILL.md 或 Codex 插件格式）。"""
    result = plugin_adapter.import_from_path(req.path, USER_SKILLS_DIR, req.name)
    if "error" in result:
        return {"code": 1, "message": result["error"]}
    return {"code": 0, "data": result, "message": "ok"}


class ImportFromGithubRequest(BaseModel):
    url: str
    subpath: str = ""


@router.post("/import-github")
async def import_from_github(req: ImportFromGithubRequest) -> dict[str, Any]:
    """从 GitHub 仓库导入技能。"""
    result = plugin_adapter.import_from_github(req.url, USER_SKILLS_DIR, req.subpath)
    if "error" in result:
        return {"code": 1, "message": result["error"]}
    return {"code": 0, "data": result, "message": "ok"}
