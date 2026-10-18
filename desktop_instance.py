"""单实例闸门：同一份安装只允许一个 SLATE 外壳进程。

为什么需要它：关掉窗口不再停机（托盘常驻）之后，再双击一次桌面图标就是再起一个
进程——两个窗口、两份后端、同一个 SQLite 两个写者。用户报的"有时会同时开好几个
SLATE 窗口"是这么来的，所以闸门必须落在**起后端与清日志之前**：晚一步就已经多出
一份服务在写同一座库。

机制：一个命名互斥体（CreateMutexW）。它随进程退出由内核释放，所以崩溃、被任务
管理器杀掉之后不会留下"再也打不开"的死锁；也不写锁文件，免得再添一类"文件残留但
进程早没了"的二次 bug。第二个进程的动作不是默默退出，而是**把已经在跑的那个窗口
唤回前台**——只退不开会让人以为双击没反应，而窗口此时可能正藏在通知区域里。

唤回哪一个窗口要钉死到"持有锁的那个进程"：装机版与仓库源码态的窗口标题都是
「SLATE 砚」，两份同时在跑时只按标题找会顶错窗口。所以抢到锁的一方把自己的 pid 写进
一块同名派生的页文件共享内存（CreateFileMappingW）——它同样随最后一个句柄消失，
不会变成锁文件那类残留。

失败口径与托盘一致：建不出锁（权限被拒、非 Windows）就照常启动，宁可多开一个
窗口，也不许把应用变成打不开。
"""
from __future__ import annotations

import ctypes
import hashlib
import os
import sys
import time
from ctypes import wintypes

ERROR_ALREADY_EXISTS = 183

SW_SHOW = 0x0005
SW_RESTORE = 0x0009
GW_OWNER = 4
FLASHW_ALL = 0x0003
FLASHW_TIMERNOFG = 0x000C

# 页文件共享内存：装"持有者的 pid"这一个十进制数。
SECTION_SIZE = 64
PAGE_READWRITE = 0x04
FILE_MAP_READ = 0x0004
FILE_MAP_WRITE = 0x0002
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1)


def available() -> bool:
    """这个平台有没有单实例闸门可做（先只做 Windows）。"""
    return os.name == "nt" and sys.platform == "win32"


def _digest(base_dir: str) -> str:
    """路径先转绝对、去尾分隔符、统一小写——Windows 路径不区分大小写，`C:\\A` 和
    `c:\\a\\` 必须是同一把锁。整串保持 ASCII：内核对象名带中文虽然也认，但哈希会
    随"这条路径被解码成什么"漂移，换个代码页就变成两把锁。
    """
    path = os.path.abspath(base_dir or ".").rstrip("\\/").lower()
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:12]


def lock_name(base_dir: str) -> str:
    """锁名按安装目录派生：同一份安装互斥，仓库源码态与装机版各管各的。"""
    return f"Local\\SLATE-desktop-{_digest(base_dir)}"


def pid_name(base_dir: str) -> str:
    """持有者 pid 那块共享内存的名字，和锁名同源：拦下我的闸门与我该唤回的窗口，
    必须出自同一份安装。用内核对象而不是锁文件，是因为它随最后一个句柄消失，
    不会变成"文件还在、进程早没了"的第二个假实例。
    """
    return f"Local\\SLATE-desktop-pid-{_digest(base_dir)}"


def already_running(last_error: int) -> bool:
    """这次 CreateMutexW 是不是"别人已经持有着"。"""
    return last_error == ERROR_ALREADY_EXISTS


def _make_kernel32():
    """use_last_error=True：ctypes 在两次调用之间自己会调 API，裸 GetLastError() 读到的可能是别人的错码，于是"已有实例"被读成"没有"，闸门形同不存在。"""
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateMutexW.restype = wintypes.HANDLE
    k.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    k.GetCurrentProcessId.restype = wintypes.DWORD
    k.GetCurrentThreadId.restype = wintypes.DWORD
    # 共享内存这几个入口的返回句柄必须按 64 位宽回来：默认按 c_int 使的话
    # INVALID_HANDLE_VALUE(-1) 会变成 0xFFFFFFFF，建不出对象。
    k.CreateFileMappingW.restype = wintypes.HANDLE
    k.CreateFileMappingW.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                                     wintypes.DWORD, wintypes.DWORD, wintypes.LPCWSTR]
    k.MapViewOfFile.restype = wintypes.LPVOID
    k.MapViewOfFile.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                wintypes.DWORD, ctypes.c_size_t]
    k.UnmapViewOfFile.argtypes = [wintypes.LPVOID]
    return k


# 只在导入时装载一次：__del__ 里再 WinDLL("kernel32") 会撞上解释器正在卸载模块，
# 得到一句 "import of nt halted; None in sys.modules" 的析构异常。
_K32 = _make_kernel32() if available() else None


def publish_pid(name: str, pid: int):
    """返回 (handle, view)，调用方要持有到进程结束——句柄一关，数据跟着内核对象一起没了。

    建不出也不许影响闸门：pid 只是"该唤回哪个窗口"的地址，读不到时 handoff 退到按标题找。
    """
    try:
        k = _K32
        handle = k.CreateFileMappingW(INVALID_HANDLE_VALUE, None, PAGE_READWRITE,
                                      0, SECTION_SIZE, name)
        if not handle:
            return None, None
        view = k.MapViewOfFile(handle, FILE_MAP_WRITE, 0, 0, SECTION_SIZE)
        if not view:
            k.CloseHandle(handle)
            return None, None
        data = f"{pid}\n".encode("ascii")
        ctypes.memmove(view, data, len(data))
        return handle, view
    except Exception:
        return None, None


def read_pid(name: str) -> int:
    """读持有者留下的 pid；0 表示读不到（没有持有者，或那是还没写 pid 的老版本外壳）。

    这里用 CreateFileMappingW 而不是 OpenFileMappingW：后者在这台 Windows 上对刚由本
    进程建好的同名对象也回 ERROR_ACCESS_DENIED(5)，而前者按同名取回的是同一块页
    （实测两个句柄读到同一份数据，跨进程也是）。万一真的没有持有者，这里建的
    匿名块是全零、句柄一关就消失，读到 0 走兜底路径，不会留下残留。
    """
    try:
        k = _K32
        handle = k.CreateFileMappingW(INVALID_HANDLE_VALUE, None, PAGE_READWRITE,
                                      0, SECTION_SIZE, name)
        if not handle:
            return 0
        try:
            view = k.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, SECTION_SIZE)
            if not view:
                return 0
            try:
                raw = ctypes.string_at(view, SECTION_SIZE)
            finally:
                k.UnmapViewOfFile(view)
            return int(raw.split(b"\x00", 1)[0].strip() or 0)
        finally:
            k.CloseHandle(handle)
    except Exception:
        return 0


class InstanceLock:
    """持有期 = 进程存活期。handle 为 None 表示"没闸门但照常跑"。"""

    def __init__(self, handle, name: str, pid_handle=None, pid_view=None):
        self.handle = handle
        self.name = name
        self._pid_handle = pid_handle
        self._pid_view = pid_view

    @property
    def held(self) -> bool:
        return self.handle is not None

    def release(self) -> None:
        # 整段包在 try 里：调用方可能在解释器退出时收尾，届时模块字典都可能已经拆了。
        try:
            k = _K32
            if self._pid_view is not None:
                k.UnmapViewOfFile(self._pid_view)
                self._pid_view = None
            if self._pid_handle is not None:
                k.CloseHandle(self._pid_handle)
                self._pid_handle = None
            if self.handle is not None:
                k.CloseHandle(self.handle)
                self.handle = None
        except Exception:
            pass

    # 故意不写 __del__：有了它，"try_acquire 的返回值没被任何活着的东西接住"就会变成
    # 一次静默的解锁（实测把这条链交给子进程，第二个进程当场就把锁抢走了）。进程退出时
    # 内核本来就会回收句柄，析构函数只能添乱。要提前放手就显式调 release()。


def try_acquire(base_dir: str) -> InstanceLock | None:
    """拿到锁 → InstanceLock；已有别的实例在跑 → None；建不出锁 → 一把"空锁"。"""
    name = lock_name(base_dir)
    if not available():
        return InstanceLock(None, name)
    handle = _K32.CreateMutexW(None, False, name)
    err = ctypes.get_last_error()
    if not handle:
        return InstanceLock(None, name)
    if already_running(err):
        _K32.CloseHandle(handle)
        return None
    # 抢到锁的这一刻就留下自己的 pid。第二进程必须靠它认出"该唤回哪个窗口"：只按标题找
    # 会叫到另一份安装的头上去——装机版和仓库源码态的窗口标题是一样的。
    ph, pv = publish_pid(pid_name(base_dir), current_pid())
    return InstanceLock(handle, name, pid_handle=ph, pid_view=pv)


def _user32():
    """原型一次配齐：x64 上 HWND 不按指针宽度回来会被砍成 32 位，
    EnumWindows 的回调签名不对则会直接崩在原生栈上。"""
    u = ctypes.windll.user32
    u.EnumWindows.argtypes = [ctypes.c_void_p, wintypes.LPARAM]
    u.GetWindowTextLengthW.restype = ctypes.c_int
    u.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    u.GetWindowTextW.restype = ctypes.c_int
    u.GetWindowTextW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
    u.GetWindowThreadProcessId.restype = wintypes.DWORD
    u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    u.GetWindow.restype = wintypes.HWND
    u.GetWindow.argtypes = [wintypes.HWND, ctypes.c_uint]
    u.IsWindow.restype = wintypes.BOOL
    u.IsWindow.argtypes = [wintypes.HWND]
    u.IsWindowVisible.restype = wintypes.BOOL
    u.IsWindowVisible.argtypes = [wintypes.HWND]
    u.IsIconic.restype = wintypes.BOOL
    u.IsIconic.argtypes = [wintypes.HWND]
    u.ShowWindow.restype = ctypes.c_int
    u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    u.GetForegroundWindow.restype = wintypes.HWND
    u.SetForegroundWindow.restype = wintypes.BOOL
    u.SetForegroundWindow.argtypes = [wintypes.HWND]
    u.BringWindowToTop.restype = wintypes.BOOL
    u.BringWindowToTop.argtypes = [wintypes.HWND]
    u.AttachThreadInput.restype = wintypes.BOOL
    u.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    u.FlashWindowEx.restype = wintypes.BOOL
    return u


def current_pid() -> int:
    return _K32.GetCurrentProcessId() if _K32 is not None else 0


def current_thread_id() -> int:
    """GetCurrentThreadId 在 kernel32，不在 user32——拿错模块只会得到一个
    AttributeError，被宽 except 吞掉后就是"窗口唤不回来"。"""
    return _K32.GetCurrentThreadId() if _K32 is not None else 0


def window_title(hwnd, u) -> str:
    length = u.GetWindowTextLengthW(hwnd)
    if not length:
        return ""
    buf = ctypes.create_unicode_buffer(length + 1)
    u.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


def window_pid(hwnd, u) -> int:
    pid = wintypes.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def is_main_window(hwnd, title: str, owner_pid: int, u) -> bool:
    """标题对得上、是 owner_pid 那个进程的、且不是从属窗口。

    只认没有 owner 的顶层窗口：pywebview 的模态框标题里带着正文，owner 指回主窗，
    唤回它等于把一个对话框顶到用户脸上。
    """
    return (bool(u.IsWindow(hwnd))
            and window_title(hwnd, u) == title
            and window_pid(hwnd, u) == owner_pid
            and not u.GetWindow(hwnd, GW_OWNER))


def find_windows(title: str, owner_pid: int = 0, u=None) -> list[int]:
    """按标题 + 持有者进程找那个 SLATE 窗口。隐藏的那个也要能找回来——
    EnumWindows 本来就连不可见的顶层窗口一起枚举，这里不拿 IsWindowVisible 过筛。

    owner_pid 传 0 = "只要不是我自己的"。这条只用于兜底（老版本外壳没留 pid），
    正常路径一定要指名到进程：同名的另一份安装也在跑时，猜标题会把别人的窗口顶上来。
    """
    if not available():
        return []
    u = u or _user32()
    mine = current_pid()
    found: list[int] = []
    cb_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lparam):
        pid = window_pid(hwnd, u)
        if pid != mine and (owner_pid == 0 or pid == owner_pid) and is_main_window(hwnd, title, pid, u):
            found.append(hwnd)
        return True

    ref = cb_type(cb)  # 枚举期间回调必须活着
    u.EnumWindows(ref, 0)
    return found


def flash_taskbar(u, hwnd) -> None:
    """抢不到前台时的回执：让任务栏图标闪，至少说明"这次双击有人接了"。"""

    class FLASHWINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.UINT), ("hwnd", wintypes.HWND),
                    ("dwFlags", wintypes.DWORD), ("uCount", wintypes.UINT),
                    ("dwTimeout", wintypes.DWORD)]

    info = FLASHWINFO()
    info.cbSize = ctypes.sizeof(FLASHWINFO)
    info.hwnd = hwnd
    info.dwFlags = FLASHW_ALL | FLASHW_TIMERNOFG
    info.uCount = 5
    try:
        u.FlashWindowEx(ctypes.byref(info))
    except Exception:
        pass


def bring_to_front(u, hwnd) -> bool:
    """跨进程顶到前台。系统有"前台锁定"，SetForegroundWindow 可能被拒；那就把自己的
    输入线程临时挂到当前前台线程上再试（记事本/资源管理器这类单实例唤回的常规做法），
    还不行退到任务栏闪烁，返回值如实报"没顶上来"。"""
    if u.SetForegroundWindow(hwnd):
        return True
    fg = u.GetForegroundWindow()
    mine = current_thread_id()
    theirs = u.GetWindowThreadProcessId(fg, None) if fg else 0
    attached = bool(theirs) and theirs != mine and bool(
        u.AttachThreadInput(wintypes.DWORD(mine), wintypes.DWORD(theirs), True))
    ok = False
    try:
        ok = bool(u.SetForegroundWindow(hwnd)) or bool(u.BringWindowToTop(hwnd))
    finally:
        if attached:
            u.AttachThreadInput(wintypes.DWORD(mine), wintypes.DWORD(theirs), False)
    if not ok:
        flash_taskbar(u, hwnd)
    return ok


def surface(hwnd, u=None) -> bool:
    """把一个窗口唤回来：先解最小化，再补 WS_VISIBLE（缩进托盘的那条路），最后顶前台。"""
    u = u or _user32()
    if not u.IsWindow(hwnd):
        return False
    u.ShowWindow(hwnd, SW_RESTORE if u.IsIconic(hwnd) else SW_SHOW)
    if not u.IsWindowVisible(hwnd):
        return False
    bring_to_front(u, hwnd)
    return True


def handoff(title: str, base_dir: str = "", wait_s: float = 3.0, sleep_s: float = 0.2) -> bool:
    """第二次启动的收尾：把已在跑的那个窗口唤回前台，唤到了返回 True。

    目标必须钉到"持有锁的那个进程"：装机版与仓库源码态的窗口标题一模一样，只按标题找
    会把另一份安装的窗口顶到用户脸上，而用户点的那一份仍然没动。

    有界重试盖的是两个几百毫秒的空档：第一个进程还在开窗口，以及它刚把 pid 写进共享内存。
    一次没找着不等于没有实例（锁已经证明它活着），所以用满等待上限再退。
    """
    if not available():
        return False
    u = _user32()
    name = pid_name(base_dir)
    deadline = time.time() + max(0.0, wait_s)
    owner = 0
    while True:
        owner = read_pid(name) or owner
        targets = find_windows(title, owner_pid=owner, u=u) if owner else []
        if not targets and not owner and time.time() >= deadline:
            # 读不到 pid（对方是还没写 pid 的老版本外壳）时的兜底：宁可顶一个同名的窗口，
            # 也好过双击完全没反应。
            targets = find_windows(title, u=u)
        for hwnd in targets:
            if surface(hwnd, u):
                return True
        if time.time() >= deadline:
            return False
        time.sleep(max(0.01, sleep_s))
