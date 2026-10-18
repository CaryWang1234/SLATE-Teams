"""夜间模式跑任务时别让电脑睡着（先只做 Windows：SetThreadExecutionState）。

三条口径，守卫逐条钉：

① 电源需求是**按线程**记的。SetThreadExecutionState 设的标志属于调用它的那条线程，
   线程一退出系统就把那份需求清掉（实测：新开一条线程去读，读到的是它自己的空状态）。
   所以置位、回读、复位必须全落在同一条常驻线程里——在 FastAPI 的请求线程上顺手调一下，
   等于把标志写在一条随时会被回收的线程上。

   回读还有个坑：这台 Windows 的 kernel32 **没有导出 GetThreadExecutionState**（只有 Set 那一只），
   而 Set 的返回值是**调用之前**的状态（实测：钉住后再放手，放手那次收到的才是 system 位）。
   想要"系统现在究竟记着什么"，就用同一组标志连调两次——第二次返回的就是第一次落下去的结果。
   传同样标志是幂等的，所以这一下不改变现状，只是把证据读回来；`applied` 记的是它，
   不是"我调用成功了"这种自证。

② 只钉「系统别睡」（ES_SYSTEM_REQUIRED），不钉「屏幕别灭」（ES_DISPLAY_REQUIRED）。
   夜间挂机跑长任务，屏幕熄掉正合适；机器睡了就什么都没了。
   合盖、手动睡眠、以及"已经睡着的机器"都不在能力范围内——那要唤醒定时器，
   改的是系统的电源计划而不是本进程的需求，这一版不碰。

③ 租约靠心跳续，不靠显式释放。界面刷新、崩掉、断网之后不会再发心跳，
   租期一到这条线程自己把标志清回去。反过来（必须显式释放）会留下最坏的一种结局：
   用户的笔记本被一个早就没了的界面钉在清醒状态，塞进包里发烫。
   进程整个退出时系统本来也会清掉这份需求，这是第四层退路，不是主设计。
"""

from __future__ import annotations

import ctypes
import os
import sys
import threading
import time

# EXECUTION_STATE 的四个标志（Windows）。ES_CONTINUOUS 单独传＝把之前的需求全部清掉。
ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
ES_DISPLAY_REQUIRED = 0x00000002
ES_AWAYMODE_REQUIRED = 0x00000040

# 租期与复查节奏：界面每 20 秒续一次租，这里给到 60 秒（三倍余量，网络抖一下不算断）。
# 持有线程最多睡 RECHECK 秒就醒一次（租约快到时按剩余时间提前醒），醒来把标志重新确认一遍——
# 既是为了准点放手，也是为了别的程序改了系统状态时我们能马上看到并补上。
LEASE_SECONDS = 60.0
RECHECK_SECONDS = 5.0

_lock = threading.Lock()
_api_lock = threading.Lock()

_want = False
_deadline = 0.0
_keeper: threading.Thread | None = None
_stop = threading.Event()
_kernel32 = None
_applied = 0
_last_error = ""


def available() -> bool:
    """这个平台有没有"阻止睡眠"可做（先只做 Windows）。"""
    return os.name == "nt" and sys.platform == "win32"


def _api():
    """取 kernel32 的 SetThreadExecutionState。非 Windows 上 ctypes.windll 根本不存在，
    所以只在真要用的时候才绑。"""
    global _kernel32
    if _kernel32 is not None:
        return _kernel32
    with _api_lock:
        if _kernel32 is None:
            lib = ctypes.WinDLL("kernel32", use_last_error=True)
            lib.SetThreadExecutionState.restype = ctypes.c_uint
            lib.SetThreadExecutionState.argtypes = [ctypes.c_uint]
            _kernel32 = lib
    return _kernel32


def _apply(api, flags: int) -> tuple[int, str]:
    """同一组标志连调两次，取第二次的返回值＝这一次之前（也就是第一次之后）系统记着的标志。

    返回值 0 才是失败（其余情况返回值是标志位，0x80000000 也是正常状态）。
    """
    first = api.SetThreadExecutionState(flags)
    if not first:
        return 0, f"SetThreadExecutionState({flags:#x}) 返回 0（错误码 {ctypes.get_last_error()}）"
    applied = api.SetThreadExecutionState(flags) & 0xFFFFFFFF
    if not applied:
        return 0, f"回读失败：第二次调用返回 0（错误码 {ctypes.get_last_error()}）"
    return applied, ""


def _hold() -> None:
    """常驻持有线程：置位→回读→每 RECHECK 醒一次，租约没了就清标志退出。

    这段必须整条跑在同一条线程上，见模块开头第①条。
    """
    global _applied, _last_error, _keeper, _want, _deadline
    _stop.clear()
    try:
        api = _api()
    except Exception as exc:  # 绑不上 API（老系统/非 Windows）也要把 _keeper 收干净
        with _lock:
            _last_error = f"kernel32 绑定失败: {exc}"
            _keeper = None
        return
    while True:
        with _lock:
            active = bool(_want) and time.monotonic() < _deadline
            remaining = max(0.0, _deadline - time.monotonic()) if _want else 0.0
        flags = (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) if active else ES_CONTINUOUS
        try:
            applied, err = _apply(api, flags)
        except Exception as exc:
            applied, err = 0, f"调用失败: {exc}"
        with _lock:
            if applied:
                _applied = applied
            _last_error = err
        if not active:
            with _lock:
                _keeper = None
            return
        # 步长按剩余租约收紧：睡满 5 秒再醒，实测会让系统里的标志比 status() 说"已经放手"
        # 多留最多一个周期——放手这件事要尽量当场兑现，别留给"下次醒来看一眼"。
        step = min(RECHECK_SECONDS, max(0.05, remaining))
        if _stop.wait(step):
            _stop.clear()


def _wait_for(flag_bit: int, want_bit: bool, timeout: float = 2.0) -> None:
    """等系统里那位标志真变成要的样子再回答。

    界面的那句"正在钉住/已经交还了"读的是这份回答。要是置位还没落进系统就把状态发回去，
    页面会一直挂着反话，而要等到下一次心跳才纠正——用户看的是这句话，不该让它是一次承诺。
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with _lock:
            got = bool(_applied & flag_bit)
        if got is want_bit:
            return
        time.sleep(0.05)


def renew(want: bool) -> dict:
    """要/不要阻止睡眠。want=True 每次调用都是续租；want=False 当场放手（不等租期到）。"""
    global _want, _deadline, _keeper, _last_error
    if not available():
        return status()
    if not want:
        stop()
        return status()
    with _lock:
        _want = True
        _deadline = time.monotonic() + LEASE_SECONDS
        started = _keeper is None or not _keeper.is_alive()
        if started:
            _last_error = ""
            _keeper = threading.Thread(target=_hold, name="slate-keepawake", daemon=True)
            _keeper.start()
    if started:
        _wait_for(ES_SYSTEM_REQUIRED, True)
    return status()


def stop() -> None:
    """立刻松手（关窗/退出/界面说不要时走这里）：等到系统里那份需求真撤掉再回话。"""
    global _want, _deadline, _applied
    if not available():
        return
    with _lock:
        _want = False
        _deadline = 0.0
    _stop.set()
    with _lock:
        keeper = _keeper
    if keeper is not None and keeper.is_alive() and keeper is not threading.current_thread():
        keeper.join(timeout=RECHECK_SECONDS + 1.0)
    # 线程已经不在了（正常退出/异常退出/从没起过）：那份需求是按线程记的，线程没了系统本来
    # 就不再认它。先有界等一拍让刚退出那条把标志落定，读不到的残值再认回"没钉着"——
    # 否则状态里会长期挂着一句没人兑现的"正在钉住"。
    if keeper is None or not keeper.is_alive():
        _wait_for(ES_SYSTEM_REQUIRED, False, 0.5)
        with _lock:
            _applied &= ~ES_SYSTEM_REQUIRED


def status() -> dict:
    """当前状态。`applied` 是持有线程用"同组标志连调两次"从系统读回来的标志位，
    不是我们自己记的期望值。"""
    with _lock:
        alive = _keeper is not None and _keeper.is_alive()
        remaining = max(0.0, _deadline - time.monotonic()) if _want else 0.0
        active = bool(_want) and alive and remaining > 0.0
        return {
            "supported": available(),
            "want": bool(_want),
            "active": active,
            "lease_seconds": LEASE_SECONDS,
            "remaining_seconds": round(remaining, 1),
            "applied": int(_applied),
            # 系统里真的记着"别睡"吗：这一位是判据，applied 只是它的出处
            "system_required": bool(_applied & ES_SYSTEM_REQUIRED),
            "display_required": bool(_applied & ES_DISPLAY_REQUIRED),
            "keeper_alive": alive,
            "last_error": _last_error,
        }
