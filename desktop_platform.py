"""平台差异的单一事实源：装机版的数据目录、日志落点、webview 渲染器。

为什么这些决定要写成"把平台字符串当参数收"的纯函数：这台开发机是 Windows，
`if sys.platform == 'darwin'` 的分支在这里永远跑不到，直接写进 desktop.py 就等于
"没验证过就发出去"。纯函数可以把 "darwin" 当实参传进来，在 Windows 上就把 Mac 那条
分支执行一遍并断言结果，scripts/check_macos_platform.py 因此才覆盖得到。

Mac 装机版不能把数据写进 .app：PyInstaller 的 bundle 落在 /Applications 下，普通用户
写不进去（写进去的那台机器又会让签名校验因为 bundle 里多出文件而失败），而升级是整包
覆盖 .app —— API Key 与聊天记录会跟着下一次拖拽一起没了。所以 Mac 走
~/Library/Application Support/SLATE。Windows 装机版维持"数据就在安装目录的 data/"
（README 与 RULES 都是这么写的），源码态两边都还在仓库 data/ 里。
"""
from __future__ import annotations

from pathlib import PurePosixPath, PureWindowsPath

WINDOWS = "win32"
MACOS = "darwin"

# Mac 的每用户数据目录是系统约定，不是我们自己发明的位置。
# 叶子目录名必须与上游 SLATE 不同：同机装两个产品时，共用 ~/Library/Application Support/SLATE
# 就等于共用一份 data/——API Key、会话历史、遥控偏好全部串在一起。
MAC_APP_SUPPORT = ("Library", "Application Support", "SLATE Teams")


def _pure(platform_name: str):
    """按**目标**平台选路径语义：在 Windows 上验证 Mac 分支时，拼出来的必须是正斜杠路径，
    否则判据读到的全是本机分隔符，等于拿 Windows 的规则去核对 Mac 的约定。"""
    return PureWindowsPath if platform_name == WINDOWS else PurePosixPath


def is_macos(platform_name: str) -> bool:
    return str(platform_name or "") == MACOS


def bundle_paths(base_dir: str, home: str, platform_name: str, frozen: bool) -> dict:
    """装机态的 Mac 把数据挪到用户目录；其余（Windows 装机、任何平台的源码态）照旧贴着程序目录。

    只在 frozen 时改道：Mac 开发者从源码跑起来时看的是仓库里的 data/，把它悄悄搬到
    用户目录会让人以为改动没生效。
    """
    pure = _pure(platform_name)
    base = pure(base_dir)
    if is_macos(platform_name) and frozen:
        data = pure(home, *MAC_APP_SUPPORT)
        # bundle 里连日志都写不下，日志跟着数据走。
        log = data / "desktop_backend.log"
    else:
        data = base / "data"
        log = base / "desktop_backend.log"
    return {
        "data_dir": str(data),
        "log_path": str(log),
        "storage_path": str(data / "webview_profile"),
    }


def webview_gui(platform_name: str):
    """按平台挑 pywebview 的 GUI。

    'edgechromium' 是 Windows(WebView2) 专有的名字：Mac 上传进去不会被拒（pywebview 只认
    'qt' 这个强制值，其余一律按 cocoa→qt 的顺序试），但把 Windows 的渲染器名写在跨平台
    入口上，读代码的人无从判断 Mac 那侧到底走的什么。None = 让 pywebview 自己按平台挑
    （Linux 走 gtk→qt，本来就没有该钉的值）。
    """
    if platform_name == WINDOWS:
        return "edgechromium"
    if is_macos(platform_name):
        return "cocoa"
    return None
