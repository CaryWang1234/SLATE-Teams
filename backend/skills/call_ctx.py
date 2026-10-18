"""砚流（InkStream）调用上下文：一笔一流程的取消桥与进度回推通道。

取消信号 = 客户端关闭 SSE 响应流（与 MCP 2026 在 HTTP 上的定义一致，不新造私有通道）；
本模块把该信号桥接成工具循环可轮询的 ctx.cancelled，并把工具的进度/输出回推为事件帧。
设计依据：DEEP_RESEARCH_AI-AGENT-TOOL-CALLING.md §4.4 / §4.6 / §4.7。
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable

Emit = Callable[[str, dict[str, Any]], None]


class CallCancelled(Exception):
    """工具循环主动放弃执行（用户已关流）。"""


class CallContext:
    """传给 skill.run_stream(ctx, **params) 的第一个参数。

    - cancelled / check()：协作式取消，工具在循环里轮询，越早自弃越少白烧资源；
    - progress() / output() / notice()：把标量进度与输出分块推回事件流；
      通道未挂载或已取消时静默丢弃——进度通道的失败绝不能改写成工具失败。
    """

    def __init__(self, call_id: str = "", emit: Emit | None = None) -> None:
        self.call_id = call_id
        self.started_at = time.monotonic()
        self._cancelled = threading.Event()
        self._emit = emit

    @property
    def cancelled(self) -> bool:
        return self._cancelled.is_set()

    def cancel(self) -> None:
        self._cancelled.set()

    def check(self) -> None:
        """取消即抛出，用于在深处循环里一行退出。"""
        if self._cancelled.is_set():
            raise CallCancelled()

    @property
    def duration_ms(self) -> int:
        return int((time.monotonic() - self.started_at) * 1000)

    def _send(self, event_type: str, data: dict[str, Any]) -> None:
        emit = self._emit
        if emit is None or self._cancelled.is_set():
            return
        try:
            emit(event_type, data)
        except Exception:
            pass

    def progress(
        self,
        *,
        progress: float | int | None = None,
        total: float | int | None = None,
        pct: float | int | None = None,
        message: str = "",
    ) -> None:
        """标量进度：只承诺单调不减，频率不保证（§4.4 规则 4）。"""
        data = {
            k: v
            for k, v in (("progress", progress), ("total", total), ("pct", pct), ("message", message))
            if v is not None and v != ""
        }
        self._send("call.progress", data)

    def output(self, chunk: str, *, stream: str = "stdout", offset: int = 0) -> None:
        """富流输出分块：接收端负责截断显示，不在这里做摘录。"""
        if not chunk:
            return
        self._send("call.output", {"stream": stream, "chunk": str(chunk), "offset": offset})

    def notice(self, text: str, level: str = "info") -> None:
        if text:
            self._send("notice", {"level": level, "text": text})
