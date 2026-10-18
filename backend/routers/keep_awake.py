"""阻止系统睡眠的开关（供界面在跑任务时续租）。

界面是"要不要醒着"的判断方，这一层只是把请求转给 backend/keepawake.py 那条持有线程。
两个口子都要能回答状态，界面靠 GET 把「这台机器支持吗」显示到设置页里。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from backend import keepawake

router = APIRouter(prefix="/system", tags=["system"])


class KeepAwakeRequest(BaseModel):
    want: bool
    # 只进日志、不参与判断：出问题时能分清是循环、页面还是别处按的
    reason: str = ""


def _ok(data: Any) -> dict:
    return {"code": 0, "data": data, "message": "ok"}


@router.get("/keep-awake")
async def get_keep_awake() -> dict:
    """当前状态：supported/want/active + 系统读回来的标志位。"""
    return _ok(keepawake.status())


@router.post("/keep-awake")
async def set_keep_awake(req: KeepAwakeRequest) -> dict:
    """续租（want=true）或松手（want=false）。不支持的平台静默返回状态，不报错——
    界面每 20 秒打一次这个口子，非 Windows 上把它变成错误只会污染日志。"""
    return _ok(keepawake.renew(bool(req.want)))


@router.post("/keep-awake/release")
async def release_keep_awake() -> dict:
    """立刻松手，不等租期到（关掉界面前那一下）。"""
    keepawake.stop()
    return _ok(keepawake.status())
