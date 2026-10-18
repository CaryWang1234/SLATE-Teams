"""后台终端任务：把耗时命令（编译、实验服务器）丢到后台，模型不用轮询。

为什么要有它：一条 `npm run build` 或训练脚本动辄几分钟，`terminal` 的 30 秒上限
等不起；让模型每轮都去问"好了没"则是在烧 token。这里的做法是"起完就走"——
start 立刻返回 task_id，进程由本模块自己管着，输出进环形缓冲 + 落盘日志；
任务结束（或输出命中模型自己设的正则）时挂一个事件，由前端把它送回对话，
模型这才被叫醒读输出。

三条不变量：
① 后台不等于免审：高危命令仍过 `check_high_risk`，灾难级命令直接拒，全部复用 terminal 的判定；
② 进程随 SLATE 后端进程存亡（不装服务、不跨重启），但日志落 `data/bg_tasks/<id>.log` 可事后查——
   跟用户说清楚"关掉 SLATE 任务就没了"，比假装能持久化要诚实；
③ 一次性语义与 `terminal` 完全一致（Windows 走同一个 PowerShell 包装脚本），
   唯一区别是"不等它结束"。因此后台任务**不接受交互式输入**，裸 python/node 这类 REPL 在这里没有意义。
④ 每个任务都记得自己"属于哪个项目、哪场会话"：多项目在册之后，A 的任务在 B 的视野里
   也看得见、也停得了，但它的结束事件必须回到 A 的那场会话去——把 A 的结局念给 B 听，
   模型就会拿着一份不相干的输出继续干 B 的活。归属优先按调用方给的 project 认，
   没给（别的入口起的）就按工作目录落在谁的目录树下反查。
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any

from backend.skills.terminal import (
    BLOCKED_PREFIXES,
    MAX_COMMAND_LENGTH,
    STATE_TRAILER_PREFIX,
    TERMINAL_ENCODING,
    _kill_process_tree,
    _powershell_argv,
    _take_state_trailer,
    check_high_risk,
    powershell_command_body,
    powershell_wrapper_script,
)
from backend.subprocess_utils import hidden_subprocess_kwargs
from backend import project_registry as registry

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
LOG_DIR = DATA_DIR / "bg_tasks"

# 环形缓冲上限（字符）：长任务输出可以很多，但留在内存里的只保留尾部
RETAIN_CHARS = 200_000
# 单次 status/log 最多回给模型多少字符（省 token 的第一道闸）
READ_MAX_CHARS = 40_000
# status 里不带 task_id 时，给每个任务带几行尾巴
PEEK_LINES = 3
# 在册上限：跑着的任务与留档的已结束任务分别封顶，避免无限堆积
MAX_RUNNING = 12
MAX_KEPT_FINISHED = 20
# 触发正则长度上限（防止模型塞一条能跑很久的表达式）
MAX_PATTERN = 200
# 单任务最多挂几个未读事件（命中正则后又结束，就别把前面的挤掉）
MAX_EVENTS_PER_TASK = 8
# start 的"先看一小段再返回"窗口：让用户/模型立刻看到命令有没有起来
HEAD_WINDOW_SECONDS = 1.2
HEAD_MAX_CHARS = 4_000


def _kill_task_group(proc: subprocess.Popen) -> None:
    """杀整个进程组。

    POSIX 上必须按进程组杀：`bash -c "make -j8"` 里真正在干活的是 make 及其子孙，
    只 terminate 直接子进程（terminal 那边的语义）会把编译留在后台继续跑——"停止"就成了谎话。
    所以后台任务起在自己的会话里（start_new_session），这里 killpg 收整组；
    Windows 走 terminal 的 taskkill /T，它本来就管整棵树。
    """
    if sys.platform == "win32":
        _kill_process_tree(proc)
        return
    try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGTERM)
        try:
            proc.wait(timeout=2)
        except Exception:
            os.killpg(pgid, signal.SIGKILL)
    except Exception:
        _kill_process_tree(proc)


class BgTask:
    """一个后台进程 + 它的输出缓冲、日志与触发事件。"""

    def __init__(self, command: str, work_dir: str, label: str, trigger: dict[str, Any], notify: bool,
                 project_id: str = "", conversation_id: str = "") -> None:
        self.id = "bt_" + uuid.uuid4().hex[:8]
        self.command = command
        self.work_dir = work_dir
        self.label = label or command[:60]
        self.trigger = trigger
        self.notify = bool(notify)
        # 出处：谁的地盘 + 哪场会话起的。空串表示"认不出来"，前端就不往任何会话里念
        self.project_id = str(project_id or "")
        self.conversation_id = str(conversation_id or "")
        self.created_at = time.time()
        self.started_at = self.created_at
        self.ended_at: float | None = None
        self.state = "running"
        self.exit_code: int | None = None
        self.pid: int | None = None
        self.output_bytes = 0
        self.total_chars = 0
        self.timed_out = False

        self._events: deque[dict[str, Any]] = deque(maxlen=MAX_EVENTS_PER_TASK)
        self._chunks: deque[str] = deque()
        self._chars = 0
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._timer: threading.Timer | None = None
        self._log = None
        self._matched = False
        self._finalized = False
        self._pattern = self._compile_pattern(trigger)

    # ── 触发条件 ──────────────────────────────

    @staticmethod
    def _compile_pattern(trigger: dict[str, Any]) -> re.Pattern | None:
        raw = str((trigger or {}).get("pattern") or "")
        if (trigger or {}).get("on") != "match" or not raw:
            return None
        if len(raw) > MAX_PATTERN:
            return None
        try:
            return re.compile(raw)
        except re.error:
            return None

    def trigger_error(self) -> str:
        """触发条件写坏了要说清楚，而不是安静地不生效。"""
        trigger = self.trigger or {}
        on = str(trigger.get("on") or "")
        if on == "match" and self._pattern is None:
            raw = str(trigger.get("pattern") or "")
            if not raw:
                return "trigger.on=match 需要同时给 pattern"
            if len(raw) > MAX_PATTERN:
                return f"pattern 过长（>{MAX_PATTERN} 字符）"
            return f"pattern 不是合法正则: {raw}"
        if on not in ("", "exit", "match"):
            return f"未知的 trigger.on: {on}（可用 exit / match）"
        return ""

    # ── 启动 ─────────────────────────────────

    def start(self, timeout: float = 0) -> dict[str, Any]:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log_path = LOG_DIR / f"{self.id}.log"
        self._log = log_path.open("a", encoding="utf-8", errors="replace", newline="\n")
        self._log.write(f"# {self.label}\n# {self.command}\n# cwd: {self.work_dir}\n")
        self._log.flush()

        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        if sys.platform == "win32":
            argv: Any = _powershell_argv(powershell_wrapper_script())
            stdin_text: str | None = powershell_command_body(self.command)
        else:
            argv = ["/bin/bash", "--norc", "--noprofile", "-c", self.command]
            stdin_text = None

        self._proc = subprocess.Popen(
            argv,
            cwd=self.work_dir,
            env=env,
            stdin=(subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,   # 合并成一路：后台任务的报错通常和进度混在一起，分开读反而难对齐
            text=True,
            encoding=TERMINAL_ENCODING,
            errors="replace",
            bufsize=1,
            start_new_session=(sys.platform != "win32"),   # 自己一组，停止时才好整组收掉
            **hidden_subprocess_kwargs(),
        )
        self.pid = self._proc.pid
        if stdin_text is not None:
            threading.Thread(target=self._feed_stdin, args=(stdin_text,), daemon=True).start()
        threading.Thread(target=self._pump, daemon=True).start()
        if timeout and float(timeout) > 0:
            self._timer = threading.Timer(float(timeout), self._on_timeout)
            self._timer.daemon = True
            self._timer.start()
        return self.snapshot()

    def _feed_stdin(self, text: str) -> None:
        """命令主体走 stdin，写完立刻关——与 terminal 同一口径（关掉让误起的 REPL 直接 EOF）。"""
        try:
            assert self._proc and self._proc.stdin
            self._proc.stdin.write(text)
            self._proc.stdin.flush()
        except Exception:
            pass
        finally:
            try:
                if self._proc and self._proc.stdin:
                    self._proc.stdin.close()
            except Exception:
                pass

    def _on_timeout(self) -> None:
        self.timed_out = True
        self.stop(reason="任务超过 timeout 上限，已终止")

    # ── 输出 ─────────────────────────────────

    def _append(self, text: str, stream: str = "stdout") -> None:
        if not text:
            return
        matched = False
        with self._lock:
            self._chunks.append(text)
            self._chars += len(text)
            self.total_chars += len(text)
            while self._chars > RETAIN_CHARS and self._chunks:
                self._chars -= len(self._chunks.popleft())
            if self._pattern is not None and not self._matched and stream == "stdout":
                try:
                    if self._pattern.search(text):
                        self._matched = True
                        matched = True
                except Exception:
                    pass
        try:
            if self._log:
                self._log.write(text)
                self._log.flush()
        except Exception:
            pass
        self.output_bytes += len(text.encode("utf-8", errors="replace"))
        if matched:
            self._fire("match", f"输出命中触发条件 /{self.trigger.get('pattern')}/")

    def _pump(self) -> None:
        """读 stdout 到进程结束；状态行不进可见输出（它带着会话状态，本来就不是给用户看的）。"""
        proc = self._proc
        exit_code: int | None = None
        try:
            assert proc and proc.stdout
            for line in iter(proc.stdout.readline, ""):
                if STATE_TRAILER_PREFIX in line:
                    rest, state = _take_state_trailer(line)
                    if state:
                        exit_code = state.get("exit", exit_code)
                    if rest:
                        self._append(rest + "\n")
                    continue
                self._append(line)
        except Exception:
            pass
        try:
            proc.wait(timeout=10)
        except Exception:
            pass
        self._finalize(exit_code if exit_code is not None else getattr(proc, "returncode", None))

    def _finalize(self, exit_code: int | None = None) -> None:
        """收尾只做一次：抢到 finalized 位的那一方决定最终状态并挂事件。

        stop() 与读线程的收尾会撞在一起（用户点停止的同时进程自己也退了），
        所以状态改写在锁里、靠 _finalized 位保证只走一次。
        """
        with self._lock:
            if self._finalized:
                return
            self._finalized = True
            self.ended_at = time.time()
            if self.state == "running":
                self.exit_code = exit_code
                self.state = "exited" if exit_code in (0, None) else "failed"
            elif self.state == "stopped":
                self.exit_code = exit_code if exit_code is not None else self.exit_code
            if self.timed_out and self.state == "exited":
                self.state = "failed"
            state, code = self.state, self.exit_code
        if self._timer:
            self._timer.cancel()
        try:
            if self._log:
                self._log.write(f"\n# 结束：state={state} exit={code}\n")
                self._log.close()
                self._log = None
        except Exception:
            pass
        if state == "stopped":
            self._fire("stopped", f"后台任务已终止（{self.label}）")
        else:
            kind = "exit" if state == "exited" else "fail"
            self._fire(kind, f"后台任务结束（{state}，退出码 {code}）")

    def _fire(self, kind: str, text: str) -> None:
        """挂事件；只有 notify 的任务才进"唤醒模型"的队列，否则安静躺着等 status/log 去问。"""
        with self._lock:
            if not self.notify:
                return
            self._events.append({
                "event_id": f"{self.id}:{self.total_chars}:{kind}",
                "task_id": self.id,
                "label": self.label,
                "kind": kind,
                "state": self.state,
                "exit_code": self.exit_code,
                "text": text,
                "at": time.time(),
                # 出处随事件走：前端据此决定"念给哪场会话"，而不是顺手念给当前会话
                "project_id": self.project_id,
                "conversation_id": self.conversation_id,
                "tail": self._tail_locked(1500),
            })

    def _tail_locked(self, chars: int) -> str:
        buf = "".join(self._chunks)
        return buf[-chars:] if len(buf) > chars else buf

    # ── 读取 ─────────────────────────────────

    def read(self, since_offset: int | None = None, tail_lines: int = 0, grep: str = "") -> dict[str, Any]:
        buf = "".join(self._chunks)
        total = self.total_chars
        trimmed = total - len(buf)
        start = 0
        if since_offset is not None:
            start = max(0, int(since_offset) - trimmed)
        text = buf[start:]
        if grep:
            try:
                rx = re.compile(grep)
                text = "\n".join(line for line in text.splitlines() if rx.search(line))
            except re.error as exc:
                return {"error": f"grep 不是合法正则: {exc}"}
        if tail_lines and tail_lines > 0:
            lines = text.splitlines()
            text = "\n".join(lines[-int(tail_lines):])
        truncated = len(text) > READ_MAX_CHARS
        if truncated:
            text = text[-READ_MAX_CHARS:]
        return {
            "output": text,
            "output_offset": total,
            "output_bytes": self.output_bytes,
            "trimmed_chars": trimmed,
            "truncated": truncated,
        }

    def snapshot(self, peek: bool = False) -> dict[str, Any]:
        with self._lock:
            ended = self.ended_at or time.time()
            info: dict[str, Any] = {
                "task_id": self.id,
                "label": self.label,
                "command": self.command,
                "work_dir": self.work_dir,
                "state": self.state,
                "exit_code": self.exit_code,
                "pid": self.pid,
                "started_at": self.started_at,
                "duration": round(ended - self.started_at, 1),
                "output_bytes": self.output_bytes,
                "output_offset": self.total_chars,
                "notify": self.notify,
                "trigger": self.trigger or {},
                "timed_out": self.timed_out,
                "pending_event": bool(self._events),
                "project_id": self.project_id,
                "conversation_id": self.conversation_id,
                "log_path": str(LOG_DIR / f"{self.id}.log"),
            }
            if peek:
                tail = self._tail_locked(600)
                info["tail"] = "\n".join(tail.splitlines()[-PEEK_LINES:])
            return info

    def alive(self) -> bool:
        return self.state == "running"

    # ── 停止 ─────────────────────────────────

    def stop(self, reason: str = "已按请求终止") -> dict[str, Any]:
        """杀整棵进程树：shell 里起的子进程不会随父进程自己退出。"""
        with self._lock:
            was_running = self.state == "running"
            if was_running:
                self.state = "stopped"
        if was_running and self._proc is not None:
            _kill_task_group(self._proc)
        self._append(f"\n[{reason}]\n")
        self._finalize()
        return self.snapshot()

    def close(self) -> None:
        if self.alive():
            self.stop("SLATE 关闭，随宿主进程一起终止")
        try:
            if self._log:
                self._log.close()
                self._log = None
        except Exception:
            pass


# ── 任务表 ────────────────────────────────────

_tasks: dict[str, BgTask] = {}
_tasks_lock = threading.Lock()


def _prune() -> None:
    """在册上限：跑着的按 MAX_RUNNING 拦，已结束的按 MAX_KEPT_FINISHED 留档。"""
    with _tasks_lock:
        finished = sorted(
            [t for t in _tasks.values() if not t.alive()],
            key=lambda t: t.ended_at or t.created_at,
        )
        while len(finished) > MAX_KEPT_FINISHED:
            victim = finished.pop(0)
            _tasks.pop(victim.id, None)
            victim.close()


def _running_count() -> int:
    return sum(1 for t in _tasks.values() if t.alive())


def _owner_project_id(project: Any) -> str:
    """把调用方给的 project（id / 路径 / 唯一名称）认成注册表里的 id。"""
    text = str(project or "").strip()
    if not text:
        return ""
    entry = registry.find_entry(registry.load_registry(), text)
    return str((entry or {}).get("id") or "")


def _provenance(project: Any, work_dir: str) -> str:
    """任务归属：先认调用方给的项目，认不出再按工作目录落在谁的目录树下反查。

    两步都要：调用方（前端）知道"现在看着哪个项目"，但 curl / 移动端 / 工作区外的
    命令未必带得上；而 work_dir 一直都在，只是它可能压根不在任何在册项目里。
    """
    given = _owner_project_id(project)
    if given:
        return given
    return registry.project_id_for_path(registry.load_registry(), work_dir)


def get_task(task_id: str) -> BgTask | None:
    return _tasks.get(str(task_id or "").strip())


def list_tasks(peek: bool = False, project_id: str | None = None) -> list[dict[str, Any]]:
    _prune()
    items = sorted(_tasks.values(), key=lambda t: (not t.alive(), -t.started_at))
    if project_id is not None:
        # 传空串=只看"认不出归属"的那一批（老任务/工作区外的命令）；None=不过滤
        items = [t for t in items if t.project_id == str(project_id)]
    return [t.snapshot(peek=peek) for t in items]


def pending_events(project_id: str | None = None) -> list[dict[str, Any]]:
    """未被确认的事件（至少一次投递：前端送达/入队后再 ack）。

    project_id 过滤给"只看当前视野"的调用方；任务中心要跨项目，默认不过滤。
    """
    out = []
    wanted = None if project_id is None else str(project_id)
    for task in _tasks.values():
        if wanted is not None and task.project_id != wanted:
            continue
        with task._lock:
            out.extend(dict(e) for e in task._events)
    out.sort(key=lambda e: e.get("at") or 0)
    return out


def ack_events(event_ids: list[str]) -> int:
    wanted = {str(x) for x in (event_ids or [])}
    acked = 0
    for task in _tasks.values():
        with task._lock:
            keep = [e for e in task._events if e.get("event_id") not in wanted]
            acked += len(task._events) - len(keep)
            task._events.clear()
            task._events.extend(keep)
    return acked


def stop_task(task_id: str) -> dict[str, Any]:
    task = get_task(task_id)
    if not task:
        return {"error": f"任务不存在: {task_id}"}
    return task.stop()


def clear_finished(keep_running: bool = True) -> int:
    """清在册记录。跑着的任务只在 keep_running=False 时一并停掉；日志文件不动。"""
    removed = 0
    with _tasks_lock:
        for tid in list(_tasks.keys()):
            task = _tasks[tid]
            if task.alive():
                if keep_running:
                    continue
                task.stop("已随记录一起清除")
            _tasks.pop(tid, None)
            task.close()
            removed += 1
    return removed


def shutdown() -> None:
    """宿主进程退出时收尾（main.py 的 shutdown 钩子调用）。"""
    for task in list(_tasks.values()):
        task.close()


# ── 技能入口 ──────────────────────────────────

def execute(**params: Any) -> dict[str, Any]:
    return _execute(**params)


def run_stream(ctx: Any, **params: Any) -> dict[str, Any]:
    return _execute(ctx=ctx, **params)


def _execute(
    action: str = "start",
    command: str = "",
    label: str = "",
    work_dir: str = ".",
    trigger: dict[str, Any] | None = None,
    notify: bool = False,
    task_id: str = "",
    timeout: float = 0,
    tail_lines: int = 0,
    since_offset: int | None = None,
    grep: str = "",
    approved: bool = False,
    project: str = "",
    conversation_id: str = "",
    ctx: Any = None,
    **_: Any,
) -> dict[str, Any]:
    """后台任务管理。

    Args:
        action: start / status / log / stop / list
        command: 要执行的命令（action=start）
        label: 任务名（给人看的一行标签）
        work_dir: 工作目录
        trigger: 触发条件 {"on": "exit"|"match", "pattern": "正则（on=match 时必填）"}
        notify: 命中触发条件/结束时是否叫醒模型（true 才进事件队列，否则要用 status 主动问）
        task_id: 目标任务（status/log/stop）
        timeout: 秒；>0 时到点终止任务（默认不限）
        tail_lines / since_offset / grep: log 的取用方式
        approved: 高危命令是否已获用户批准
        project: 这个任务属于哪个在册项目（id / 路径 / 唯一名称都行）；不传就按 work_dir 反查
        conversation_id: 起它的那场会话（结束事件回哪儿由它决定）
        ctx: 流式上下文（只有 start 用它推开头一小段）
    """
    action = (action or "start").strip().lower()

    if action in ("list", "status"):
        target = get_task(task_id) if task_id else None
        if task_id and not target:
            return {"error": f"任务不存在: {task_id}"}
        if target:
            info = target.snapshot(peek=True)
            info.update(target.read(since_offset=since_offset))
            return {"task": info, "hint": _HINT}
        wanted: str | None = None
        if str(project or "").strip():
            wanted = _owner_project_id(project)
            if not wanted:
                # 认不出来就说认不出来：静默回一堆别的项目的任务，比报错更难查
                return {"error": f"项目不在册，无法按项目过滤: {project}"}
        tasks = list_tasks(peek=True, project_id=wanted)
        return {"tasks": tasks, "count": len(tasks), "hint": _HINT}

    if action == "log":
        target = get_task(task_id)
        if not target:
            return {"error": f"任务不存在: {task_id}"}
        info = target.snapshot(peek=False)
        info.update(target.read(since_offset=since_offset, tail_lines=tail_lines, grep=grep))
        if "error" in info:
            return info
        return {"task": info, "hint": _HINT}

    if action == "stop":
        target = get_task(task_id)
        if not target:
            return {"error": f"任务不存在: {task_id}"}
        if not target.alive():
            info = target.snapshot(peek=True)
            info.update(target.read(tail_lines=20))
            return {"task": info, "message": "任务早已结束，无需停止"}
        info = target.stop()
        info.update(target.read(tail_lines=20))
        return {"task": info, "message": f"已终止 {target.id}"}

    if action != "start":
        return {"error": f"未知操作: {action}（可用 start/status/log/stop/list）"}

    # ── start ────────────────────────────────
    command = str(command or "").strip()
    if not command:
        return {"error": "命令不能为空"}
    if len(command) > MAX_COMMAND_LENGTH:
        return {"error": f"命令过长（{len(command)} 字符 > {MAX_COMMAND_LENGTH} 限制）"}

    cmd_lower = command.lower()
    for prefix in BLOCKED_PREFIXES:
        if cmd_lower.startswith(prefix):
            return {"error": f"禁止执行的危险命令: {prefix}"}
    risk = check_high_risk(command)
    if risk and not bool(approved):
        return {"error": f"高危命令（{risk}）未获用户批准，已拦截: {command}"}

    cwd = Path(work_dir or ".").expanduser()
    if not cwd.is_dir():
        return {"error": f"工作目录不存在: {work_dir}"}

    _prune()
    if _running_count() >= MAX_RUNNING:
        return {"error": f"同时运行的后台任务已达上限 {MAX_RUNNING}，先 stop 掉不用的再开"}

    task = BgTask(command, str(cwd), label, dict(trigger or {}), notify,
                  project_id=_provenance(project, str(cwd)), conversation_id=str(conversation_id or ""))
    trigger_err = task.trigger_error()
    if trigger_err:
        return {"error": trigger_err}

    with _tasks_lock:
        _tasks[task.id] = task
    head = task.start(timeout=timeout)

    # 先看一小段再返回：命令有没有起来、有没有立刻报错，这一步就能看出来
    deadline = time.time() + HEAD_WINDOW_SECONDS
    cursor = 0
    while time.time() < deadline and task.alive():
        time.sleep(0.1)
        payload = task.read(since_offset=cursor)
        chunk = payload.get("output", "")
        cursor = payload.get("output_offset", cursor)
        if ctx is not None and chunk:
            try:
                ctx.output(chunk, stream="stdout", offset=0)
            except Exception:
                pass
        if cursor >= HEAD_MAX_CHARS:
            break

    if ctx is not None and getattr(ctx, "cancelled", False):
        task.stop("发起调用的连接已关闭，任务未保留")
        return {**task.snapshot(peek=True), "error": "已取消：连接关闭，后台任务已终止"}

    payload = task.read(since_offset=None)
    info = task.snapshot(peek=True)
    info["output"] = payload["output"][:HEAD_MAX_CHARS]
    info["output_offset"] = payload["output_offset"]
    return {"task": info, "hint": _HINT}


_HINT = (
    "任务在后台继续跑，不要轮询等它。要主动问就用 action=status/log（log 带 since_offset "
    "可以只取新增输出）；任务结束或命中 trigger 时若 notify=true，系统会把事件送回来叫醒你。"
)
