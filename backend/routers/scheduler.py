"""定时任务路由 + 后台调度器。

任务持久化在 data/scheduled_tasks.json；后台协程每 30 秒检查一次，
触发时：创建 [定时] 专属会话 → 用 desktop_state.json 中的 API Key
调用 OpenAI 兼容模型 → 将用户提示词与模型回复归档进会话。

支持「定时 + 事件」双驱动模式：
- 定时模式：once / daily / interval（原有）
- 事件模式：file_change（文件变更）/ git_push（Git 推送）/ webhook（HTTP 回调）

每条任务记着它属于哪个项目（project_id，见 data/projects.json）：跑出来的会话落在
该项目名下，事件模式没填 watch_paths 时也按这个项目根兜底——多项目在册之后，
"A 的定时任务"不能再跟着"当前正好打开着的项目"跑。
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Request

from backend.data_io import atomic_write_json, backup_corrupt
from backend import project_registry as registry
from backend.ai_features import feature_enabled
from backend.routers.chat import _get_db, add_message, create_conversation
from backend.routers.proxy import _find_model
from backend.routers.settings import STATE_PATH
from backend.subprocess_utils import hidden_subprocess_kwargs

router = APIRouter(prefix="/schedule", tags=["schedule"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
TASKS_PATH = DATA_DIR / "scheduled_tasks.json"

_loop_started = False
_running: set[str] = set()  # 正在执行中的任务 id，防止长任务被重复触发
_tasks_load_error = False  # 上次加载损坏时置位，保存前备份原文件防覆盖丢失

# ── 事件驱动状态 ────────────────────────────────

_file_mtimes: dict[str, float] = {}          # path -> last mtime
_git_heads: dict[str, str] = {}              # repo_path -> last HEAD hash
_pending_webhooks: dict[str, list[dict]] = {}  # task_id -> [payload, ...]
_event_loop_started = False


# ── 持久化 ────────────────────────────────────

def _resolve_project_id(key: Any) -> str:
    """把"归属哪个项目"认成注册表 id；没给就落到当时正在看的那一个。

    认不出来时返回空串而不是硬绑 active：一个挂在废弃目录上的定时任务，
    被悄悄改到"当前项目"名下，比它没有归属更难查。
    """
    doc = registry.load_registry()
    text = str(key or "").strip()
    if not text:
        return str(doc.get("active") or "")
    entry = registry.find_entry(doc, text)
    if entry:
        return str(entry.get("id") or "")
    return registry.project_id_for_path(doc, text)


def _project_of(task: dict[str, Any]) -> tuple[str, str]:
    """(project_id, 名称)。名称只用于旧数据口径（conversations.project 存的是名字）。"""
    pid = _resolve_project_id(task.get("project_id"))
    entry = registry.entry_of(registry.load_registry(), pid) if pid else None
    return pid, str((entry or {}).get("name") or "")


def _load_tasks() -> list[dict[str, Any]]:
    global _tasks_load_error
    if not TASKS_PATH.exists():
        _tasks_load_error = False
        return []
    try:
        data = json.loads(TASKS_PATH.read_text(encoding="utf-8"))
        _tasks_load_error = False
        return data if isinstance(data, list) else []
    except Exception:
        _tasks_load_error = True
        return []


def _save_tasks(tasks: list[dict[str, Any]]) -> None:
    if _tasks_load_error:
        backup_corrupt(TASKS_PATH)
    atomic_write_json(TASKS_PATH, tasks)


def _update_task(task: dict[str, Any]) -> None:
    """后台完成时只回写运行状态字段，避免用触发时的旧快照覆盖用户并发修改。

    模型调用可能持续数分钟，期间用户可能 PATCH 了 prompt/enabled，
    整对象覆盖会把那些改动回滚掉。
    """
    tasks = _load_tasks()
    for i, t in enumerate(tasks):
        if t.get("id") == task.get("id"):
            tasks[i]["last_run"] = task.get("last_run")
            tasks[i]["last_status"] = task.get("last_status")
            if "last_conversation_id" in task:
                tasks[i]["last_conversation_id"] = task.get("last_conversation_id")
            if task.get("mode") == "once" and "enabled" in task:
                tasks[i]["enabled"] = task["enabled"]
            break
    _save_tasks(tasks)


# ── 到期判断 ──────────────────────────────────

def _parse_hhmm(s: str) -> tuple[int, int] | None:
    try:
        h, m = str(s).split(":")
        h, m = int(h), int(m)
        if 0 <= h <= 23 and 0 <= m <= 59:
            return h, m
    except Exception:
        pass
    return None


def _today_occurrence(hhmm: tuple[int, int]) -> datetime:
    now = datetime.now()
    return now.replace(hour=hhmm[0], minute=hhmm[1], second=0, microsecond=0)


def _should_run(task: dict[str, Any], now_ts: float) -> bool:
    mode = task.get("mode", "daily")
    last_run = task.get("last_run") or 0

    if mode == "interval":
        minutes = max(1, int(task.get("every_minutes") or 60))
        base = last_run or task.get("created_at") or now_ts
        return now_ts - base >= minutes * 60

    hhmm = _parse_hhmm(task.get("time", ""))
    if not hhmm:
        return False
    occ_ts = _today_occurrence(hhmm).timestamp()
    if now_ts < occ_ts:
        return False
    if mode == "once":
        return last_run == 0  # 只执行一次
    return last_run < occ_ts  # daily：今天的时间点尚未执行


# ── 事件驱动检测器 ─────────────────────────────

def _check_file_changes(task: dict[str, Any]) -> bool:
    """检查文件变更事件：比较 mtime 是否更新。"""
    targets = _default_watch_paths(task)
    if not targets:
        return False
    changed = False
    for fp in targets:
        if not fp.exists():
            continue
        if fp.is_dir():
            # 目录：逐一比对目录内所有文件 mtime。
            # 初始快照由 _init_event_snapshots 预填，因此运行期出现的新 key 就是新建文件，应触发
            try:
                for f in fp.rglob("*"):
                    if not f.is_file():
                        continue
                    key = str(f.resolve())
                    mtime = f.stat().st_mtime
                    if key not in _file_mtimes:
                        changed = True
                    elif mtime > _file_mtimes[key]:
                        changed = True
                    _file_mtimes[key] = mtime
            except (OSError, ValueError):
                pass
        elif fp.is_file():
            mtime = fp.stat().st_mtime
            key = str(fp.resolve())
            if key not in _file_mtimes:
                changed = True
            elif mtime > _file_mtimes[key]:
                changed = True
            _file_mtimes[key] = mtime
    return changed


def _default_watch_paths(task: dict[str, Any]) -> list[Path]:
    """watch_paths 没填时按项目根兜底。

    多项目在册之前，"项目根"就是当时打开的那一个；现在有了注册表，
    兜底必须认任务自己记的 project_id——否则 A 的定时任务会在切到 B 之后
    开始盯 B 的文件改动。
    """
    paths = [p.strip() for p in str(task.get("watch_paths") or "").splitlines() if p.strip()]
    if paths:
        return [Path(p).expanduser() for p in paths]
    pid = _resolve_project_id(task.get("project_id"))
    entry = registry.entry_of(registry.load_registry(), pid) if pid else None
    host = str((entry or {}).get("path") or "")
    return [Path(host)] if host else []


def _check_git_push(task: dict[str, Any]) -> bool:
    """检查 Git push 事件：比较 HEAD hash 是否变化。"""
    repo_path = task.get("git_repo", "").strip()
    if not repo_path:
        return False
    rp = Path(repo_path)
    if not (rp / ".git").exists():
        return False
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(rp), capture_output=True, text=True, timeout=10,
            **hidden_subprocess_kwargs(),
        )
        if result.returncode != 0:
            return False
        current_head = result.stdout.strip()
        key = str(rp.resolve())
        if key in _git_heads and current_head != _git_heads[key]:
            _git_heads[key] = current_head
            return True
        _git_heads[key] = current_head
    except Exception:
        pass
    return False


def _check_webhook(task: dict[str, Any]) -> bool:
    """检查是否有待处理的 webhook 触发。"""
    task_id = task.get("id", "")
    # 只判断不消费：payload 由 _run_task 在真正注入提示词时取出，
    # 避免这里清空后异步任务读到空列表
    return bool(_pending_webhooks.get(task_id))


def _should_run_event(task: dict[str, Any]) -> bool:
    """事件模式任务是否应触发。"""
    event_type = task.get("event_type", "")
    cooldown = max(10, int(task.get("cooldown_seconds") or 60))  # 最小触发间隔 10 秒
    last_run = task.get("last_run") or 0
    # 冷却期内不触发
    if time.time() - last_run < cooldown:
        return False

    if event_type == "file_change":
        return _check_file_changes(task)
    elif event_type == "git_push":
        return _check_git_push(task)
    elif event_type == "webhook":
        return _check_webhook(task)
    return False


def _init_event_snapshots() -> None:
    """初始化事件快照：记录当前文件 mtime 和 git HEAD，避免启动时误触发。"""
    for task in _load_tasks():
        if task.get("mode") != "event" or not task.get("enabled"):
            continue
        event_type = task.get("event_type", "")
        if event_type == "file_change":
            # 快照必须按和 _check_file_changes 完全同一套路径来铺（含"没填就按项目根"），
            # 两边口径一旦不同，启动后第一次 tick 就会把整批文件当成"新建"而误触发
            for fp in _default_watch_paths(task):
                if fp.is_file():
                    _file_mtimes[str(fp.resolve())] = fp.stat().st_mtime
                elif fp.is_dir():
                    try:
                        for f in fp.rglob("*"):
                            if f.is_file():
                                _file_mtimes[str(f.resolve())] = f.stat().st_mtime
                    except OSError:
                        pass
        elif event_type == "git_push":
            repo_path = task.get("git_repo", "").strip()
            rp = Path(repo_path)
            if (rp / ".git").exists():
                try:
                    result = subprocess.run(
                        ["git", "rev-parse", "HEAD"],
                        cwd=str(rp), capture_output=True, text=True, timeout=10,
                        **hidden_subprocess_kwargs(),
                    )
                    if result.returncode == 0:
                        _git_heads[str(rp.resolve())] = result.stdout.strip()
                except Exception:
                    pass


# ── 任务执行 ──────────────────────────────────

def _finish_run(task: dict[str, Any], error: str | None = None, conversation_id: str | None = None) -> None:
    task["last_run"] = time.time()
    task["last_status"] = f"error: {error}" if error else "ok"
    if conversation_id:
        task["last_conversation_id"] = conversation_id
    if task.get("mode") == "once":
        task["enabled"] = False
    _update_task(task)


async def _run_task(task: dict[str, Any]) -> None:
    model_id = task.get("model_id", "")
    prompt = task.get("prompt", "")

    # 这一档关掉就一次模型都不发：把原因写进 last_status，界面上看得见"为什么没跑"，
    # 而不是让人以为定时任务本身坏了。
    if not feature_enabled("scheduled_task"):
        _finish_run(task, error="「定时与事件任务」已在设置中关闭（设置 → AI 辅助功能）")
        return

    # 事件模式：注入触发上下文
    if task.get("mode") == "event":
        event_type = task.get("event_type", "")
        context_parts = []
        if event_type == "file_change":
            # 找出最近变更的文件
            changed_files = []
            for p_str, mtime in _file_mtimes.items():
                if time.time() - mtime < 120:  # 2 分钟内变更的
                    changed_files.append(p_str)
            context_parts.append(f"触发原因：文件变更\n最近变更文件：{', '.join(changed_files[-10:])}")
        elif event_type == "git_push":
            repo = task.get("git_repo", "")
            head = _git_heads.get(str(Path(repo).resolve()), "")
            context_parts.append(f"触发原因：Git push 检测\n仓库：{repo}\n最新 HEAD：{head[:12]}")
        elif event_type == "webhook":
            # 消费队列：取出后清空，payload 真正进入提示词
            payloads = _pending_webhooks.pop(task.get("id", ""), [])
            context_parts.append(f"触发原因：Webhook 回调")
            if payloads:
                try:
                    context_parts.append(f"Payload: {json.dumps(payloads[-1], ensure_ascii=False)[:2000]}")
                except Exception:
                    pass
        if context_parts:
            prompt = f"{prompt}\n\n---\n事件上下文：\n" + "\n".join(context_parts)

    try:
        shared = json.loads(STATE_PATH.read_text(encoding="utf-8")) if STATE_PATH.exists() else {}
    except Exception:
        shared = {}

    api_key = (shared.get("modelKeys") or {}).get(model_id, "")
    if not api_key:
        _finish_run(task, error="未配置该模型的 API Key")
        return

    model = _find_model(model_id)
    base_url = model["base_url"] if model else None
    provider = model.get("provider") if model else "openai"
    if not base_url:
        for cm in shared.get("customModels") or []:
            if cm.get("id") == model_id:
                base_url = cm.get("base_url")
                provider = "openai"
                break
    if not base_url:
        _finish_run(task, error="找不到模型的 base_url")
        return
    if provider != "openai":
        _finish_run(task, error="定时任务目前仅支持 OpenAI 兼容模型")
        return

    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": "你是 SLATE 的定时任务执行器。请直接、完整地执行用户给出的定时指令并输出结果，不要反问；结果有结构时用清晰的 Markdown 组织。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.7,
        "max_tokens": 8192,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(base_url.rstrip("/") + "/chat/completions", json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    reply = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    if not reply:
        _finish_run(task, error="模型返回为空")
        return

    # 归档到专属会话
    stamp = datetime.now().strftime("%m-%d %H:%M")
    prefix = "[事件]" if task.get("mode") == "event" else "[定时]"
    title = f"{prefix} {task.get('name') or '未命名'} · {stamp}"
    # 会话要落在它自己的项目上：否则 A 的定时任务跑出来的那条，会在按项目筛选时
    # 出现在"当前正好打开着"的那个项目里（旧版只有单项目，看不出来；多项目下就是假归属）
    pid, pname = _project_of(task)
    conv = await create_conversation({"title": title, "project_id": pid, "project": pname})
    conv_id = conv["data"]["id"]
    await add_message(conv_id, {"role": "user", "content": prompt, "model": ""})
    await add_message(conv_id, {"role": "assistant", "content": reply, "model": model_id})
    # add_message 会用首条用户消息覆盖标题，这里改回 [定时] 标题
    conn = _get_db()
    conn.execute("UPDATE conversations SET title = ? WHERE id = ?", (title, conv_id))
    conn.commit()
    conn.close()

    _finish_run(task, conversation_id=conv_id)


async def _guarded_run(task: dict[str, Any]) -> None:
    task_id = task.get("id", "")
    _running.add(task_id)
    try:
        await _run_task(task)
    except httpx.HTTPStatusError as exc:
        _finish_run(task, error=f"模型 API 错误 {exc.response.status_code}")
    except Exception as exc:
        _finish_run(task, error=str(exc))
    finally:
        _running.discard(task_id)


# ── 后台循环 ──────────────────────────────────

async def _tick() -> None:
    now_ts = time.time()
    for task in _load_tasks():
        if not task.get("enabled"):
            continue
        if task.get("id") in _running:
            continue
        mode = task.get("mode", "daily")
        if mode == "event":
            if _should_run_event(task):
                asyncio.create_task(_guarded_run(dict(task)))
        elif _should_run(task, now_ts):
            asyncio.create_task(_guarded_run(dict(task)))


async def _loop() -> None:
    while True:
        try:
            await _tick()
        except Exception:
            pass
        await asyncio.sleep(30)


def start_scheduler() -> None:
    global _loop_started, _event_loop_started
    if _loop_started:
        return
    _loop_started = True
    _init_event_snapshots()
    asyncio.create_task(_loop())
    # 事件检测循环（与定时循环共用 _tick，无需独立循环）
    _event_loop_started = True


# ── API ───────────────────────────────────────

@router.get("/tasks")
async def list_tasks() -> dict[str, Any]:
    return {"code": 0, "data": _load_tasks(), "message": "ok"}


@router.post("/tasks")
async def create_task(body: dict[str, Any]) -> dict[str, Any]:
    name = str(body.get("name", "")).strip()
    prompt = str(body.get("prompt", "")).strip()
    model_id = str(body.get("model_id", "")).strip()
    mode = body.get("mode", "daily")
    if mode not in ("once", "daily", "interval", "event"):
        return {"code": 1, "message": "无效的执行模式"}
    if not name or not prompt or not model_id:
        return {"code": 1, "message": "名称、提示词、模型均必填"}
    if mode == "event":
        event_type = body.get("event_type", "")
        if event_type not in ("file_change", "git_push", "webhook"):
            return {"code": 1, "message": "无效的事件类型"}
    elif mode != "interval" and not _parse_hhmm(body.get("time", "")):
        return {"code": 1, "message": "请填写有效的执行时间（HH:MM）"}
    task = {
        "id": str(uuid.uuid4())[:8],
        "name": name,
        "prompt": prompt,
        "model_id": model_id,
        "mode": mode,
        "time": body.get("time", "09:00") if mode not in ("interval", "event") else "",
        "every_minutes": max(1, int(body.get("every_minutes") or 60)) if mode == "interval" else 0,
        # 事件模式字段
        "event_type": body.get("event_type", "") if mode == "event" else "",
        "watch_paths": body.get("watch_paths", "") if mode == "event" else "",
        "git_repo": body.get("git_repo", "") if mode == "event" else "",
        "webhook_secret": body.get("webhook_secret", "") if mode == "event" else "",
        "cooldown_seconds": max(10, int(body.get("cooldown_seconds") or 60)) if mode == "event" else 0,
        "enabled": True,
        "created_at": time.time(),
        "last_run": None,
        "last_status": "",
        "last_conversation_id": "",
        # 归属项目：建任务时认一次（前端给了就用给的，没给就记当时正在看的那一个）。
        # 存 id 而不是名字——名字可以重、可以改，id 才认得出"这两条属于同一个项目"。
        "project_id": _resolve_project_id(body.get("project_id")),
    }
    tasks = _load_tasks()
    tasks.append(task)
    _save_tasks(tasks)
    # 初始化事件快照（避免启动时误触发）
    if mode == "event":
        _init_event_snapshots()
    return {"code": 0, "data": task, "message": "ok"}


@router.patch("/tasks/{task_id}")
async def update_task(task_id: str, body: dict[str, Any]) -> dict[str, Any]:
    tasks = _load_tasks()
    target = next((t for t in tasks if t.get("id") == task_id), None)
    if not target:
        return {"code": 1, "message": "任务不存在"}
    allowed = {"name", "prompt", "model_id", "mode", "time", "every_minutes", "enabled",
               "event_type", "watch_paths", "git_repo", "webhook_secret", "cooldown_seconds",
               # 允许把任务改挂到别的项目（重命名/搬家之后手工归位）
               "project_id"}
    for key in allowed:
        if key in body:
            target[key] = body[key]
    _save_tasks(tasks)
    return {"code": 0, "data": target, "message": "ok"}


@router.delete("/tasks/{task_id}")
async def delete_task(task_id: str) -> dict[str, Any]:
    tasks = [t for t in _load_tasks() if t.get("id") != task_id]
    _save_tasks(tasks)
    return {"code": 0, "data": None, "message": "ok"}


@router.post("/tasks/{task_id}/run")
async def run_task_now(task_id: str) -> dict[str, Any]:
    target = next((t for t in _load_tasks() if t.get("id") == task_id), None)
    if not target:
        return {"code": 1, "message": "任务不存在"}
    if task_id in _running:
        return {"code": 1, "message": "任务正在执行中"}
    asyncio.create_task(_guarded_run(dict(target)))
    return {"code": 0, "data": None, "message": "已触发"}


# ── Webhook 接收端点 ─────────────────────────────

@router.post("/webhook/{task_id}")
async def receive_webhook(task_id: str, request: Request) -> dict[str, Any]:
    """接收外部 Webhook 回调，触发对应的事件任务。

    调用方式：POST /api/schedule/webhook/{task_id}
    Body: 任意 JSON（可选，会作为上下文注入提示词）
    """
    tasks = _load_tasks()
    target = next((t for t in tasks if t.get("id") == task_id), None)
    if not target:
        return {"code": 1, "message": "任务不存在"}
    if target.get("mode") != "event" or target.get("event_type") != "webhook":
        return {"code": 1, "message": "该任务不是 Webhook 事件类型"}
    if not target.get("enabled"):
        return {"code": 1, "message": "任务已停用"}

    # 解析 payload
    try:
        payload = await request.json()
    except Exception:
        payload = {"raw": "(non-JSON body)"}

    # 校验 secret（如果任务配置了 webhook_secret）
    expected_secret = target.get("webhook_secret", "")
    if expected_secret:
        received_secret = str(payload.get("secret", ""))
        if received_secret != expected_secret:
            return {"code": 1, "message": "Webhook secret 校验失败"}

    # 加入待处理队列
    if task_id not in _pending_webhooks:
        _pending_webhooks[task_id] = []
    _pending_webhooks[task_id].append({
        "received_at": time.time(),
        "payload": payload,
    })
    return {"code": 0, "data": None, "message": "Webhook 已接收，将在下次轮询时触发任务"}


@router.get("/events/status")
async def event_status() -> dict[str, Any]:
    """返回事件驱动系统状态（调试用）。"""
    return {
        "code": 0,
        "data": {
            "file_watchers": len(_file_mtimes),
            "git_watchers": len(_git_heads),
            "pending_webhooks": {k: len(v) for k, v in _pending_webhooks.items() if v},
        },
        "message": "ok",
    }
