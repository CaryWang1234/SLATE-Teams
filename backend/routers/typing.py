# -*- coding: utf-8 -*-
"""打字小游戏题库：读写 data/typing_custom.txt（一行一条，# 开头当注释）。

题目怎么筛（长度、非 ASCII、去重）归前端 typing_game.js 判，这里只做定死路径的文本读写：
不接路径参数也就没有目录穿越。文件缺失按空题库返回，前端照玩内置题库。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from backend.data_io import atomic_write_text

router = APIRouter(prefix="/typing", tags=["typing"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
CORPUS_PATH = DATA_DIR / "typing_custom.txt"

MAX_CONTENT_CHARS = 60_000
READ_LIMIT_CHARS = 200_000


def _snapshot() -> dict[str, Any]:
    exists = CORPUS_PATH.is_file()
    content = ""
    if exists:
        try:
            # 记事本另存成 ANSI 也要读得动：非 ASCII 行前端会丢掉，纯 ASCII 行两种编码字节一致
            content = CORPUS_PATH.read_text(encoding="utf-8", errors="replace")[:READ_LIMIT_CHARS]
        except OSError:
            exists = False
    return {"path": str(CORPUS_PATH), "exists": exists, "content": content}


@router.get("/corpus")
async def get_corpus() -> dict[str, Any]:
    """返回自定义题库的文件路径与原文（文件不存在时 content 为空串）。"""
    return {"code": 0, "data": _snapshot(), "message": "ok"}


@router.post("/corpus")
async def save_corpus(body: dict[str, Any]) -> dict[str, Any]:
    """整份覆盖写入自定义题库；存空串即回到只用内置题库。"""
    content = body.get("content")
    if not isinstance(content, str):
        return {"code": -1, "data": None, "message": "content 必须是字符串"}
    if len(content) > MAX_CONTENT_CHARS:
        return {"code": -1, "data": None, "message": f"题库过大，上限 {MAX_CONTENT_CHARS} 字符"}
    try:
        atomic_write_text(CORPUS_PATH, content)
    except OSError as exc:
        return {"code": -1, "data": None, "message": f"写入失败：{exc}"}
    return {"code": 0, "data": _snapshot(), "message": "ok"}
