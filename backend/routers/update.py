"""更新检查路由：启动时查询 GitHub 最新 Release，提示用户下载新版安装包。

版本号唯一事实源：APP_VERSION（需与 SLATE_Teams.iss 的 MyAppVersion 保持同步）。
"""

from __future__ import annotations

import re
import sys
import webbrowser

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/update", tags=["update"])

# 与 SLATE_Teams.iss 的 MyAppVersion 保持同步；预发布版带后缀，如 "0.4.5-rc1"
APP_VERSION = "0.4.5"

# 更新源必须是本产品自己的仓库。这里刻意指向一个尚未建立的仓库名而**不是**上游 SLATE：
# 上游的 Release 里放的是 SLATE-Teams-Setup-*.exe，装上去就是把 Teams 换成 SLATE。
# 仓库还不存在时 GitHub 返回 404，检查静默失败、界面只说"已是最新"——fail closed。
REPO = "CaryWang1234/SLATE-Teams-Teams"
API_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
# 安装包命名规则：SLATE-Teams-Setup-{版本}{后缀}，与 build_installer.bat / build_macos.sh 的产物一致
DOWNLOAD_URL = "https://github.com/{repo}/releases/download/{tag}/SLATE-Teams-Setup-{ver}{ext}"
RELEASE_PAGE = "https://github.com/{repo}/releases/tag/{tag}"
# 各平台的装机包后缀。Linux 不在这张表里——它没有打包产物（官网就是这么写的），
# 于是那一侧拿到的是 Release 页，而不是今天这样被指到 Windows 的 .exe 上。
INSTALLER_EXT = {"win32": ".exe", "darwin": ".dmg"}
# 允许用系统浏览器打开的链接前缀：本仓库 GitHub 页 + 官网。
# 只放本产品的地址——借道这里跳到上游，等于把用户送到另一个产品的安装包上。
ALLOWED_PREFIXES = (
    f"https://github.com/{REPO}",
)


def _parse_version(tag: str) -> tuple[int, int, int, int]:
    """解析成可比较四元组：数字三段 + 预发布位次（首个 - 之后算预发布，位次 0，排在同名正式版 1 之前）。"""
    base, sep, _suffix = (tag or "").strip().lstrip("vV").partition("-")
    nums = [int(n) for n in re.findall(r"\d+", base)[:3]]
    nums += [0] * (3 - len(nums))
    return (*nums, 0 if sep else 1)


def installer_ext(platform: str) -> str:
    """这台机器的装机包后缀；空串 = 这个平台没有打包产物。"""
    return INSTALLER_EXT.get(str(platform or ""), "")


def pick_asset_url(assets, ext: str) -> str:
    """从 Release 资产里挑出本机那一份。

    只认 endswith(ext)：校验文件叫 `SLATE-Teams-Setup-x.dmg.sha256`，按后缀自然排除了；
    反过来如果判据写成"名字里带 .dmg"就会把校验和当成安装包发给用户。
    """
    if not ext:
        return ""
    for asset in assets or []:
        if str(asset.get("name") or "").lower().endswith(ext):
            return str(asset.get("browser_download_url") or "")
    return ""


def download_url_for(assets, repo: str, tag: str, ver: str, platform: str) -> str:
    """资产直链 → 按命名规则拼的直链 → Release 页（这个平台压根没有包时）。"""
    ext = installer_ext(platform)
    asset_url = pick_asset_url(assets, ext)
    if asset_url:
        return asset_url
    if ext:
        return DOWNLOAD_URL.format(repo=repo, tag=tag, ver=ver, ext=ext)
    return RELEASE_PAGE.format(repo=repo, tag=tag)


@router.get("/check")
async def check_update():
    """查询最新 Release。网络失败静默返回 hasUpdate=false，绝不阻塞启动。"""
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(
                API_URL,
                headers={"User-Agent": "SLATE-Teams", "Accept": "application/vnd.github+json"},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception:
        return {
            "code": 0,
            "data": {"current": APP_VERSION, "hasUpdate": False, "checked": False},
            "message": "更新检查失败（网络不可用），已跳过",
        }

    tag = str(data.get("tag_name") or "").strip()
    latest = tag.lstrip("vV")
    has_update = bool(tag) and _parse_version(latest) > _parse_version(APP_VERSION)

    # 下载直链按当前平台挑（Mac 拿 .dmg，Windows 拿 .exe），见 download_url_for
    return {
        "code": 0,
        "data": {
            "current": APP_VERSION,
            "latest": latest,
            "hasUpdate": has_update,
            "checked": True,
            "downloadUrl": download_url_for(data.get("assets"), REPO, tag, latest, sys.platform),
            "releaseUrl": RELEASE_PAGE.format(repo=REPO, tag=tag),
            "notes": str(data.get("body") or "")[:500],
        },
        "message": "ok",
    }


class OpenUrlRequest(BaseModel):
    url: str


@router.post("/open-url")
async def open_url(req: OpenUrlRequest):
    """用系统浏览器打开项目链接（webview 内 window.open 不可靠）。

    白名单限制：仅允许本仓库 GitHub 页与官网链接，防止被当作通用跳板。
    """
    url = (req.url or "").strip()
    if not any(url.startswith(p) for p in ALLOWED_PREFIXES):
        return {"code": 1, "message": "仅允许打开本项目的 GitHub / 官网链接"}
    try:
        webbrowser.open(url)
        return {"code": 0, "data": None, "message": "ok"}
    except Exception as e:
        return {"code": 1, "message": f"打开链接失败: {e}"}
