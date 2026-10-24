"""办公室路由：AI 员工、值班表、工位通信与任务队列。

「员工」不是「会自己开口的会话」。差别落在四件事上：
1. 员工有名册（岗位、职责、模型、轮数预算、是否托管），活在库里，跨重启还在；
2. 员工有值班表（定时 / 事件），到点由后端时钟排一次队；
3. 员工之间会递话（office_messages），递话可以唤起对方，但有转述上限；
4. 活本身是一条队列（office_jobs），执行人是主持人页面——那里才有工具与审批层。

三条不可退让的口径：

1. 后端只排队，不执行。执行需要工具调用、高危审批、API Key，那些全在页面上
   （与团队轮次循环留在主持人页面同口径）。所以 job 的状态机是
   queued → running → done/error/stopped/blocked/dropped，running 由页面 CAS 领取产生，
   崩溃/关页靠租约过期退回 queued，绝不出现「看着在跑其实早死了」。
   blocked 与 dropped 是**等人**的状态：不是失败，也不由后端自行复活。

2. 唤起必须有止损线。A 给 B 递话就唤起 B，B 回一句又唤起 A——这条链不加约束
   就是两台机器互相踢皮球到永远。hop 随队列往下传，到 MAX_HOPS 就不再唤起，
   消息照常落库并在返回里写明「已达转述上限」，让跑着的那一趟去给人汇报。

3. 时钟复用 scheduler 的判据，不另写一套文件/Git 探测。到期算法
   （_should_run / _should_run_event）与快照缓存都直接取 scheduler 那一份：
   两处实现迟早分叉成「定时任务会触发、值班表不会」。

还有一条与上面三条同量级：**需要判断的事一律走 job，不在后端偷偷做**。值班表的守卫
（guard）只允许确定性预检——时间窗、队列条数、Git HEAD、仓库自带的自检脚本；一旦要读
内容、权衡、总结，就排一条活让页面跑。员工的「今天干什么」也是活（分诊 job），
不是后端里的一个 planner。
"""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import subprocess
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request

from backend import project_registry as registry
from backend.ai_features import feature_enabled
from backend.routers import scheduler
from backend.routers.chat import _get_db

router = APIRouter(prefix="/office", tags=["office"])

# 一次领取最多搬几条：领太多会把这台机器的并行额度全占走，用户自己的对话就排不上了
CLAIM_MAX = 2
# 领取后多久没人续约就算掉了（页面刷新 / 崩掉 / 关窗都靠这一条兜住）
LEASE_MS = 120_000
# 同一条 job 最多被领几次：第 2 次还死掉就判失败，不再无限重放
JOB_MAX_ATTEMPTS = 2
# 员工之间最多互相转述几手
MAX_HOPS = 6

MAX_NAME_CHARS = 24
MAX_ROLE_CHARS = 40
MAX_DUTY_TEXT_CHARS = 6000
MAX_BRIEF_CHARS = 6000
MAX_MESSAGE_CHARS = 4000
MAX_RESULT_CHARS = 20000
MAX_ROUNDS_BUDGET = 24

# 员工自己写的备忘：每人只留最近这么多条。不设上限，prompt 迟早被自己的历史撑爆
MAX_NOTES = 40
MAX_NOTE_CHARS = 1200
NOTE_KINDS = ("open", "ledger", "blocked")
# 一次晨会分诊最多处置多少条活（一条 job 里想完今天要干什么）
MAX_TRIAGE_DECISIONS = 30
TRIAGE_ACTIONS = ("keep", "defer", "drop")
# 优先级：0 普通，越大越先办；用户点头复活的活按这一档重新排队
REVIVED_PRIORITY = 2
# 审校门禁：交付先进审校人那一侧，过了才到用户手上。判定由那位同事做（是一条 job），
# 后端只做「谁的 gate 是谁」「这条还欠审校」这类确定性核对。
REVIEW_VERDICTS = ("approve", "return")
# 交给审校那一趟的正文长度：够他判合格与否，又不至于把一次往返的窗口吃掉
REVIEW_RESULT_CHARS = 6000
# 审校那一趟排在队里的位置与期限：欠着的审校本身就是一条挂账，不该排在普通活后面
REVIEW_PRIORITY = 1
REVIEW_DUE_MS = 2 * 3600 * 1000
# 预算熔断：今天用超之后，值班不再排新活（已排队的照旧办完，用户自己交办也不拦）。
# 两条开口：晨会分诊照排——它正是「剩这点预算该干什么」的判断本身，禁了熔断就变成自锁；
# 手动交班照排——人按下那一下由人负责，与守卫刻意绕闸同一口径。
# 设计稿那句「只排 priority <= 2 的活」在这里落不成 priority 过滤：新排的值班活一律 priority=0，
# 只有分诊会给队列里的活抬顺序，所以同一句话在这套实现里等于「不再排新的值班活」。
# 期限升级：每一跳最多升级几条过期未办的活（一次灌满动态栏会把人淹没，等于没提醒）
SLA_ESCALATE_MAX = 5
# 站会那一行自报的长度
STANDUP_LINE_CHARS = 160
# 守卫预检里的自检脚本：只跑仓库自带的 check_*.mjs，文件名先过白名单，绝不接外部命令串
GUARD_SCRIPT = re.compile(r"^check_[a-z0-9_]+\.mjs$")
GUARD_SCRIPT_TIMEOUT_S = 25
# 自检结果只留这么多字进值班状态（够看清是哪条判据红了）
GUARD_OUTPUT_CHARS = 400
REPO_ROOT = Path(__file__).resolve().parents[2]

# 招聘模板：只当「填好的表单」用，不落库（落库就变成第五张表和一堆同步问题）
TEMPLATES = (
    {
        "key": "researcher",
        "name": "研究员",
        "role": "资料与取证",
        "glyph": "研",
        "hue": 210,
        "duty_text": "你负责把问题问清楚再回答：先查项目里的现成实现与文档，再动手。\n"
                     "每条结论都要带出处（文件路径与行号，或抓到的原文片段）；"
                     "查不到就明说没查到，不要臆测。\n"
                     "产出是一份能直接给人用的判断清单，不是过程叙述。",
    },
    {
        "key": "engineer",
        "name": "工程师",
        "role": "改代码与验证",
        "glyph": "工",
        "hue": 150,
        "duty_text": "你负责动手改：先读懂相关代码再改，改动要小且可回滚。\n"
                     "改完必须自己验证——跑已有的检查或测试，把逐字输出贴进结论。\n"
                     "没有验证过的事情不写成「已修好」。",
    },
    {
        "key": "reviewer",
        "name": "审校",
        "role": "复核与挑刺",
        "glyph": "审",
        "hue": 20,
        "duty_text": "你负责复核别人的产出：找事实错误、漏掉的边界、说了一半的结论。\n"
                     "每条意见指出位置与判据，给可执行的修改方向；不重写、不代做。\n"
                     "找不到问题时也要说明检查过哪些面。",
    },
    {
        "key": "warden",
        "name": "值班管家",
        "role": "巡检与提醒",
        "glyph": "值",
        "hue": 265,
        "duty_text": "你负责盯着交代给你的那些面：按值班表巡检，只报有变化的部分。\n"
                     "发现需要人决定的事情就写清「等谁、等什么、不处理会怎样」。\n"
                     "没事的时候一句话说明检查了什么，不要长篇汇报。",
    },
)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


def _office_ddl(conn) -> None:
    """办公室的落库结构（幂等）。

    employees 是名册；employee_duties 是每个人的值班表；office_jobs 是队列——
    队列必须落库而不是留在页面内存里，因为「到点了」发生在后端时钟里，
    那一刻页面可能根本没开（合盖、没开机、用户在看别的会话）。
    office_messages 是工位之间的传话，本身也是办公室动态流的内容。
    """
    conn.execute("""
        CREATE TABLE IF NOT EXISTS employees (
            employee_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            role TEXT DEFAULT '',
            duty_text TEXT DEFAULT '',
            model_id TEXT DEFAULT '',
            glyph TEXT DEFAULT '',
            hue INTEGER DEFAULT 0,
            rounds_budget INTEGER DEFAULT 8,
            unattended INTEGER DEFAULT 0,
            status TEXT DEFAULT 'idle',
            project_id TEXT DEFAULT '',
            objective TEXT DEFAULT '',
            review_gate TEXT DEFAULT '',
            daily_token_cap INTEGER DEFAULT 0,
            created_at_ms INTEGER DEFAULT 0,
            last_seen_ms INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS employee_duties (
            duty_id TEXT PRIMARY KEY,
            employee_id TEXT NOT NULL,
            name TEXT DEFAULT '',
            prompt TEXT DEFAULT '',
            guard TEXT DEFAULT '',
            triage INTEGER DEFAULT 0,
            mode TEXT DEFAULT 'daily',
            time TEXT DEFAULT '',
            every_minutes INTEGER DEFAULT 0,
            event_type TEXT DEFAULT '',
            watch_paths TEXT DEFAULT '',
            git_repo TEXT DEFAULT '',
            webhook_secret TEXT DEFAULT '',
            cooldown_seconds INTEGER DEFAULT 60,
            max_runs INTEGER DEFAULT 0,
            until_ms INTEGER DEFAULT 0,
            runs INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1,
            last_run_ms INTEGER DEFAULT 0,
            last_status TEXT DEFAULT '',
            project_id TEXT DEFAULT '',
            created_at_ms INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS office_jobs (
            job_id TEXT PRIMARY KEY,
            employee_id TEXT NOT NULL,
            employee_name TEXT DEFAULT '',
            origin TEXT DEFAULT 'manual',
            duty_id TEXT DEFAULT '',
            thread_id TEXT DEFAULT '',
            hop INTEGER DEFAULT 0,
            brief TEXT DEFAULT '',
            status TEXT DEFAULT 'queued',
            kind TEXT DEFAULT 'work',
            priority INTEGER DEFAULT 0,
            due_ms INTEGER DEFAULT 0,
            state_reason TEXT DEFAULT '',
            decided_by TEXT DEFAULT '',
            review_of TEXT DEFAULT '',
            review_state TEXT DEFAULT '',
            tokens INTEGER DEFAULT 0,
            sla_notified INTEGER DEFAULT 0,
            claim_token TEXT DEFAULT '',
            attempts INTEGER DEFAULT 0,
            conversation_id TEXT DEFAULT '',
            result_text TEXT DEFAULT '',
            error TEXT DEFAULT '',
            rounds INTEGER DEFAULT 0,
            tool_calls INTEGER DEFAULT 0,
            project_id TEXT DEFAULT '',
            enqueued_at_ms INTEGER DEFAULT 0,
            claimed_at_ms INTEGER DEFAULT 0,
            lease_ms INTEGER DEFAULT 0,
            finished_at_ms INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS office_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT DEFAULT '',
            hop INTEGER DEFAULT 0,
            from_kind TEXT DEFAULT 'employee',
            from_id TEXT DEFAULT '',
            from_name TEXT DEFAULT '',
            to_kind TEXT DEFAULT 'user',
            to_id TEXT DEFAULT '',
            to_name TEXT DEFAULT '',
            text TEXT DEFAULT '',
            job_id TEXT DEFAULT '',
            wake INTEGER DEFAULT 0,
            created_at_ms INTEGER DEFAULT 0,
            read_at_ms INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS employee_notes (
            note_id TEXT PRIMARY KEY,
            employee_id TEXT NOT NULL,
            kind TEXT DEFAULT 'open',
            text TEXT DEFAULT '',
            ref TEXT DEFAULT '',
            job_id TEXT DEFAULT '',
            created_at_ms INTEGER DEFAULT 0,
            updated_at_ms INTEGER DEFAULT 0
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_duties_employee ON employee_duties(employee_id, enabled)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_queue ON office_jobs(status, priority, enqueued_at_ms)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_employee ON office_jobs(employee_id, enqueued_at_ms)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_msgs_target ON office_messages(to_kind, to_id, read_at_ms)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_employee ON employee_notes(employee_id, kind, updated_at_ms)")
    _ensure_cols(conn)


# 早先建起来的库里没有这几列：CREATE TABLE IF NOT EXISTS 不会补，缺了就当场 ALTER 一次。
# 表名与列名都写死在这张常量表里（不来自任何外部输入），拼进 DDL 才安全。
_ADDED_COLS = (
    ("employees", "objective", "TEXT DEFAULT ''"),
    ("employee_duties", "guard", "TEXT DEFAULT ''"),
    ("employee_duties", "triage", "INTEGER DEFAULT 0"),
    ("office_jobs", "kind", "TEXT DEFAULT 'work'"),
    ("office_jobs", "priority", "INTEGER DEFAULT 0"),
    ("office_jobs", "due_ms", "INTEGER DEFAULT 0"),
    ("office_jobs", "state_reason", "TEXT DEFAULT ''"),
    ("office_jobs", "decided_by", "TEXT DEFAULT ''"),
    ("employees", "review_gate", "TEXT DEFAULT ''"),
    ("employees", "daily_token_cap", "INTEGER DEFAULT 0"),
    ("office_jobs", "review_of", "TEXT DEFAULT ''"),
    ("office_jobs", "review_state", "TEXT DEFAULT ''"),
    ("office_jobs", "tokens", "INTEGER DEFAULT 0"),
    ("office_jobs", "sla_notified", "INTEGER DEFAULT 0"),
)


def _ensure_cols(conn) -> None:
    for table, column, ddl in _ADDED_COLS:
        have = {str(r["name"]) for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in have:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
    conn.commit()


# ── 行 → 界面形状 ──────────────────────────────────

def _employee_row(row) -> dict[str, Any]:
    return {
        "employeeId": row["employee_id"],
        "name": row["name"],
        "role": row["role"],
        "dutyText": row["duty_text"],
        "modelId": row["model_id"],
        "glyph": row["glyph"],
        "hue": int(row["hue"] or 0),
        "roundsBudget": int(row["rounds_budget"] or 8),
        "unattended": bool(int(row["unattended"] or 0)),
        "status": row["status"] or "idle",
        "projectId": row["project_id"],
        "objective": row["objective"] or "",
        "reviewGate": row["review_gate"] or "",
        "dailyTokenCap": int(row["daily_token_cap"] or 0),
        "createdAtMs": int(row["created_at_ms"] or 0),
        "lastSeenMs": int(row["last_seen_ms"] or 0),
    }


def _note_row(row) -> dict[str, Any]:
    return {
        "noteId": row["note_id"],
        "employeeId": row["employee_id"],
        "kind": row["kind"] or "open",
        "text": row["text"] or "",
        "ref": row["ref"] or "",
        "jobId": row["job_id"] or "",
        "createdAtMs": int(row["created_at_ms"] or 0),
        "updatedAtMs": int(row["updated_at_ms"] or 0),
    }


def _duty_row(row) -> dict[str, Any]:
    return {
        "dutyId": row["duty_id"],
        "employeeId": row["employee_id"],
        "name": row["name"],
        "prompt": row["prompt"],
        "guard": row["guard"] or "",
        "triage": bool(int(row["triage"] or 0)),
        "mode": row["mode"],
        "time": row["time"],
        "everyMinutes": int(row["every_minutes"] or 0),
        "eventType": row["event_type"],
        "watchPaths": row["watch_paths"],
        "gitRepo": row["git_repo"],
        "hasWebhookSecret": bool(row["webhook_secret"]),
        "cooldownSeconds": int(row["cooldown_seconds"] or 60),
        "maxRuns": int(row["max_runs"] or 0),
        "untilMs": int(row["until_ms"] or 0),
        "runs": int(row["runs"] or 0),
        "enabled": bool(int(row["enabled"] or 0)),
        "lastRunMs": int(row["last_run_ms"] or 0),
        "lastStatus": row["last_status"],
        "projectId": row["project_id"],
        "createdAtMs": int(row["created_at_ms"] or 0),
    }


def _job_row(row, *, full: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "jobId": row["job_id"],
        "employeeId": row["employee_id"],
        "employeeName": row["employee_name"],
        "origin": row["origin"],
        "dutyId": row["duty_id"],
        "threadId": row["thread_id"],
        "hop": int(row["hop"] or 0),
        "brief": row["brief"],
        "status": row["status"],
        "kind": row["kind"] or "work",
        "priority": int(row["priority"] or 0),
        "dueMs": int(row["due_ms"] or 0),
        "stateReason": row["state_reason"] or "",
        "decidedBy": row["decided_by"] or "",
        "reviewOf": row["review_of"] or "",
        "reviewState": row["review_state"] or "",
        "tokens": int(row["tokens"] or 0),
        "slaNotified": int(row["sla_notified"] or 0),
        "attempts": int(row["attempts"] or 0),
        "conversationId": row["conversation_id"],
        "rounds": int(row["rounds"] or 0),
        "toolCalls": int(row["tool_calls"] or 0),
        "projectId": row["project_id"],
        "enqueuedAtMs": int(row["enqueued_at_ms"] or 0),
        "claimedAtMs": int(row["claimed_at_ms"] or 0),
        "finishedAtMs": int(row["finished_at_ms"] or 0),
        "error": row["error"],
    }
    if full:
        out["resultText"] = row["result_text"]
    return out


def _message_row(row) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "threadId": row["thread_id"],
        "hop": int(row["hop"] or 0),
        "fromKind": row["from_kind"],
        "fromId": row["from_id"],
        "fromName": row["from_name"],
        "toKind": row["to_kind"],
        "toId": row["to_id"],
        "toName": row["to_name"],
        "text": row["text"],
        "jobId": row["job_id"],
        "wake": int(row["wake"] or 0),
        "createdAtMs": int(row["created_at_ms"] or 0),
        "readAtMs": int(row["read_at_ms"] or 0),
    }


def _write(conn, sql: str, args: tuple) -> int:
    """单条写入并回受影响行数。办公室的写全是小事务，只有领取需要 CAS。"""
    cur = conn.execute(sql, args)
    conn.commit()
    return cur.rowcount


def _employee_of(conn, employee_id: str):
    return conn.execute(
        "SELECT * FROM employees WHERE employee_id = ?", (employee_id[:64],)
    ).fetchone()


# ── 到期判断（判据取自 scheduler，不在这里重写）────────────────

def _as_schedule_row(duty: dict[str, Any]) -> dict[str, Any]:
    """把值班表的一条打扮成 scheduler 认识的样子。

    scheduler 的 last_run/created_at 是秒，这里存的是毫秒——换算只在这一个函数里做，
    两处各写各的除法迟早有一天会写成乘。
    """
    return {
        "id": duty.get("dutyId", ""),
        "mode": duty.get("mode", "daily"),
        "time": duty.get("time", ""),
        "every_minutes": duty.get("everyMinutes", 0),
        "event_type": duty.get("eventType", ""),
        "watch_paths": duty.get("watchPaths", ""),
        "git_repo": duty.get("gitRepo", ""),
        "cooldown_seconds": duty.get("cooldownSeconds", 60),
        "project_id": duty.get("projectId", ""),
        "last_run": (duty.get("lastRunMs") or 0) / 1000.0,
        "created_at": (duty.get("createdAtMs") or 0) / 1000.0,
    }


def _duty_due(conn, duty: dict[str, Any], now_ts: float) -> str:
    """这条值班到点没有；返回触发原因（空串＝不触发）。"""
    until = int(duty.get("untilMs") or 0)
    if until and _now_ms() > until:
        _retire_duty(conn, duty["dutyId"], "已到截止日期，值班自动停用")
        return ""
    if duty.get("mode") == "event":
        return "event" if scheduler._should_run_event(_as_schedule_row(duty)) else ""
    if scheduler._should_run(_as_schedule_row(duty), now_ts):
        return "time"
    return ""


def _retire_duty(conn, duty_id: str, note: str) -> None:
    _write(conn, "UPDATE employee_duties SET enabled = 0, last_status = ? WHERE duty_id = ?",
           (note, duty_id[:64]))


# ── 排队 ─────────────────────────────────────────

def _enqueue(conn, *, employee_id: str, employee_name: str, brief: str, origin: str,
             duty_id: str = "", thread_id: str = "", hop: int = 0,
             project_id: str = "", kind: str = "work",
             priority: int = 0, due_ms: int = 0, review_of: str = "") -> str:
    """排一条活进队列。

    归属项目在排活这一刻定死并写进 job：页面上「当前打开的项目」随时会变，
    晚点再认就会把 A 项目的值班活跑到 B 项目的根上。
    """
    job_id = _new_id("job")
    _write(conn,
           "INSERT INTO office_jobs (job_id, employee_id, employee_name, origin, duty_id, "
           "thread_id, hop, brief, status, kind, priority, due_ms, project_id, review_of, "
           "enqueued_at_ms) "
           "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
           (job_id, employee_id, employee_name, origin, duty_id, thread_id, hop,
            brief[:MAX_BRIEF_CHARS], kind, max(0, int(priority or 0)),
            max(0, int(due_ms or 0)), project_id, review_of[:64], _now_ms()))
    return job_id


def _mark_duty_fired(conn, duty_id: str, status: str) -> None:
    """记一次触发：跑过几轮、最后一次什么时候、为什么没跑成。

    once 模式跑过一次就下值——和 scheduler 的 once 同口径，否则每天重复同一件事。
    """
    conn.execute(
        "UPDATE employee_duties SET last_run_ms = ?, last_status = ?, runs = runs + 1, "
        "enabled = CASE WHEN mode = 'once' THEN 0 ELSE enabled END WHERE duty_id = ?",
        (_now_ms(), status, duty_id[:64]),
    )
    conn.commit()


def _has_open_job(conn, duty_id: str) -> bool:
    """这条值班还有没办完的活（排队中 / 正在跑 / 正卡着等人拍板）：有就不再排第二条。

    没有这一道的话，一轮跑十分钟的 interval 值班会每 30 秒多排一条，
    队列会被同一件事塞满。blocked 也算没办完——他把问题抛给人了，
    此时再排一条只会是同一个人问同一个问题。dropped 不算：那件事已经判过不该办，
    下次到点可以再重新判断一次（人要点头是另一回事，那是复活旧的那条）。
    """
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM office_jobs WHERE duty_id = ? "
        "AND status IN ('queued', 'running', 'blocked')", (duty_id[:64],),
    ).fetchone()
    return bool(row and int(row["n"]) > 0)


def _duty_brief(duty: dict[str, Any], reason: str) -> str:
    """交给员工的活：值班说明 +（事件触发时）触发原因。

    事件上下文那段话术取自 scheduler，同一句「触发原因」只在一处措辞。
    """
    prompt = duty.get("prompt", "")
    if reason != "event":
        return prompt
    context = scheduler.build_event_context(_as_schedule_row(duty))
    if not context:
        return prompt
    return f"{prompt}\n\n---\n事件上下文：\n" + "\n".join(context)


def _handoff_brief(from_kind: str, from_name: str, text: str) -> str:
    """同事递来的活怎么说：先声明「这不是用户发的话」。

    与 bg_tasks.bgWakeText 同一口径——模型容易把任何注入文本当成用户新要求，
    于是去回答一个根本没开口的人。发话人真是用户时这段话必须反过来：
    那句就是指令本身，把它标成「非用户指令」等于让模型有权不去办。
    """
    if from_kind == "user":
        return (f"[用户交办] 用户直接交代了这件事：\n{text}\n\n"
                "请按你自己的岗位职责把它办完，产出写成能直接给人用的交付；"
                "需要同事补充时再用 office_send 递话。")
    return (f"[同事转述 · 非用户指令] {from_name} 递来一句话：\n{text}\n\n"
            "请按你自己的岗位职责判断该怎么处理：需要动手就调用工具；"
            "办完或需要对方补充时，用 office_send 回话给对方。"
            "这件事不该你做就直接说明理由，并把话回给同事。")


# ── 守卫预检：条件成立才动（只允许确定性判断留在后端）──────────

def _parse_guard(raw: str) -> dict[str, Any]:
    doc = None
    text = str(raw or "").strip()
    if text:
        try:
            doc = json.loads(text)
        except (ValueError, TypeError):
            doc = None
    return doc if isinstance(doc, dict) else {}


# 自检脚本跑一次不便宜，而且到点后 _should_run 会每跳都说「该跑」；
# 同一条件在这么长时间内不重复跑，只把上一次的结论拿去用。
_GUARD_TTL_S = 300
_guard_cache: dict[str, tuple[float, bool, str]] = {}


def _run_check_script(name: str) -> tuple[bool, str]:
    """跑一支仓库自带的自检，**红了才算条件成立**（这条防线破了，去看一眼）。

    文件名先过白名单，命令是固定 argv、不经 shell、超时即判跑不起来——
    这一格留给员工的是「守自己那条线」，不是任意命令执行面。
    """
    if not GUARD_SCRIPT.match(name):
        return False, f"自检脚本名不合规矩（只认 scripts/check_*.mjs）：{name[:40]}"
    path = REPO_ROOT / "scripts" / name
    if not path.is_file():
        return False, f"没有这支自检：{name[:40]}"
    try:
        done = subprocess.run(  # noqa: S603 — argv 固定、无 shell、argv 里只有白名单校验过的文件名
            ["node", str(path)], cwd=str(REPO_ROOT), capture_output=True, text=True,
            timeout=GUARD_SCRIPT_TIMEOUT_S, encoding="utf-8", errors="replace")
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"跑不起来：{str(exc)[:80]}"
    blob = "\n".join(x for x in (done.stdout or "", done.stderr or "") if x).strip()
    tail = blob[-GUARD_OUTPUT_CHARS:]
    if done.returncode != 0:
        return True, f"自检 {name} 红了：{tail}"
    return False, f"自检 {name} 还是绿的"


def _probe_row(duty: dict[str, Any], kind: str, doc: dict[str, Any]) -> dict[str, Any]:
    """把一条值班（或它的一格守卫条件）打扮成 scheduler 的探测器认识的那一行。

    file_change 与 git_push 两条路径共用：守卫条件与事件值班走的是同一份探测与同一份缓存，
    这样「事件值班会触发、守卫条件不会」这种分叉从源头上就没有。
    """
    row = _as_schedule_row(duty)
    row["event_type"] = kind
    if kind == "file_change":
        paths = doc.get("paths")
        if isinstance(paths, list) and paths:
            row["watch_paths"] = "\n".join(str(p) for p in paths)
        elif isinstance(paths, str) and paths.strip():
            # 面板那一格是单行输入框：字符串就是它写的那一行，口径与事件值班的 watchPaths 同一套
            # （都交给 scheduler 按行拆）。只认 list 的话，用户填的路径会被静默丢掉，去盯项目根。
            row["watch_paths"] = paths.strip()
    elif kind == "git_push":
        if doc.get("repo"):
            row["git_repo"] = str(doc["repo"])
    return row


def _guard_probe(duty: dict[str, Any], kind: str, doc: dict[str, Any]) -> bool:
    """把守卫条件交给 scheduler 那份探测器去判。

    探测算法、mtime/HEAD 缓存与冷却全在它手里；这里只是把条件换成事件类型再问一次——
    写第二份探测迟早分叉成「事件值班会触发、守卫条件不会」。
    """
    return bool(scheduler._should_run_event(_probe_row(duty, kind, doc)))


def _guard_passes(conn, duty: dict[str, Any]) -> tuple[bool, str]:
    """这条值班现在该动吗；返回 (该动, 不该动时写进状态的原因)。

    只允许确定性判断——队列条数、文件时间窗、Git HEAD、仓库自带的自检。
    要读内容、要权衡、要总结，那就是活本身该做的事（排 job 让页面跑），
    在这里判就等于让后端悄悄调了一次模型，那条路一律不开。
    """
    doc = _parse_guard(duty.get("guard") or "")
    kind = str(doc.get("kind") or "")
    if not kind:
        return True, ""
    duty_id = str(duty["dutyId"])
    if kind == "open_jobs_max":
        want = max(0, int(doc.get("n") or 0))
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM office_jobs WHERE employee_id = ? "
            "AND status IN ('queued', 'running', 'blocked')", (str(duty["employeeId"])[:64],),
        ).fetchone()
        n = int((row["n"] if row else 0) or 0)
        if n > want:
            return False, f"守卫：手上还压着 {n} 条（阈值 {want}），这一轮不排"
        return True, ""
    if kind == "file_change":
        if not _guard_probe(duty, "file_change", doc):
            return False, "守卫：盯的文件这段时间没动，不排"
        return True, ""
    if kind == "git_head":
        if not _guard_probe(duty, "git_push", doc):
            return False, "守卫：仓库 HEAD 没变，不排"
        return True, ""
    if kind == "check_script":
        now = time.time()
        cached = _guard_cache.get(duty_id)
        if cached and now - cached[0] < _GUARD_TTL_S:
            return cached[1], "" if cached[1] else cached[2] + "，这一轮不排"
        fired, note = _run_check_script(str(doc.get("script") or ""))
        _guard_cache[duty_id] = (now, fired, note)
        return (True, "") if fired else (False, note + "，这一轮不排")
    # 认不出的条件不当没写：静默照排会让人以为那道守卫在生效
    return False, f"守卫：认不出这个条件（{kind[:24]}），这一轮不排"


def _mark_duty_skipped(conn, duty_id: str, reason: str) -> None:
    """被守卫拦下的这一轮：只写原因，不动 runs 与 last_run_ms——他还没真跑过。

    把 last_run_ms 一起写就等于替这条值班「记了一次成功」，到点判据下一跳就不让了，
    结果是一条从没办过的班看起来天天在办。
    """
    _write(conn, "UPDATE employee_duties SET last_status = ? WHERE duty_id = ?",
           (reason[:MAX_BRIEF_CHARS], duty_id[:64]))


# ── 后台时钟 ─────────────────────────────────────

_clock_started = False
# 正在排队的 duty：一次 tick 内的防重入口
_firing: set[str] = set()


def _reap_leases(conn) -> None:
    """租约过期就把活退回队列；退无可退就判失败。

    页面崩掉时 job 会永远停在 running——那比报错更糟，因为看起来「有人在办」。
    第 JOB_MAX_ATTEMPTS 次仍然死掉就不再重放：反复死掉的多半不是意外，重放只会刷满队列。
    """
    now = _now_ms()
    stale = conn.execute(
        "SELECT job_id, attempts, employee_id FROM office_jobs "
        "WHERE status = 'running' AND lease_ms > 0 AND lease_ms < ?", (now,),
    ).fetchall()
    for row in stale:
        attempts = int(row["attempts"] or 0)
        if attempts >= JOB_MAX_ATTEMPTS:
            _write(conn,
                   "UPDATE office_jobs SET status = 'error', error = ?, finished_at_ms = ?, "
                   "lease_ms = 0 WHERE job_id = ? AND status = 'running'",
                   (f"执行页面断开，已放弃重放（第 {attempts} 次）", now, row["job_id"]))
        else:
            _write(conn,
                   "UPDATE office_jobs SET status = 'queued', claim_token = '', lease_ms = 0, "
                   "claimed_at_ms = 0 WHERE job_id = ? AND status = 'running'",
                   (row["job_id"],))
        _sync_employee_status(conn, str(row["employee_id"]))


def _sync_employee_status(conn, employee_id: str) -> None:
    """状态灯的唯一事实源：队列里有什么，灯就是什么。

    不让页面自己点亮灯——它报 done 之前若崩了，灯就永远停在「在忙」。
    """
    row = conn.execute(
        "SELECT "
        "SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running, "
        "SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued, "
        "SUM(CASE WHEN status IN ('blocked', 'dropped') THEN 1 ELSE 0 END) AS pending "
        "FROM office_jobs WHERE employee_id = ?", (employee_id[:64],),
    ).fetchone()
    running = int((row["running"] if row else 0) or 0)
    queued = int((row["queued"] if row else 0) or 0)
    pending = int((row["pending"] if row else 0) or 0)
    if running > 0:
        # 在忙还要再分一刀：有没送走的「等你拍板」时，这一位真正需要的是人回来
        waiting = conn.execute(
            "SELECT COUNT(*) AS n FROM office_messages WHERE to_kind = 'user' AND read_at_ms = 0 "
            "AND from_id = ?", (employee_id[:64],),
        ).fetchone()
        status = "waiting" if int((waiting["n"] if waiting else 0) or 0) > 0 else "busy"
    elif pending > 0:
        # 卡住或被判「不该办」的活等他点头——这比有活排在前面更需要人回来
        status = "waiting"
    elif queued > 0:
        status = "busy"
    else:
        status = "idle"
    _write(conn, "UPDATE employees SET status = ? WHERE employee_id = ?",
           (status, employee_id[:64]))


def _day_start_ms(now_s: float) -> int:
    """本机这一天的 00:00（毫秒）。预算按日历日熔断，窗口得落在用户看得见的那一天上。"""
    lt = time.localtime(now_s)
    return int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1)) * 1000)


def _budget_over(conn, employee_id: str, now_s: float) -> tuple[bool, str]:
    """今天这位员工的 token 用超了没。读的是 office_jobs.tokens 那一列——
    引擎在收口时把这一趟的用量交回，与 daily_usage 同一份估算口径，不另起一套埋点。

    cap=0 就是没设限；这里只回答「还排不排新值班活」，已排队的照旧办完：
    把已经交给他的活半路掐了，比让他办完更贵，也更难解释。
    """
    emp = conn.execute("SELECT daily_token_cap FROM employees WHERE employee_id = ?",
                       (employee_id[:64],)).fetchone()
    cap = int(emp["daily_token_cap"] or 0) if emp is not None else 0
    if cap <= 0:
        return False, ""
    used = conn.execute(
        "SELECT COALESCE(SUM(tokens), 0) AS n FROM office_jobs "
        "WHERE employee_id = ? AND finished_at_ms >= ?",
        (employee_id[:64], _day_start_ms(now_s))).fetchone()
    n = int((used["n"] if used else 0) or 0)
    if n < cap:
        return False, ""
    return True, f"预算：今天已用 {n} / 上限 {cap}，新的值班活不再排（已排队的照旧办完）"


async def _sla_watch(conn, now: int) -> None:
    """过期还没办的活升级给人：一条 job 只喊一次，sla_notified 就是那一枚幂等印章。

    不改状态、不重排队列、不重排优先级——期限到了不代表这件事不该办，只代表该有人知道
    它还没办完。递话复用 /messages 那一条通路（不另写第二份 INSERT），
    发给用户的那条 read_at_ms=0，未读只在动态栏摊开时才销账。
    """
    rows = conn.execute(
        "SELECT job_id, employee_name, brief, due_ms FROM office_jobs "
        "WHERE status IN ('queued', 'blocked') AND due_ms > 0 AND due_ms < ? AND sla_notified = 0 "
        "ORDER BY due_ms ASC LIMIT ?", (now, SLA_ESCALATE_MAX)).fetchall()
    for row in rows:
        job_id = str(row["job_id"])
        mins = max(1, int((now - int(row["due_ms"])) / 60000))
        await post_message({
            "fromKind": "system", "fromId": "", "fromName": "期限",
            "toKind": "user", "jobId": job_id,
            "text": f"这条活过期 {mins} 分钟还没办完（经办 {row['employee_name']}）："
                    f"{str(row['brief'])[:200]}",
        })
        # 印章写在递话之后：万一中间炸了，下一跳还会再喊一次，比永远不喊好
        _write(conn, "UPDATE office_jobs SET sla_notified = 1 WHERE job_id = ?", (job_id,))


async def _tick() -> None:
    now_ts = time.time()
    conn = _get_db()
    try:
        _office_ddl(conn)
        _reap_leases(conn)
        # 期限升级排在值班之前：没有值班也照样可能有活儿过期挂着，那一栏不该跟着空转
        await _sla_watch(conn, int(now_ts * 1000))
        duties = [dict(r) for r in conn.execute(
            "SELECT * FROM employee_duties WHERE enabled = 1 ORDER BY created_at_ms ASC").fetchall()]
        if not duties:
            return
        employees = {str(r["employee_id"]): dict(r) for r in
                     conn.execute("SELECT * FROM employees").fetchall()}
        for raw in duties:
            duty = _duty_row(raw)
            if duty["dutyId"] in _firing:
                continue
            emp = employees.get(duty["employeeId"])
            if not emp:
                _retire_duty(conn, duty["dutyId"], "员工已离职，值班自动停用")
                continue
            reason = _duty_due(conn, duty, now_ts)
            if not reason:
                continue
            if not feature_enabled("scheduled_task"):
                # 这一档关掉就一条活都不排，并把原因写明：用户看到的不是「值班表坏了」
                _mark_duty_fired(conn, duty["dutyId"],
                                 "「定时与事件任务」已在设置中关闭（设置 → AI 辅助功能）")
                continue
            if _has_open_job(conn, duty["dutyId"]):
                _mark_duty_fired(conn, duty["dutyId"], "上一次交班还没办完，这一轮跳过")
                continue
            passed, why = _guard_passes(conn, duty)
            if not passed:
                # 到点了但条件不成立：写清楚为什么没排，且不替他记一次成功运行
                _mark_duty_skipped(conn, duty["dutyId"], why)
                continue
            if not duty["triage"]:
                # 预算熔断只管普通值班活：分诊那趟正是「剩这点预算该干什么」的判断，
                # 把它也禁掉会让熔断变成自锁——再也排不出能重新排顺序的那一趟。
                over, budget_why = _budget_over(conn, duty["employeeId"], now_ts)
                if over:
                    _mark_duty_skipped(conn, duty["dutyId"], budget_why)
                    continue
            _firing.add(duty["dutyId"])
            try:
                pid = duty["projectId"] or str(emp.get("project_id") or "")
                job_id = _enqueue(conn, employee_id=duty["employeeId"],
                                  employee_name=str(emp["name"]),
                                  brief=_duty_brief(duty, reason),
                                  origin="duty", duty_id=duty["dutyId"],
                                  thread_id=duty["dutyId"], project_id=pid,
                                  kind="triage" if duty["triage"] else "work")
                _mark_duty_fired(conn, duty["dutyId"], f"已排入队列 {job_id}")
                _sync_employee_status(conn, duty["employeeId"])
            finally:
                _firing.discard(duty["dutyId"])
    finally:
        conn.close()


async def _loop() -> None:
    while True:
        try:
            await _tick()
        except Exception:
            pass
        await asyncio.sleep(30)


def start_office_clock() -> None:
    """装上办公室的时钟，并把值班的文件/Git 快照铺进 scheduler 那份缓存。

    快照必须和探测用同一套路径口径（沿用 scheduler 的 _default_watch_paths），
    否则后端一起来就把整批在盯的文件当成「新建」而误触发一次。
    """
    global _clock_started
    if _clock_started:
        return
    _clock_started = True
    seed_event_snapshots()
    asyncio.create_task(_loop())


def seed_event_snapshots() -> None:
    conn = _get_db()
    try:
        _office_ddl(conn)
        duties = [dict(r) for r in conn.execute(
            "SELECT * FROM employee_duties WHERE enabled = 1").fetchall()]
    finally:
        conn.close()
    for raw in duties:
        duty = _duty_row(raw)
        event_type = duty.get("eventType") or ""
        # 事件值班的探测对象，与守卫条件（挂在任何模式上）的探测对象，两份都要铺快照：
        # 没有基线，第一跳就会把整批在盯的文件当成「刚变更」而误排一次活。
        wanted = []
        if event_type in ("file_change", "git_push"):
            wanted.append((event_type, _as_schedule_row(duty)))
        doc = _parse_guard(duty.get("guard") or "")
        guard_kind = str(doc.get("kind") or "")
        if guard_kind == "file_change":
            wanted.append(("file_change", _probe_row(duty, "file_change", doc)))
        elif guard_kind == "git_head":
            wanted.append(("git_push", _probe_row(duty, "git_push", doc)))
        for kind, row in wanted:
            _seed_probe(kind, row)


def _seed_probe(kind: str, row: dict[str, Any]) -> None:
    if kind == "file_change":
        for fp in scheduler._default_watch_paths(row):
            if fp.is_file():
                scheduler._file_mtimes[str(fp.resolve())] = fp.stat().st_mtime
            elif fp.is_dir():
                try:
                    for f in fp.rglob("*"):
                        if f.is_file():
                            scheduler._file_mtimes[str(f.resolve())] = f.stat().st_mtime
                except OSError:
                    pass
    elif kind == "git_push":
        rp = scheduler.resolve_repo_path(row.get("git_repo") or "")
        head = scheduler.read_git_head(rp)
        if rp and head:
            scheduler._git_heads[str(rp.resolve())] = head


# ── API：名册 ────────────────────────────────────

def _first_line(text: str, limit: int) -> str:
    """取正文第一行有字的那句作为自报：站会那一行要的是「他说他要干什么」，不是整份交付。"""
    for line in str(text or "").splitlines():
        stripped = line.strip().lstrip("#-*· ").strip()
        if stripped:
            return stripped[:limit]
    return ""


def _standup(conn) -> list[dict[str, Any]]:
    """今日站会：每人一行自报，取自他最近一趟跑完的晨会分诊正文。

    不落第五张表——分诊那一趟本来就要「说清有什么、缺什么、打算办什么」，
    再让他为界面单独写一份就是同一个意思写两处，早晚对不上。
    """
    rows = conn.execute(
        "SELECT employee_id, result_text, finished_at_ms FROM office_jobs "
        "WHERE kind = 'triage' AND status = 'done' AND result_text <> '' "
        "ORDER BY finished_at_ms DESC").fetchall()
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        eid = str(row["employee_id"])
        if eid in seen:
            continue
        seen.add(eid)
        line = _first_line(str(row["result_text"]), STANDUP_LINE_CHARS)
        if not line:
            continue
        out.append({"employeeId": eid, "line": line, "atMs": int(row["finished_at_ms"] or 0)})
    return out


def _performance(conn, employees: list[dict[str, Any]], day_start_ms: int) -> list[dict[str, Any]]:
    """绩效一人一行：全部从 office_jobs 现算，不新写埋点。

    平均耗时用的是领取到收口那一段（claimed_at_ms → finished_at_ms）——这一条链路
    本来就要落这两枚时间戳，再去 joins runs 拿 wall_ms 只是多引一张表的口径。
    审校那两列走 review_of 的回查：审校 job 上的 review_state 记的是判定，
    经办 job 上的记的是当前状态，两个意思共用一列，所以谁的历史要看穿到哪一侧。
    """
    jobs = conn.execute(
        "SELECT employee_id, status, review_state, tokens, claimed_at_ms, finished_at_ms, "
        "kind FROM office_jobs").fetchall()
    verdicts = conn.execute(
        "SELECT j.employee_id AS author, r.review_state AS verdict, COUNT(*) AS n "
        "FROM office_jobs r JOIN office_jobs j ON r.review_of = j.job_id "
        "WHERE r.kind = 'review' AND r.review_state IN ('approved', 'returned') "
        "GROUP BY j.employee_id, r.review_state").fetchall()
    tally: dict[str, dict[str, int]] = {}
    for row in verdicts:
        bucket = tally.setdefault(str(row["author"]), {})
        bucket[str(row["verdict"])] = int(row["n"] or 0)
    # 今天退回了几件：按判定落地那一天数，取的是审校那一趟的收口时间戳
    todays = conn.execute(
        "SELECT j.employee_id AS author, COUNT(*) AS n "
        "FROM office_jobs r JOIN office_jobs j ON r.review_of = j.job_id "
        "WHERE r.kind = 'review' AND r.review_state = 'returned' AND r.finished_at_ms >= ? "
        "GROUP BY j.employee_id", (day_start_ms,)).fetchall()
    today_returned = {str(r["author"]): int(r["n"] or 0) for r in todays}
    out: list[dict[str, Any]] = []
    for emp in employees:
        eid = emp["employeeId"]
        mine = [j for j in jobs if str(j["employee_id"]) == eid]
        walls = [int(j["finished_at_ms"]) - int(j["claimed_at_ms"]) for j in mine
                 if int(j["claimed_at_ms"] or 0) > 0 and int(j["finished_at_ms"] or 0)
                 > int(j["claimed_at_ms"] or 0)]
        today = [j for j in mine if int(j["finished_at_ms"] or 0) >= day_start_ms]
        counts = {s: sum(1 for j in mine if str(j["status"]) == s)
                  for s in ("done", "error", "stopped", "blocked", "dropped", "queued", "running")}
        vt = tally.get(eid, {})
        out.append({
            "employeeId": eid,
            **counts,
            "pendingReview": sum(1 for j in mine if str(j["review_state"] or "") == "pending"),
            "awaiting": counts["blocked"] + counts["dropped"],
            "approvedCount": int(vt.get("approved") or 0),
            "returnedCount": int(vt.get("returned") or 0),
            "avgWallMs": int(sum(walls) / len(walls)) if walls else 0,
            "tokensToday": sum(int(j["tokens"] or 0) for j in today),
            "tokensTotal": sum(int(j["tokens"] or 0) for j in mine),
            "dailyTokenCap": emp["dailyTokenCap"],
            "overBudget": (emp["dailyTokenCap"] > 0
                           and sum(int(j["tokens"] or 0) for j in today) >= emp["dailyTokenCap"]),
            "doneToday": sum(1 for j in today if str(j["status"]) == "done"),
            "returnedToday": int(today_returned.get(eid) or 0),
        })
    return out


@router.get("/board")
async def get_board(limit: int = 40) -> dict[str, Any]:
    """办公室一屏的全部读数：名册 + 值班表 + 队列 + 动态流。

    刻意做成一个端点：面板每几秒刷一次，拆成四个端点就是每次四个请求，
    走查里「请求数」是判据，多打几个会把别的判据冲掉。
    """
    conn = _get_db()
    try:
        _office_ddl(conn)
        employees = [_employee_row(r) for r in conn.execute(
            "SELECT * FROM employees ORDER BY created_at_ms ASC").fetchall()]
        duties = [_duty_row(r) for r in conn.execute(
            "SELECT * FROM employee_duties ORDER BY created_at_ms ASC").fetchall()]
        capped = max(1, min(200, int(limit)))
        jobs = [_job_row(r) for r in conn.execute(
            "SELECT * FROM office_jobs ORDER BY enqueued_at_ms DESC LIMIT ?", (capped,)).fetchall()]
        recent = [_message_row(r) for r in conn.execute(
            "SELECT * FROM office_messages ORDER BY id DESC LIMIT ?", (capped,)).fetchall()]
        notes = [_note_row(r) for r in conn.execute(
            "SELECT * FROM employee_notes ORDER BY updated_at_ms DESC LIMIT ?",
            (capped,)).fetchall()]
        unread_user = conn.execute(
            "SELECT COUNT(*) AS n FROM office_messages WHERE to_kind = 'user' AND read_at_ms = 0"
        ).fetchone()
        # 站会与绩效都是「从既有几张表现算」：不新增表、不加埋点，面板那边只读这一份
        standup = _standup(conn)
        performance = _performance(conn, employees, _day_start_ms(time.time()))
        perf_by = {p["employeeId"]: p for p in performance}
        for emp in employees:
            mine = [j for j in jobs if j["employeeId"] == emp["employeeId"]]
            emp["runningCount"] = sum(1 for j in mine if j["status"] == "running")
            emp["queuedCount"] = sum(1 for j in mine if j["status"] == "queued")
            # 「等你拍板」的条数：卡住 + 被判不该办，两样都等人回来点头
            emp["pendingCount"] = sum(1 for j in mine if j["status"] in ("blocked", "dropped"))
            emp["openNoteCount"] = sum(1 for n in notes
                                       if n["employeeId"] == emp["employeeId"] and n["kind"] == "open")
            emp["dutyCount"] = sum(1 for d in duties
                                   if d["employeeId"] == emp["employeeId"] and d["enabled"])
            emp["lastJob"] = mine[0] if mine else None
            p = perf_by.get(emp["employeeId"]) or {}
            # 工位那一行要说的「今天办了几件 / 退回几件」，与绩效卡同一个来源，别两处各数一份
            emp["doneToday"] = int(p.get("doneToday") or 0)
            emp["returnedToday"] = int(p.get("returnedToday") or 0)
            emp["pendingReviewCount"] = int(p.get("pendingReview") or 0)
            emp["tokensToday"] = int(p.get("tokensToday") or 0)
            emp["overBudget"] = bool(p.get("overBudget"))
            # 审校人从 id 翻成名字：面板抄一份 lookup 就会在改名那一刻对不上
            gate = emp["reviewGate"]
            emp["reviewGateName"] = next((e["name"] for e in employees
                                          if e["employeeId"] == gate), "") if gate else ""
    finally:
        conn.close()
    return {
        "code": 0,
        "data": {
            "employees": employees,
            "duties": duties,
            "jobs": jobs,
            "messages": list(reversed(recent)),
            "notes": list(reversed(notes)),
            "unreadForUser": int((unread_user["n"] if unread_user else 0) or 0),
            "templates": list(TEMPLATES),
            "maxHops": MAX_HOPS,
            "guardKinds": list(GUARD_KINDS),
            "triageActions": list(TRIAGE_ACTIONS),
            "reviewVerdicts": list(REVIEW_VERDICTS),
            "standup": standup,
            "performance": performance,
        },
        "message": "ok",
    }


@router.post("/employees")
async def create_employee(body: dict[str, Any]) -> dict[str, Any]:
    name = str(body.get("name") or "").strip()[:MAX_NAME_CHARS]
    if not name:
        return {"code": 1, "data": None, "message": "要给这位员工起个名字"}
    role = str(body.get("role") or "").strip()[:MAX_ROLE_CHARS]
    duty_text = str(body.get("dutyText") or "").strip()[:MAX_DUTY_TEXT_CHARS]
    objective = str(body.get("objective") or "").strip()[:MAX_DUTY_TEXT_CHARS]
    glyph = str(body.get("glyph") or name[:1])[:2]
    employee_id = _new_id("emp")
    pid = resolve_employee_project(body.get("projectId"))
    wanted_gate = str(body.get("reviewGate") or "").strip()
    conn = _get_db()
    try:
        _office_ddl(conn)
        dup = conn.execute("SELECT 1 FROM employees WHERE name = ? LIMIT 1", (name,)).fetchone()
        if dup:
            # 名字是同事之间递话用的寻址键，重名会让「发给阿明」变成一句谁也不知道给谁的话
            return {"code": 1, "data": None, "message": "已经有同名的员工了，换一个名字"}
        # 招聘那一刻没核对上的审校人，之后每次交付都会静默绕过这道门，所以在库里再认一次
        gate, gate_err = _resolve_review_gate(conn, wanted_gate, employee_id)
        if gate_err:
            return {"code": 1, "data": None, "message": gate_err}
        conn.execute(
            "INSERT INTO employees (employee_id, name, role, duty_text, objective, model_id, glyph, "
            "hue, rounds_budget, unattended, status, project_id, review_gate, daily_token_cap, "
            "created_at_ms, last_seen_ms) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, 0)",
            (employee_id, name, role, duty_text, objective, str(body.get("modelId") or ""), glyph,
             int(body.get("hue") or 0), _clamp_budget(body.get("roundsBudget")),
             1 if body.get("unattended") else 0, pid, gate, _clamp_cap(body.get("dailyTokenCap")),
             _now_ms()),
        )
        conn.commit()
        row = _employee_of(conn, employee_id)
    finally:
        conn.close()
    return {"code": 0, "data": _employee_row(row), "message": "已入职"}


def _clamp_budget(raw: Any) -> int:
    return max(1, min(MAX_ROUNDS_BUDGET, int(raw or 8)))


def _clamp_cap(raw: Any) -> int:
    """每日 token 上限：0 就是不限。给个上界只为挡住手滑——写成一亿等于没写。"""
    return max(0, min(200_000_000, int(raw or 0)))


def _resolve_review_gate(conn, raw: Any, self_id: str) -> tuple[str, str]:
    """审校人必须是名册里另一位在职员工；认不出来就当场报错，不悄悄落回「没有这道门」。

    gate 指到一个认不出来的人，交付就会直接到用户手上——那正是这道门要拦的那一步，
    所以宁可排班失败，也不能让「看起来有审校」变成「其实没有」。
    """
    text = str(raw or "").strip()
    if not text:
        return "", ""
    if text == self_id:
        return "", "审校人不能是他自己（自己判自己合格，等于没有这道门）"
    target = _resolve_recipient(conn, text)
    if isinstance(target, dict):
        return "", str(target.get("message") or "审校人认不出来")
    if target is None:
        return "", "审校人不在名册里：先招进来，或把这一格留空"
    gate = str(target["employee_id"])
    if gate == self_id:
        return "", "审校人不能是他自己（自己判自己合格，等于没有这道门）"
    return gate, ""


def resolve_employee_project(key: Any) -> str:
    """员工挂在哪个项目上：认不出来就留空串，不悄悄落到「屏幕上那一个」。

    与 scheduler 的归属口径一致——把 A 的活挪到 B 名下，比它没有归属更难查。
    """
    text = str(key or "").strip()
    if not text:
        return ""
    doc = registry.load_registry()
    entry = registry.find_entry(doc, text)
    if entry:
        return str(entry.get("id") or "")
    return registry.project_id_for_path(doc, text) or ""


@router.patch("/employees/{employee_id}")
async def update_employee(employee_id: str, body: dict[str, Any]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for key, column in (("name", "name"), ("role", "role"), ("dutyText", "duty_text"),
                        ("objective", "objective"),
                        ("modelId", "model_id"), ("glyph", "glyph"), ("projectId", "project_id")):
        if key in body:
            fields[column] = str(body.get(key) or "").strip()
    if "hue" in body:
        fields["hue"] = int(body.get("hue") or 0)
    if "roundsBudget" in body:
        fields["rounds_budget"] = _clamp_budget(body.get("roundsBudget"))
    if "unattended" in body:
        fields["unattended"] = 1 if body.get("unattended") else 0
    if "dailyTokenCap" in body:
        fields["daily_token_cap"] = _clamp_cap(body.get("dailyTokenCap"))
    conn = _get_db()
    try:
        _office_ddl(conn)
        # 审校人要对着名册认，所以这一步必须排在库开起来之后（认不出来就整个不写）
        if "reviewGate" in body:
            gate, gate_err = _resolve_review_gate(conn, body.get("reviewGate"), employee_id[:64])
            if gate_err:
                return {"code": 1, "data": None, "message": gate_err}
            fields["review_gate"] = gate
        if not fields:
            return {"code": 1, "data": None, "message": "没有要改的字段"}
        sets = ", ".join(f"{column} = ?" for column in fields)
        _write(conn, f"UPDATE employees SET {sets} WHERE employee_id = ?",
               (*fields.values(), employee_id[:64]))
        row = _employee_of(conn, employee_id)
    finally:
        conn.close()
    if row is None:
        return {"code": 1, "data": None, "message": "没有这位员工"}
    return {"code": 0, "data": _employee_row(row), "message": "ok"}


@router.delete("/employees/{employee_id}")
async def delete_employee(employee_id: str) -> dict[str, Any]:
    """解雇：名册、值班表与他自己的备忘一起走，队列与传话留着。

    留着的历史是「这台机器做过什么」的凭据；job 上有 employee_name 快照，
    所以名册删了界面照样说得出当时是谁办的。备忘（employee_notes）跟着人走：
    人都不在了，那份「他记得的未闭环」没有下一个读者。
    正在跑的活不在这里强杀——停止口只有一个，在页面上。
    """
    employee_id = employee_id[:64]
    conn = _get_db()
    try:
        _office_ddl(conn)
        row = _employee_of(conn, employee_id)
        if row is None:
            return {"code": 1, "data": None, "message": "没有这位员工"}
        conn.execute("DELETE FROM employee_duties WHERE employee_id = ?", (employee_id,))
        conn.execute("DELETE FROM employee_notes WHERE employee_id = ?", (employee_id,))
        conn.execute("DELETE FROM employees WHERE employee_id = ?", (employee_id,))
        # 还在排队的活没人能办了：留在 queued 就是「看着有活其实没人接」
        conn.execute(
            "UPDATE office_jobs SET status = 'stopped', error = ?, finished_at_ms = ? "
            "WHERE employee_id = ? AND status IN ('queued', 'running')",
            ("员工已离职", _now_ms(), employee_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"code": 0, "data": None, "message": "已解雇"}


# ── API：值班表 ──────────────────────────────────

DUTY_MODES = ("once", "daily", "interval", "event")
EVENT_TYPES = ("file_change", "git_push", "webhook")
GUARD_KINDS = ("open_jobs_max", "file_change", "git_head", "check_script")


def validate_guard(raw: Any) -> tuple[bool, str, str]:
    """排班时就认守卫条件：写错的条件当场拒，不留一条「看起来有道闸其实永远不关」的班。

    返回 (通过, 错误话, 规范化后的 JSON 串)。空串＝不设条件。
    """
    text = str(raw or "").strip()
    if not text or text == "{}":
        return True, "", ""
    try:
        doc = json.loads(text)
    except (ValueError, TypeError):
        return False, "守卫条件要写成 JSON（形如 {\"kind\":\"check_script\",\"script\":\"check_ui_identity.mjs\"}）", ""
    if not isinstance(doc, dict):
        return False, "守卫条件要写成一个对象", ""
    kind = str(doc.get("kind") or "")
    if kind not in GUARD_KINDS:
        return False, f"认不出这个守卫条件，只支持 {'、'.join(GUARD_KINDS)}", ""
    if kind == "check_script" and not GUARD_SCRIPT.match(str(doc.get("script") or "")):
        return False, "自检脚本只认 scripts/ 里的 check_*.mjs 文件名", ""
    if kind == "open_jobs_max":
        try:
            int(doc.get("n"))
        except (TypeError, ValueError):
            return False, "队列条数阈值要填个数（0 表示手上没活才动）", ""
    return True, "", json.dumps(doc, ensure_ascii=False, separators=(",", ":"))[:MAX_BRIEF_CHARS]


@router.post("/duties")
async def create_duty(body: dict[str, Any]) -> dict[str, Any]:
    employee_id = str(body.get("employeeId") or "")[:64]
    prompt = str(body.get("prompt") or "").strip()[:MAX_BRIEF_CHARS]
    name = str(body.get("name") or "").strip()[:MAX_NAME_CHARS]
    mode = str(body.get("mode") or "daily")
    if mode not in DUTY_MODES:
        return {"code": 1, "data": None, "message": "无效的值班模式"}
    ok_guard, guard_msg, guard = validate_guard(body.get("guard"))
    if not ok_guard:
        return {"code": 1, "data": None, "message": guard_msg}
    if not employee_id or not prompt:
        return {"code": 1, "data": None, "message": "员工与要做的事都必填"}
    conn = _get_db()
    try:
        _office_ddl(conn)
        emp = _employee_of(conn, employee_id)
        if emp is None:
            return {"code": 1, "data": None, "message": "没有这位员工"}
        hhmm = str(body.get("time") or "")
        if mode == "event":
            if str(body.get("eventType") or "") not in EVENT_TYPES:
                return {"code": 1, "data": None, "message": "无效的事件类型"}
        elif mode != "interval" and not scheduler._parse_hhmm(hhmm):
            return {"code": 1, "data": None, "message": "请填写有效的执行时间（HH:MM）"}
        duty_id = _new_id("duty")
        pid = resolve_employee_project(body.get("projectId")) or str(emp["project_id"] or "")
        conn.execute(
            "INSERT INTO employee_duties (duty_id, employee_id, name, prompt, guard, triage, mode, "
            "time, every_minutes, event_type, watch_paths, git_repo, webhook_secret, cooldown_seconds, "
            "max_runs, until_ms, runs, enabled, last_run_ms, last_status, project_id, created_at_ms) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, '', ?, ?)",
            (duty_id, employee_id,
             name or _default_duty_name(mode, hhmm), prompt, guard,
             1 if body.get("triage") else 0, mode,
             hhmm or "09:00" if mode not in ("interval", "event") else "",
             max(1, int(body.get("everyMinutes") or 60)) if mode == "interval" else 0,
             str(body.get("eventType") or "") if mode == "event" else "",
             str(body.get("watchPaths") or "") if mode == "event" else "",
             str(body.get("gitRepo") or "") if mode == "event" else "",
             str(body.get("webhookSecret") or "") if mode == "event" else "",
             max(10, int(body.get("cooldownSeconds") or 60)) if mode == "event" else 0,
             max(0, int(body.get("maxRuns") or 0)),
             max(0, int(body.get("untilMs") or 0)), pid, _now_ms()),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM employee_duties WHERE duty_id = ?", (duty_id,)).fetchone()
    finally:
        conn.close()
    if mode == "event" or _parse_guard(guard).get("kind") in ("file_change", "git_head"):
        seed_event_snapshots()
    return {"code": 0, "data": _duty_row(row), "message": "已排班"}


def _default_duty_name(mode: str, hhmm: str) -> str:
    if mode == "interval":
        return "周期值班"
    if mode == "event":
        return "值守"
    if mode == "once":
        return f"单次 · {hhmm}"
    return f"每日 · {hhmm}"


@router.patch("/duties/{duty_id}")
async def update_duty(duty_id: str, body: dict[str, Any]) -> dict[str, Any]:
    columns = {"name": "name", "prompt": "prompt", "mode": "mode", "time": "time",
               "eventType": "event_type", "watchPaths": "watch_paths", "gitRepo": "git_repo",
               "webhookSecret": "webhook_secret", "projectId": "project_id"}
    fields: dict[str, Any] = {}
    if "guard" in body:
        ok_guard, guard_msg, guard = validate_guard(body.get("guard"))
        if not ok_guard:
            return {"code": 1, "data": None, "message": guard_msg}
        fields["guard"] = guard
    if "triage" in body:
        fields["triage"] = 1 if body.get("triage") else 0
    for key, column in columns.items():
        if key in body:
            fields[column] = str(body.get(key) or "").strip()
    if "everyMinutes" in body:
        fields["every_minutes"] = max(1, int(body.get("everyMinutes") or 60))
    if "cooldownSeconds" in body:
        fields["cooldown_seconds"] = max(10, int(body.get("cooldownSeconds") or 60))
    if "maxRuns" in body:
        fields["max_runs"] = max(0, int(body.get("maxRuns") or 0))
    if "untilMs" in body:
        fields["until_ms"] = max(0, int(body.get("untilMs") or 0))
    if "enabled" in body:
        fields["enabled"] = 1 if body.get("enabled") else 0
        # 重新排班要清掉「已放弃」那类终局原因，否则界面上一直挂着上次的失败
        if fields["enabled"]:
            fields["last_status"] = ""
    if not fields:
        return {"code": 1, "data": None, "message": "没有要改的字段"}
    conn = _get_db()
    try:
        _office_ddl(conn)
        sets = ", ".join(f"{column} = ?" for column in fields)
        rowcount = _write(conn, f"UPDATE employee_duties SET {sets} WHERE duty_id = ?",
                          (*fields.values(), duty_id[:64]))
        if not rowcount:
            return {"code": 1, "data": None, "message": "这条值班不存在"}
        row = conn.execute("SELECT * FROM employee_duties WHERE duty_id = ?",
                           (duty_id[:64],)).fetchone()
    finally:
        conn.close()
    seed_event_snapshots()
    return {"code": 0, "data": _duty_row(row), "message": "ok"}


@router.delete("/duties/{duty_id}")
async def delete_duty(duty_id: str) -> dict[str, Any]:
    conn = _get_db()
    try:
        _office_ddl(conn)
        _write(conn, "DELETE FROM employee_duties WHERE duty_id = ?", (duty_id[:64],))
    finally:
        conn.close()
    return {"code": 0, "data": None, "message": "已取消排班"}


@router.post("/duties/{duty_id}/run")
async def run_duty_now(duty_id: str) -> dict[str, Any]:
    """手动交一次班：不等时钟，直接把活排进队列。

    刻意不看守卫：人按下这一下就是「现在要他办」，条件成立与否由他自己判断。
    """
    conn = _get_db()
    try:
        _office_ddl(conn)
        row = conn.execute("SELECT * FROM employee_duties WHERE duty_id = ?",
                           (duty_id[:64],)).fetchone()
        if row is None:
            return {"code": 1, "data": None, "message": "这条值班不存在"}
        duty = _duty_row(row)
        emp = _employee_of(conn, duty["employeeId"])
        if emp is None:
            return {"code": 1, "data": None, "message": "这位员工已离职"}
        if _has_open_job(conn, duty["dutyId"]):
            return {"code": 1, "data": None, "message": "上一次交班还没办完"}
        job_id = _enqueue(conn, employee_id=duty["employeeId"], employee_name=str(emp["name"]),
                          brief=duty["prompt"], origin="duty", duty_id=duty["dutyId"],
                          thread_id=duty["dutyId"], project_id=duty["projectId"],
                          kind="triage" if duty["triage"] else "work")
        _mark_duty_fired(conn, duty["dutyId"], f"手动交班 {job_id}")
        _sync_employee_status(conn, duty["employeeId"])
    finally:
        conn.close()
    return {"code": 0, "data": {"jobId": job_id}, "message": "已排入队列"}


@router.post("/notes")
async def write_note(body: dict[str, Any]) -> dict[str, Any]:
    """员工给自己留一条备忘：未闭环（open）/ 已定论（ledger）/ 卡住（blocked）。

    close 填某条备忘的 id 就先把它划掉——办完的「未闭环」留着，下一趟会照着
    再办一遍，那是重复劳动而不是记忆。备忘按人裁剪到 MAX_NOTES 条：不设上限，
    注入 prompt 的那一段迟早把自己的窗口撑掉。
    """
    employee_id = str(body.get("employeeId") or "")[:64]
    kind = str(body.get("kind") or "open")
    text = str(body.get("text") or "").strip()[:MAX_NOTE_CHARS]
    ref = str(body.get("ref") or "").strip()[:200]
    job_id = str(body.get("jobId") or "")[:64]
    close = str(body.get("closeNoteId") or "")[:64]
    if not employee_id:
        return {"code": 1, "data": None, "message": "少了要写备忘的那一位"}
    if kind not in NOTE_KINDS:
        return {"code": 1, "data": None, "message": f"备忘只有 {'、'.join(NOTE_KINDS)} 三种"}
    if not text and not close:
        return {"code": 1, "data": None, "message": "备忘内容没写，也没说要划掉哪条"}
    now = _now_ms()
    conn = _get_db()
    try:
        _office_ddl(conn)
        if _employee_of(conn, employee_id) is None:
            return {"code": 1, "data": None, "message": "没有这位员工"}
        closed = 0
        if close:
            # 只许划自己的：别人的 id 递进来也算成功，就成了一条改他人记忆的路
            closed = _write(conn, "DELETE FROM employee_notes WHERE note_id = ? AND employee_id = ?",
                            (close, employee_id))
        note_id = ""
        if text:
            note_id = _new_id("note")
            conn.execute(
                "INSERT INTO employee_notes (note_id, employee_id, kind, text, ref, job_id, "
                "created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (note_id, employee_id, kind, text, ref, job_id, now, now))
            # 裁剪按「最近写过的人」这一侧，留最新的这么多条
            conn.execute(
                "DELETE FROM employee_notes WHERE employee_id = ? AND note_id NOT IN "
                "(SELECT note_id FROM employee_notes WHERE employee_id = ? "
                "ORDER BY updated_at_ms DESC LIMIT ?)",
                (employee_id, employee_id, MAX_NOTES))
        conn.commit()
        mine = conn.execute("SELECT COUNT(*) AS n FROM employee_notes WHERE employee_id = ? "
                            "AND kind = 'open'", (employee_id,)).fetchone()
    finally:
        conn.close()
    return {"code": 0,
            "data": {"noteId": note_id, "closed": closed, "openCount": int((mine["n"] if mine else 0) or 0)},
            "message": "已记下"}


@router.post("/triage")
async def apply_triage(body: dict[str, Any]) -> dict[str, Any]:
    """晨会分诊落库：员工对自己名下的活给出 keep / defer / drop 与理由。

    三条边界钉死：
    • 只能处置自己的活（别人的 job_id 递进来算跳过，不改）；
    • drop 不是删除——落 'dropped' 等人点头，复活只有 /jobs/{id}/revive 那一扇门；
    • 正在跑的这一条不在处置范围内（它就是这次判断的载体）。
    """
    employee_id = str(body.get("employeeId") or "")[:64]
    self_job = str(body.get("jobId") or "")[:64]
    decisions = body.get("decisions")
    if not employee_id:
        return {"code": 1, "data": None, "message": "少了做分诊的那一位"}
    if not isinstance(decisions, list) or not decisions:
        return {"code": 1, "data": None, "message": "分诊结果要是一串处置"}
    decisions = decisions[:MAX_TRIAGE_DECISIONS]
    applied: list[dict[str, Any]] = []
    skipped: list[str] = []
    now = _now_ms()
    conn = _get_db()
    try:
        _office_ddl(conn)
        for raw in decisions:
            if not isinstance(raw, dict):
                skipped.append("有一条不是对象，跳过")
                continue
            target = str(raw.get("jobId") or "")[:64]
            action = str(raw.get("action") or "")
            why = str(raw.get("why") or "").strip()[:MAX_NOTE_CHARS]
            if not target or target == self_job:
                skipped.append("没写 job_id，或处置的正是这次分诊自己")
                continue
            if action not in TRIAGE_ACTIONS:
                skipped.append(f"{target[:20]}：认不出这个处置（{action[:16]}）")
                continue
            row = conn.execute("SELECT * FROM office_jobs WHERE job_id = ?", (target,)).fetchone()
            if row is None:
                skipped.append(f"{target[:20]}：没有这条活")
                continue
            if str(row["employee_id"]) != employee_id:
                # 分诊只对自己的队列负责：把同事的活判成不该办，那是越权不是分工
                skipped.append(f"{target[:20]}：不是他名下的活")
                continue
            if str(row["kind"] or "") == "review":
                # 排给他的审校是名册指派的职责，不是「今天要不要办」的选项：
                # 判成不该办，被审的那份交付就永远拿不到结论（引擎那边同一口径，不列进名单）
                skipped.append(f"{target[:20]}：审校由名册指派，不进分诊")
                continue
            if row["status"] not in ("queued", "blocked", "dropped"):
                skipped.append(f"{target[:20]}：已经在办或办完了")
                continue
            if action == "drop" and not why:
                skipped.append(f"{target[:20]}：判「不该办」得写理由")
                continue
            priority = max(0, min(9, int(raw.get("priority") or 0)))
            due_ms = max(0, int(raw.get("dueMs") or 0))
            if action == "keep":
                _write(conn, "UPDATE office_jobs SET priority = ?, due_ms = ?, state_reason = ? "
                             "WHERE job_id = ?", (priority, due_ms, why, target))
            elif action == "defer":
                _write(conn, "UPDATE office_jobs SET priority = ?, due_ms = ?, state_reason = ? "
                             "WHERE job_id = ?", (0, due_ms or (now + 86_400_000),
                                                  why or "先放着：等更该办的办完", target))
            else:
                # 判定不该办：落 dropped 等人点头，decided_by 记下是谁判的（员工判的才需要人复活）
                _write(conn, "UPDATE office_jobs SET status = 'dropped', priority = 0, due_ms = 0, "
                             "state_reason = ?, decided_by = 'employee', finished_at_ms = ?, "
                             "lease_ms = 0, claim_token = '' WHERE job_id = ?",
                       (why, now, target))
            applied.append({"jobId": target, "action": action})
        _sync_employee_status(conn, employee_id)
        conn.commit()
    finally:
        conn.close()
    return {"code": 0,
            "data": {"applied": len(applied), "skipped": skipped, "decisions": applied},
            "message": f"分诊记下 {len(applied)} 条"}


@router.post("/jobs/{job_id}/revive")
async def revive_job(job_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """人点头把活放回队列：这是 dropped / blocked 回到 queued 的唯一一扇门。

    员工自己不能推开这扇门（否则「不该办」就成了自我授权）；所以 decided_by 只写 user。
    """
    conn = _get_db()
    try:
        _office_ddl(conn)
        row = conn.execute("SELECT * FROM office_jobs WHERE job_id = ?", (job_id[:64],)).fetchone()
        if row is None:
            return {"code": 1, "data": None, "message": "没有这条活"}
        if row["status"] not in ("dropped", "blocked"):
            return {"code": 1, "data": None, "message": "这条不在等人拍板的状态"}
        if _employee_of(conn, str(row["employee_id"])) is None:
            return {"code": 1, "data": None, "message": "这位员工已离职，活没人能办"}
        _write(conn, "UPDATE office_jobs SET status = 'queued', priority = ?, due_ms = ?, "
                     "state_reason = '', decided_by = 'user', claim_token = '', lease_ms = 0, "
                     "claimed_at_ms = 0, finished_at_ms = 0, enqueued_at_ms = ? WHERE job_id = ?",
               (REVIVED_PRIORITY, max(0, int(body.get("dueMs") or 0)), _now_ms(), job_id[:64]))
        _sync_employee_status(conn, str(row["employee_id"]))
        conn.commit()
    finally:
        conn.close()
    return {"code": 0, "data": {"jobId": job_id[:64]}, "message": "已放回队列"}


@router.post("/jobs/{job_id}/decline")
async def decline_job(job_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """人同意「不该办」：这条从等人拍板那一栏落成结案，不再挂着。

    只翻状态与 decided_by，不碰 rounds / result_text——那一趟的账（几轮、几次工具、
    交付正文）已经落过了，用 finish 重写会把历史洗成 0。
    """
    conn = _get_db()
    try:
        _office_ddl(conn)
        row = conn.execute("SELECT * FROM office_jobs WHERE job_id = ?", (job_id[:64],)).fetchone()
        if row is None:
            return {"code": 1, "data": None, "message": "没有这条活"}
        if row["status"] not in ("dropped", "blocked"):
            return {"code": 1, "data": None, "message": "这条不在等人拍板的状态"}
        _write(conn, "UPDATE office_jobs SET status = 'stopped', decided_by = 'user', "
                     "state_reason = ? WHERE job_id = ?",
               (str(body.get("reason") or "")[:MAX_NOTE_CHARS] or "人同意这不该办", job_id[:64]))
        _sync_employee_status(conn, str(row["employee_id"]))
        conn.commit()
    finally:
        conn.close()
    return {"code": 0, "data": {"jobId": job_id[:64]}, "message": "已结案"}


@router.post("/webhook/{duty_id}")
async def receive_duty_webhook(duty_id: str, request: Request) -> dict[str, Any]:
    """外部回调打进这一条值班：payload 先进 scheduler 那份待发队列，下一次 tick 触发。

    与 /schedule/webhook 共用一套队列与消费口径，不另写第二份待发缓存——
    两份的话，后端重启后就说不清哪一份还没被读过。
    """
    conn = _get_db()
    try:
        _office_ddl(conn)
        row = conn.execute("SELECT * FROM employee_duties WHERE duty_id = ?",
                           (duty_id[:64],)).fetchone()
        if row is None:
            return {"code": 1, "data": None, "message": "这条值班不存在"}
        if row["mode"] != "event" or row["event_type"] != "webhook":
            return {"code": 1, "data": None, "message": "这条值班不是回调事件类型"}
        if not int(row["enabled"] or 0):
            return {"code": 1, "data": None, "message": "这条值班已停用"}
        try:
            payload = await request.json()
        except Exception:
            payload = {"raw": "(non-JSON body)"}
        secret = str(row["webhook_secret"] or "")
        if secret and str((payload or {}).get("secret", "")) != secret:
            return {"code": 1, "data": None, "message": "回调密钥校验失败"}
        scheduler._pending_webhooks.setdefault(duty_id[:64], []).append(
            {"received_at": time.time(), "payload": payload},
        )
    finally:
        conn.close()
    return {"code": 0, "data": None, "message": "回调已接收，将在下次轮询时触发"}


# ── API：队列 ────────────────────────────────────

@router.get("/jobs")
async def list_jobs(employeeId: str = "", status: str = "", limit: int = 40) -> dict[str, Any]:
    conn = _get_db()
    try:
        _office_ddl(conn)
        sql = "SELECT * FROM office_jobs WHERE 1 = 1"
        args: list[Any] = []
        if employeeId:
            sql += " AND employee_id = ?"
            args.append(employeeId[:64])
        if status:
            sql += " AND status = ?"
            args.append(status[:16])
        sql += " ORDER BY enqueued_at_ms DESC LIMIT ?"
        args.append(max(1, min(200, int(limit))))
        jobs = [_job_row(r, full=True) for r in conn.execute(sql, tuple(args)).fetchall()]
    finally:
        conn.close()
    return {"code": 0, "data": {"jobs": jobs}, "message": "ok"}


@router.post("/jobs")
async def enqueue_job(body: dict[str, Any]) -> dict[str, Any]:
    """人直接交办一条活（办公室面板上那句「去做…」）。"""
    employee_id = str(body.get("employeeId") or "")[:64]
    brief = str(body.get("brief") or "").strip()[:MAX_BRIEF_CHARS]
    if not employee_id or not brief:
        return {"code": 1, "data": None, "message": "员工与要做的事都必填"}
    conn = _get_db()
    try:
        _office_ddl(conn)
        emp = _employee_of(conn, employee_id)
        if emp is None:
            return {"code": 1, "data": None, "message": "没有这位员工"}
        job_id = _enqueue(conn, employee_id=employee_id, employee_name=str(emp["name"]),
                          brief=brief, origin="manual", thread_id=_new_id("thr"),
                          project_id=str(emp["project_id"] or ""))
        _sync_employee_status(conn, employee_id)
    finally:
        conn.close()
    return {"code": 0, "data": {"jobId": job_id}, "message": "已排入队列"}


@router.post("/jobs/claim")
async def claim_jobs(body: dict[str, Any]) -> dict[str, Any]:
    """页面领活：CAS 把 queued 改成 running，抢不到就当没抢到。

    为什么用 CAS 而不是「先查再改」：可能开着两个桌面窗口，两者同时读到同一条
    queued 就会各跑一遍——同一句交办动两次工具，比不跑严重得多。
    """
    token = str(body.get("claimToken") or "") or _new_id("host")
    limit = max(1, min(CLAIM_MAX, int(body.get("limit") or CLAIM_MAX)))
    claimed: list[dict[str, Any]] = []
    now = _now_ms()
    conn = _get_db()
    try:
        _office_ddl(conn)
        while len(claimed) < limit:
            # 先办优先级高的，其次赶期限的，最后才按到的先后。
            # due_ms=0 是「没设期限」，必须排在任何设了期限的活之后——直接 ORDER BY due_ms
            # 会把这一堆 0 顶到最前面，等于把优先级又洗回 FIFO。
            row = conn.execute(
                "SELECT job_id FROM office_jobs WHERE status = 'queued' "
                "ORDER BY priority DESC, "
                "CASE WHEN due_ms > 0 THEN due_ms ELSE 9223372036854775807 END ASC, "
                "enqueued_at_ms ASC LIMIT 1").fetchone()
            if row is None:
                break
            job_id = str(row["job_id"])
            cur = conn.execute(
                "UPDATE office_jobs SET status = 'running', claim_token = ?, attempts = attempts + 1, "
                "claimed_at_ms = ?, lease_ms = ? WHERE job_id = ? AND status = 'queued'",
                (token, now, now + LEASE_MS, job_id),
            )
            conn.commit()
            if cur.rowcount != 1:
                # 被另一个窗口抢走了：重新看一眼队列，不算失败
                continue
            got = conn.execute("SELECT * FROM office_jobs WHERE job_id = ?", (job_id,)).fetchone()
            if got is not None:
                claimed.append(_job_row(got))
        for job in claimed:
            _sync_employee_status(conn, job["employeeId"])
            conn.execute("UPDATE employees SET last_seen_ms = ? WHERE employee_id = ?",
                         (now, job["employeeId"]))
        conn.commit()
    finally:
        conn.close()
    return {"code": 0, "data": {"jobs": claimed, "claimToken": token}, "message": "ok"}


@router.post("/jobs/heartbeat")
async def heartbeat_jobs(body: dict[str, Any]) -> dict[str, Any]:
    """跑着的活每 30 秒续一次租约。续不上就会被时钟退回队列。"""
    ids = [str(j)[:64] for j in (body.get("jobIds") or []) if str(j)]
    if not ids:
        return {"code": 1, "data": None, "message": "缺少 jobIds"}
    now = _now_ms()
    placeholders = ",".join("?" * len(ids))
    conn = _get_db()
    try:
        _office_ddl(conn)
        # 只给还活着、且确实是这一次领取的 job 续约：token 不认＝这活已被别人接走
        rowcount = _write(conn,
                          f"UPDATE office_jobs SET lease_ms = ? WHERE status = 'running' "
                          f"AND claim_token = ? AND job_id IN ({placeholders})",
                          (now + LEASE_MS, str(body.get("claimToken") or ""), *ids))
    finally:
        conn.close()
    return {"code": 0, "data": {"renewed": rowcount}, "message": "ok"}


# ── 审校门禁 ────────────────────────────────────

def _review_brief(author_name: str, brief: str, result_text: str) -> str:
    """排给审校那一趟的正文：交付的原件，加一句「你这一趟只做一个判定」。

    正文按长度截断——审校判的是「够不够格给人」，不是替他重做一遍；真要逐字复核，
    那一条 job 的会话链接就在界面上，他自己会去点开。
    """
    return (
        f"[审校] {author_name} 交来一份交付，你替他过一遍，再决定它能不能到用户手上。\n\n"
        f"他接到的交代：\n{brief[:1200]}\n\n"
        f"他交的正文：\n{result_text[:REVIEW_RESULT_CHARS]}\n\n"
        "这一趟只做一个判定，判完就收班：\n"
        "- 合格：office_review(verdict=\"approve\", note=一句话写清你核过什么)。\n"
        "- 不合格：office_review(verdict=\"return\", note=写清要他改哪里)——"
        "这条会退回他名下重做，你们之间来回有手次上限，到顶会自动升级给用户。\n"
        "不要替他重写交付正文：那既不是这道门的职责，也会把两份正文混成一份。"
    )


async def _route_review(conn, job_id: str, status: str) -> dict[str, Any]:
    """这份交付该不该先进审校。判定本身是一条 job（排在审校人名下），这里只核对名册。

    四种情况不进审校：这一趟本身就是审校（不然 A 审 B、B 审 A 会审到永远）、
    这一趟是晨会分诊（他自报「今天打算干什么」，不是给人用的交付，判无可判）、
    他没设审校人、审校人已经离职。最后一种要写进状态——用户以为有道门，其实门早空了，
    静默绕过比没有门更糟。
    """
    if status != "done":
        return {}
    row = conn.execute(
        "SELECT employee_id, employee_name, brief, result_text, kind, thread_id, hop, "
        "project_id, review_state FROM office_jobs WHERE job_id = ?", (job_id,)).fetchone()
    if row is None or str(row["kind"] or "") in ("review", "triage") or str(row["review_state"] or ""):
        return {}
    author = conn.execute("SELECT review_gate FROM employees WHERE employee_id = ?",
                          (str(row["employee_id"]),)).fetchone()
    gate = str(author["review_gate"] or "") if author is not None else ""
    if not gate:
        return {}
    reviewer = _employee_of(conn, gate)
    if reviewer is None:
        _write(conn, "UPDATE office_jobs SET state_reason = ? WHERE job_id = ?",
               ("审校人已经不在名册里，这一份直接到了用户手上", job_id))
        return {}
    _write(conn, "UPDATE office_jobs SET review_state = 'pending' WHERE job_id = ?", (job_id,))
    # 审校欠着也是一种挂账：给它设期限，超时就走 SLA 那一路升级到人，不靠人自己想起来
    review_job = _enqueue(conn, employee_id=str(reviewer["employee_id"]),
                          employee_name=str(reviewer["name"]),
                          brief=_review_brief(str(row["employee_name"]), str(row["brief"]),
                                              str(row["result_text"])),
                          origin="review", thread_id=str(row["thread_id"] or ""),
                          hop=int(row["hop"] or 0), project_id=str(row["project_id"] or ""),
                          kind="review", priority=REVIEW_PRIORITY,
                          due_ms=_now_ms() + REVIEW_DUE_MS, review_of=job_id)
    _sync_employee_status(conn, str(reviewer["employee_id"]))
    return {"review": "pending", "reviewJobId": review_job, "reviewerName": str(reviewer["name"])}


@router.post("/jobs/{job_id}/review")
async def apply_review(job_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """审校那一趟交回判定：approve 才把交付递到用户手上，return 让他重做。

    四道门，缺一道这道门禁就形同虚设：
    • 这条 job 必须真的是审校那一趟（kind=review）；
    • 递进来的判定人必须是这一趟名下那位（别人的 job_id 不算）；
    • 被审的那份必须还挂在 pending，且名册上确实把这份交付交给了判定人审（gate 是唯一凭据）；
    • 一份审校只判一次，判过就锁上，免得两次 verdict 把状态翻来翻去。
    """
    employee_id = str(body.get("employeeId") or "")[:64]
    verdict = str(body.get("verdict") or "")
    note = str(body.get("note") or "").strip()[:MAX_NOTE_CHARS]
    if not employee_id:
        return {"code": 1, "data": None, "message": "少了做审校的那一位"}
    if verdict not in REVIEW_VERDICTS:
        return {"code": 1, "data": None, "message": f"审校结论只认 {'、'.join(REVIEW_VERDICTS)}"}
    if not note:
        return {"code": 1, "data": None, "message": "审校要写一句话：核过什么，或要他改哪里"}
    conn = _get_db()
    try:
        _office_ddl(conn)
        job = conn.execute("SELECT * FROM office_jobs WHERE job_id = ?", (job_id[:64],)).fetchone()
        if job is None:
            return {"code": 1, "data": None, "message": "没有这条审校"}
        if str(job["kind"] or "") != "review":
            return {"code": 1, "data": None, "message": "这不是审校那一趟，判不了交付"}
        if str(job["employee_id"]) != employee_id:
            return {"code": 1, "data": None, "message": "这条审校不是排给你的"}
        if str(job["review_state"] or ""):
            return {"code": 1, "data": None, "message": "这一份你已经判过了"}
        reviewer_name = str(job["employee_name"] or "审校")
        target = conn.execute("SELECT * FROM office_jobs WHERE job_id = ?",
                              (str(job["review_of"] or ""),)).fetchone()
        if target is None:
            return {"code": 1, "data": None, "message": "要审的那份交付不在了"}
        if str(target["review_state"] or "") != "pending":
            return {"code": 1, "data": None, "message": "那份交付不在待审校的状态"}
        author_gate = conn.execute("SELECT review_gate FROM employees WHERE employee_id = ?",
                                   (str(target["employee_id"]),)).fetchone()
        if author_gate is None or str(author_gate["review_gate"] or "") != employee_id:
            return {"code": 1, "data": None, "message": "名册上没把这份交付交给你审"}
        target_id = str(target["job_id"])
        _write(conn, "UPDATE office_jobs SET review_state = ?, state_reason = ? WHERE job_id = ?",
               ("approved" if verdict == "approve" else "returned", note, job_id[:64]))
        if verdict == "approve":
            _write(conn, "UPDATE office_jobs SET review_state = 'approved' WHERE job_id = ?",
                   (target_id,))
            # 过了这道门，交付才第一次递到用户手上：正文还是他那一份，只在头上加一句谁审的
            res = await post_message({
                "fromKind": "employee", "fromId": str(target["employee_id"]),
                "fromName": str(target["employee_name"]),
                "toKind": "user", "jobId": target_id,
                "text": f"（审校通过 · {reviewer_name}）{str(target['result_text'] or '')[:MAX_MESSAGE_CHARS]}",
            })
            if res.get("code") != 0:
                return res
            return {"code": 0, "data": {"verdict": verdict, "targetJobId": target_id},
                    "message": "已审校通过，交付已递给用户"}
        # 退回走既有的递话那一路：hop 由那条消息自己数，到顶就不唤起（口径只在 MAX_HOPS 那一行）
        _write(conn, "UPDATE office_jobs SET review_state = 'returned' WHERE job_id = ?", (target_id,))
        res = await post_message({
            "fromKind": "employee", "fromId": employee_id, "fromName": reviewer_name,
            "toKind": "employee", "toId": str(target["employee_id"]), "jobId": target_id,
            "wake": True,
            "text": f"审校退回：{note}",
        })
        if res.get("code") != 0:
            return res
        data: dict[str, Any] = {"verdict": verdict, "targetJobId": target_id,
                                "hop": int((res.get("data") or {}).get("hop") or 0)}
        if (res.get("data") or {}).get("capped"):
            # 互踢到顶：不再退回，落成 blocked 等人拍板—— revive 那一扇门是唯一出口
            _write(conn, "UPDATE office_jobs SET status = 'blocked', "
                         "state_reason = ? WHERE job_id = ?",
                   (f"审校与经办已互相来回到上限，等人拍板：{note}"[:MAX_NOTE_CHARS], target_id))
            _sync_employee_status(conn, str(target["employee_id"]))
            data["escalated"] = True
        return {"code": 0, "data": data, "message": "已退回经办人重做"}
    finally:
        conn.close()


@router.post("/jobs/{job_id}/finish")
async def finish_job(job_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """页面交回结局：状态、正文、错误、轮数、工具调用数、归属会话。

    blocked / dropped 是「等人」的两个终态：前者是他缺条件要人给，后者是他判定这件事
    不该办（理由写进 state_reason）。两个都不算失败，也都不由后端自行复活——
    复活只有 /jobs/{id}/revive 这一扇门，进来的一定是人。
    """
    status = str(body.get("status") or "done")
    if status not in ("done", "error", "stopped", "blocked", "dropped"):
        status = "done"
    # 谁做的判定：员工自己判「不该办」只有人点头才回队列，所以这一栏要留名。
    # 只认这两个值，别的（包括空）不改写——复活那扇门会把它刷成 user，后端不认页面递进来的第三种。
    decided = str(body.get("decidedBy") or "")
    if status in ("blocked", "dropped"):
        decided_by = decided if decided in ("employee", "user") else "employee"
    else:
        decided_by = ""
    conn = _get_db()
    try:
        _office_ddl(conn)
        _write(conn,
               "UPDATE office_jobs SET status = ?, result_text = ?, error = ?, conversation_id = ?, "
               "rounds = ?, tool_calls = ?, tokens = ?, "
               "state_reason = ?, decided_by = ?, finished_at_ms = ?, lease_ms = 0 WHERE job_id = ?",
               (status,
                str(body.get("resultText") or "")[:MAX_RESULT_CHARS],
                str(body.get("error") or "")[:500],
                str(body.get("conversationId") or "")[:64],
                max(0, int(body.get("rounds") or 0)),
                max(0, int(body.get("toolCalls") or 0)),
                max(0, int(body.get("tokens") or 0)),
                str(body.get("stateReason") or "")[:MAX_NOTE_CHARS],
                decided_by,
                _now_ms(), job_id[:64]))
        row = conn.execute("SELECT employee_id FROM office_jobs WHERE job_id = ?",
                           (job_id[:64],)).fetchone()
        if row is not None:
            _sync_employee_status(conn, str(row["employee_id"]))
        review = await _route_review(conn, job_id[:64], status)
    finally:
        conn.close()
    return {"code": 0, "data": review, "message": "ok"}


@router.post("/jobs/{job_id}/abandon")
async def abandon_job(job_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """页面主动放手（比如这一场的模型没配 Key）：退回队列并写明原因。

    与租约过期的区别在于「我知道这一趟跑不了」，不必等 120 秒后被时钟判死。
    """
    conn = _get_db()
    try:
        _office_ddl(conn)
        _write(conn,
               "UPDATE office_jobs SET status = 'queued', claim_token = '', lease_ms = 0, "
               "claimed_at_ms = 0, error = ? WHERE job_id = ? AND status = 'running'",
               (str(body.get("reason") or "")[:500], job_id[:64]))
        row = conn.execute("SELECT employee_id FROM office_jobs WHERE job_id = ?",
                           (job_id[:64],)).fetchone()
        if row is not None:
            _sync_employee_status(conn, str(row["employee_id"]))
    finally:
        conn.close()
    return {"code": 0, "data": None, "message": "ok"}


# ── API：工位通信 ────────────────────────────────

@router.post("/messages")
async def post_message(body: dict[str, Any]) -> dict[str, Any]:
    """递一句话。收件人可以是员工，也可以是「人」（broadcast 就是贴进动态流）。

    wake=1 且收件人是员工时顺带排一条活。唤起受 hop 上限约束：到顶就只落消息不排活，
    并在返回里说清「为什么不唤起」——静默不唤起会被当成消息丢了。
    """
    text = str(body.get("text") or "").strip()[:MAX_MESSAGE_CHARS]
    if not text:
        return {"code": 1, "data": None, "message": "内容为空"}
    from_kind = str(body.get("fromKind") or "employee")
    if from_kind not in ("employee", "user", "system"):
        return {"code": 1, "data": None, "message": "无效的发送方"}
    to_kind = str(body.get("toKind") or "user")
    if to_kind not in ("employee", "user", "broadcast"):
        return {"code": 1, "data": None, "message": "无效的接收方"}
    job_id = str(body.get("jobId") or "")[:64]
    want_wake = bool(body.get("wake")) and to_kind == "employee"

    conn = _get_db()
    try:
        _office_ddl(conn)
        to_id = str(body.get("toId") or "")[:64]
        to_name = str(body.get("toName") or "")[:MAX_NAME_CHARS]
        target = None
        if to_kind == "employee":
            target = _resolve_recipient(conn, to_id or str(body.get("toName") or ""))
            if isinstance(target, dict):
                return target
            if target is None:
                return {"code": 1, "data": None, "message": "找不到这位同事，请核对名字"}
            to_id, to_name = str(target["employee_id"]), str(target["name"])
            if str(body.get("fromId") or "") == to_id:
                return {"code": 1, "data": None, "message": "不能给自己递话"}
        # 当前是第几手：沿着触发这条 job 的那条消息往下数
        hop = 0
        thread_id = str(body.get("threadId") or "")[:64]
        if job_id:
            parent = conn.execute("SELECT thread_id, hop FROM office_jobs WHERE job_id = ?",
                                  (job_id,)).fetchone()
            if parent is not None:
                hop = int(parent["hop"] or 0) + 1
                thread_id = thread_id or str(parent["thread_id"] or "")
        if not thread_id:
            thread_id = _new_id("thr")
        # 超过上限的这一手只记录、不唤起：链不加约束就是两台机器互相踢皮球
        capped = want_wake and hop > MAX_HOPS
        wake = 1 if (want_wake and not capped) else 0
        now = _now_ms()
        # 唤起的那一条当场就把正文带进 job 的 brief 了，标记已读才不会让下一趟重读一遍
        conn.execute(
            "INSERT INTO office_messages (thread_id, hop, from_kind, from_id, from_name, "
            "to_kind, to_id, to_name, text, job_id, wake, created_at_ms, read_at_ms) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (thread_id, hop, from_kind, str(body.get("fromId") or "")[:64],
             str(body.get("fromName") or "")[:MAX_NAME_CHARS], to_kind, to_id, to_name,
             text, job_id, wake, now, now if wake else 0),
        )
        message_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        if wake:
            _enqueue(conn, employee_id=to_id, employee_name=to_name,
                     brief=_handoff_brief(from_kind, str(body.get("fromName") or "同事"), text),
                     # 用户递的话就是交办本身，origin 要落成 manual：界面上"谁交代的"读的是这一项
                     origin="manual" if from_kind == "user" else "message",
                     thread_id=thread_id, hop=hop,
                     project_id=str(target["project_id"] or ""))
            _sync_employee_status(conn, to_id)
        conn.commit()
    finally:
        conn.close()
    data: dict[str, Any] = {"id": message_id, "threadId": thread_id, "hop": hop,
                            "toKind": to_kind, "toId": to_id, "toName": to_name,
                            "text": text, "jobId": job_id, "wake": wake}
    if capped:
        data["capped"] = True
        data["note"] = (f"已达转述上限（{MAX_HOPS} 手），消息已记录但不再自动唤起同事，"
                        "请把结论直接汇报给用户")
    return {"code": 0, "data": data, "message": "已记录" if capped else "ok"}


def _resolve_recipient(conn, key: str):
    """按 id 精确认，认不到再按名字精确认；模糊命中多条时报错而不是猜一个。

    猜的后果是把话递给了同名的另一个人，而且界面上一切正常。
    """
    text = str(key or "").strip()
    if not text:
        return None
    row = conn.execute("SELECT * FROM employees WHERE employee_id = ?", (text,)).fetchone()
    if row is not None:
        return row
    rows = conn.execute("SELECT * FROM employees WHERE name = ?", (text,)).fetchall()
    if len(rows) == 1:
        return rows[0]
    if len(rows) > 1:
        return {"code": 1, "data": None, "message": "有两位同事同名，改用工号寻址"}
    return None


@router.post("/messages/take")
async def take_messages(body: dict[str, Any]) -> dict[str, Any]:
    """某位员工取走发给自己的、还没读过的话；取走即标记已读。

    消费型收件箱与 team_inbox 同一口径：不标记的话，同一句转述会被每趟都读一遍。
    """
    employee_id = str(body.get("employeeId") or "")[:64]
    if not employee_id:
        return {"code": 1, "data": None, "message": "缺少 employeeId"}
    limit = max(1, min(50, int(body.get("limit") or 20)))
    now = _now_ms()
    conn = _get_db()
    try:
        _office_ddl(conn)
        rows = conn.execute(
            "SELECT * FROM office_messages WHERE to_kind = 'employee' AND to_id = ? "
            "AND read_at_ms = 0 ORDER BY id ASC LIMIT ?", (employee_id, limit)).fetchall()
        ids = [int(r["id"]) for r in rows]
        if ids:
            placeholders = ",".join("?" * len(ids))
            conn.execute(f"UPDATE office_messages SET read_at_ms = ? WHERE id IN ({placeholders})",
                         (now, *ids))
        conn.execute("UPDATE employees SET last_seen_ms = ? WHERE employee_id = ?",
                     (now, employee_id))
        conn.commit()
    finally:
        conn.close()
    return {"code": 0, "data": {"items": [_message_row(r) for r in rows]}, "message": "ok"}


@router.get("/messages")
async def list_messages(sinceId: int = 0, limit: int = 60) -> dict[str, Any]:
    conn = _get_db()
    try:
        _office_ddl(conn)
        rows = conn.execute(
            "SELECT * FROM office_messages WHERE id > ? ORDER BY id ASC LIMIT ?",
            (max(0, int(sinceId)), max(1, min(200, int(limit))))).fetchall()
    finally:
        conn.close()
    return {"code": 0, "data": {"items": [_message_row(r) for r in rows]}, "message": "ok"}


@router.post("/messages/read")
async def mark_read(body: dict[str, Any]) -> dict[str, Any]:
    """人看完动态流／拍板条：把发给 user 的未读清掉（员工名下的未读由 take 负责）。"""
    employee_id = str(body.get("employeeId") or "")
    conn = _get_db()
    try:
        _office_ddl(conn)
        rowcount = _write(conn,
                          "UPDATE office_messages SET read_at_ms = ? WHERE to_kind = 'user' "
                          "AND read_at_ms = 0 AND (? = '' OR from_id = ?)",
                          (_now_ms(), employee_id, employee_id))
        if employee_id:
            _sync_employee_status(conn, employee_id[:64])
    finally:
        conn.close()
    return {"code": 0, "data": {"read": rowcount}, "message": "ok"}
