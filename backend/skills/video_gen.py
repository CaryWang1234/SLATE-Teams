# -*- coding: utf-8 -*-
"""工具：AI 视频生成（OpenAI 兼容 /videos/generations，双兼容同步/异步任务）。

依赖用户在「设置 → 视频生成」中配置 model / base_url / api_key（存于
data/desktop_state.json 的 videoGen 字段），未配置时直接返回错误，禁止使用。

响应双兼容：
1. 同步完成：data[0].url / data[0].video_url / data[0].download_url / 顶层 url
2. 异步任务：响应含 id/task_id，轮询 GET {base_url}/videos/generations/{id}
   直到 status 变为完成（5s 间隔，最多 10 分钟）

产物保存到 data/outputs/，返回 file_path 与 preview_url
（前端经 /api/files/output 提供内联预览）。
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from backend.ai_features import feature_enabled

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
STATE_PATH = DATA_DIR / "desktop_state.json"

DEFAULT_BASE_URL = "https://api.openai.com/v1"
REQUEST_TIMEOUT = 120.0
DOWNLOAD_TIMEOUT = 180.0
POLL_INTERVAL = 5.0
POLL_MAX = 120  # 10 分钟上限

_DONE_STATUS = {"completed", "success", "succeeded", "finished", "succeed"}
_FAIL_STATUS = {"failed", "error", "cancelled", "canceled", "failure"}
_VIDEO_URL_KEYS = ("url", "video_url", "download_url", "output_url", "video")
_TASK_ID_KEYS = ("id", "task_id", "video_id", "generation_id")


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


def _extract_video_url(data: Any) -> str:
    """从生成/轮询响应中提取视频直链；找不到返回空串。"""
    if isinstance(data, dict):
        for key in _VIDEO_URL_KEYS:
            val = data.get(key)
            if isinstance(val, str) and val.startswith(("http://", "https://")):
                return val
        items = data.get("data")
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict):
                    for key in _VIDEO_URL_KEYS:
                        val = item.get(key)
                        if isinstance(val, str) and val.startswith(("http://", "https://")):
                            return val
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                for key in _VIDEO_URL_KEYS:
                    val = item.get(key)
                    if isinstance(val, str) and val.startswith(("http://", "https://")):
                        return val
    return ""


def _extract_task_id(data: Any) -> str:
    """从生成响应中提取异步任务 id；找不到返回空串。"""
    if isinstance(data, dict):
        for key in _TASK_ID_KEYS:
            val = data.get(key)
            if isinstance(val, str) and val:
                return val
        items = data.get("data")
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict):
                    for key in _TASK_ID_KEYS:
                        val = item.get(key)
                        if isinstance(val, str) and val:
                            return val
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                for key in _TASK_ID_KEYS:
                    val = item.get(key)
                    if isinstance(val, str) and val:
                        return val
    return ""


def _poll_video_task(base_url: str, api_key: str, task_id: str) -> tuple[str, str]:
    """轮询异步视频任务，返回 (视频URL, 错误消息)；完成返回 (url, "")。"""
    poll_url = f"{base_url}/videos/generations/{task_id}"
    headers = {"Authorization": f"Bearer {api_key}"}
    for _ in range(POLL_MAX):
        time.sleep(POLL_INTERVAL)
        try:
            resp = httpx.get(poll_url, headers=headers, timeout=30.0)
        except Exception:
            continue
        if resp.status_code >= 400:
            continue
        try:
            payload = resp.json()
        except (ValueError, json.JSONDecodeError):
            continue
        video_url = _extract_video_url(payload)
        if video_url:
            return video_url, ""
        status = ""
        if isinstance(payload, dict):
            status = str(payload.get("status") or "").lower()
            items = payload.get("data")
            if not status and isinstance(items, list) and items and isinstance(items[0], dict):
                status = str(items[0].get("status") or "").lower()
        if status in _FAIL_STATUS:
            detail = ""
            if isinstance(payload, dict):
                detail = str(payload.get("error") or payload.get("message") or "")[:200]
            return "", f"视频任务失败: {detail or status}"
    return "", "视频生成超时（约 10 分钟），请稍后重试"


def _ext_from_content_type(content_type: str) -> str:
    mime = (content_type or "").split(";")[0].strip().lower()
    if mime == "video/webm":
        return ".webm"
    return ".mp4"


def execute(
    prompt: str = "",
    duration: int = 5,
    output_dir: str | None = None,
    **_: Any,
) -> dict[str, Any]:
    """根据描述生成短视频并落盘，返回 file_path 与 preview_url。"""
    prompt = (prompt or "").strip()
    if not prompt:
        return {"message": "缺少 prompt 参数：描述要生成的视频内容"}

    # 关掉就不发请求，也不去读配置里的 Key：给出能照着改回的路径
    if not feature_enabled("video_gen"):
        return {"message": "「AI 视频生成」已在设置中关闭（设置 → AI 辅助功能）"}
    cfg = _load_gen_config("videoGen")
    model = (cfg.get("model") or "").strip()
    api_key = (cfg.get("api_key") or "").strip()
    base_url = (cfg.get("base_url") or DEFAULT_BASE_URL).strip().rstrip("/")
    if not model or not api_key:
        return {"message": "未配置视频生成模型或 API Key，请到「设置 → 视频生成」中配置后再试"}

    try:
        dur = max(1, min(int(duration or 5), 30))
    except (TypeError, ValueError):
        dur = 5

    url = f"{base_url}/videos/generations"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    body: dict[str, Any] = {"model": model, "prompt": prompt, "duration": dur}

    try:
        resp = httpx.post(url, json=body, headers=headers, timeout=REQUEST_TIMEOUT)
    except Exception as exc:
        return {"message": f"视频生成请求失败: {exc}"}

    if resp.status_code >= 400:
        return {"message": f"视频生成失败（HTTP {resp.status_code}）: {resp.text[:300]}"}

    try:
        data = resp.json()
    except (ValueError, json.JSONDecodeError):
        return {"message": "视频生成响应解析失败"}

    video_url = _extract_video_url(data)
    if not video_url:
        task_id = _extract_task_id(data)
        if not task_id:
            return {"message": "视频生成响应未包含视频链接或任务 ID，无法获取结果"}
        video_url, err = _poll_video_task(base_url, api_key, task_id)
        if err:
            return {"message": err}
        if not video_url:
            return {"message": "视频生成未返回视频链接"}

    out_dir = Path((output_dir or "").strip()) if (output_dir or "").strip() else DATA_DIR / "outputs"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    try:
        dl = httpx.get(video_url, timeout=DOWNLOAD_TIMEOUT, follow_redirects=True)
        if dl.status_code != 200:
            return {"message": f"视频下载失败（HTTP {dl.status_code}）: {video_url[:200]}"}
        ext = _ext_from_content_type(dl.headers.get("content-type", ""))
        fname = f"video_{stamp}{ext}"
        (out_dir / fname).write_bytes(dl.content)
    except Exception as exc:
        return {"message": f"视频保存失败: {exc}"}

    return {
        "message": "ok",
        "count": 1,
        "results": [
            {
                "file_path": str(out_dir / fname),
                "preview_url": f"/api/files/output?name={fname}",
            }
        ],
        "file_path": str(out_dir / fname),
        "preview_url": f"/api/files/output?name={fname}",
    }
