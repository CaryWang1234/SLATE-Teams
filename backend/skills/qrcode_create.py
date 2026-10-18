# -*- coding: utf-8 -*-
"""
qrcode_create — 二维码生成 工具（qrcode 库，SVG 输出）。

将文本或 URL 编码为 SVG 二维码，落盘到数据目录 outputs/，
返回 file_path 与 preview_url（前端经 /api/files/output 内联预览）。
"""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import Any

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))


def execute(text: str = "", size: int = 8, border: int = 2,
            file_name: str = "", output_dir: str = "", **_kwargs) -> dict[str, Any]:
    """生成 SVG 二维码并落盘，返回文件路径与预览链接。"""
    content = str(text or "").strip()
    if not content:
        return {"message": "缺少 text 参数：二维码内容（文本或 URL）"}
    # QR Code v40-L 最大容量约 2953 字节（UTF-8），中文按 3 字节估算
    byte_len = len(content.encode("utf-8"))
    if byte_len > 2500:
        return {"message": f"内容过长（{byte_len} 字节，上限 2500），二维码将难以扫描，请精简"}

    try:
        import qrcode
        import qrcode.image.svg
    except ImportError:
        return {"message": "缺少 qrcode 依赖，无法生成二维码"}

    box_size = max(2, min(int(size or 8), 24))
    box_border = max(0, min(int(border or 2), 8))

    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=box_size,
        border=box_border,
        image_factory=qrcode.image.svg.SvgPathImage,
    )
    qr.add_data(content)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#1a1d23", back_color="#ffffff")

    out_dir = Path(output_dir.strip()) if (output_dir or "").strip() else DATA_DIR / "outputs"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    fname = file_name.strip() if file_name else f"qrcode_{stamp}.svg"
    if not fname.lower().endswith(".svg"):
        fname += ".svg"
    out_path = out_dir / fname
    img.save(str(out_path))

    return {
        "message": "ok",
        "content_length": len(content),
        "file_path": str(out_path),
        "preview_url": f"/api/files/output?name={out_path.name}",
    }
