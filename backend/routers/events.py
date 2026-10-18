"""Agent 事件账本路由：一次工具循环（run）的事件按序落账。

前端 agent_ledger.js 把 kernel 观测到的 run/round/call 事件在轮次边界与收尾时
批量 POST 到这里，白板步骤卡与聊天工具卡片都是这份账的投影。

写入语义：
- 单事务 BEGIN IMMEDIATE —— app 内还有 scheduler 后台写者与可能的第二个 uvicorn server，
  并发只靠事务保证，不靠"应该没有第二个写者"的假设。
- INSERT OR IGNORE + UNIQUE(run_id, seq) —— 同一批重放即 no-op，前端可放心重试。
- runs 每批 upsert 且字段 COALESCE —— 只补不覆盖，收尾批把 final 置 1。

时间戳单位是 epoch 毫秒（前端 Date.now()），与 messages.created_at 的秒不同，列名以 _ms 结尾自证。
"""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter

from backend.routers.chat import _get_db

router = APIRouter(prefix="/events", tags=["events"])

MAX_EVENTS_PER_REQUEST = 500
MAX_PAYLOAD_CHARS = 8000
MAX_TURN_DIGEST = 400
MAX_TURN_FULL = 8000
MAX_TEAM_TURNS = 400
MAX_TEAM_SEATS = 20
MAX_INBOX_PENDING = 200

# 星图的角色标签词表；角度与配色由前端 star_map.js 决定，后端只如实存标签
TEAM_ROLES = ("decider", "analyst", "creative", "member")

# 席位来源：ai = 模型发言，human = 真人席位（发言由主持人页面代收后写进账）
TEAM_SEAT_KINDS = ("ai", "human")

# 不算发言的动作：失败、缺席、超时没开口。它们必须留痕，但不能被下一位读成
# "某某的主张"接着反驳，算进星图也会让没开口的席位看起来一样忙。
NOT_SPEECH_ACTIONS = ("error", "skipped", "silent")


def _add_cols(conn, table: str, cols: dict[str, str]) -> None:
    """老库补列：CREATE TABLE IF NOT EXISTS 对已存在的表不加新列，沿用 chat.py 的 PRAGMA 迁移法。

    表名与列名都只来自本模块内的字面量表，不接外部输入。
    """
    existing = {str(r["name"]) for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    for name, decl in cols.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def _team_ddl(conn) -> None:
    """团队会话与参会的落库结构（幂等）。

    team_sessions 存席位名册快照（含冻结色相）与议事状态，team_turns 存每一次发言——
    星图的边从这两张表派生，而不是从 localStorage 派生，关掉页面不该丢历史。

    team_attendees 是与会者票据（只存 token 的 sha256，原文不落库）；team_inbox 是
    与会者发言的收件箱。会话的轮次循环留在主持人页面，所以 team_turns 的写者始终
    只有它一个——单写者正是 UNIQUE(session_id, seq) 这条幂等键还成立的前提，
    与会者的话先落收件箱，由主持人页面按自己的 seq 顺序代收进账。
    """
    conn.execute("""
        CREATE TABLE IF NOT EXISTS team_sessions (
            session_id TEXT PRIMARY KEY,
            conversation_id TEXT DEFAULT '',
            topic TEXT DEFAULT '',
            created_at_ms INTEGER DEFAULT 0,
            ended_at_ms INTEGER DEFAULT 0,
            status TEXT DEFAULT '',
            rounds INTEGER DEFAULT 0,
            verdict_text TEXT DEFAULT '',
            summary_markdown TEXT DEFAULT '',
            members_json TEXT DEFAULT '[]',
            host_device_id TEXT DEFAULT '',
            scope_project_id TEXT DEFAULT '',
            phase TEXT DEFAULT '',
            awaiting_seat_id TEXT DEFAULT '',
            awaiting_since_ms INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS team_turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            round INTEGER DEFAULT 0,
            member_id TEXT DEFAULT '',
            member_name TEXT DEFAULT '',
            role TEXT DEFAULT '',
            model_id TEXT DEFAULT '',
            expert_id TEXT DEFAULT '',
            action TEXT DEFAULT '',
            target_member_id TEXT DEFAULT '',
            run_id TEXT DEFAULT '',
            text_digest TEXT DEFAULT '',
            text_full TEXT DEFAULT '',
            ts INTEGER DEFAULT 0,
            seat_kind TEXT DEFAULT '',
            on_behalf_of TEXT DEFAULT '',
            author_device_id TEXT DEFAULT '',
            UNIQUE(session_id, seq)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS team_attendees (
            attendee_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            seat_id TEXT NOT NULL,
            name TEXT DEFAULT '',
            token_hash TEXT DEFAULT '',
            device_id TEXT DEFAULT '',
            caps_json TEXT DEFAULT '[]',
            joined_at_ms INTEGER DEFAULT 0,
            revoked_at_ms INTEGER DEFAULT 0,
            last_seen_ms INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS team_inbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            seat_id TEXT NOT NULL,
            attendee_id TEXT DEFAULT '',
            action TEXT DEFAULT 'propose',
            target_seat_id TEXT DEFAULT '',
            text TEXT DEFAULT '',
            created_at_ms INTEGER DEFAULT 0,
            consumed_at_ms INTEGER DEFAULT 0
        )
    """)
    # 摘要列留给星图与看板渲染，全文列才是"这一场说过什么"的可追溯正文；
    # 归属三列是"这句话到底是谁说的"的凭据，缺一列就等于把人的发言记成了机器的。
    _add_cols(conn, "team_turns", {
        "text_full": "TEXT DEFAULT ''",
        "seat_kind": "TEXT DEFAULT ''",
        "on_behalf_of": "TEXT DEFAULT ''",
        "author_device_id": "TEXT DEFAULT ''",
    })
    _add_cols(conn, "team_sessions", {
        "host_device_id": "TEXT DEFAULT ''",
        "scope_project_id": "TEXT DEFAULT ''",
        "phase": "TEXT DEFAULT ''",
        "awaiting_seat_id": "TEXT DEFAULT ''",
        "awaiting_since_ms": "INTEGER DEFAULT 0",
    })
    conn.execute("CREATE INDEX IF NOT EXISTS idx_team_turns_session ON team_turns(session_id, seq)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_team_sessions_conv ON team_sessions(conversation_id, created_at_ms)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_team_attendees_session ON team_attendees(session_id, revoked_at_ms)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_team_attendees_token ON team_attendees(token_hash)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_team_inbox_pending ON team_inbox(session_id, consumed_at_ms)")


def _append_ledger_ddl(conn) -> None:
    """建表（幂等）。跟随 chat.py 惯例：每次调用都跑 CREATE TABLE IF NOT EXISTS。"""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            conversation_id TEXT DEFAULT '',
            mode TEXT DEFAULT '',
            started_at_ms INTEGER DEFAULT 0,
            ended_at_ms INTEGER DEFAULT 0,
            status TEXT DEFAULT '',
            budget_rounds INTEGER DEFAULT 0,
            wall_ms INTEGER DEFAULT 0,
            final INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS tool_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            ts INTEGER NOT NULL,
            type TEXT NOT NULL,
            call_id TEXT DEFAULT '',
            parent_call_id TEXT DEFAULT '',
            tool TEXT DEFAULT '',
            message_id TEXT DEFAULT '',
            payload TEXT DEFAULT ''
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tool_events_run ON tool_events(run_id, seq)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_events_seq ON tool_events(run_id, seq)")


def _upsert_run(conn, row: dict[str, Any]) -> None:
    conn.execute(
        "INSERT INTO runs (run_id, conversation_id, mode, started_at_ms, ended_at_ms, "
        "status, budget_rounds, wall_ms, final) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(run_id) DO UPDATE SET "
        "conversation_id = COALESCE(NULLIF(excluded.conversation_id, ''), runs.conversation_id), "
        "mode = COALESCE(NULLIF(excluded.mode, ''), runs.mode), "
        "started_at_ms = CASE WHEN excluded.started_at_ms > 0 THEN excluded.started_at_ms ELSE runs.started_at_ms END, "
        "ended_at_ms = CASE WHEN excluded.ended_at_ms > 0 THEN excluded.ended_at_ms ELSE runs.ended_at_ms END, "
        "status = COALESCE(NULLIF(excluded.status, ''), runs.status), "
        "budget_rounds = CASE WHEN excluded.budget_rounds > 0 THEN excluded.budget_rounds ELSE runs.budget_rounds END, "
        "wall_ms = CASE WHEN excluded.wall_ms > 0 THEN excluded.wall_ms ELSE runs.wall_ms END, "
        "final = MAX(excluded.final, runs.final)",
        (
            row["run_id"],
            row["conversation_id"],
            row["mode"],
            _as_int(row["started_at_ms"]),
            _as_int(row["ended_at_ms"]),
            row["status"],
            _as_int(row["budget_rounds"]),
            _as_int(row["wall_ms"]),
            1 if row["final"] else 0,
        ),
    )


def _run_row(run: dict[str, Any], run_id: str) -> dict[str, Any]:
    """上行 camelCase → 列名 snake_case，一处映射。"""
    return {
        "run_id": run_id,
        "conversation_id": str(run.get("conversationId") or ""),
        "mode": str(run.get("mode") or ""),
        "started_at_ms": run.get("startedAtMs"),
        "ended_at_ms": run.get("endedAtMs"),
        "status": str(run.get("status") or ""),
        "budget_rounds": run.get("budgetRounds"),
        "wall_ms": run.get("wallMs"),
        "final": bool(run.get("final")),
    }


def _as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _clip_payload(event: dict[str, Any]) -> str:
    data = event.get("data")
    if data is None:
        return ""
    try:
        text = json.dumps(data, ensure_ascii=False)
    except (TypeError, ValueError):
        text = json.dumps({"unserializable": str(data)[:500]}, ensure_ascii=False)
    if len(text) <= MAX_PAYLOAD_CHARS:
        return text
    return json.dumps(
        {"truncated": 1, "bytes": len(text), "digest": _as_str(data)[:500]},
        ensure_ascii=False,
    )


def _as_str(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


@router.post("/append")
async def append_events(body: dict[str, Any]) -> dict[str, Any]:
    """追加一批事件。响应只报写入了多少条，读端点属 P6。"""
    run = body.get("run") if isinstance(body.get("run"), dict) else {}
    run_id = str(run.get("runId") or body.get("runId") or "")
    events = body.get("events")
    if not run_id:
        return {"code": 1, "data": None, "message": "缺少 runId"}
    if not isinstance(events, list):
        return {"code": 1, "data": None, "message": "events 必须是数组"}

    events = events[:MAX_EVENTS_PER_REQUEST]
    conn = _get_db()
    conn.isolation_level = None  # 交回事务控制权，显式 BEGIN IMMEDIATE
    inserted = 0
    try:
        _append_ledger_ddl(conn)
        conn.execute("BEGIN IMMEDIATE")
        try:
            _upsert_run(conn, _run_row(run, run_id))
            for event in events:
                if not isinstance(event, dict) or event.get("seq") is None or not event.get("type"):
                    continue
                cur = conn.execute(
                    "INSERT OR IGNORE INTO tool_events "
                    "(run_id, seq, ts, type, call_id, parent_call_id, tool, message_id, payload) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        run_id,
                        _as_int(event.get("seq")),
                        _as_int(event.get("ts")) or int(time.time() * 1000),
                        str(event["type"])[:64],
                        str(event.get("callId") or "")[:64],
                        str(event.get("parentCallId") or "")[:64],
                        str(event.get("tool") or "")[:64],
                        str(event.get("messageId") or "")[:64],
                        _clip_payload(event),
                    ),
                )
                inserted += cur.rowcount
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()

    return {
        "code": 0,
        "data": {
            "runId": run_id,
            "accepted": inserted,
            "dropped": max(0, len(body.get("events") or []) - len(events)),
        },
        "message": "ok",
    }


# ── 团队会话：星图的真数据 ──────────────────────────────

def _member_snapshot(raw: Any) -> list[dict[str, Any]]:
    """名册只留图要用的字段，hue 由前端算好后冻结在这里（同一席位永远同色）。

    席位有两种来源：kind="ai" 的发言来自模型，kind="human" 的发言等人来写。
    这里是白名单——没列到的字段在落库那一刻就丢了，席位新增任何字段都要同步过来。
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        mid = str(item.get("id") or "")[:64]
        if not mid or mid in seen:
            continue
        seen.add(mid)
        kind = str(item.get("kind") or "ai")[:8]
        caps = item.get("caps")
        out.append({
            "id": mid,
            "kind": kind if kind in TEAM_SEAT_KINDS else "ai",
            "name": str(item.get("name") or mid)[:40],
            "role": str(item.get("role") or "member")[:16],
            "modelId": str(item.get("modelId") or "")[:64],
            "expertId": str(item.get("expertId") or "")[:64],
            "hue": _as_int(item.get("hue")) % 360,
            "caps": [str(c)[:16] for c in caps if str(c).strip()][:8] if isinstance(caps, list) else [],
            "fallback": str(item.get("fallback") or "")[:16],
            "timeoutSec": _as_int(item.get("timeoutSec")),
        })
    return out[:MAX_TEAM_SEATS]


def _upsert_team_session(conn, session: dict[str, Any]) -> None:
    conn.execute(
        "INSERT INTO team_sessions (session_id, conversation_id, topic, created_at_ms, ended_at_ms, "
        "status, rounds, verdict_text, summary_markdown, members_json, host_device_id, scope_project_id, "
        "phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(session_id) DO UPDATE SET "
        "conversation_id = COALESCE(NULLIF(excluded.conversation_id, ''), team_sessions.conversation_id), "
        "topic = CASE WHEN excluded.topic != '' THEN excluded.topic ELSE team_sessions.topic END, "
        "created_at_ms = CASE WHEN excluded.created_at_ms > 0 THEN excluded.created_at_ms ELSE team_sessions.created_at_ms END, "
        "ended_at_ms = CASE WHEN excluded.ended_at_ms > 0 THEN excluded.ended_at_ms ELSE team_sessions.ended_at_ms END, "
        "status = COALESCE(NULLIF(excluded.status, ''), team_sessions.status), "
        "rounds = CASE WHEN excluded.rounds > 0 THEN excluded.rounds ELSE team_sessions.rounds END, "
        "verdict_text = CASE WHEN excluded.verdict_text != '' THEN excluded.verdict_text ELSE team_sessions.verdict_text END, "
        "summary_markdown = CASE WHEN excluded.summary_markdown != '' THEN excluded.summary_markdown ELSE team_sessions.summary_markdown END, "
        "members_json = CASE WHEN excluded.members_json != '[]' THEN excluded.members_json ELSE team_sessions.members_json END, "
        "host_device_id = COALESCE(NULLIF(excluded.host_device_id, ''), team_sessions.host_device_id), "
        "scope_project_id = COALESCE(NULLIF(excluded.scope_project_id, ''), team_sessions.scope_project_id), "
        "phase = COALESCE(NULLIF(excluded.phase, ''), team_sessions.phase)",
        (
            str(session.get("id") or "")[:64],
            str(session.get("conversationId") or "")[:64],
            str(session.get("topic") or "")[:200],
            _as_int(session.get("createdAtMs")),
            _as_int(session.get("endedAtMs")),
            str(session.get("status") or "")[:16],
            _as_int(session.get("rounds")),
            str(session.get("verdictText") or "")[:4000],
            str(session.get("summaryMarkdown") or "")[:8000],
            json.dumps(_member_snapshot(session.get("members")), ensure_ascii=False),
            str(session.get("hostDeviceId") or "")[:64],
            str(session.get("scopeProjectId") or "")[:64],
            str(session.get("phase") or "")[:24],
        ),
    )
    # 等待席位与上面几列不同：它要从"有人在等"回到"没人等"，所以不能只补不覆盖。
    # 又因为成员发言的批次里压根不带这个键，只有显式带上时才动它——否则一句普通发言
    # 会把正在进行的等待清掉，主持人页面再也等不到人来。
    if "awaitingSeatId" in session:
        conn.execute(
            "UPDATE team_sessions SET awaiting_seat_id = ?, awaiting_since_ms = ? WHERE session_id = ?",
            (
                str(session.get("awaitingSeatId") or "")[:64],
                _as_int(session.get("awaitingSinceMs")),
                str(session.get("id") or "")[:64],
            ),
        )


@router.post("/team/append")
async def append_team(body: dict[str, Any]) -> dict[str, Any]:
    """写入/追加一场团队讨论。同一 (session_id, seq) 重放即 no-op，前端可放心重试。"""
    session = body.get("session") if isinstance(body.get("session"), dict) else {}
    session_id = str(session.get("id") or "")
    if not session_id:
        return {"code": 1, "data": None, "message": "缺少 session.id"}
    turns = body.get("turns") if isinstance(body.get("turns"), list) else []
    conn = _get_db()
    conn.isolation_level = None
    inserted = 0
    try:
        _team_ddl(conn)
        conn.execute("BEGIN IMMEDIATE")
        try:
            _upsert_team_session(conn, session)
            for turn in turns[:MAX_TEAM_TURNS]:
                if not isinstance(turn, dict) or turn.get("seq") is None:
                    continue
                cur = conn.execute(
                    "INSERT OR IGNORE INTO team_turns (session_id, seq, round, member_id, member_name, role, "
                    "model_id, expert_id, action, target_member_id, run_id, text_digest, text_full, ts, "
                    "seat_kind, on_behalf_of, author_device_id) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        session_id[:64],
                        _as_int(turn.get("seq")),
                        _as_int(turn.get("round")),
                        str(turn.get("memberId") or "")[:64],
                        str(turn.get("memberName") or "")[:40],
                        str(turn.get("role") or "")[:16],
                        str(turn.get("modelId") or "")[:64],
                        str(turn.get("expertId") or "")[:64],
                        str(turn.get("action") or "")[:24],
                        str(turn.get("targetMemberId") or "")[:64],
                        str(turn.get("runId") or "")[:64],
                        str(turn.get("text") or "")[:MAX_TURN_DIGEST],
                        str(turn.get("fullText") or "")[:MAX_TURN_FULL],
                        _as_int(turn.get("ts")) or int(time.time() * 1000),
                        str(turn.get("seatKind") or "ai")[:8],
                        str(turn.get("onBehalfOf") or "")[:64],
                        str(turn.get("authorDeviceId") or "")[:64],
                    ),
                )
                inserted += cur.rowcount
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return {
        "code": 0,
        "data": {"sessionId": session_id, "accepted": inserted},
        "message": "ok",
    }


def _json_members(raw: Any) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def _team_graph(conn, session_row) -> dict[str, Any]:
    """把两张表 + 账本合成星图形状：members / edges(reply) / leaves(spawn) / turns。

    工具与子代理这一侧来自 runs→tool_events：一次成员发言开一个 run，
    run 里的 call.ready 就是这位成员动过的手，parent_call_id 非空的行是它派生的子代理。
    """
    session_id = str(session_row["session_id"])
    members = _json_members(session_row["members_json"])
    member_ids = {m.get("id") for m in members}
    turns = [
        {
            "seq": r["seq"],
            "round": r["round"],
            "memberId": r["member_id"],
            "memberName": r["member_name"],
            "role": r["role"],
            "action": r["action"],
            "targetMemberId": r["target_member_id"],
            "runId": r["run_id"],
            "digest": r["text_digest"],
            "fullText": r["text_full"],
            "ts": r["ts"],
            # 归属：老库补列前写下的行 seat_kind 为空串，读出来一律按 "ai" 认——
            # 那之前本来就还没有人类席位，空串当归一类不会冤枉谁。
            "seatKind": r["seat_kind"] or "ai",
            "onBehalfOf": r["on_behalf_of"],
            "authorDeviceId": r["author_device_id"],
        }
        for r in conn.execute(
            "SELECT seq, round, member_id, member_name, role, action, target_member_id, run_id, "
            "text_digest, text_full, ts, seat_kind, on_behalf_of, author_device_id "
            "FROM team_turns WHERE session_id = ? ORDER BY seq ASC LIMIT ?",
            (session_id, MAX_TEAM_TURNS),
        ).fetchall()
    ]

    # reply 边：只承认名册里的成员之间，@ 到一个不存在的名字不该凭空造一颗星
    edge_weights: dict[tuple[str, str], int] = {}
    for turn in turns:
        src, dst = turn["memberId"], turn["targetMemberId"]
        if not src or src not in member_ids or dst not in member_ids or src == dst:
            continue
        key = (src, dst)
        edge_weights[key] = edge_weights.get(key, 0) + 1
    edges = [{"from": a, "to": b, "kind": "reply", "weight": w} for (a, b), w in edge_weights.items()]

    run_to_member = {t["runId"]: t["memberId"] for t in turns if t["runId"] and t["memberId"] in member_ids}
    leaves: dict[tuple[str, str, str], dict[str, Any]] = {}

    def _collect(sql: str, kind: str) -> None:
        """按"每调用只发一次"的事件型取叶子：call.ready 每个调用一条，
        subagent.started 每个子代理一条——用 finished 会一个调用数出三遍。"""
        if not run_to_member:
            return
        placeholders = ",".join("?" * len(run_to_member))
        for row in conn.execute(sql.format(placeholders=placeholders), tuple(run_to_member)).fetchall():
            mid = run_to_member.get(row["run_id"]) or ""
            tool = str(row["tool"] or "") or ("subagent" if kind == "subagent" else "")
            if not mid or not tool:
                continue
            key = (mid, tool, kind)
            rec = leaves.get(key)
            if rec:
                rec["count"] += 1
            else:
                leaves[key] = {"id": f"{mid}:{tool}:{kind}", "memberId": mid, "label": tool, "kind": kind, "count": 1}

    _collect(
        "SELECT run_id, call_id, tool FROM tool_events "
        "WHERE type = 'call.ready' AND parent_call_id = '' AND run_id IN ({placeholders})",
        "tool",
    )
    _collect(
        "SELECT run_id, call_id, tool FROM tool_events "
        "WHERE type = 'subagent.started' AND parent_call_id <> '' AND run_id IN ({placeholders})",
        "subagent",
    )

    turns_by_member: dict[str, int] = {}
    for turn in turns:
        # 「失败」「未参与」「超时没开口」是留痕不是发言：算进星图会让没开口的席位看起来一样忙
        if turn["memberId"] in member_ids and turn["action"] not in NOT_SPEECH_ACTIONS:
            turns_by_member[turn["memberId"]] = turns_by_member.get(turn["memberId"], 0) + 1
    members = [{**m, "turns": turns_by_member.get(m.get("id"), 0)} for m in members]
    return {
        "session": {
            "id": session_id,
            "conversationId": session_row["conversation_id"],
            "topic": session_row["topic"],
            "status": session_row["status"],
            "createdAtMs": session_row["created_at_ms"],
            "endedAtMs": session_row["ended_at_ms"],
            "rounds": session_row["rounds"],
            "verdict": session_row["verdict_text"],
            # 重读一场旧讨论要能拿回总结正文，否则从库里只能重建发言、重建不了收尾那屏
            "summaryMarkdown": session_row["summary_markdown"],
            "hostDeviceId": session_row["host_device_id"],
            "scopeProjectId": session_row["scope_project_id"],
            "phase": session_row["phase"],
            "awaitingSeatId": session_row["awaiting_seat_id"],
            "awaitingSinceMs": session_row["awaiting_since_ms"],
        },
        "members": members,
        "edges": edges,
        "leaves": list(leaves.values()),
        "turns": turns,
    }


@router.get("/team/latest")
async def latest_team(conversationId: str = "") -> dict[str, Any]:
    """这场对话最近一次团队讨论的星图数据。声明在 /{session_id} 之前，否则 latest 会被当成 id。"""
    conn = _get_db()
    try:
        _team_ddl(conn)
        sql = "SELECT * FROM team_sessions"
        args: tuple[Any, ...] = ()
        if conversationId:
            sql += " WHERE conversation_id = ?"
            args = (conversationId,)
        sql += " ORDER BY created_at_ms DESC LIMIT 1"
        row = conn.execute(sql, args).fetchone()
        if row is None:
            return {"code": 0, "data": None, "message": "尚无团队记录"}
        return {"code": 0, "data": _team_graph(conn, row), "message": "ok"}
    finally:
        conn.close()


@router.get("/team/{session_id}")
async def read_team(session_id: str) -> dict[str, Any]:
    conn = _get_db()
    try:
        _team_ddl(conn)
        row = conn.execute("SELECT * FROM team_sessions WHERE session_id = ?", (session_id[:64],)).fetchone()
        if row is None:
            return {"code": 1, "data": None, "message": "找不到这场团队讨论"}
        return {"code": 0, "data": _team_graph(conn, row), "message": "ok"}
    finally:
        conn.close()
