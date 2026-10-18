# -*- coding: utf-8 -*-
"""
screenshot_to_code — 截图/图片转代码 工具。

读取图片文件，编码为 base64 data URI 返回给 AI 视觉模型，
AI 根据截图内容生成 HTML/CSS 代码。配合 html_render 可即时预览。
"""

from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Any

# 支持的图片格式及其 MIME
MIME_MAP = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
}

MAX_SIZE = 10 * 1024 * 1024  # 10 MB


def execute(image_path: str = "", style: str = "", **_kw: Any) -> dict[str, Any]:
    """读取截图/图片，返回 base64 data URI 供 AI 视觉分析生成代码。

    参数：
    - image_path : 图片文件路径（必填）
    - style : 生成代码的风格偏好（可选），如 "tailwind" / "plain css" / "responsive"
    """
    path = str(image_path or "").strip()
    if not path:
        return {"error": "缺少 image_path 参数：请提供截图文件路径"}

    path = os.path.expanduser(path)
    if not os.path.isfile(path):
        return {"error": f"文件不存在: {path}"}

    ext = Path(path).suffix.lower()
    if ext not in MIME_MAP:
        supported = ", ".join(sorted(MIME_MAP.keys()))
        return {"error": f"不支持的图片格式: {ext}（支持: {supported}）"}

    file_size = os.path.getsize(path)
    if file_size > MAX_SIZE:
        return {"error": f"图片过大: {file_size / 1024 / 1024:.1f} MB（上限 10 MB）"}

    mime = MIME_MAP[ext]
    with open(path, "rb") as f:
        raw = f.read()
    b64 = base64.b64encode(raw).decode("ascii")
    data_uri = f"data:{mime};base64,{b64}"

    style_hint = style.strip() if style else ""
    instruction = (
        "请仔细观察这张截图/图片，分析其布局结构、配色方案、字体层级和组件类型，"
        "然后生成一份完整的单文件 HTML（含内联 CSS），尽可能还原截图中的视觉效果。"
        "要求：语义化标签、响应式布局、纯黑白灰基调。"
    )
    if style_hint:
        instruction += f"\n风格偏好：{style_hint}"

    return {
        "message": "ok",
        "image_data_uri": data_uri,
        "image_format": ext.lstrip("."),
        "image_size": file_size,
        "instruction": instruction,
        "tip": "AI 已收到截图，将根据视觉内容生成 HTML/CSS 代码。生成后可使用 html_render 预览。",
    }
