# -*- coding: utf-8 -*-
"""局域网遥控：在 0.0.0.0 上共享主应用，供局域网设备用浏览器遥控 SLATE。

实现要点：
- 与主服务共享同一个 FastAPI app 实例（UI 与能力完全一致），
  副服务在守护线程中运行 uvicorn.Server，lifespan="off" 避免重复触发启动事件；
- 默认端口 8001，被占用时向上扫描，实际端口经 /info 返回；
- /info 返回局域网地址供前端醒目展示，/qrcode 生成地址二维码。
- 开关：偏好记在 data/desktop_state.json 的 lanRemote，缺键或读坏都按"开"处理
  （升级前的行为就是一直开着，默认关会让现有装机的人突然发现手机连不上）；
  设置页可实时启停，关掉是真的把监听端口释放掉，不只是藏起地址。
  SLATE_LAN_FORCE=1 是 desktop.py --remote 用的一次性强制开，只在本次进程内生效，不落盘。
"""

from __future__ import annotations

import json
import os
import socket
import secrets
import threading
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel

from backend.data_io import atomic_write_json

router = APIRouter(prefix="/lan", tags=["lan"])

PREFERRED_PORT = 8131
PORT_SCAN_RANGE = 20  # 8131 被占用时最多向上尝试的端口数

TOKEN_QUERY = "slate_lan_token"
TOKEN_COOKIE = "slate_lan_auth"
TOKEN_HEADER = "x-slate-lan-token"

STATE_PATH = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data")) / "desktop_state.json"
PREF_KEY = "lanRemote"
FORCE_ENV = "SLATE_LAN_FORCE"

_state: dict[str, Any] = {"port": None, "error": "", "thread": None, "server": None, "token": secrets.token_urlsafe(24)}
_lock = threading.Lock()


def _read_pref() -> bool:
    """遥控开关的偏好。文件不在、内容坏了、没这个键，都按"开"走。"""
    if not STATE_PATH.exists():
        return True
    try:
        shared = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return True
    if not isinstance(shared, dict):
        return True
    return shared.get(PREF_KEY, True) is not False


def _write_pref(enabled: bool) -> bool:
    """合并式写入：只动这一个键，别把设置页刚存的其他字段抹掉。"""
    existing: dict[str, Any] = {}
    if STATE_PATH.exists():
        try:
            loaded = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                existing = loaded
        except (OSError, json.JSONDecodeError):
            existing = {}
    existing[PREF_KEY] = bool(enabled)
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(STATE_PATH, existing)
        return True
    except OSError:
        return False


def force_requested() -> bool:
    """本次进程是否被 --remote 强制开启（环境变量，不落盘）。"""
    return os.environ.get(FORCE_ENV, "").strip().lower() in ("1", "true", "yes", "on")


def should_start_on_boot() -> bool:
    """启动时要不要起副服务：被强制，或者用户偏好是开。"""
    return force_requested() or _read_pref()


def _port_free(port: int) -> bool:
    """检测 0.0.0.0 上的端口是否可用。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def _pick_port() -> int | None:
    """优先 8001，其次向上扫描，最后交给系统分配。"""
    for port in range(PREFERRED_PORT, PREFERRED_PORT + PORT_SCAN_RANGE):
        if _port_free(port):
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("0.0.0.0", 0))
            return s.getsockname()[1]
        except OSError:
            return None


def get_lan_ip() -> str:
    """获取本机局域网 IP（UDP 连接探测，无需真正发包）。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        pass
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return "127.0.0.1"


def _remote_url(ip: str, port: int) -> str:
    """生成带鉴权 token 的局域网访问地址。"""
    return f"http://{ip}:{port}/?{TOKEN_QUERY}={_state['token']}"


def invite_url(token: str) -> str:
    """与会者的邀请地址：带票据，并且落到议事厅那一页。

    落到 `/teams.html` 而不是工作台首页是刻意的：与会者拿到的是被邀请的那一场，
    把他领进整套工作台只会让他看到一片 403。
    """
    port = _state.get("port")
    if not port or not token:
        return ""
    return f"http://{get_lan_ip()}:{port}/teams.html?{TOKEN_QUERY}={token}"


def is_lan_request(request: Request) -> bool:
    """是否来自局域网副服务端口。主 127.0.0.1 端口不走此鉴权。

    基于 ASGI scope 中的实际监听端口（TCP 层，客户端不可伪造），
    不能用 Host 头 —— Host 头可被任意伪造，用它判断必然可被绕过。
    """
    port = _state.get("port")
    if not port:
        return False
    server = request.scope.get("server")
    if not server or len(server) < 2:
        return False
    try:
        return int(server[1]) == port
    except (TypeError, ValueError):
        return False


def presented_token(request: Request) -> str:
    """这道请求带来的票。

    顺序是**显式优先**：header → query → cookie。环境里那份 cookie 是上次访问留下的，
    它要是排在前面，同一浏览器换个身份（比如再用另一张票据的链接进来）就会被静默
    按旧身份处理——身份绝不该由"上一次访问"决定。
    """
    for value in (
        request.headers.get(TOKEN_HEADER, ""),
        request.query_params.get(TOKEN_QUERY, ""),
        request.cookies.get(TOKEN_COOKIE, ""),
    ):
        if value:
            return value
    return ""


def is_master_token(token: str) -> bool:
    """是不是主持人那把主 token（也就是"这台机器的主人"）。"""
    expected = str(_state.get("token") or "")
    if not expected or not token:
        return False
    try:
        return secrets.compare_digest(str(token).encode("utf-8"), expected.encode("utf-8"))
    except (TypeError, ValueError, UnicodeEncodeError):
        return False


# 团队模块提供"这张票是谁"与"这个人能碰什么"。它要 import 本模块的 token 名字，
# 本模块若反过来 import 它就成环——所以运行时注入，装配点在 main.py。
_team_actor_resolver: Callable[[Request], dict[str, Any] | None] | None = None
_team_scope_checker: Callable[[Request, dict[str, Any]], Any] | None = None


def set_team_hooks(
    resolver: Callable[[Request], dict[str, Any] | None],
    scope_checker: Callable[[Request, dict[str, Any]], Any],
) -> None:
    global _team_actor_resolver, _team_scope_checker
    _team_actor_resolver = resolver
    _team_scope_checker = scope_checker


def _resolve_actor(request: Request) -> dict[str, Any] | None:
    """这张票对应谁：主 token = 主持人，其余交给团队模块认与会者票据。"""
    token = presented_token(request)
    if is_master_token(token):
        return {"kind": "host"}
    if _team_actor_resolver is None:
        return None
    try:
        return _team_actor_resolver(request)
    except Exception:
        # 认票过程出错一律当作"没票"：这里放行一个陌生人才是真正的严重后果
        return None


def _auth_page() -> HTMLResponse:
    return HTMLResponse(
        status_code=401,
        content="""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SLATE 局域网遥控需要授权</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f5f3;color:#202124}
    main{width:min(520px,calc(100vw - 40px));border:1px solid #d8d8d2;background:#fff;padding:28px}
    h1{font-size:20px;margin:0 0 12px} p{line-height:1.7;color:#555;margin:0 0 12px} code{background:#f0f0ec;padding:2px 6px}
  </style>
</head>
<body>
  <main>
    <h1>局域网遥控需要授权</h1>
    <p>请在运行 SLATE 的主电脑上打开「设置 → 局域网遥控」，复制带授权码的遥控地址，或扫码进入。</p>
    <p>为安全起见，未带授权码的局域网访问已被拦截。</p>
  </main>
</body>
</html>""",
    )


async def enforce_lan_auth(request: Request, call_next):
    """FastAPI middleware：仅保护局域网副端口。

    两道关，顺序不能反：先认人（主 token / 与会者票据），再按人判作用域。
    与会者拿的是一张只能进议事厅的票，越界的请求在 `teams.check_lan_scope` 里被挡下——
    认证通过不等于什么都能做。
    """
    if not is_lan_request(request):
        return await call_next(request)
    actor = _resolve_actor(request)
    if actor is None:
        return _auth_page()
    if _team_scope_checker is not None:
        try:
            denied = _team_scope_checker(request, actor)
        except Exception:
            denied = None
        if denied is not None:
            return denied
    response = await call_next(request)
    token = presented_token(request)
    if token:
        # 回写的必须是被带来的那张票：写死主 token 会让与会者下一次请求起
        # 悄悄换成主持人的身份，等于自己把作用域拆了。
        response.set_cookie(
            TOKEN_COOKIE,
            token,
            httponly=True,
            samesite="lax",
            max_age=60 * 60 * 24 * 30,
        )
    return response


def start_lan_server(app: Any) -> None:
    """启动局域网副服务（幂等）。由主应用 startup 事件调用。"""
    with _lock:
        thread = _state["thread"]
        if thread is not None and thread.is_alive():
            return
        port = _pick_port()
        if port is None:
            _state["error"] = "未找到可用端口，局域网遥控未启动"
            return
        try:
            import uvicorn
            config = uvicorn.Config(
                app, host="0.0.0.0", port=port,
                log_level="warning", lifespan="off",
            )
            server = uvicorn.Server(config)
        except Exception as e:  # pragma: no cover
            _state["error"] = f"副服务初始化失败: {e}"
            return

        def _run() -> None:
            try:
                server.run()
            except Exception as e:
                _state["error"] = f"局域网服务异常退出: {e}"

        t = threading.Thread(target=_run, daemon=True, name="slate-lan")
        t.start()
        _state["port"] = port
        _state["error"] = ""
        _state["thread"] = t
        _state["server"] = server


def stop_lan_server() -> None:
    """停掉副服务并释放端口（幂等）。

    只置 should_exit 不行：线程退出后 _state["port"] 还留着旧端口，
    is_lan_request 就会继续把主端口的请求当成局域网请求去拦。
    """
    with _lock:
        server = _state.get("server")
        thread = _state.get("thread")
        _state["port"] = None
        _state["server"] = None
        _state["thread"] = None
        _state["error"] = ""
    if server is not None:
        try:
            server.should_exit = True
        except Exception:
            pass
    if thread is not None:
        thread.join(timeout=5)


def set_enabled(app: Any, enabled: bool) -> None:
    """应用开关：先落偏好再启停，顺序反过来的话起不来的一刻偏好已经丢了。"""
    _write_pref(enabled)
    if enabled:
        start_lan_server(app)
    else:
        stop_lan_server()


def _info_data() -> dict[str, Any]:
    port = _state["port"]
    ip = get_lan_ip()
    return {
        # enabled = 用户那个开关；running = 副服务是不是真的在听。两者在 --remote
        # 强制开启时会不一致（开关关着但服务在听），前端据此把原因说清楚。
        "enabled": _read_pref(),
        "running": port is not None,
        "forced": force_requested(),
        "port": port,
        "ip": ip,
        "urls": [_remote_url(ip, port)] if port else [],
        "plainUrls": [f"http://{ip}:{port}"] if port else [],
        "auth": {
            "enabled": True,
            "query": TOKEN_QUERY,
        },
        "error": _state["error"],
    }


@router.get("/info")
async def lan_info() -> dict[str, Any]:
    """返回局域网遥控地址与开关状态（前端设置页醒目展示）。"""
    return {"code": 0, "data": _info_data(), "message": "ok"}


class LanToggleRequest(BaseModel):
    enabled: bool


@router.post("/enabled")
async def lan_set_enabled(req: LanToggleRequest, request: Request) -> dict[str, Any]:
    """设置页的遥控开关。

    只认桌面主端口：从遥控副端口调用的设备正靠这条连接做事，关掉就是把自己关在
    门外；而"打开"方向在服务停掉之后根本不可达。留着那种调用只会让人以为按钮坏了。
    """
    if is_lan_request(request):
        return {"code": 1, "message": "遥控开关只能在运行 SLATE 的主机上操作"}
    set_enabled(request.app, req.enabled)
    return {"code": 0, "data": _info_data(), "message": "ok"}


@router.get("/qrcode")
async def lan_qrcode() -> Response:
    """生成局域网遥控地址的 SVG 二维码。"""
    port = _state["port"]
    if not port:
        return Response(content="", status_code=503, media_type="text/plain")
    url = _remote_url(get_lan_ip(), port)
    try:
        import qrcode
        import qrcode.image.svg
        qr = qrcode.QRCode(
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=10, border=2,
            image_factory=qrcode.image.svg.SvgPathImage,
        )
        qr.add_data(url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="#1a1d23", back_color="#ffffff")
        svg = img.to_string().decode("utf-8")
        return Response(content=svg, media_type="image/svg+xml")
    except ImportError:
        return Response(content="qrcode 库未安装", status_code=500, media_type="text/plain")
