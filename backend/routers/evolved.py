# -*- coding: utf-8 -*-
"""自进化工具路由：data/evolved/，一工具两份文件（源码 + 清单）。

「扩展 → 新功能」这一栏的管理面都在这里：列清单、看代码、启用/停用、留底与回滚、撤销。
产物落在用户数据区而不是源码树，是为了让"升级"和"我自己长出来的东西"互不干扰——
升级覆盖不到 data/，而新版若带来了同名内置工具，那份自生产代码会被顶掉并标成 shadowed，
用户在界面上看得见、随时能撤。

不抛 500：所有失败都回 {code:-1, message:中文}，与 actions 路由同口径。
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from backend import evolution

router = APIRouter(prefix="/evolved", tags=["evolved"])
logger = logging.getLogger(__name__)


class EvolvedToggle(BaseModel):
    enabled: bool = True


class EvolvedRestore(BaseModel):
    ts: str = ""


@router.get("")
async def list_evolved() -> dict[str, Any]:
    """全部自进化工具（含已停用与坏掉的），新条目按名字排序。"""
    items = evolution.list_items()
    return {
        "code": 0,
        "data": {
            "path": str(evolution.EVOLVED_DIR),
            "items": items,
            "shadowed": sum(1 for i in items if i["shadowed"]),
            "broken": sum(1 for i in items if i["error"]),
            "disabled": sum(1 for i in items if not i["enabled"] and not i["error"]),
        },
        "message": "ok",
    }


@router.get("/{tool_name}/source")
async def read_source(tool_name: str) -> dict[str, Any]:
    """读一份生成代码的原文：撤销之前得让人看清楚它到底干了什么。"""
    return evolution.read_source(tool_name)


@router.post("/{tool_name}/toggle")
async def toggle(tool_name: str, body: EvolvedToggle) -> dict[str, Any]:
    """启用/停用。停用＝从模型目录里整体摘掉，不是"调用了再报错"。"""
    return evolution.set_enabled(tool_name, bool(body.enabled))


@router.delete("/{tool_name}")
async def remove(tool_name: str) -> dict[str, Any]:
    """撤销一个自进化工具：先留底再删，给用户留「我反悔了」的出口。"""
    return evolution.delete_tool(tool_name)


@router.get("/{tool_name}/history")
async def list_history(tool_name: str) -> dict[str, Any]:
    clean = evolution.clean_name(tool_name)
    if not clean:
        return {"code": -1, "data": None, "message": f"无效的工具名称: {tool_name}"}
    return {
        "code": 0,
        "data": {"tool_name": clean, "keep": evolution.HISTORY_KEEP,
                 "versions": evolution.history_versions(clean)},
        "message": "ok",
    }


@router.get("/{tool_name}/history/{ts}")
async def read_history(tool_name: str, ts: str) -> dict[str, Any]:
    """读一个留底的原文：回滚前得看清楚要恢复什么。"""
    return evolution.read_history_source(tool_name, ts)


@router.post("/{tool_name}/history/restore")
async def restore_history(tool_name: str, body: EvolvedRestore) -> dict[str, Any]:
    """回滚到某个留底。回滚也是写：编译不过的旧版本不许盖回去。"""
    return evolution.restore_history(tool_name, str(body.ts or ""))
