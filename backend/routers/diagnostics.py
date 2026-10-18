# -*- coding: utf-8 -*-
"""前端异常落盘：把浏览器里抛出的 JS 错误写进 data/js_errors.log。

为什么要这个：SLATE 前端原先没有 window.onerror / unhandledrejection 兜底，
偶发的 RangeError（Maximum call stack size exceeded）只会变成气泡里一句「请求失败: …」，
栈迹就地丢掉，没法定位是哪一层递归/展开炸的。这里只负责「接住并落盘 + 限量回读」，
判定怎么修归前端和开发者，不做任何自动处理。

写入路径定死在 DATA_DIR 下、不接路径参数，避免目录穿越；任何 IO 失败都静默吞掉，
诊断通道绝不能反过来把主流程带崩。
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/diagnostics", tags=["diagnostics"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
LOG_PATH = DATA_DIR / "js_errors.log"

MAX_MESSAGE_CHARS = 600
MAX_STACK_CHARS = 6000
MAX_FILE_BYTES = 512_000
KEEP_BYTES = 200_000
READ_LIMIT_LINES = 200

# 只收字符串字段，长度写死上限：前端塞什么进来都不会把日志撑爆
_SAFE_VERSION_RE = re.compile(r"^[\w.\-+]{0,32}$")


class JsErrorReport(BaseModel):
    message: str = ""
    source: str = ""
    lineno: int = 0
    colno: int = 0
    stack: str = ""
    url: str = ""
    ua: str = ""
    version: str = ""
    at: float = 0.0


def _clip(value: str, limit: int) -> str:
    s = str(value or "")
    return s if len(s) <= limit else s[:limit] + "…"


def _rotate_if_needed() -> None:
    try:
        if LOG_PATH.stat().st_size <= MAX_FILE_BYTES:
            return
        tail = LOG_PATH.read_bytes()[-KEEP_BYTES:]
        cut = tail.find(b"\n")
        if 0 <= cut < len(tail) - 1:
            tail = tail[cut + 1:]
        LOG_PATH.write_bytes(b"\n# truncated to keep recent entries\n" + tail)
    except OSError:
        pass


def _append(line: str) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _rotate_if_needed()
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


@router.post("/js-error")
async def report_js_error(report: JsErrorReport) -> dict[str, Any]:
    """记录一条前端未捕获异常（永不抛错、永不返回失败）。"""
    version = report.version if _SAFE_VERSION_RE.match(report.version or "") else ""
    payload = {
        "at": report.at or time.time(),
        "message": _clip(report.message, MAX_MESSAGE_CHARS),
        "source": _clip(report.source, 300),
        "line": max(0, int(report.lineno or 0)),
        "col": max(0, int(report.colno or 0)),
        "stack": _clip(report.stack, MAX_STACK_CHARS),
        "url": _clip(report.url, 300),
        "ua": _clip(report.ua, 200),
        "version": version,
    }
    try:
        _append(json.dumps(payload, ensure_ascii=False))
    except (TypeError, ValueError):  # 理论不可达，兜住别把 500 抛回前端
        pass
    return {"code": 0, "data": {}, "message": "ok"}


@router.get("/js-error")
async def list_js_errors() -> dict[str, Any]:
    """回读最近的异常记录（设置页/排查时用），文件缺失时返回空列表。"""
    try:
        raw = LOG_PATH.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {"code": 0, "data": {"path": str(LOG_PATH), "errors": []}, "message": "ok"}
    lines = [ln for ln in raw.splitlines() if ln.strip() and not ln.startswith("#")]
    errors: list[dict[str, Any]] = []
    for ln in lines[-READ_LIMIT_LINES:]:
        try:
            errors.append(json.loads(ln))
        except json.JSONDecodeError:
            continue
    return {"code": 0, "data": {"path": str(LOG_PATH), "errors": errors}, "message": "ok"}
