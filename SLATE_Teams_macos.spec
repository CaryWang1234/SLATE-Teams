# -*- mode: python ; coding: utf-8 -*-
"""
SLATE macOS PyInstaller 构建配置
用法：pyinstaller SLATE_Teams_macos.spec
"""

import os
import re
import sys
from pathlib import Path

# ── 基础路径 ────────────────────────────────────────────────
BASE_DIR = Path(SPECPATH).resolve()
FRONTEND_DIR = BASE_DIR / "frontend"
BACKEND_DIR = BASE_DIR / "backend"

# ── 应用信息 ────────────────────────────────────────────────
app_name = "SLATE Teams"


def _read_app_version():
    """版本串以 SLATE_Teams.iss 的 MyAppVersion 为准，CI 用 SLATE_TEAMS_APP_VERSION 注入 tag 版本。"""
    env = os.environ.get("SLATE_TEAMS_APP_VERSION", "").strip()
    if env:
        return env
    iss_text = (BASE_DIR / "SLATE_Teams.iss").read_text(encoding="utf-8")
    match = re.search(r'#define MyAppVersion "([^"]+)"', iss_text)
    if not match:
        raise SystemExit("没能在 SLATE_Teams.iss 里读到 MyAppVersion")
    return match.group(1)


app_version = _read_app_version()
# CFBundleVersion 是 LaunchServices 做升级比较的那一位，只放数字段（与 Inno 的 VersionInfoVersion 同口径）
app_build_version = app_version.partition("-")[0]

# ── 收集前端文件 ────────────────────────────────────────────
def collect_frontend():
    """递归收集 frontend 目录下所有文件"""
    datas = []
    if FRONTEND_DIR.exists():
        for root, dirs, files in os.walk(FRONTEND_DIR):
            rel_dir = Path(root).relative_to(BASE_DIR)
            for f in files:
                src = str(Path(root) / f)
                dst = str(rel_dir / f)
                datas.append((src, dst))
    return datas

# ── 收集后端技能文件 ─────────────────────────────────────────
def collect_skills():
    """收集 backend/skills 目录下的 Python 文件"""
    datas = []
    skills_dir = BACKEND_DIR / "skills"
    if skills_dir.exists():
        for f in skills_dir.glob("*.py"):
            datas.append((str(f), f"backend/skills"))
    return datas

# ─ 数据文件列表 ────────────────────────────────────────────
datas = collect_frontend() + collect_skills()

# 添加其他必要的数据文件（可选）
extra_datas = []
if Path("LICENSE").exists():
    extra_datas.append(("LICENSE", "."))
if Path("README.md").exists():
    extra_datas.append(("README.md", "."))
datas.extend(extra_datas)

# ── 隐藏导入（PyInstaller 自动检测可能遗漏的模块）────────────
hiddenimports = [
    # FastAPI & Uvicorn
    "fastapi",
    "uvicorn",
    "uvicorn.main",
    "uvicorn.config",
    "uvicorn.lifespan",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.ws",
    # HTTPX
    "httpx",
    "httpcore",
    # Database
    "aiosqlite",
    "sqlite3",
    # File handling
    "aiofiles",
    "aiofiles.os",
    # Document processing
    "pptx",
    "docx",
    "openpyxl",
    "pdfplumber",
    # Web scraping
    "ddgs",
    "trafilatura",
    "playwright",
    "playwright.sync_api",
    # Desktop
    "webview",
    "webview.guilib",
    # Mac 后端只在函数体里 import，PyInstaller 静态扫不到；漏掉它打出来的 .app 一启动就
    # 报 "PyObjC cannot be loaded"（Windows 那份 spec 同理显式列了 platforms.edgechromium）。
    # 下面这些名字就是 webview/platforms/cocoa.py 顶部真的读的那几个。
    "webview.platforms.cocoa",
    "AppKit",
    "Foundation",
    "WebKit",
    "CoreFoundation",
    "objc",
    "PyObjCTools.AppHelper",
    # System info
    "psutil",
    # Utilities
    "qrcode",
    "PIL",
    "PIL.Image",
    "pyautogui",
    "pyperclip",
    "pygetwindow",
    # JSON/Config
    "json",
    "configparser",
]

# ── 二进制文件排除（macOS 不需要 Windows DLL）────────────────
binaries = []

# ── 排除项 ──────────────────────────────────────────────────
excludes = [
    "tkinter",
    "matplotlib",
    "numpy",
    "scipy",
    "pandas",
    "pytest",
    "setuptools",
    "distutils",
    # Windows 专属
    "win32api",
    "win32con",
    "winreg",
    "_winapi",
    "msvcrt",
    # pythonnet 是 pywebview 的 Windows 后端互操作层；Mac 走 cocoa，留着只会在构建日志里
    # 多一串"找不到 clr"，还可能把 Windows 的 .NET 运行时候选拖进包里。
    "pythonnet",
    "clr",
    "clr_loader",
]

# ── PyInstaller 主配置 ──────────────────────────────────────
a = Analysis(
    ["desktop.py"],
    pathex=[str(BASE_DIR)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=None)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="SLATE-Teams",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX 会重写可执行文件的段表，Mach-O 的签名跟着就废了（macOS 一律按"签名是否有效"决定
    # 能不能加载），而未签名的 .app 在 Gatekeeper 那里直接是"已损坏"。Windows 那份 spec 开
    # UPX 是为了压体积，Mac 这边没有对应的收益。
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # macOS GUI 应用不显示控制台
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,  # auto-detect
    codesign_identity=None,
    entitlements_file=None,
    icon="app.icns" if Path("app.icns").exists() else None,
)

# macOS .app Bundle 配置（直接 BUNDLE，无需 COLLECT）
app = BUNDLE(
    exe,
    name=f"{app_name}.app",
    icon="app.icns" if Path("app.icns").exists() else None,
    bundle_identifier="com.slate-teams.desktop",
    version=app_version,
    info_plist={
        "CFBundleName": app_name,
        "CFBundleDisplayName": app_name,
        "CFBundleVersion": app_build_version,
        "CFBundleShortVersionString": app_version,
        "CFBundleIdentifier": "com.slate-teams.desktop",
        "NSHighResolutionCapable": True,
        "LSMinimumSystemVersion": "10.15.0",
        "NSRequiresAquaSystemAppearance": False,
        # 权限用途说明：没有这两行，系统弹的授权框只会写"SLATE Teams 想控制这台电脑"，
        # 用户看不到是为谁开的。macos/Info.plist 里早就写着这两条，但那份文件没有进
        # 构建——真正生效的是这里，所以把它抄一份到实际被读的地方。
        "NSAppleEventsUsageDescription": "SLATE Teams 需要自动化权限以执行系统操作",
        "NSAccessibilityUsageDescription": "SLATE Teams 需要辅助功能权限以进行 UI 自动化",
    },
)
