"""Windows 系统托盘：关掉窗口不停机，缩到通知区域继续跑。

只用 ctypes 直接打 Shell_NotifyIcon，不引第三方托盘库（pystray / Pillow 都不必装），
PyInstaller 侧因此零新增件。非 Windows、或任一步原生调用失败时 start() 返回 False，
desktop.py 会退回"关窗即退出"的老行为——托盘是锦上添花，不许把它变成打不开的应用。

线程口径：托盘自带一个消息循环线程（一个挂在 HWND_MESSAGE 下的隐藏窗口），回调
（显示／退出）就在该线程上触发。pywebview 的 show/hide 内部走 WinForms Invoke，
本来就支持跨线程调用；这里仍把每个回调用 try 包住——托盘线程炸了不该把主程序带走，
更不该让"退出"从此按不动。

图标：读打包进包的 app.ico（LoadImageW + LR_LOADFROMFILE）。读不到就退到系统通用图标，
只掉卖相不掉功能。
"""
from __future__ import annotations

import os
import sys
import threading

WM_USER = 0x0400
WM_TRAY = WM_USER + 1
WM_CLOSE = 0x0010
WM_DESTROY = 0x0002
WM_LBUTTONUP = 0x0202
WM_LBUTTONDBLCLK = 0x0203
WM_RBUTTONUP = 0x0205
WM_CONTEXTMENU = 0x007B
WM_NULL = 0x0000

NIM_ADD = 0x0000
NIM_MODIFY = 0x0001
NIM_DELETE = 0x0002
NIM_SETVERSION = 0x0004

NIF_MESSAGE = 0x0001
NIF_ICON = 0x0002
NIF_TIP = 0x0004
NIF_INFO = 0x0010

NOTIFY_ICON_VERSION_4 = 0x04
NIIF_INFO = 0x00000001
IDI_APPLICATION = 32512

TPM_RETURNCMD = 0x0100
TPM_RIGHTBUTTON = 0x0002
MF_STRING = 0x0000
MF_SEPARATOR = 0x0001

ID_SHOW = 1
ID_QUIT = 2

IMAGE_ICON = 1
LR_LOADFROMFILE = 0x0010
HWND_MESSAGE = -3
CLASS_NAME = "SLATETeamsTrayMessageWindow"

_LABELS = {
    "zh": {
        "tooltip": "SLATE Teams",
        "show": "显示主窗口",
        "quit": "退出 SLATE Teams",
        "hint_title": "SLATE Teams 仍在后台运行",
        "hint_text": "已缩到托盘。双击托盘图标恢复窗口，右键可退出。",
    },
    "en": {
        "tooltip": "SLATE Teams",
        "show": "Show window",
        "quit": "Quit SLATE Teams",
        "hint_title": "SLATE Teams is still running",
        "hint_text": "Minimized to tray. Double-click the icon to restore, right-click to quit.",
    },
}

# hwnd → Tray。回调里靠它找回实例；模块级字典比 GWLP_USERDATA 少一层 cast。
_WINDOWS: dict[int, "Tray"] = {}


def available() -> bool:
    """这个平台有没有托盘可做（先只做 Windows）。"""
    return os.name == "nt" and sys.platform == "win32"


def close_action(quitting: bool, tray_ready: bool) -> str:
    """关窗该干什么：真退（"exit"）还是缩进托盘（"hide"）。

    两种情况必须退：用户是从托盘菜单点的「退出」，或者托盘压根没起来（老系统、
    没有通知区域的会话）。否则窗口关不掉，任务管理器里留一个吃内存的进程。
    """
    return "exit" if (quitting or not tray_ready) else "hide"


def labels(lang: str | None = None) -> dict[str, str]:
    """托盘菜单与气泡的文案。语言在安装时定死（data/language.txt），应用内不切。"""
    code = (lang or "zh").strip().lower()
    return dict(_LABELS["en"] if code.startswith("en") else _LABELS["zh"])


def read_lang(data_dir: str) -> str:
    """读安装程序写下的 data/language.txt；读不到一律按 zh（与后端同一口径）。"""
    try:
        with open(os.path.join(data_dir, "language.txt"), "r", encoding="utf-8") as f:
            return (f.read().strip() or "zh")
    except OSError:
        return "zh"


class Tray:
    """一个进程一个托盘图标。start() 之后由内部线程泵消息；stop() 幂等。"""

    def __init__(self, icon_path: str | None = None, on_show=None, on_quit=None,
                 text: dict[str, str] | None = None) -> None:
        self._icon_path = icon_path
        self._on_show = on_show
        self._on_quit = on_quit
        self._text = text or labels()
        self._thread: threading.Thread | None = None
        self._hwnd = None
        self._menu = None
        self._nid = None
        self._ready = threading.Event()
        self._ok = False
        self._stopped = False
        self._hicon_owned = False
        self._wndproc_ref = None
        self._user32 = None
        self._kernel32 = None
        self._shell32 = None
        self._ct = None
        self._wt = None
        # 观测点：给自检脚本看"图标真的挂上去了没、菜单建全了没、退出时删干净了没"
        self.menu_items = 0
        self.delete_called = False
        self.fail_reason = ""
        self.shown_calls = 0
        self.quit_calls = 0

    # ── 对外 ─────────────────────────────────
    def start(self, timeout: float = 5.0) -> bool:
        """起托盘线程并等它把图标加上；没加上就返回 False（调用方退回老行为）。"""
        if not available() or self._thread is not None:
            return False
        self._thread = threading.Thread(target=self._run, name="slate-tray", daemon=True)
        self._thread.start()
        self._ready.wait(timeout)
        return self._ok

    def added(self) -> bool:
        return self._ok

    def loop_alive(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def hint(self, title: str | None = None, text: str | None = None) -> bool:
        """弹一条气泡：首次缩进托盘时告诉用户去哪儿找回窗口。默认用本语言文案。"""
        if not self._ok:
            return False
        return self._modify_info(
            self._text["hint_title"] if title is None else title,
            self._text["hint_text"] if text is None else text,
        )

    def stop(self, timeout: float = 5.0) -> None:
        if self._stopped:
            return
        self._stopped = True
        if self._hwnd and self._user32:
            try:
                self._user32.PostMessageW(self._hwnd, WM_CLOSE, 0, 0)
            except Exception:
                pass
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout)

    # ── 内部：原生调用 ───────────────────────
    def _load_libs(self) -> None:
        import ctypes
        from ctypes import wintypes

        wt = self._wt = wintypes
        ct = self._ct = ctypes
        u = self._user32 = ctypes.windll.user32
        # GetModuleHandleW 在 kernel32，不在 user32 —— 拿错模块只会得到一个
        # AttributeError，被宽 except 吞掉后就是"托盘静默起不来"。
        k = self._kernel32 = ctypes.windll.kernel32
        self._shell32 = ctypes.windll.shell32

        # x64 上指针必须按指针宽度回来，否则 HWND 会被砍成 32 位。
        k.GetModuleHandleW.restype = wt.HINSTANCE
        u.CreateWindowExW.restype = wt.HWND
        # 不设 argtypes，指针宽度的 hInstance / HWND_MESSAGE 会被当成 c_int 塞进去，
        # 64 位上直接 OverflowError（"argument 11: int too long to convert"）
        u.CreateWindowExW.argtypes = [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD, ct.c_int,
                                      ct.c_int, ct.c_int, ct.c_int, wt.HWND, wt.HMENU,
                                      wt.HINSTANCE, ct.c_void_p]
        u.DefWindowProcW.restype = wt.LPARAM
        u.DefWindowProcW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
        u.DestroyWindow.argtypes = [wt.HWND]
        u.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
        u.PostQuitMessage.argtypes = [ct.c_int]
        u.GetMessageW.restype = ct.c_int
        u.TranslateMessage.argtypes = [ct.c_void_p]
        u.DispatchMessageW.argtypes = [ct.c_void_p]
        u.SetForegroundWindow.argtypes = [wt.HWND]
        u.GetCursorPos.argtypes = [ct.c_void_p]
        u.LoadImageW.restype = wt.HICON
        u.LoadImageW.argtypes = [wt.HINSTANCE, wt.LPCWSTR, ct.c_uint, ct.c_int, ct.c_int, ct.c_uint]
        u.LoadIconW.restype = wt.HICON
        u.LoadIconW.argtypes = [wt.HINSTANCE, ct.c_void_p]
        u.DestroyIcon.argtypes = [wt.HICON]
        u.CreatePopupMenu.restype = wt.HMENU
        u.AppendMenuW.argtypes = [wt.HMENU, wt.UINT, ct.c_size_t, wt.LPCWSTR]
        u.GetMenuItemCount.restype = ct.c_int
        u.GetMenuItemCount.argtypes = [wt.HMENU]
        u.TrackPopupMenuEx.restype = ct.c_int
        u.TrackPopupMenuEx.argtypes = [wt.HMENU, wt.UINT, ct.c_int, ct.c_int, wt.HWND, ct.c_void_p]
        self._shell32.Shell_NotifyIconW.restype = wt.BOOL
        self._shell32.Shell_NotifyIconW.argtypes = [wt.DWORD, ct.c_void_p]

    def _class(self) -> None:
        ct, wt = self._ct, self._wt

        class WNDCLASSEXW(ct.Structure):
            _fields_ = [
                ("cbSize", wt.UINT), ("style", wt.UINT), ("lpfnWndProc", ct.c_void_p),
                ("cbClsIndex", ct.c_int), ("cbWndIndex", ct.c_int), ("hInstance", wt.HINSTANCE),
                ("hIcon", wt.HICON), ("hCursor", wt.HANDLE), ("hbrBackground", wt.HANDLE),
                ("lpszMenuName", wt.LPCWSTR), ("lpszClassName", wt.LPCWSTR), ("hIconSm", wt.HICON),
            ]

        cls = WNDCLASSEXW()
        cls.cbSize = ct.sizeof(WNDCLASSEXW)
        cls.lpfnWndProc = ct.cast(self._wndproc_ref, ct.c_void_p)
        cls.hInstance = self._kernel32.GetModuleHandleW(None)
        cls.lpszClassName = CLASS_NAME
        if not self._user32.RegisterClassExW(ct.byref(cls)):
            gle = self._kernel32.GetLastError()
            if gle != 1410:  # ERROR_CLASS_ALREADY_EXISTS：同进程再开一个托盘是允许的
                self.fail_reason = f"RegisterClassExW failed (gle={gle})"

    def _make_nid(self, hwnd, hicon):
        ct, wt = self._ct, self._wt

        class GUID(ct.Structure):
            _fields_ = [("Data1", wt.DWORD), ("Data2", wt.WORD), ("Data3", wt.WORD),
                        ("Data4", ct.c_ubyte * 8)]

        class NID(ct.Structure):
            _fields_ = [
                ("cbSize", wt.DWORD), ("hWnd", wt.HWND), ("uID", wt.UINT), ("uFlags", wt.UINT),
                ("uCallbackMessage", wt.UINT), ("hIcon", wt.HICON), ("szTip", wt.WCHAR * 64),
                ("dwState", wt.DWORD), ("dwStateMask", wt.DWORD), ("szInfo", wt.WCHAR * 256),
                ("uVersion", wt.UINT), ("szInfoTitle", wt.WCHAR * 64), ("dwInfoFlags", wt.DWORD),
                ("guidItem", GUID), ("hBalloonIcon", wt.HICON),
            ]

        nid = NID()
        nid.cbSize = ct.sizeof(NID)
        nid.hWnd = hwnd
        nid.uID = 1
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
        nid.uCallbackMessage = WM_TRAY
        nid.hIcon = hicon
        nid.szTip = self._text["tooltip"][:63]
        return nid

    def _load_icon(self):
        u = self._user32
        path = self._icon_path
        if path and os.path.exists(path):
            hicon = u.LoadImageW(None, path, IMAGE_ICON, 0, 0, LR_LOADFROMFILE)
            if hicon:
                self._hicon_owned = True
                return hicon
        return u.LoadIconW(None, IDI_APPLICATION)

    def _build_menu(self):
        u = self._user32
        menu = u.CreatePopupMenu()
        if not menu:
            return None
        u.AppendMenuW(menu, MF_STRING, ID_SHOW, self._text["show"])
        u.AppendMenuW(menu, MF_SEPARATOR, 0, None)
        u.AppendMenuW(menu, MF_STRING, ID_QUIT, self._text["quit"])
        self.menu_items = u.GetMenuItemCount(menu)
        return menu

    def _run(self) -> None:
        try:
            self._load_libs()
        except Exception as exc:
            self.fail_reason = f"load libs failed: {exc!r}"
            self._ready.set()
            return

        ct, wt = self._ct, self._wt
        u, k = self._user32, self._kernel32

        def wndproc(hwnd, msg, wparam, lparam):
            tray = _WINDOWS.get(int(hwnd or 0))
            if msg == WM_TRAY:
                if tray:
                    tray._on_tray(int(lparam) & 0xFFFF)
                return 0
            if msg == WM_CLOSE:
                u.DestroyWindow(hwnd)
                return 0
            if msg == WM_DESTROY:
                if tray:
                    tray._teardown()
                    _WINDOWS.pop(int(hwnd), None)
                u.PostQuitMessage(0)
                return 0
            return u.DefWindowProcW(hwnd, msg, wparam, lparam)

        self._wndproc_ref = ct.WINFUNCTYPE(wt.LPARAM, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)(wndproc)
        try:
            self._class()
            hwnd = u.CreateWindowExW(0, CLASS_NAME, "SLATE Teams Tray", 0, 0, 0, 0, 0,
                                     ct.c_void_p(HWND_MESSAGE), None,
                                     k.GetModuleHandleW(None), None)
            if not hwnd:
                self.fail_reason = f"CreateWindowExW failed (gle={k.GetLastError()})"
                return
            self._hwnd = hwnd
            _WINDOWS[int(hwnd)] = self

            hicon = self._load_icon()
            if not hicon:
                self.fail_reason = f"LoadIcon failed (gle={k.GetLastError()})"
                return
            self._nid = self._make_nid(hwnd, hicon)
            if not self._shell32.Shell_NotifyIconW(NIM_ADD, ct.byref(self._nid)):
                self.fail_reason = (f"Shell_NotifyIconW(NIM_ADD) refused "
                                    f"(cbSize={self._nid.cbSize}, gle={k.GetLastError()})")
                return
            self._nid.uVersion = NOTIFY_ICON_VERSION_4
            self._shell32.Shell_NotifyIconW(NIM_SETVERSION, ct.byref(self._nid))
            self._menu = self._build_menu()
            self._ok = True
        except Exception as exc:
            self._ok = False
            self.fail_reason = f"tray setup raised: {exc!r}"
            return
        finally:
            self._ready.set()

        msg = wt.MSG()
        while True:
            try:
                got = u.GetMessageW(ct.byref(msg), None, 0, 0)
            except Exception:
                break
            if got == 0 or got == -1:
                break
            u.TranslateMessage(ct.byref(msg))
            u.DispatchMessageW(ct.byref(msg))

    def _on_tray(self, event: int) -> None:
        if event in (WM_LBUTTONUP, WM_LBUTTONDBLCLK):
            self.shown_calls += 1
            self._fire(self._on_show)
        elif event in (WM_RBUTTONUP, WM_CONTEXTMENU):
            self._popup()

    def _popup(self) -> None:
        if not self._menu:
            return
        u = self._user32
        pt = self._wt.POINT()
        u.GetCursorPos(self._ct.byref(pt))
        u.SetForegroundWindow(self._hwnd)
        cmd = u.TrackPopupMenuEx(self._menu, TPM_RETURNCMD | TPM_RIGHTBUTTON,
                                 pt.x, pt.y, self._hwnd, None)
        # 不补这一发，菜单会在点击别处时留屏不走（Shell 的老毛病）
        u.PostMessageW(self._hwnd, WM_NULL, 0, 0)
        if cmd == ID_SHOW:
            self.shown_calls += 1
            self._fire(self._on_show)
        elif cmd == ID_QUIT:
            self.quit_calls += 1
            self._fire(self._on_quit)

    def _fire(self, callback) -> None:
        if not callback:
            return
        try:
            callback()
        except Exception:
            pass  # 托盘不许把主程序带崩

    def _modify_info(self, title: str, text: str) -> bool:
        nid = self._nid
        if nid is None:
            return False
        wt = self._wt
        nid.uFlags = NIF_INFO | NIF_ICON | NIF_TIP
        nid.szInfoTitle = (title or "")[:63]
        nid.szInfo = (text or "")[:255]
        nid.dwInfoFlags = NIIF_INFO
        try:
            return bool(self._shell32.Shell_NotifyIconW(NIM_MODIFY, self._ct.byref(nid)))
        except Exception:
            return False

    def _teardown(self) -> None:
        self.delete_called = True
        try:
            if self._nid is not None:
                self._nid.uFlags = 0
                self._shell32.Shell_NotifyIconW(NIM_DELETE, self._ct.byref(self._nid))
        except Exception:
            pass
        try:
            if self._hicon_owned and self._nid is not None:
                self._user32.DestroyIcon(self._nid.hIcon)
        except Exception:
            pass
