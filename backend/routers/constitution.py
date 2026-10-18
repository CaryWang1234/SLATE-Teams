"""宪法路由：读写项目宪法 data/constitution.json。"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from backend.data_io import atomic_write_json

router = APIRouter(prefix="/constitution", tags=["constitution"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
CONSTITUTION_PATH = DATA_DIR / "constitution.json"


@router.get("")
async def get_constitution() -> dict[str, Any]:
    """读取项目宪法。"""
    if not CONSTITUTION_PATH.is_file():
        return {"code": -1, "data": None, "message": "宪法文件不存在"}
    text = CONSTITUTION_PATH.read_text(encoding="utf-8")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {"code": -1, "data": None, "message": "宪法文件格式错误"}
    return {"code": 0, "data": data, "message": "ok"}


@router.put("")
async def update_constitution(body: dict[str, Any]) -> dict[str, Any]:
    """更新项目宪法。"""
    CONSTITUTION_PATH.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(CONSTITUTION_PATH, body)
    return {"code": 0, "data": body, "message": "ok"}
