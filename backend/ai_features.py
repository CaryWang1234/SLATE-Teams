# -*- coding: utf-8 -*-
"""「设置 → AI 辅助功能」在后端的读取处。

前端 services/ai_features.js 是功能清单与写入口，落到 data/desktop_state.json 的
aiHelpers 字段：{ 功能id: { enabled: true/false, modelId: "" } }。
后端只有三处会自己发模型请求（定时任务、图片生成、视频生成），它们在这里查同一份
开关，用户在设置页关掉的东西才不会在后台照常跑。

这里刻意不复制一份功能 id 清单：缺键按默认值（开）处理，多出来的键无人读取也无害。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
STATE_PATH = DATA_DIR / "desktop_state.json"


def _ai_helpers() -> dict[str, Any]:
    if not STATE_PATH.exists():
        return {}
    try:
        shared = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    value = shared.get("aiHelpers") if isinstance(shared, dict) else None
    return value if isinstance(value, dict) else {}


def feature_enabled(feature_id: str, default: bool = True) -> bool:
    """功能开着吗。没写过状态文件、内容读坏了、没有这个键，都按 default（开）走——
    后台功能不该因为一份损坏的偏好文件被静默禁掉，那会让人以为功能坏了。"""
    entry = _ai_helpers().get(feature_id)
    if not isinstance(entry, dict):
        return default
    return entry.get("enabled", default) is not False


def feature_model_id(feature_id: str) -> str:
    """功能指定的模型 id（空串 = 跟随默认）。后端目前不消费它，留给排查与后续统一路由。"""
    entry = _ai_helpers().get(feature_id)
    if not isinstance(entry, dict):
        return ""
    value = entry.get("modelId")
    return value if isinstance(value, str) else ""
