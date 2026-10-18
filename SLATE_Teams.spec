# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

# pythonnet / clr_loader 的原生数据文件（.NET runtime DLLs、配置文件等）
try:
    _clr_data = collect_data_files('clr_loader')
except Exception:
    _clr_data = []
try:
    _cffi_data = collect_data_files('cffi')
except Exception:
    _cffi_data = []
try:
    _clr_libs = collect_dynamic_libs('clr_loader')
except Exception:
    _clr_libs = []

datas = [
    ('frontend', 'frontend'),
    ('backend/routers', 'backend/routers'),
    ('backend/skills', 'backend/skills'),
    ('backend/workflows', 'backend/workflows'),
    # 托盘图标运行时要用：EXE 的 icon= 只画 exe 文件图标，不会把 .ico 放进包里
    ('app.ico', '.'),
] + _clr_data + _cffi_data

binaries_extra = _clr_libs

hiddenimports = [
    'backend.main',
    'backend.routers.chat',
    'backend.routers.constitution',
    'backend.routers.experts',
    'backend.routers.files',
    'backend.routers.grind',
    'backend.routers.i18n',
    'backend.routers.keep_awake',
    'backend.keepawake',
    'backend.routers.knowledge',
    'backend.routers.lan',
    'backend.routers.mcp',
    'backend.routers.mcp_servers',
    'backend.routers.projects',
    'backend.routers.proxy',
    'backend.routers.settings',
    'backend.routers.skills',
    'backend.routers.system_info',
    'backend.routers.theme',
    'backend.routers.update',
    'backend.routers.vault',
    'backend.routers.workflows',
    'backend.skills.css_color',
    'backend.skills.doc_write',
    'backend.skills.file_create',
    'backend.skills.file_edit',
    'backend.skills.file_peek',
    'backend.skills.file_tree',
    'backend.skills.html_render',
    'backend.skills.json_tool',
    'backend.skills.ppt_create',
    'backend.skills.regex_test',
    'backend.skills.repo_stats',
    'backend.skills.text_summarize',
    'backend.skills.todo_scan',
    'backend.skills.terminal',
    'backend.skills.sandbox',
    'backend.skills.web_fetch',
    'backend.skills.web_search',
    'backend.skills.word_create',
    'backend.skills.chart_create',
    'backend.skills.qrcode_create',
    'backend.skills.python_api_extract',
    'backend.skills.html_bundle',
    'backend.skills.browser_automation',
    'backend.skills.computer_use',
    'backend.skills.excel_tool',
    'backend.skills.pdf_tool',
    'backend.skills.git_tool',
    'backend.skills.screenshot_to_code',
    'backend.skills.mcp_factory',
    'backend.skills.code_scan',
    'backend.skills.doc_scan',
    'backend.skills.plugin_adapter',
    'backend.skills.text_io',
    'backend.mcp_client',
    # 系统元认知（system_info.py 延迟导入 psutil）
    'psutil',
    # 多模态文件解析依赖（files.py 内函数级延迟导入，需显式声明）
    'openpyxl',
    'pdfplumber',
    'qrcode',
    'qrcode.image.svg',
    'pptx',
    'pptx.oxml',
    'docx',
    'docx.oxml',
    # 桌面自动化窗口管理（computer_use 内函数级延迟导入）
    'pygetwindow',
    'webview.platforms.edgechromium',
    # pythonnet 全链路（pywebview Windows 后端依赖 .NET 互操作）
    'pythonnet',
    'clr',
    'clr_loader',
    'clr_loader.loader',
    'clr_loader.netfx',
    'clr_loader.mono',
    'clr_loader.coreclr',
    'clr_loader.ffi',
    'cffi',
    '_cffi_backend',
    'uvicorn.lifespan.on',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.loops.auto',
]

excludes = [
    'bambulabs_api',
    'kivy',
    'gi',
    'gtk',
    'tkinter',
    # ML/AI 大包（项目未使用，Blake2B 哈希向量无需神经网络嵌入）
    'torch',
    'torchvision',
    'torchaudio',
    'transformers',
    'sentence_transformers',
    'sentencepiece',
    'triton',
    'paddleocr',
    'paddlex',
    'paddle',
    'chromadb',
    'onnxruntime',
    'safetensors',
    'tokenizers',
    'sklearn',
    'scikit-learn',
    # 数据科学大包（项目未使用）
    'numpy',
    'scipy',
    'pandas',
    'matplotlib',
    # 3D/CAD/视觉（项目未使用）
    'vtk',
    'trame',
    'cadquery',
    'trimesh',
    'cv2',
    'opencv-python',
    'opencv-contrib-python',
    'casadi',
    'sympy',
    # GUI 框架（项目使用 pywebview，不需要 Qt/Tk）
    'PyQt5',
    'PyQt6',
    'PySide2',
    'PySide6',
    'customtkinter',
]

a = Analysis(
    ['desktop.py'],
    pathex=[],
    binaries=binaries_extra,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='SLATE-Teams',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['app.ico'],
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='SLATE-Teams',
)
