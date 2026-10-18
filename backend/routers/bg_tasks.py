"""后台终端任务的 HTTP 面：面板看状态、按按钮停任务、领未读事件。

工具面（backend/skills/bg_task.py）是给模型用的；这里是给人用的那一半：
- GET  /bg-tasks              在册任务一览（含尾巴几行）+ 未读事件
- GET  /bg-tasks/{id}         单个任务 + 增量输出（since_offset 游标）
- POST /bg-tasks/{id}/stop    停一个任务（真杀进程树）
- POST /bg-tasks/events/ack   确认已送达的事件

进程寿命 = 后端进程寿命：这里不做落库重放，后端一停，在册任务随之收尾
（启动期不恢复，日志文件留在 data/bg_tasks/ 供事后查）。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from backend.skills import bg_task

router = APIRouter(prefix="/bg-tasks", tags=["bg-tasks"])


def _ok(data: Any, message: str = "ok") -> dict[str, Any]:
    return {"code": 0, "data": data, "message": message}


def _err(message: str) -> dict[str, Any]:
    return {"code": 1, "data": None, "message": message}


@router.get("")
async def list_bg_tasks(peek: bool = True, project_id: str | None = None) -> dict[str, Any]:
    """在册任务 + 未读事件。peek=false 时不带尾巴，给"只想看数量"的调用省字节。

    project_id 传了就把任务与事件一起过滤到该项目（含传空串=只看认不出归属的那些）；
    不传就是跨项目全量，任务中心要的是这一份。
    """
    tasks = bg_task.list_tasks(peek=peek, project_id=project_id)
    events = bg_task.pending_events(project_id=project_id)
    return _ok({
        "tasks": tasks,
        "events": events,
        "running": sum(1 for t in tasks if t.get("state") == "running"),
    })


@router.post("/events/ack")
async def ack_bg_events(body: dict[str, Any]) -> dict[str, Any]:
    """确认事件已送达前端。声明在 /{task_id} 之前，否则 events 会被当成任务 id。"""
    ids = body.get("eventIds")
    if not isinstance(ids, list):
        return _err("eventIds 必须是数组")
    acked = bg_task.ack_events(ids)
    return _ok({"acked": acked})


@router.post("/clear")
async def clear_bg_tasks(body: dict[str, Any] | None = None) -> dict[str, Any]:
    """清掉已结束任务的在册记录（跑着的不动）。日志文件保留在磁盘。"""
    keep_running = bool((body or {}).get("keepRunning", True))
    removed = bg_task.clear_finished(keep_running=keep_running)
    return _ok({"removed": removed})


@router.get("/{task_id}")
async def read_bg_task(
    task_id: str,
    since_offset: int | None = None,
    tail_lines: int = 0,
    grep: str = "",
) -> dict[str, Any]:
    """单个任务 + 增量输出。since_offset 是上一轮拿到的 output_offset。"""
    task = bg_task.get_task(task_id)
    if task is None:
        return _err(f"任务不存在: {task_id}")
    info = task.snapshot(peek=True)
    info.update(task.read(since_offset=since_offset, tail_lines=tail_lines, grep=grep))
    return _ok({"task": info})


@router.post("/{task_id}/stop")
async def stop_bg_task(task_id: str) -> dict[str, Any]:
    """终止任务：杀整棵进程树，不是只杀壳。"""
    result = bg_task.stop_task(task_id)
    if "error" in result:
        return _err(str(result["error"]))
    return _ok({"task": result})
