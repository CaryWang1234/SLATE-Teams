"""SLATE Teams 后端入口：挂载静态目录，注册路由。"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.routers import actions, bg_tasks, chat, constitution, diagnostics, events, evolved, experts, files, grind, i18n, keep_awake, knowledge, lan, mcp, mcp_servers, office, proxy, projects, scheduler, settings, skills, teams, theme, typing, update, vault, workflows
from backend import evolution, keepawake, mcp_client
from backend.skills import bg_task as bg_task_skill

# system_info 需要 psutil，可能不在所有环境中可用
try:
    from backend.routers import system_info
    HAS_SYSTEM_INFO = True
except ImportError as e:
    logging.warning(f"[system_info] 路由导入失败: {e}")
    HAS_SYSTEM_INFO = False

PROJECT_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))

app = FastAPI(title="SLATE Teams", version="20260803-1")

# CORS：仅允许本机来源（桌面应用同源加载，不受影响）；跨源恶意网页一律拒绝
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null"],  # file:// 直接打开时的 origin
    allow_origin_regex=r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 最大请求体大小 (20MB)
MAX_REQUEST_BODY_SIZE = 20 * 1024 * 1024


@app.middleware("http")
async def check_request_size(request: Request, call_next):
    """拦截超大请求体，防止内存溢出攻击。"""
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BODY_SIZE:
                return JSONResponse(
                    status_code=413,
                    content={"code": -1, "data": None, "message": f"请求体过大（最大 {MAX_REQUEST_BODY_SIZE // 1024 // 1024}MB）"},
                )
        except ValueError:
            pass
    return await call_next(request)


@app.middleware("http")
async def check_lan_auth(request: Request, call_next):
    """局域网副端口访问必须带授权 token；本机主端口不受影响。

    与会者的票据识别与作用域由团队模块提供，这里装一次钩子：团队模块要用到
    lan 的 token 名字，lan 反向 import 它就成环，所以走注入而不是互相 import。
    """
    return await lan.enforce_lan_auth(request, call_next)


lan.set_team_hooks(teams.resolve_lan_actor, teams.check_lan_scope)


@app.middleware("http")
async def add_dev_cache_headers(request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


# 注册 API 路由
app.include_router(proxy.router, prefix="/api")
app.include_router(constitution.router, prefix="/api")
app.include_router(skills.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(events.router, prefix="/api")
app.include_router(teams.router, prefix="/api")
app.include_router(grind.router, prefix="/api")
app.include_router(files.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(update.router, prefix="/api")
app.include_router(knowledge.router, prefix="/api")
app.include_router(experts.router, prefix="/api")
app.include_router(scheduler.router, prefix="/api")
app.include_router(office.router, prefix="/api")
app.include_router(workflows.router, prefix="/api")
app.include_router(lan.router, prefix="/api")
app.include_router(i18n.router, prefix="/api")
app.include_router(vault.router, prefix="/api")
app.include_router(mcp.router, prefix="/api")
app.include_router(mcp_servers.router, prefix="/api")
app.include_router(typing.router, prefix="/api")
app.include_router(diagnostics.router, prefix="/api")
app.include_router(actions.router, prefix="/api")
app.include_router(bg_tasks.router, prefix="/api")
app.include_router(theme.router, prefix="/api")
app.include_router(evolved.router, prefix="/api")
app.include_router(keep_awake.router, prefix="/api")

# system_info 路由（需要 psutil，可能不可用）
if HAS_SYSTEM_INFO:
    app.include_router(system_info.router, prefix="/api")


@app.on_event("startup")
async def _start_schedule_loop():
    """启动定时任务后台循环。"""
    scheduler.start_scheduler()


@app.on_event("startup")
async def _start_office_clock():
    """启动办公室时钟：员工值班表到点只排队，执行仍由主持人页面领走。"""
    office.start_office_clock()


@app.on_event("startup")
async def _migrate_legacy_tools():
    """把旧版写进 backend/skills/ 的自生产工具搬进 data/evolved/。

    失败只记日志：那些文件在新版里本来也不会被注册（不在 BUILTIN_SKILLS 里），
    留一次迁移不顺不该让整个后端起不来。
    """
    try:
        moved = evolution.migrate_legacy()
        if moved:
            logging.info(f"[evolution] 自进化工具已迁入 data/evolved/: {', '.join(moved)}")
    except Exception as e:  # noqa: BLE001 - 启动路径上的兜底，见上方说明
        logging.warning(f"[evolution] 旧自进化工具迁移失败: {e}")


@app.on_event("startup")
async def _start_lan_remote():
    """启动局域网副服务（0.0.0.0:8131，共享本 app），与会者从这里接入。

    设置页把开关关掉后不再起；desktop.py --remote 用环境变量强制开，只影响本次进程。
    """
    if not lan.should_start_on_boot():
        return
    lan.start_lan_server(app)


@app.on_event("startup")
async def _start_mcp_clients():
    """启动时自动连接已配置的外部 MCP Server。"""
    asyncio.create_task(mcp_client.startup_connect_all())


@app.on_event("shutdown")
async def _shutdown_mcp_clients():
    """关闭时断开所有 MCP Server 连接。"""
    await mcp_client.shutdown_disconnect_all()


@app.on_event("shutdown")
async def _shutdown_bg_tasks():
    """关闭时收尾在册后台任务：托管在宿主进程里的进程树不该活过宿主。"""
    bg_task_skill.shutdown()


@app.on_event("shutdown")
async def _release_keep_awake():
    """退出时把"别让电脑睡"的需求清掉。

    进程死亡时 Windows 本来也会回收，但那是兜底不是设计：显式清一次，状态才停在
    日志和接口里看得见，也不会因为这条线程被别的什么拖着没退而多钉几十秒。
    """
    keepawake.stop()

# 挂载前端静态文件
frontend_dir = PROJECT_ROOT / "frontend"
if frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
