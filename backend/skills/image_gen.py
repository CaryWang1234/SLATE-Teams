# -*- coding: utf-8 -*-
"""工具：AI 图片生成（OpenAI 兼容 images/generations）。

依赖用户在「设置 → 图片生成」中配置 model / base_url / api_key（存于
data/desktop_state.json 的 imageGen 字段），未配置时直接返回错误，禁止使用。

响应支持两种形态：
- data[0].url    ：远程图片地址，下载落盘
- data[0].b64_json：base64 编码图片，解码落盘

产物保存到 data/outputs/，返回 file_path 与 preview_url
（前端经 /api/files/output 提供内联预览）。
"""

from __future__ import annotations

import base64
import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from backend.ai_features import feature_enabled

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
STATE_PATH = DATA_DIR / "desktop_state.json"

DEFAULT_BASE_URL = "https://api.openai.com/v1"
REQUEST_TIMEOUT = 120.0
DOWNLOAD_TIMEOUT = 60.0
MAX_IMAGES = 4

# Content-Type → 文件扩展名
_MIME_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def _load_gen_config(kind: str) -> dict[str, Any]:
    """读取 desktop_state.json 中的媒体生成配置（imageGen / videoGen）。"""
    if STATE_PATH.exists():
        try:
            shared = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            cfg = shared.get(kind)
            if isinstance(cfg, dict):
                return cfg
        except (OSError, json.JSONDecodeError):
            pass
    return {}


def _ext_from_content_type(content_type: str) -> str:
    mime = (content_type or "").split(";")[0].strip().lower()
    return _MIME_EXT.get(mime, ".png")


def execute(
    prompt: str = "",
    size: str = "1024x1024",
    n: int = 1,
    output_dir: str | None = None,
    **_: Any,
) -> dict[str, Any]:
    """根据描述生成图片并落盘，返回 file_path 与 preview_url。"""
    prompt = (prompt or "").strip()
    if not prompt:
        return {"message": "缺少 prompt 参数：描述要生成的图片内容"}

    # 关掉就不发请求，也不去读配置里的 Key：给出能照着改回的路径
    if not feature_enabled("image_gen"):
        return {"message": "「AI 图片生成」已在设置中关闭（设置 → AI 辅助功能）"}
    cfg = _load_gen_config("imageGen")
    model = (cfg.get("model") or "").strip()
    api_key = (cfg.get("api_key") or "").strip()
    base_url = (cfg.get("base_url") or DEFAULT_BASE_URL).strip().rstrip("/")
    if not model or not api_key:
        return {"message": "未配置图片生成模型或 API Key，请到「设置 → 图片生成」中配置后再试"}

    try:
        count = max(1, min(int(n or 1), MAX_IMAGES))
    except (TypeError, ValueError):
        count = 1

    url = f"{base_url}/images/generations"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    body: dict[str, Any] = {"model": model, "prompt": prompt, "n": count}
    if (size or "").strip():
        body["size"] = size.strip()

    try:
        resp = httpx.post(url, json=body, headers=headers, timeout=REQUEST_TIMEOUT)
    except Exception as exc:
        return {"message": f"图片生成请求失败: {exc}"}

    if resp.status_code >= 400:
        return {"message": f"图片生成失败（HTTP {resp.status_code}）: {resp.text[:300]}"}

    try:
        data = resp.json()
    except (ValueError, json.JSONDecodeError):
        return {"message": "图片生成响应解析失败"}

    items = data.get("data")
    if not isinstance(items, list) or not items:
        return {"message": "图片生成未返回结果"}

    out_dir = Path((output_dir or "").strip()) if (output_dir or "").strip() else DATA_DIR / "outputs"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    results: list[dict[str, str]] = []
    for i, item in enumerate(items[:count]):
        if not isinstance(item, dict):
            continue
        fname = f"image_{stamp}_{i}{'.png'}"
        try:
            b64 = item.get("b64_json") or ""
            if b64:
                raw = base64.b64decode(b64)
                (out_dir / fname).write_bytes(raw)
            else:
                img_url = (item.get("url") or "").strip()
                if not img_url:
                    continue
                dl = httpx.get(img_url, timeout=DOWNLOAD_TIMEOUT, follow_redirects=True)
                if dl.status_code != 200:
                    return {"message": f"图片下载失败（HTTP {dl.status_code}）: {img_url[:200]}"}
                ext = _ext_from_content_type(dl.headers.get("content-type", ""))
                fname = f"image_{stamp}_{i}{ext}"
                (out_dir / fname).write_bytes(dl.content)
        except Exception as exc:
            return {"message": f"图片保存失败: {exc}"}
        results.append(
            {
                "file_path": str(out_dir / fname),
                "preview_url": f"/api/files/output?name={fname}",
            }
        )

    if not results:
        return {"message": "图片生成未返回可用结果"}

    return {
        "message": "ok",
        "count": len(results),
        "results": results,
        "file_path": results[0]["file_path"],
        "preview_url": results[0]["preview_url"],
    }
