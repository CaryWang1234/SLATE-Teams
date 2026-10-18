"""磨墨模式路由：磨墨会话状态机（idle / grinding / collecting）。

磨墨会话本身仍是普通对话消息，本路由只管会话级状态与持久化：
- POST   /api/grind/sessions          开启磨墨（同一对话复用已有会话）
- GET    /api/grind/sessions/{conv}   查询会话状态（不存在返回 state=idle）
- PATCH  /api/grind/sessions/{conv}   更新轮数/已定项/墨稿
- POST   /api/grind/sessions/{conv}/collect  转入收墨（collecting）
- DELETE /api/grind/sessions/{conv}   结束并归档会话

数据存内存 + data/grind_sessions/{conv_id}.json，刷新页面后可恢复。
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from backend.data_io import atomic_write_json

router = APIRouter(prefix="/grind", tags=["grind"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
SESSIONS_DIR = DATA_DIR / "grind_sessions"

# 内存缓存：conv_id -> session dict
_sessions: dict[str, dict[str, Any]] = {}

MAX_ROUNDS = 10

# 会话 ID 只允许字母/数字/下划线/连字符，防止 `../`、`%5C` 等路径穿越写/删任意 .json
_CONV_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _sanitize_conv_id(conv_id: str | None) -> str | None:
    """校验并规范化会话 ID；非法时返回 None。"""
    conv_id = (conv_id or "").strip()
    if not _CONV_ID_RE.match(conv_id):
        return None
    return conv_id


def _load_all() -> None:
    """启动时从磁盘恢复会话。"""
    if _sessions or not SESSIONS_DIR.is_dir():
        return
    for f in SESSIONS_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("conversation_id"):
                _sessions[data["conversation_id"]] = data
        except (OSError, json.JSONDecodeError):
            continue


def _persist(session: dict[str, Any]) -> None:
    try:
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        path = SESSIONS_DIR / f"{session['conversation_id']}.json"
        atomic_write_json(path, session)
    except OSError:
        pass


def _archive(conv_id: str) -> None:
    _sessions.pop(conv_id, None)
    try:
        path = SESSIONS_DIR / f"{conv_id}.json"
        if path.exists():
            path.unlink()
    except OSError:
        pass


@router.post("/sessions")
async def start_session(body: dict[str, Any]) -> dict[str, Any]:
    """开启磨墨会话；同一对话已有进行中会话时直接复用。"""
    conv_id = _sanitize_conv_id(body.get("conversation_id"))
    if not conv_id:
        return {"code": -1, "data": None, "message": "conversation_id 不能为空或包含非法字符"}

    _load_all()
    existing = _sessions.get(conv_id)
    if existing and existing["state"] in ("grinding", "collecting"):
        return {"code": 0, "data": existing, "message": "ok"}

    session = {
        "conversation_id": conv_id,
        "state": "grinding",
        "idea": str(body.get("idea") or "").strip(),
        "round": 0,
        "max_rounds": MAX_ROUNDS,
        "resolved": [str(x) for x in (body.get("resolved") or [])],
        "draft": body.get("draft"),
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    _sessions[conv_id] = session
    _persist(session)
    return {"code": 0, "data": session, "message": "ok"}


@router.get("/sessions/{conv_id}")
async def get_session(conv_id: str) -> dict[str, Any]:
    """查询会话状态；不存在时返回 idle 占位。"""
    safe_id = _sanitize_conv_id(conv_id)
    if not safe_id:
        return {"code": -1, "data": None, "message": "会话 ID 不合法"}
    _load_all()
    session = _sessions.get(safe_id)
    if not session:
        return {"code": 0, "data": {"conversation_id": safe_id, "state": "idle"}, "message": "ok"}
    return {"code": 0, "data": session, "message": "ok"}


@router.patch("/sessions/{conv_id}")
async def update_session(conv_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """更新会话的轮数、已定项与墨稿。"""
    safe_id = _sanitize_conv_id(conv_id)
    if not safe_id:
        return {"code": -1, "data": None, "message": "会话 ID 不合法"}
    _load_all()
    session = _sessions.get(safe_id)
    if not session:
        return {"code": -1, "data": None, "message": "磨墨会话不存在"}

    if isinstance(body.get("round"), int) and body["round"] >= 0:
        session["round"] = min(body["round"], MAX_ROUNDS + 1)
    if isinstance(body.get("resolved"), list):
        session["resolved"] = [str(x) for x in body["resolved"] if str(x).strip()]
    if "draft" in body and isinstance(body.get("draft"), dict):
        session["draft"] = body["draft"]
        session["state"] = "done"
    if body.get("state") in ("grinding", "collecting", "done"):
        session["state"] = body["state"]
    session["updated_at"] = time.time()

    _persist(session)
    return {"code": 0, "data": session, "message": "ok"}


@router.post("/sessions/{conv_id}/collect")
async def collect_session(conv_id: str) -> dict[str, Any]:
    """转入收墨状态：下一轮助手回复直接输出墨稿。"""
    safe_id = _sanitize_conv_id(conv_id)
    if not safe_id:
        return {"code": -1, "data": None, "message": "会话 ID 不合法"}
    _load_all()
    session = _sessions.get(safe_id)
    if not session:
        return {"code": -1, "data": None, "message": "磨墨会话不存在"}
    if session["state"] != "done":
        session["state"] = "collecting"
        session["updated_at"] = time.time()
        _persist(session)
    return {"code": 0, "data": session, "message": "ok"}


@router.delete("/sessions/{conv_id}")
async def end_session(conv_id: str) -> dict[str, Any]:
    """结束并归档会话（清除状态文件）。"""
    safe_id = _sanitize_conv_id(conv_id)
    if not safe_id:
        return {"code": -1, "data": None, "message": "会话 ID 不合法"}
    _load_all()
    _archive(safe_id)
    return {"code": 0, "data": None, "message": "ok"}
