"""外部 MCP Server 客户端管理器。

通过 SSE 传输协议连接外部 MCP Server，发现并调用其工具。
支持多 Server 同时连接，连接状态持久化。

协议规范：https://modelcontextprotocol.io/docs/concepts/transports
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import httpx

from backend import scope_overlay
from backend.data_io import atomic_write_json, backup_corrupt

logger = logging.getLogger("slate.mcp_client")

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
CONFIG_PATH = DATA_DIR / "mcp_servers.json"

# ── 连接状态 ─────────────────────────────────────────────

class McpServerConnection:
    """单个 MCP Server 的 SSE 连接。"""

    def __init__(self, server_id: str, name: str, url: str, enabled: bool = True):
        self.server_id = server_id
        self.name = name
        self.url = url.rstrip("/")
        self.enabled = enabled
        self.status: str = "disconnected"  # disconnected / connecting / connected / error
        self.error: str = ""
        self.tools: list[dict[str, Any]] = []
        self._message_url: str = ""
        self._request_id: int = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._sse_task: asyncio.Task | None = None
        self._client: httpx.AsyncClient | None = None
        self._connected_at: float = 0
        self._endpoint_event = asyncio.Event()
        self._listen_error = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.server_id,
            "name": self.name,
            "url": self.url,
            "enabled": self.enabled,
            "status": self.status,
            "error": self.error,
            "tools": [{"name": t["name"], "description": t.get("description", "")} for t in self.tools],
            "toolCount": len(self.tools),
        }

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    async def _fail_connect(self, error: str) -> bool:
        """连接失败统一出口：记录错误并清理 SSE 监听任务与 HTTP 客户端。"""
        self.status = "error"
        self.error = error
        if self._sse_task:
            self._sse_task.cancel()
            try:
                await self._sse_task
            except BaseException:
                pass
            self._sse_task = None
        if self._client:
            try:
                await self._client.aclose()
            except Exception:
                pass
            self._client = None
        return False

    async def connect(self) -> bool:
        """建立 SSE 连接，获取 message URL，拉取工具列表。

        MCP HTTP+SSE 传输：endpoint 事件绑定当前 SSE 会话（含 sessionId），
        因此必须保持同一条 SSE 连接持续监听，POST 消息全部发往该连接解析出的 URL。
        """
        self.status = "connecting"
        self.error = ""
        self.tools = []

        try:
            self._client = httpx.AsyncClient(timeout=30.0)

            # 1. 建立持久 SSE 监听（后台任务）：endpoint 事件由该连接解析并保存 message URL
            self._endpoint_event = asyncio.Event()
            self._listen_error = ""
            self._sse_task = asyncio.create_task(self._listen_sse())

            # 2. 等待 message endpoint（含 sessionId 绑定），15 秒超时
            try:
                await asyncio.wait_for(self._endpoint_event.wait(), timeout=15.0)
            except asyncio.TimeoutError:
                return await self._fail_connect(self._listen_error or "未收到 message endpoint")
            if not self._message_url:
                return await self._fail_connect(self._listen_error or "未收到 message endpoint")

            # 3. 发送 initialize 请求
            init_result = await self._send_request("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "SLATE", "version": "1.0.0"},
            })
            if not init_result or "error" in init_result:
                err = (init_result or {}).get("error")
                err_text = err if isinstance(err, str) else (json.dumps(err, ensure_ascii=False)[:200] if err else "无响应")
                return await self._fail_connect(f"initialize 失败: {err_text}")

            # 4. 发送 initialized 通知
            await self._send_notification("notifications/initialized")

            # 5. 拉取工具列表
            tools_result = await self._send_request("tools/list", {})
            if not tools_result or "error" in tools_result:
                err = (tools_result or {}).get("error")
                err_text = err if isinstance(err, str) else (json.dumps(err, ensure_ascii=False)[:200] if err else "无响应")
                return await self._fail_connect(f"tools/list 失败: {err_text}")
            self.tools = tools_result.get("tools") or []

            self.status = "connected"
            self._connected_at = time.time()
            logger.info(f"MCP Server '{self.name}' 已连接，{len(self.tools)} 个工具")
            return True

        except httpx.ConnectError:
            return await self._fail_connect(f"无法连接到 {self.url}")
        except httpx.TimeoutException:
            return await self._fail_connect("连接超时")
        except Exception as e:
            self.error = str(e)[:200]
            logger.exception(f"MCP Server '{self.name}' 连接失败")
            return await self._fail_connect(str(e)[:200])

    async def _listen_sse(self):
        """后台监听 SSE 流：解析 endpoint 事件保存 message URL，持续接收响应与通知。"""
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("GET", f"{self.url}/sse", headers={"Accept": "text/event-stream"}) as resp:
                    if resp.status_code != 200:
                        self._listen_error = f"SSE 连接失败: HTTP {resp.status_code}"
                        self._endpoint_event.set()
                        return
                    event_type = ""
                    async for line in resp.aiter_lines():
                        if line.startswith("event:"):
                            event_type = line[6:].strip()
                        elif line.startswith("data:"):
                            data = line[5:].strip()
                            # endpoint 事件（MCP 规范），兼容旧式 data 前缀判断
                            if event_type == "endpoint" or data.startswith("/message") or data.startswith("http"):
                                if not self._message_url:
                                    self._message_url = data if data.startswith("http") else f"{self.url}{data}"
                                    self._endpoint_event.set()
                            elif event_type == "message" and data:
                                try:
                                    msg = json.loads(data)
                                    req_id = msg.get("id")
                                    if req_id is not None and req_id in self._pending:
                                        if "error" in msg:
                                            self._pending[req_id].set_result({"error": msg["error"]})
                                        else:
                                            self._pending[req_id].set_result(msg.get("result", {}))
                                except json.JSONDecodeError:
                                    pass
                        elif line == "":
                            event_type = ""
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"MCP SSE 监听断开 ({self.name}): {e}")
            self._listen_error = str(e)[:200]
            self._endpoint_event.set()
            if self.status == "connected":
                self.status = "error"
                self.error = f"连接断开: {e}"
            # 断线后让所有挂起的请求立即失败，避免 15 秒空等
            for req_id, fut in list(self._pending.items()):
                if not fut.done():
                    fut.set_result({"error": "SSE 连接断开"})

    async def _send_request(self, method: str, params: dict) -> dict | None:
        """发送 JSON-RPC 请求并等待响应。"""
        if not self._message_url:
            return None
        req_id = self._next_id()
        payload = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "params": params,
        }
        future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = future
        try:
            resp = await self._client.post(self._message_url, json=payload, timeout=15.0)
            if resp.status_code not in (200, 202):
                self._pending.pop(req_id, None)
                return {"error": f"HTTP {resp.status_code}"}
            # 等待 SSE 流传回结果
            try:
                result = await asyncio.wait_for(future, timeout=15.0)
                return result
            except asyncio.TimeoutError:
                self._pending.pop(req_id, None)
                return {"error": "响应超时"}
        except Exception as e:
            self._pending.pop(req_id, None)
            return {"error": str(e)[:200]}

    async def _send_notification(self, method: str, params: dict | None = None):
        """发送 JSON-RPC 通知（无 id，无响应）。"""
        if not self._message_url:
            return
        payload = {"jsonrpc": "2.0", "method": method}
        if params:
            payload["params"] = params
        try:
            await self._client.post(self._message_url, json=payload, timeout=5.0)
        except Exception:
            pass

    async def call_tool(self, tool_name: str, arguments: dict) -> dict[str, Any]:
        """调用远程 MCP Server 的工具。"""
        if self.status != "connected":
            return {"error": f"服务器未连接: {self.status}"}
        result = await self._send_request("tools/call", {
            "name": tool_name,
            "arguments": arguments,
        })
        if result is None:
            return {"error": "请求失败"}
        if "error" in result:
            return {"error": result["error"]}
        return result

    async def disconnect(self):
        """断开连接。"""
        if self._sse_task:
            self._sse_task.cancel()
            try:
                await self._sse_task
            except BaseException:
                pass
            self._sse_task = None
        if self._client:
            await self._client.aclose()
            self._client = None
        self._pending.clear()
        self.tools = []
        self._message_url = ""
        self.status = "disconnected"


# ── 管理器（全局单例） ──────────────────────────────────

_connections: dict[str, McpServerConnection] = {}
_config_load_error = False  # 原文件损坏时置位，保存前备份防覆盖丢失


def _load_config() -> list[dict[str, Any]]:
    """从磁盘加载 MCP Server 配置。"""
    global _config_load_error
    if not CONFIG_PATH.exists():
        _config_load_error = False
        return []
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        _config_load_error = False
        return data if isinstance(data, list) else []
    except Exception:
        _config_load_error = True
        return []


def _save_config(servers: list[dict[str, Any]]):
    """保存 MCP Server 配置到磁盘（原子写；原文件损坏时先备份再写）。"""
    if _config_load_error:
        backup_corrupt(CONFIG_PATH)
    atomic_write_json(CONFIG_PATH, servers)


def list_servers(project_id: str = "") -> list[dict[str, Any]]:
    """列出所有已配置的 MCP Server 及其状态。

    带 project 时每条多给两个字段：`effectiveEnabled`（这一项目里到底用不用）与
    `enableScope`（这条结论来自项目掩码还是全局那一份）。面板要写明"现在关的是哪一份"，
    光靠一个开关按钮说不清——关错一份会把别的项目共用的服务器一起停掉。
    """
    configs = _load_config()
    result = []
    for cfg in configs:
        sid = cfg["id"]
        conn = _connections.get(sid)
        base = conn.to_dict() if conn else {
            "id": sid,
            "name": cfg.get("name", ""),
            "url": cfg.get("url", ""),
            "enabled": cfg.get("enabled", True),
            "status": "disconnected",
            "error": "",
            "tools": [],
            "toolCount": 0,
        }
        default_on = bool(base.get("enabled", True))
        masked = bool(project_id) and str(sid) in scope_overlay.mcp_mask_of(project_id)
        base["effectiveEnabled"] = scope_overlay.server_enabled(project_id, sid, default=default_on)
        base["enableScope"] = "project" if masked else "global"
        result.append(base)
    return result


def get_all_remote_tools(project_id: str = "") -> list[dict[str, Any]]:
    """获取所有已连接 MCP Server 的工具列表（供技能面板和 AI 工具系统使用）。

    带 project 时按该项目掩码过滤：整台关掉的不进列表，只给了白名单的只进白名单那几个。
    """
    tools = []
    for conn in _connections.values():
        if conn.status != "connected" or not conn.enabled:
            continue
        if not scope_overlay.server_enabled(project_id, conn.server_id, default=True):
            continue
        for t in conn.tools:
            if not scope_overlay.tool_allowed(project_id, conn.server_id, t["name"]):
                continue
            tools.append({
                "name": t["name"],
                "description": t.get("description", ""),
                "server": conn.name,
                "serverId": conn.server_id,
                # 带 url 才认得出品牌：Server 名是用户手输的任意字符串，
                # "My MCP" 指向 mcp.notion.com 时前端也该画 Notion 的 mark。
                "url": conn.url,
            })
    return tools


async def add_server(name: str, url: str, auto_connect: bool = True) -> dict[str, Any]:
    """添加一个新的 MCP Server。"""
    configs = _load_config()
    # 检查 URL 是否已存在
    for cfg in configs:
        if cfg.get("url") == url:
            return {"error": f"该地址已配置: {cfg.get('name', '')}"}

    import hashlib
    sid = hashlib.sha256(url.encode()).hexdigest()[:12]

    cfg = {"id": sid, "name": name, "url": url, "enabled": True}
    configs.append(cfg)
    _save_config(configs)

    if auto_connect:
        conn = McpServerConnection(sid, name, url)
        _connections[sid] = conn
        ok = await conn.connect()
        if not ok:
            return {"id": sid, "name": name, "url": url, "status": "error", "error": conn.error, "tools": [], "toolCount": 0}
        return conn.to_dict()

    return {"id": sid, "name": name, "url": url, "status": "disconnected", "tools": [], "toolCount": 0}


async def remove_server(server_id: str) -> dict[str, Any]:
    """移除一个 MCP Server。"""
    conn = _connections.pop(server_id, None)
    if conn:
        await conn.disconnect()

    configs = _load_config()
    configs = [c for c in configs if c["id"] != server_id]
    _save_config(configs)
    return {"ok": True}


async def connect_server(server_id: str) -> dict[str, Any]:
    """连接指定的 MCP Server。"""
    configs = _load_config()
    cfg = next((c for c in configs if c["id"] == server_id), None)
    if not cfg:
        return {"error": f"服务器不存在: {server_id}"}

    # 先断开旧连接
    old = _connections.pop(server_id, None)
    if old:
        await old.disconnect()

    conn = McpServerConnection(server_id, cfg["name"], cfg["url"], cfg.get("enabled", True))
    _connections[server_id] = conn
    ok = await conn.connect()
    if not ok:
        return conn.to_dict()
    return conn.to_dict()


async def disconnect_server(server_id: str) -> dict[str, Any]:
    """断开指定的 MCP Server。"""
    conn = _connections.pop(server_id, None)
    if conn:
        await conn.disconnect()
    return {"ok": True}


async def call_remote_tool(server_id: str, tool_name: str, arguments: dict, project_id: str = "") -> dict[str, Any]:
    """调用远程 MCP Server 上的工具。

    带 project 时在门口再验一次掩码：列表已经过滤过一轮，这里是防御性复核——
    前端拿到的是旧列表、或有人直接打这条路由，都不该绕过项目的收窄。
    """
    conn = _connections.get(server_id)
    if not conn:
        return {"error": f"服务器未连接: {server_id}"}
    if conn.status != "connected":
        return {"error": f"服务器未连接: {conn.status}"}
    if project_id and not scope_overlay.server_enabled(project_id, server_id, default=conn.enabled):
        return {"error": f"这台服务器在该项目里已关闭: {conn.name}"}
    if project_id and not scope_overlay.tool_allowed(project_id, server_id, tool_name):
        return {"error": f"工具 {tool_name} 不在该项目允许的清单里（服务器：{conn.name}）"}
    return await conn.call_tool(tool_name, arguments)


async def startup_connect_all():
    """启动时自动连接所有已启用的 MCP Server。"""
    configs = _load_config()
    for cfg in configs:
        if not cfg.get("enabled", True):
            continue
        sid = cfg["id"]
        conn = McpServerConnection(sid, cfg["name"], cfg["url"])
        _connections[sid] = conn
        try:
            ok = await conn.connect()
            if ok:
                logger.info(f"MCP Server '{cfg['name']}' 启动连接成功")
            else:
                logger.warning(f"MCP Server '{cfg['name']}' 启动连接失败: {conn.error}")
        except Exception as e:
            logger.warning(f"MCP Server '{cfg['name']}' 启动连接异常: {e}")


async def shutdown_disconnect_all():
    """关闭时断开所有连接。"""
    for conn in _connections.values():
        await conn.disconnect()
    _connections.clear()
