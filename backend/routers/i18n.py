# -*- coding: utf-8 -*-
"""语言配置：安装时由安装程序写入 data/language.txt（zh/en），运行时只读。

优先级：环境变量 SLATE_LANG > data/language.txt > 默认 zh。
前端启动时经 GET /api/i18n/lang 获取，据此决定是否启用英文词典翻译。
"""

import os
from pathlib import Path

from fastapi import APIRouter

router = APIRouter(prefix="/i18n", tags=["i18n"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
LANG_PATH = DATA_DIR / "language.txt"

SUPPORTED = ("zh", "en")


def get_lang() -> str:
    """解析当前界面语言：env > 安装选择文件 > 默认中文。"""
    env = os.environ.get("SLATE_LANG", "").strip().lower()
    if env in SUPPORTED:
        return env
    try:
        if LANG_PATH.exists():
            v = LANG_PATH.read_text(encoding="utf-8").strip().lower()
            if v in SUPPORTED:
                return v
    except OSError:
        pass
    return "zh"


@router.get("/lang")
async def current_lang():
    return {"code": 0, "data": {"lang": get_lang()}, "message": "ok"}
