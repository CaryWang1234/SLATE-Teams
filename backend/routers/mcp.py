"""标准 MCP（Model Context Protocol）协议端点。

实现 JSON-RPC 2.0 + tools/list + tools/call，
让 SLATE 的内置工具可被任何标准 MCP 客户端调用。

协议规范：https://modelcontextprotocol.io
"""

from __future__ import annotations

import importlib
import inspect
import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix="/mcp", tags=["mcp"])

# ── MCP 协议版本 ──────────────────────────────────────────────
MCP_PROTOCOL_VERSION = "2024-11-05"
MCP_SERVER_INFO = {
    "name": "SLATE",
    "version": "1.0.0",
}


# ── 工具 JSON Schema 定义（供标准 MCP 客户端使用） ──────────────

_TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    "file_tree": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "directory": {"type": "string", "description": "目录路径"},
                "recursive": {"type": "boolean", "description": "是否递归扫描（默认 false）"},
                "depth": {"type": "integer", "description": "递归深度（默认 1）"},
                "pattern": {"type": "string", "description": "glob 模式过滤（如 '*.py'）"},
                "include_hidden": {"type": "boolean", "description": "是否包含隐藏文件（默认 false）"},
            },
        },
    },
    "file_peek": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "文件路径"},
                "lines": {"type": "integer", "description": "读取行数（默认 30，上限 50）"},
                "encoding": {"type": "string", "description": "文件编码（如 'utf-8', 'utf-8-sig', 'gb18030', 'gbk', 'utf-16'）"},
                "auto_detect": {"type": "boolean", "description": "是否自动检测编码"},
                "start_line": {"type": "integer", "description": "起始行号（1-based）"},
                "end_line": {"type": "integer", "description": "结束行号（1-based）"},
                "tail": {"type": "boolean", "description": "是否读取最后 N 行"},
                "fast": {"type": "boolean", "description": "快速模式（不统计总行数）"},
            },
            "required": ["file_path"],
        },
    },
    "file_create": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "新文件路径"},
                "content": {"type": "string", "description": "文件内容"},
            },
            "required": ["file_path", "content"],
        },
    },
    "file_edit": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "目标文件路径"},
                "action": {"type": "string", "description": "操作类型: view/replace/edit/replace_range/read/insert/delete/copy/paste/cut"},
                "edits": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "old_text": {"type": "string"},
                            "new_text": {"type": "string"},
                        },
                    },
                    "description": "编辑列表（edit 操作），每项含 old_text 和 new_text",
                },
                "content": {"type": "string", "description": "要插入或替换的内容（insert/replace_range 操作）"},
                "old_str": {"type": "string", "description": "要被替换的精确字符串（replace 操作，必须唯一匹配）"},
                "new_str": {"type": "string", "description": "替换后的新字符串（replace 操作）"},
                "start_line": {"type": "integer", "description": "起始行号（1-based，用于 view/replace_range/insert/delete/copy/paste/cut）"},
                "end_line": {"type": "integer", "description": "结束行号（1-based，用于 view/replace_range/delete/copy/cut）"},
                "clipboard_name": {"type": "string", "description": "剪贴板名称（默认 'default'）"},
                "encoding": {"type": "string", "description": "可选文本编码；留空自动检测并保留原编码，支持中文/emoji 与 BOM"},
            },
        },
    },
    "terminal": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "要执行的命令（action 为空时必填）；终端管道使用 UTF-8，支持中文和 emoji"},
                "work_dir": {"type": "string", "description": "工作目录（创建新会话时使用）"},
                "action": {"type": "string", "description": "操作类型: create 创建会话 / list 列出所有会话 / close 关闭会话 / kill 终止进程 / 空串执行命令"},
                "session_id": {"type": "string", "description": "会话 ID（默认 'default'，可自定义）"},
                "timeout": {"type": "number", "description": "命令超时秒数（默认 30）"},
            },
        },
    },
    "html_render": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "html": {"type": "string", "description": "HTML 内容"},
            },
            "required": ["html"],
        },
    },
    "css_color": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "description": {"type": "string", "description": "配色描述"},
                "style": {"type": "string", "description": "风格: warm/cool/natural/dark"},
            },
            "required": ["description"],
        },
    },
    "doc_write": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "文档标题"},
                "content": {"type": "string", "description": "文档内容（Markdown）"},
            },
            "required": ["title", "content"],
        },
    },
    "ppt_create": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "演示文稿标题"},
                "outline": {"type": "string", "description": "章节大纲（逗号分隔）"},
                "slides": {"type": "array", "description": "精确幻灯片数据"},
                "theme": {"type": "string", "description": "主题色"},
            },
            "required": ["title"],
        },
    },
    "word_create": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "文档标题"},
                "content": {"type": "string", "description": "文档内容"},
            },
            "required": ["title", "content"],
        },
    },
    "text_summarize": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "要摘要的文本"},
            },
            "required": ["text"],
        },
    },
    "json_tool": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "description": "操作: validate/format/compact/read"},
                "text": {"type": "string", "description": "JSON 文本"},
            },
            "required": ["action"],
        },
    },
    "regex_test": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "正则表达式"},
                "text": {"type": "string", "description": "测试文本"},
            },
            "required": ["pattern", "text"],
        },
    },
    "repo_stats": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "directory": {"type": "string", "description": "项目目录"},
            },
            "required": ["directory"],
        },
    },
    "todo_scan": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "directory": {"type": "string", "description": "扫描目录"},
            },
            "required": ["directory"],
        },
    },
    "web_search": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词或 URL"},
                "mode": {"type": "string", "enum": ["search", "fetch"], "description": "search 或 fetch"},
                "max_results": {"type": "integer", "description": "结果数（≤10）"},
                "engine": {"type": "string", "enum": ["auto", "bing", "ddg"], "description": "auto 双引擎合并 / bing / ddg"},
            },
            "required": ["query"],
        },
    },
    "web_fetch": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "网页 URL"},
                "mode": {"type": "string", "enum": ["text", "html"], "description": "text 或 html"},
                "max_chars": {"type": "integer", "description": "内容截断长度（≤60000）"},
                "render_js": {"type": "string", "enum": ["auto", "on", "off"], "description": "JS 渲染降级策略"},
            },
            "required": ["url"],
        },
    },
    "chart_create": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": ["bar", "hbar", "line", "pie"], "description": "图表类型"},
                "data": {"type": "string", "description": "图表数据（JSON 或文本格式）"},
                "title": {"type": "string", "description": "图表标题"},
                "theme": {"type": "string", "description": "配色主题"},
            },
            "required": ["type", "data"],
        },
    },
    "qrcode_create": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "二维码内容"},
                "size": {"type": "integer", "description": "模块像素大小"},
            },
            "required": ["text"],
        },
    },
    "python_api_extract": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {"type": "string", "description": "包名或文件路径"},
                "depth": {"type": "integer", "description": "子模块递归深度"},
                "format": {"type": "string", "enum": ["json", "markdown"], "description": "输出格式"},
            },
            "required": ["target"],
        },
    },
    "html_bundle": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "src": {"type": "string", "description": "源 HTML 文件路径"},
                "out": {"type": "string", "description": "输出路径（可选）"},
            },
            "required": ["src"],
        },
    },
    "code_scan": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "directory": {"type": "string", "description": "扫描目录"},
                "severity": {"type": "string", "description": "严重级别过滤"},
                "category": {"type": "string", "description": "类别过滤"},
            },
            "required": ["directory"],
        },
    },
    "doc_scan": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "directory": {"type": "string", "description": "扫描目录（递归扫描其中的文档文件）"},
                "file_path": {"type": "string", "description": "扫描单个文件（与 directory 二选一）"},
                "severity": {"type": "string", "description": "严重级别过滤 (critical/high/medium/low)"},
                "category": {"type": "string", "description": "类别过滤（如 '身份证号'、'硬编码密码'）"},
                "max_files": {"type": "integer", "description": "最大扫描文件数（默认 50）"},
            },
        },
    },
    "mcp_factory": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "tool_name": {"type": "string", "description": "工具名称（英文）"},
                "description": {"type": "string", "description": "工具描述"},
                "params": {"type": "array", "description": "参数规格 JSON 数组"},
                "body": {"type": "string", "description": "核心逻辑代码"},
                "overwrite": {"type": "boolean", "description": "是否覆盖已有工具"},
            },
            "required": ["tool_name", "description"],
        },
    },
    "browser_automation": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "description": "操作: launch/navigate/screenshot/click/type/get_text/evaluate/scroll/wait/close"},
                "url": {"type": "string", "description": "目标 URL"},
                "selector": {"type": "string", "description": "CSS 选择器"},
                "text": {"type": "string", "description": "输入文字"},
                "expression": {"type": "string", "description": "JS 表达式"},
                "headless": {"type": "boolean", "description": "无头模式"},
                "full_page": {"type": "boolean", "description": "全页截图"},
            },
            "required": ["action"],
        },
    },
    "computer_use": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "description": "操作: screenshot/click/double_click/right_click/type/press/hotkey/scroll/move/drag/wait/position/screen_size/locate/clipboard/window_list/window_focus/window_minimize/window_maximize/window_restore/window_close"},
                "x": {"type": "integer", "description": "X 坐标"},
                "y": {"type": "integer", "description": "Y 坐标"},
                "text": {"type": "string", "description": "输入文字"},
                "keys": {"type": "string", "description": "按键（hotkey 逗号分隔；press 单个键名）"},
                "button": {"type": "string", "description": "鼠标按键"},
                "region": {"type": "string", "description": "截图区域 x,y,w,h"},
                "fast": {"type": "boolean", "description": "快速模式，减少动作间暂停（默认 true）"},
                "screenshot_format": {"type": "string", "description": "截图格式 jpeg/png（默认 jpeg，更快更小）"},
                "quality": {"type": "integer", "description": "JPEG 质量 1-95（默认 80）"},
                "max_width": {"type": "integer", "description": "截图保存前最大宽度，0 为原尺寸"},
                "max_height": {"type": "integer", "description": "截图保存前最大高度，0 为原尺寸"},
                "seconds": {"type": "number", "description": "等待秒数（wait）"},
                "repeats": {"type": "integer", "description": "按键重复次数（press）"},
                "scroll_amount": {"type": "integer", "description": "滚动格数"},
                "image_path": {"type": "string", "description": "参考图片路径"},
                "confidence": {"type": "number", "description": "匹配置信度 0-1"},
                "title": {"type": "string", "description": "窗口标题关键词（window_* 操作，模糊匹配）"},
            },
            "required": ["action"],
        },
    },
    "excel_tool": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "description": "操作: create/read/convert"},
                "file_path": {"type": "string", "description": "源文件路径（read/convert）"},
                "title": {"type": "string", "description": "表格标题（create 文件名）"},
                "sheet": {"type": "string", "description": "工作表名"},
                "headers": {"type": "string", "description": "表头（JSON 数组或逗号分隔）"},
                "rows": {"type": "string", "description": "数据行（JSON 二维数组）"},
                "data": {"type": "string", "description": "CSV 格式文本数据（首行表头）"},
                "limit": {"type": "integer", "description": "读取预览行数上限"},
                "out": {"type": "string", "description": "输出路径（convert 可选）"},
            },
            "required": ["action"],
        },
    },
    "pdf_tool": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "description": "操作: info/extract/tables"},
                "file_path": {"type": "string", "description": "PDF 文件路径"},
                "pages": {"type": "string", "description": "页码范围，如 1-3,5 或 all"},
                "max_chars": {"type": "integer", "description": "文本提取最大字符数"},
            },
            "required": ["action", "file_path"],
        },
    },
    "git_tool": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "description": "操作: status/log/diff/branches/remotes"},
                "directory": {"type": "string", "description": "仓库目录路径"},
                "limit": {"type": "integer", "description": "提交记录条数（log）"},
                "scope": {"type": "string", "description": "diff 范围: unstaged/staged/all"},
            },
            "required": ["action", "directory"],
        },
    },
    "screenshot_to_code": {
        "inputSchema": {
            "type": "object",
            "properties": {
                "image_path": {"type": "string", "description": "图片路径"},
                "style": {"type": "string", "description": "风格偏好"},
            },
            "required": ["image_path"],
        },
    },
}


def _build_tools_list() -> list[dict[str, Any]]:
    """从 BUILTIN_SKILLS 构建 MCP 标准 tools 列表。"""
    from backend.routers.skills import BUILTIN_SKILLS

    tools = []
    for name, description in BUILTIN_SKILLS.items():
        schema = _TOOL_SCHEMAS.get(name, {"inputSchema": {"type": "object", "properties": {}}})
        tools.append({
            "name": name,
            "description": description,
            "inputSchema": schema["inputSchema"],
        })
    return tools


# ── JSON-RPC 2.0 辅助函数 ──────────────────────────────────────

def _jsonrpc_result(id: Any, result: Any) -> dict[str, Any]:
    """构建 JSON-RPC 2.0 成功响应。"""
    return {"jsonrpc": "2.0", "id": id, "result": result}


def _jsonrpc_error(id: Any, code: int, message: str, data: Any = None) -> dict[str, Any]:
    """构建 JSON-RPC 2.0 错误响应。"""
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": id, "error": err}


def _handle_tools_list(req_id: Any) -> dict[str, Any]:
    """处理 tools/list：返回所有工具及其 JSON Schema。"""
    return _jsonrpc_result(req_id, {
        "tools": _build_tools_list(),
    })


async def _handle_tools_call(req_id: Any, params: dict[str, Any]) -> dict[str, Any]:
    """处理 tools/call：执行指定工具并返回结果。"""
    tool_name = params.get("name", "")
    arguments = params.get("arguments", {}) or {}

    if not tool_name:
        return _jsonrpc_error(req_id, -32602, "Invalid params: missing 'name'")

    # 查找并加载工具模块
    try:
        module = importlib.import_module(f"backend.skills.{tool_name}")
    except ImportError:
        return _jsonrpc_error(req_id, -32602, f"Unknown tool: {tool_name}")

    if not hasattr(module, "execute"):
        return _jsonrpc_error(req_id, -32602, f"Tool {tool_name} has no execute function")

    # 执行工具：模块为同步实现，terminal/computer_use/web_search 等耗时可达数十秒，
    # 必须移出事件循环，否则会挂起整个后端（含聊天流式响应）
    try:
        result = await run_in_threadpool(module.execute, **arguments)
        return _jsonrpc_result(req_id, {
            "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}],
        })
    except Exception as e:
        return _jsonrpc_result(req_id, {
            "content": [{"type": "text", "text": f"Error: {e}"}],
            "isError": True,
        })


# ── JSON-RPC 2.0 方法分发发表 ──────────────────────────────────

_METHOD_HANDLERS = {
    "initialize": lambda req_id, params: _jsonrpc_result(req_id, {
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {"tools": {}},
        "serverInfo": MCP_SERVER_INFO,
    }),
    "tools/list": _handle_tools_list,
    "tools/call": _handle_tools_call,
}


async def _dispatch(body: dict[str, Any]) -> dict[str, Any]:
    """分发 JSON-RPC 2.0 请求到对应方法处理器。"""
    jsonrpc = body.get("jsonrpc")
    if jsonrpc != "2.0":
        return _jsonrpc_error(body.get("id"), -32600, "Invalid Request: jsonrpc must be '2.0'")

    method = body.get("method", "")
    req_id = body.get("id")
    params = body.get("params", {}) or {}

    handler = _METHOD_HANDLERS.get(method)
    if handler:
        result = handler(req_id, params)
        # 处理器可能为协程（tools/call 需在线程池中执行同步工具）
        if inspect.isawaitable(result):
            return await result
        return result

    return _jsonrpc_error(req_id, -32601, f"Method not found: {method}")


# ── FastAPI 路由 ──────────────────────────────────────────────

@router.post("")
async def mcp_endpoint(request: Request) -> JSONResponse:
    """MCP 协议统一入口（JSON-RPC 2.0）。

    支持方法：
    - initialize: 握手，返回协议版本与服务能力
    - tools/list: 列出所有工具（含 JSON Schema 参数定义）
    - tools/call: 调用指定工具
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            content=_jsonrpc_error(None, -32700, "Parse error"),
            status_code=400,
        )

    result = await _dispatch(body)
    return JSONResponse(content=result)
