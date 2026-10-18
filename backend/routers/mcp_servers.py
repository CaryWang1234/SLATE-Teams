"""外部 MCP Server 管理路由。

提供 REST API 增删查改外部 MCP Server 连接，
以及代理调用远程工具。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from backend import mcp_client, scope_overlay

router = APIRouter(prefix="/mcp-servers", tags=["mcp-servers"])


@router.get("")
async def list_mcp_servers(project: str = "") -> dict[str, Any]:
    """列出所有已配置的 MCP Server 及连接状态。

    带 project 时每条附 `effectiveEnabled`/`enableScope`：面板要能说清现在这一格是
    项目掩码盖出来的，还是全局那一份。
    """
    servers = mcp_client.list_servers(project)
    return {"code": 0, "data": servers, "message": "ok"}


class AddServerRequest(BaseModel):
    name: str
    url: str
    auto_connect: bool = True


@router.post("")
async def add_mcp_server(req: AddServerRequest) -> dict[str, Any]:
    """添加并连接一个新的外部 MCP Server。"""
    if not req.name or not req.name.strip():
        return {"code": 1, "message": "名称不能为空"}
    if not req.url or not req.url.strip():
        return {"code": 1, "message": "URL 不能为空"}
    result = await mcp_client.add_server(req.name.strip(), req.url.strip(), req.auto_connect)
    if "error" in result and "id" not in result:
        return {"code": 1, "message": result["error"]}
    return {"code": 0, "data": result, "message": "ok"}


@router.post("/{server_id}/connect")
async def connect_mcp_server(server_id: str) -> dict[str, Any]:
    """连接指定的 MCP Server。"""
    result = await mcp_client.connect_server(server_id)
    if "error" in result and result.get("status") != "error":
        return {"code": 1, "message": result["error"]}
    return {"code": 0, "data": result, "message": "ok"}


@router.post("/{server_id}/disconnect")
async def disconnect_mcp_server(server_id: str) -> dict[str, Any]:
    """断开指定的 MCP Server。"""
    result = await mcp_client.disconnect_server(server_id)
    return {"code": 0, "data": result, "message": "ok"}


@router.delete("/{server_id}")
async def remove_mcp_server(server_id: str) -> dict[str, Any]:
    """移除一个 MCP Server 配置。"""
    result = await mcp_client.remove_server(server_id)
    return {"code": 0, "data": result, "message": "ok"}


@router.get("/tools")
async def list_remote_tools(project: str = "") -> dict[str, Any]:
    """获取所有已连接 MCP Server 的工具列表（带 project 时按该项目掩码收窄）。"""
    tools = mcp_client.get_all_remote_tools(project)
    return {"code": 0, "data": tools, "message": "ok"}


class CallRemoteToolRequest(BaseModel):
    server_id: str
    tool_name: str
    arguments: dict = {}
    project: str = ""


@router.post("/call")
async def call_remote_tool(req: CallRemoteToolRequest) -> dict[str, Any]:
    """代理调用远程 MCP Server 上的工具。"""
    result = await mcp_client.call_remote_tool(req.server_id, req.tool_name, req.arguments, req.project)
    if "error" in result:
        return {"code": -1, "data": None, "message": result["error"]}
    return {"code": 0, "data": result, "message": "ok"}


class ServerMaskRequest(BaseModel):
    project: str
    enabled: bool | None = None
    tools: list[str] | None = None


@router.post("/{server_id}/mask")
async def set_server_mask(server_id: str, req: ServerMaskRequest) -> dict[str, Any]:
    """给某项目写/摘一台服务器的掩码。

    掩码只存开关和工具白名单——URL 与密钥留在全局配置里，绝不落进用户仓库目录。
    两个字段都为空即视为摘掉这一格，这一项目回到跟全局。
    """
    clean_id = str(server_id or "").strip()
    if not clean_id:
        return {"code": -1, "data": None, "message": "无效的 Server 标识"}
    if not req.project:
        return {"code": -1, "data": None, "message": "掩码只对某个项目有意义，请点名项目"}
    both_empty = req.enabled is None and not req.tools
    mask = None if both_empty else {
        k: v for k, v in (("enabled", req.enabled), ("tools", req.tools)) if v is not None and v != []
    }
    if not scope_overlay.set_server_mask(req.project, clean_id, mask):
        return {"code": -1, "data": None, "message": "项目不在册或目录写不进去，没动它的配置"}
    return {
        "code": 0,
        "data": {"project_id": req.project, "server_id": clean_id, "mask": mask},
        "message": "已摘掉该项目的掩码，这台服务器回到跟全局" if mask is None else "已写入该项目的掩码",
    }
