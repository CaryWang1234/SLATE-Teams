"""SLATE Teams 议事厅：与会者票据、作用域收窄、发言收件箱。

一台机器上跑着主持人（后端 + 模型 Key + 工作区），其余人用浏览器接入同一场讨论。
这个模块只管"谁能进来、能碰什么、话怎么递进来"三件事；轮次推进仍在主持人页面。

三条不可退让的口径：

1. **与会者不是"缩小版的遥控"**。局域网遥控给的是一张全权门票——能看所有会话、
   改设置、跑任何工具。做团队时必须反过来：**默认拒绝，只放行一张很短的清单**
   （见 `check_lan_scope`）。逐个去证明"这个端点安全"是证明不完的。

2. **token 原文不落库**。库里只留 sha256，票据可撤回（`revoked_at_ms`）；与会者的
   昵称、权限、设备都挂在票据上，请求里带来的参数一律不作数——会话从票据推出来，
   否则改一个 query 参数就能读到别人的会。

3. **与会者不直接写 team_turns**。轮次循环留在主持人页面（那里才有工具与审批层），
   所以 `team_turns` 的写者始终唯一，`UNIQUE(session_id, seq)` 这条幂等键才成立。
   与会者的话先落 `team_inbox`，由主持人页面按自己的 seq 顺序代收进账。
"""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from typing import Any, Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend.routers import lan
from backend.routers.chat import _get_db
from backend.routers.events import _team_ddl

router = APIRouter(prefix="/teams", tags=["teams"])

# 与会者能拿到的权限。签发时勾选，请求时只按票据上记的算。
CAPS = ("speak", "signoff")

# 与会者能提交的动作：与前端 parseDebateAction 认的那几个词同源。
# "late" 是轮外插话——主持人页面决定是当场播报还是留到下一轮。
SAY_ACTIONS = ("propose", "support", "oppose", "rebut", "supplement", "late")

MAX_INBOX_TEXT = 4000
MAX_TAKE = 50
# 在线判定的新鲜度：多久没有心跳就算不在（人合上笔记本、走出门都靠这个兜住）
PRESENCE_TTL_MS = 20_000


# ── 票据 ────────────────────────────────────────────────

def _hash_token(token: str) -> str:
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


def _new_token() -> str:
    return secrets.token_urlsafe(24)


def _attendee_row(conn, token: str):
    if not token:
        return None
    return conn.execute(
        "SELECT * FROM team_attendees WHERE token_hash = ? AND revoked_at_ms = 0",
        (_hash_token(token),),
    ).fetchone()


def resolve_lan_actor(request: Request) -> dict[str, Any] | None:
    """局域网端口上这道请求是谁发的：带票据的与会者，其余交给 lan 认主 token。

    这个函数由 main.py 注入给 lan（团队模块反过来 import lan 会成环，所以走钩子）。

    票据→身份的解析带一层内存缓存：一次页面加载几十个静态请求，每个都去连库查一遍
    纯属浪费；库仍是事实源，撤回时把缓存清掉即可。
    """
    token = lan.presented_token(request)
    if not token:
        return None
    key = _hash_token(token)
    cached = _actor_cache.get(key)
    if cached is not None:
        return cached
    conn = _get_db()
    try:
        _team_ddl(conn)
        row = _attendee_row(conn, token)
        if row is None:
            return None
        caps = []
        try:
            parsed = json.loads(row["caps_json"] or "[]")
            caps = [str(c) for c in parsed] if isinstance(parsed, list) else []
        except (TypeError, ValueError):
            caps = []
        actor = {
            "kind": "attendee",
            "attendeeId": str(row["attendee_id"]),
            "seatId": str(row["seat_id"]),
            "name": str(row["name"]),
            "caps": caps,
        }
        _actor_cache[key] = actor
        return actor
    finally:
        conn.close()


def _actor_of(request: Request) -> dict[str, Any] | None:
    """当前请求的 actor。主端口（本机）恒为主持人——与会者根本接不到那个端口。"""
    if not lan.is_lan_request(request):
        return {"kind": "host", "attendeeId": "", "seatId": "", "name": "", "caps": []}
    token = lan.presented_token(request)
    if token and lan.is_master_token(token):
        return {"kind": "host", "attendeeId": "", "seatId": "", "name": "", "caps": []}
    return resolve_lan_actor(request)


# ── 作用域：与会者能碰的只有这张短清单 ──────────────────────

ATTENDEE_ALLOWED_PREFIXES = (
    "/api/teams/",   # 议事厅自己的面，每个端点还会各自判权限
    "/api/i18n/",    # 界面词典：不是秘密，且不认它会退回中文
)


def check_lan_scope(request: Request, actor: dict[str, Any]) -> JSONResponse | None:
    """与会者的越界请求在这里被挡下。返回 None = 放行。

    静态文件不设限：前端源码本来就是公开的，真正的边界在 API——设置、文件、
    技能执行、会话历史全在 /api/ 底下。所以这里只对 /api/ 做白名单，
    默认拒绝，而不是逐个列出"安全的端点"。
    """
    if actor.get("kind") == "host":
        return None
    path = request.url.path
    if not path.startswith("/api/"):
        return None
    if any(path.startswith(prefix) for prefix in ATTENDEE_ALLOWED_PREFIXES):
        return None
    return JSONResponse(
        status_code=403,
        content={"code": 403, "data": None, "message": "与会者只能访问被邀请的那一场讨论"},
    )


def _host_only(actor: dict[str, Any]) -> JSONResponse | None:
    if actor.get("kind") == "host":
        return None
    return JSONResponse(
        status_code=403,
        content={"code": 403, "data": None, "message": "这个操作只能由主持人在本机进行"},
    )


# ── 在线态 ──────────────────────────────────────────────
#
# 只在内存里：进程一重启就全清空。落库的话重启后会把上次的"在线"读回来，
# 界面上一排鬼在线比不显示在线更糟。库里只留 last_seen_ms 做"上次出现"的痕迹。

_presence: dict[str, dict[str, Any]] = {}
# sha256(token) → actor。只在一次进程里有效；撤回时清掉，重启后自然重查。
_actor_cache: dict[str, dict[str, Any]] = {}


def _touch(attendee_id: str, state: str = "") -> None:
    rec = _presence.setdefault(attendee_id, {})
    rec["last"] = int(time.time() * 1000)
    if state:
        rec["state"] = state


def _presence_of(attendee_id: str) -> dict[str, Any]:
    rec = _presence.get(attendee_id) or {}
    last = int(rec.get("last") or 0)
    fresh = last > 0 and (int(time.time() * 1000) - last) < PRESENCE_TTL_MS
    return {
        "online": fresh,
        "state": str(rec.get("state") or "") if fresh else "away",
        "lastSeenMs": last,
    }


# ── 会话解析：从票据推，不看请求参数 ────────────────────────

def _session_for_seat(conn, seat_id: str):
    """这个席位最近的那场讨论。

    按席位反查而不是把 session_id 写在票据上：邀请通常发在开会之前，
    那时讨论还没开始；而且同一套名册会被反复用来开好几场。
    """
    if not seat_id:
        return None
    # 模式串由 json.dumps 自己拼出来（它怎么写名册，这里就怎么找），
    # 免得手写一个空格差异就让反查永远找不到——那种坏法不会报错，只会一直"还没开始"。
    like = '%"id": ' + json.dumps(seat_id, ensure_ascii=False) + '%'
    return conn.execute(
        "SELECT * FROM team_sessions WHERE members_json LIKE ? ORDER BY created_at_ms DESC LIMIT 1",
        (like,),
    ).fetchone()


def _session_graph(conn, session_row) -> dict[str, Any]:
    """复用 events 里那份星图投影，不另写一套读数。"""
    from backend.routers import events  # 局部导入：events 不 import teams，不会成环

    return events._team_graph(conn, session_row)


# ── 主持人面 ────────────────────────────────────────────

@router.post("/invite")
async def create_invite(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    """签发一张与会者票据。token 只在这一次响应里出现，之后库里只有它的 sha256。"""
    actor = _actor_of(request)
    denied = _host_only(actor)
    if denied is not None:
        return denied

    seat_id = str(body.get("seatId") or "")[:64]
    if not seat_id:
        return {"code": 1, "data": None, "message": "缺少 seatId"}
    name = str(body.get("name") or "")[:40] or seat_id
    caps = [c for c in (body.get("caps") or ["speak"]) if str(c) in CAPS]
    if not caps:
        caps = ["speak"]

    token = _new_token()
    attendee_id = "att_" + secrets.token_hex(6)
    now = int(time.time() * 1000)
    conn = _get_db()
    conn.isolation_level = None
    try:
        _team_ddl(conn)
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                "INSERT INTO team_attendees (attendee_id, session_id, seat_id, name, token_hash, "
                "device_id, caps_json, joined_at_ms, revoked_at_ms, last_seen_ms) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
                (
                    attendee_id,
                    str(body.get("sessionId") or "")[:64],
                    seat_id,
                    name,
                    _hash_token(token),
                    str(body.get("deviceId") or "")[:64],
                    json.dumps(caps, ensure_ascii=False),
                    now,
                ),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()

    return {
        "code": 0,
        "data": {
            "attendeeId": attendee_id,
            "seatId": seat_id,
            "name": name,
            "caps": caps,
            "token": token,
            # 专门落到议事厅那一页：与会者不需要（也不该）看到主持人的整套工作台
            "inviteUrl": lan.invite_url(token),
        },
        "message": "ok",
    }


@router.post("/revoke")
async def revoke_invite(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    actor = _actor_of(request)
    denied = _host_only(actor)
    if denied is not None:
        return denied
    attendee_id = str(body.get("attendeeId") or "")[:64]
    if not attendee_id:
        return {"code": 1, "data": None, "message": "缺少 attendeeId"}
    conn = _get_db()
    try:
        _team_ddl(conn)
        cur = conn.execute(
            "UPDATE team_attendees SET revoked_at_ms = ? WHERE attendee_id = ? AND revoked_at_ms = 0",
            (int(time.time() * 1000), attendee_id),
        )
        conn.commit()
    finally:
        conn.close()
    _presence.pop(attendee_id, None)
    # 缓存不清的话，被踢掉的人会在这一进程的余生里继续通行
    for key, cached in list(_actor_cache.items()):
        if cached.get("attendeeId") == attendee_id:
            _actor_cache.pop(key, None)
    return {"code": 0, "data": {"revoked": cur.rowcount}, "message": "ok"}


@router.get("/attendees")
async def list_attendees(request: Request, sessionId: str = "") -> dict[str, Any]:
    """名册 + 在线态。主持人页面据此画席位栏上的在线点。"""
    actor = _actor_of(request)
    denied = _host_only(actor)
    if denied is not None:
        return denied
    conn = _get_db()
    try:
        _team_ddl(conn)
        sql = ("SELECT attendee_id, session_id, seat_id, name, caps_json, device_id, "
               "joined_at_ms, last_seen_ms FROM team_attendees WHERE revoked_at_ms = 0")
        args: tuple[Any, ...] = ()
        if sessionId:
            sql += " AND session_id = ?"
            args = (sessionId[:64],)
        sql += " ORDER BY joined_at_ms ASC"
        rows = conn.execute(sql, args).fetchall()
    finally:
        conn.close()
    out = []
    for row in rows:
        try:
            caps = json.loads(row["caps_json"] or "[]")
        except (TypeError, ValueError):
            caps = []
        out.append({
            "attendeeId": row["attendee_id"],
            "sessionId": row["session_id"],
            "seatId": row["seat_id"],
            "name": row["name"],
            "caps": caps,
            "deviceId": row["device_id"],
            "joinedAtMs": row["joined_at_ms"],
            **_presence_of(str(row["attendee_id"])),
        })
    return {"code": 0, "data": {"attendees": out}, "message": "ok"}


@router.post("/inbox/take")
async def take_inbox(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    """主持人页面取走待处理的与会者发言，取走即标记已消费（同一批不会收两次）。

    用 POST 而不是 GET：这个动作会改状态，GET 被浏览器/代理预取一次就会把话吃掉。
    """
    actor = _actor_of(request)
    denied = _host_only(actor)
    if denied is not None:
        return denied
    session_id = str(body.get("sessionId") or "")[:64]
    if not session_id:
        return {"code": 1, "data": None, "message": "缺少 sessionId"}
    limit = max(1, min(MAX_TAKE, int(body.get("limit") or MAX_TAKE)))
    # 可以只取某一个席位的话：主持人等 A 发言时若把整队都取走，B 的话就被"消费"掉了，
    # 谁也看不到——收件箱是消费型的，取错一批就是静默吞话。
    seat_filter = str(body.get("seatId") or "")[:64]
    now = int(time.time() * 1000)
    conn = _get_db()
    conn.isolation_level = None
    try:
        _team_ddl(conn)
        conn.execute("BEGIN IMMEDIATE")
        try:
            sql = ("SELECT i.id, i.seat_id, i.attendee_id, i.action, i.target_seat_id, i.text, "
                   "i.created_at_ms, a.device_id FROM team_inbox i "
                   "LEFT JOIN team_attendees a ON a.attendee_id = i.attendee_id "
                   "WHERE i.session_id = ? AND i.consumed_at_ms = 0")
            args: list[Any] = [session_id]
            if seat_filter:
                sql += " AND i.seat_id = ?"
                args.append(seat_filter)
            sql += " ORDER BY i.id ASC LIMIT ?"
            args.append(limit)
            rows = conn.execute(sql, tuple(args)).fetchall()
            ids = [int(r["id"]) for r in rows]
            if ids:
                placeholders = ",".join("?" * len(ids))
                conn.execute(
                    f"UPDATE team_inbox SET consumed_at_ms = ? WHERE id IN ({placeholders})",
                    (now, *ids),
                )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return {"code": 0, "data": {"items": [dict(r) for r in rows]}, "message": "ok"}


@router.post("/awaiting")
async def set_awaiting(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    """把"正等着谁开口"写到会话上：与会者页面靠它显示"轮到你"。"""
    actor = _actor_of(request)
    denied = _host_only(actor)
    if denied is not None:
        return denied
    session_id = str(body.get("sessionId") or "")[:64]
    if not session_id:
        return {"code": 1, "data": None, "message": "缺少 sessionId"}
    seat_id = str(body.get("seatId") or "")[:64]
    since = int(body.get("sinceMs") or time.time() * 1000) if seat_id else 0
    conn = _get_db()
    try:
        _team_ddl(conn)
        cur = conn.execute(
            "UPDATE team_sessions SET awaiting_seat_id = ?, awaiting_since_ms = ? WHERE session_id = ?",
            (seat_id, since, session_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"code": 0, "data": {"updated": cur.rowcount, "awaitingSeatId": seat_id}, "message": "ok"}


# ── 与会者面 ────────────────────────────────────────────

@router.get("/session")
async def attendee_session(request: Request) -> dict[str, Any]:
    """与会者看到的这一场：名册、发言、等待席位，外加"我是谁"。

    会话完全由票据推出来，不接受任何来自请求的 sessionId —— 否则改个参数就能读别人的会。
    """
    actor = _actor_of(request)
    if actor is None:
        return JSONResponse(status_code=401, content={"code": 401, "data": None, "message": "票据无效"})
    if actor.get("kind") == "host":
        return {"code": 1, "data": None, "message": "主持人请用工作台里的团队面板"}
    _touch(str(actor["attendeeId"]))
    conn = _get_db()
    try:
        _team_ddl(conn)
        row = _session_for_seat(conn, str(actor["seatId"]))
        if row is None:
            # 邀请通常发在开会之前：会话还没建，页面显示"等主持人开始"而不是报错
            return {
                "code": 0,
                "data": {
                    "me": {"seatId": actor["seatId"], "name": actor["name"], "caps": actor["caps"]},
                    "phase": "idle",
                    "session": None,
                },
                "message": "尚未开始",
            }
        graph = _session_graph(conn, row)
    finally:
        conn.close()
    graph["me"] = {"seatId": actor["seatId"], "name": actor["name"], "caps": actor["caps"]}
    return {"code": 0, "data": graph, "message": "ok"}


@router.post("/say")
async def attendee_say(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    """与会者发言：写进收件箱，由主持人页面代收进账。"""
    actor = _actor_of(request)
    if actor is None or actor.get("kind") != "attendee":
        return JSONResponse(status_code=401, content={"code": 401, "data": None, "message": "票据无效"})
    if "speak" not in (actor.get("caps") or []):
        return {"code": 1, "data": None, "message": "这张票据没有发言权限"}
    text = str(body.get("text") or "").strip()
    if not text:
        return {"code": 1, "data": None, "message": "内容为空"}
    action = str(body.get("action") or "propose")
    if action not in SAY_ACTIONS:
        action = "propose"
    conn = _get_db()
    conn.isolation_level = None
    try:
        _team_ddl(conn)
        row = _session_for_seat(conn, str(actor["seatId"]))
        if row is None:
            return {"code": 1, "data": None, "message": "这一场还没开始，先等主持人"}
        session_id = str(row["session_id"])
        conn.execute("BEGIN IMMEDIATE")
        try:
            cur = conn.execute(
                "INSERT INTO team_inbox (session_id, seat_id, attendee_id, action, target_seat_id, text, "
                "created_at_ms, consumed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                (
                    session_id,
                    str(actor["seatId"])[:64],
                    str(actor["attendeeId"])[:64],
                    action,
                    str(body.get("targetSeatId") or "")[:64],
                    text[:MAX_INBOX_TEXT],
                    int(time.time() * 1000),
                ),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    _touch(str(actor["attendeeId"]))
    return {"code": 0, "data": {"inboxId": cur.lastrowid, "sessionId": session_id}, "message": "ok"}


@router.post("/presence")
async def attendee_presence(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    """心跳。state 只认「在 / 暂离」两态，托管是主持人的事，不由与会者自称。"""
    actor = _actor_of(request)
    if actor is None or actor.get("kind") != "attendee":
        return JSONResponse(status_code=401, content={"code": 401, "data": None, "message": "票据无效"})
    state = str(body.get("state") or "in")
    if state not in ("in", "away"):
        state = "in"
    _touch(str(actor["attendeeId"]), state)
    now = int(time.time() * 1000)
    conn = _get_db()
    try:
        _team_ddl(conn)
        conn.execute(
            "UPDATE team_attendees SET last_seen_ms = ? WHERE attendee_id = ?",
            (now, str(actor["attendeeId"])),
        )
        conn.commit()
    finally:
        conn.close()
    return {"code": 0, "data": {"state": state, "lastSeenMs": now}, "message": "ok"}
