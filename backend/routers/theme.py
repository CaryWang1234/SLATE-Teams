# -*- coding: utf-8 -*-
"""自定义主题的二进制资源：背景图、导入的字体，以及 Wallpaper Engine 的当前壁纸。

配色与板块透明度本身是几个字符串/数字，直接进 desktop_state.json 的 customTheme 键；
背景图和字体文件是几百 KB ~ 十几 MB 的二进制，不能塞进状态文件（localStorage 有配额，
且每次 savePersistent 都会整份重写）。所以这里只存文件，状态里只留"选了哪一个"。

背景图有两个来源：用户自己挑一张文件，或者取 Wallpaper Engine 当前壁纸的预览图
（只读它写在自己目录里的 config.json 与 preview.*，不启动它、也不改它的配置）。

上传走 JSON + base64 而不是 multipart：api.js 的 upload() 不带局域网鉴权头，
手机遥控时会被 401 挡掉；post() 走的是那条带鉴权的通道。从 WE 取图是本机读文件，
不过浏览器，所以这个端点一个字节都不用上传。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

router = APIRouter(prefix="/theme", tags=["theme"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
THEME_DIR = DATA_DIR / "theme"
FONT_DIR = THEME_DIR / "fonts"

# 4MB 上限：背景图铺满屏幕用不了更多，也让一次误选视频不至于把 data/ 撑爆
MAX_BACKGROUND_BYTES = 4 * 1024 * 1024

# 字体上限 16MB：一个中文全集字体轻松到 20MB+，那是子集化该解决的事，
# 这里先把"一次误拖整个字体目录"挡在门外。
MAX_FONT_BYTES = 16 * 1024 * 1024

# 字体文件名的 id 形状：只由 _font_id() 生成（f + 内容哈希 10 位），
# 每个入口都先按它校验，才敢拿它去拼路径——用户传进来的字符串永远不当文件名用。
_FONT_ID_RE = re.compile(r"^[a-z0-9]{1,16}$")

# 认内容不认扩展名：前 12 字节的魔数 → (扩展名, MIME)
_MAGIC: tuple[tuple[bytes, str, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", ".png", "image/png"),
    (b"\xff\xd8\xff", ".jpg", "image/jpeg"),
    (b"GIF87a", ".gif", "image/gif"),
    (b"GIF89a", ".gif", "image/gif"),
)

_B64_RE = re.compile(r"^[A-Za-z0-9+/=\s]+$")


class BackgroundRequest(BaseModel):
    data: str = ""


class FontRequest(BaseModel):
    data: str = ""
    name: str = ""


def _sniff(raw: bytes) -> tuple[str, str]:
    """返回 (扩展名, MIME)。认不出来的直接拒：这张图会被 CSS 当背景反复请求，别留活口。"""
    for magic, ext, mime in _MAGIC:
        if raw.startswith(magic):
            return ext, mime
    # WebP: "RIFF"...."WEBP"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return ".webp", "image/webp"
    raise HTTPException(status_code=400, detail="只支持 PNG / JPG / GIF / WebP 背景图")


def _current_file() -> Path | None:
    """data/theme/ 里唯一那张背景图（历史上换过格式会留下旧文件，取最新的一张）。

    排除 background.tmp*：那是写一半的临时名，断电之类留下的残骸不该被当成图发出去。
    """
    if not THEME_DIR.is_dir():
        return None
    files = [p for p in THEME_DIR.glob("background.*")
             if p.is_file() and not p.name.startswith("background.tmp")]
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_mtime)


def _drop_others(keep: Path) -> None:
    # 连 background.tmp* 残骸一起收：那是上次写一半断掉的，留着只会占地方
    for p in THEME_DIR.glob("background.*"):
        if p != keep:
            try:
                p.unlink()
            except OSError:
                pass


def _store_background(raw: bytes) -> dict:
    """一份字节 → data/theme/background<ext>，返回 {bytes, ext, stamp}。

    上传（base64）与 Wallpaper Engine（本机文件）两条路共用这一道门口：体积、魔数、
    临时名、清旧图四件事只在这里做一次，分两处写迟早一边紧一边松。
    """
    if not raw:
        raise HTTPException(status_code=400, detail="背景图是空的")
    if len(raw) > MAX_BACKGROUND_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"背景图超过 {MAX_BACKGROUND_BYTES // 1024 // 1024}MB，换一张小一点的")
    ext, _mime = _sniff(raw)
    THEME_DIR.mkdir(parents=True, exist_ok=True)
    target = THEME_DIR / f"background{ext}"
    # 先写临时名再换：直接覆盖的话，写到一半断电会留下半张图，CSS 会反复请求它
    tmp = THEME_DIR / f"background.tmp{ext}"
    tmp.write_bytes(raw)
    tmp.replace(target)
    _drop_others(target)
    return {"bytes": len(raw), "ext": ext,
            # 缓存串用文件 mtime：同一 URL 换图后浏览器不会拿旧的那张
            "stamp": int(target.stat().st_mtime * 1000)}


@router.get("/background/status")
async def background_status():
    """前端每次生效主题前先问一句「这台机器上到底有没有那张图」。

    不直接靠 GET /background 的 404 判断：那条路会把图片本身下载一遍，
    而且 404 会在控制台里留一条难看红色的请求。
    """
    path = _current_file()
    stat = path.stat() if path else None
    return {
        "code": 0,
        "data": {
            "exists": bool(path),
            "stamp": int(stat.st_mtime * 1000) if stat else 0,
            # 设置页那行说明要报"这张图多大"，让用户在换图后知道自己塞进去的是什么
            "bytes": stat.st_size if stat else 0,
        },
        "message": "ok",
    }


@router.get("/background")
async def get_background():
    """没有背景图时返回 404：前端把这张图当 CSS url() 用，404 就是"不画"，不需要额外协议。"""
    path = _current_file()
    if not path:
        raise HTTPException(status_code=404, detail="没有背景图")
    ext = path.suffix.lower()
    mime = "image/png" if ext == ".png" else {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    }.get(ext, "application/octet-stream")
    # no-store：换图后同名文件被覆盖，靠缓存串会看到上一张
    return FileResponse(str(path), media_type=mime, headers={"Cache-Control": "no-store"})


@router.post("/background")
async def save_background(req: BackgroundRequest):
    raw_b64 = (req.data or "").strip()
    if raw_b64.startswith("data:"):
        raw_b64 = raw_b64.split(",", 1)[-1]
    if not raw_b64 or not _B64_RE.match(raw_b64):
        raise HTTPException(status_code=400, detail="背景图内容不是有效的 base64")
    try:
        raw = base64.b64decode(raw_b64, validate=False)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"背景图解码失败: {exc}")
    if not raw:
        raise HTTPException(status_code=400, detail="背景图是空的")
    stored = _store_background(raw)
    return {"code": 0, "data": stored, "message": "ok"}


@router.delete("/background")
async def delete_background():
    removed = 0
    if THEME_DIR.is_dir():
        for p in THEME_DIR.glob("background.*"):
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return {"code": 0, "data": {"removed": removed}, "message": "ok"}


# ── Wallpaper Engine：把 WE 当前壁纸的预览图取过来当背景图 ──────
#
# 只读不启动。WE 把"每块屏正在放哪张壁纸"记在 <安装目录>/config.json 里：
#   "<用户名>" → general → wallpaperconfig → selectedwallpapers → Monitor<N> → {"file": "…"}
# 那个 file 通常是 .mp4 / scene.pkg / index.html，界面既用不上也不需要——同一个目录里的
# preview.jpg / preview.png / preview.gif 才是 WE 自己画给别人看的那一张。静态的排在前面，
# gif 只兜底：gif 会在聊天界面后面一直动，白占一次解码，能拿到静态的就别拿动的。
#
# 两条边界写在这里也说给用户听：WE 换了壁纸这里不会自己跟着换（要再点一次）；
# SLATE 也绝不动 WE 的进程与它的配置。
WE_CONFIG_NAME = "config.json"
WE_PREVIEW_NAMES = ("preview.jpg", "preview.jpeg", "preview.png", "preview.gif")
_WE_MONITOR_RE = re.compile(r"^Monitor(\d+)$")


def _steam_library(install: Path) -> Path:
    """<库>/steamapps/common/wallpaper_engine → <库>：创意工坊下载的壁纸住在这底下。"""
    parents = install.parents
    if len(parents) >= 3 and parents[1].name == "steamapps":
        return parents[2]
    return install


def _steam_roots_from_registry() -> list[Path]:
    """HKCU\\Software\\Valve\\Steam 的 SteamPath：Steam 装在别的盘时靠它认出来。"""
    try:
        import winreg
    except ImportError:
        return []
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
            value, _type = winreg.QueryValueEx(key, "SteamPath")
    except OSError:
        return []
    return [Path(str(value))] if value else []


def _we_install_dirs() -> list[Path]:
    """WE 可能装在哪。环境变量指定的目录是排他的一句话：「我要用的就是这一份」——
    非默认安装位、走查用的假目录都走它；设了它就不再去猜 Program Files 里那份真安装。
    """
    override = (os.environ.get("SLATE_WALLPAPER_ENGINE_DIR") or "").strip()
    if override:
        return [Path(override)]
    if sys.platform != "win32":
        return []             # 认不出来说"没装"就是没装：不去猜别的盘，更不去扫文件系统
    out = [Path(base) / "Steam" / "steamapps" / "common" / "wallpaper_engine"
           for key in ("ProgramFiles(x86)", "ProgramFiles")
           if (base := (os.environ.get(key) or "").strip())]
    out.extend(root / "steamapps" / "common" / "wallpaper_engine"
               for root in _steam_roots_from_registry())
    uniq: list[Path] = []
    for p in out:
        if p not in uniq:
            uniq.append(p)
    return uniq


def _within(root: Path, target: Path) -> bool:
    """target 是否落在 root 里面（两边都先 resolve，`..` 与链接都糊弄不过去）。"""
    try:
        target.resolve().relative_to(root.resolve())
    except (OSError, ValueError):
        return False
    return True


def _we_user_blocks(cfg_path: Path) -> list[dict]:
    """config.json 里那些"某个用户的设置"块。当前用户名对得上的排前面，其余块留着兜底。

    WE 运行时会重写这个文件，读到半截是可能的：那种情况返回空列表，让上面说"没选中的壁纸"，
    而不是抛一个 500 出去。
    """
    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    me = (os.environ.get("USERNAME") or os.environ.get("USER") or "").strip().lower()
    named: list[dict] = []
    others: list[dict] = []
    for key, value in data.items():
        if not isinstance(key, str) or key.startswith("?") or not isinstance(value, dict):
            continue
        if not isinstance(value.get("general"), dict):
            continue
        (named if key.lower() == me else others).append(value)
    return named + others


def _we_monitor_order(name: str) -> tuple[int, int, str]:
    """Monitor0 < Monitor1 < Monitor10（按数字排，不是按字符串，否则 10 会插到 2 前面）。"""
    m = _WE_MONITOR_RE.match(name)
    return (0, int(m.group(1)), "") if m else (1, 0, name)


def _we_preview_for(wallpaper: Path, allowed: list[Path]) -> Path | None:
    """这张壁纸目录里能用的那一张预览图。路径只从"配置里那个文件的目录"拼出来，
    文件名固定是 preview.* 这四种之一，且必须还落在 Steam/WE 目录内——配置是被谁改过的
    我们不知道，所以它只用来定位目录，不当成"照着读"的凭据。
    """
    for name in WE_PREVIEW_NAMES:
        cand = wallpaper.parent / name
        if not cand.is_file():
            continue
        if not any(_within(root, cand) for root in allowed):
            continue
        try:
            if cand.stat().st_size > MAX_BACKGROUND_BYTES:
                continue
        except OSError:
            continue
        return cand
    return None


def _we_candidates(cfg_path: Path, install: Path) -> list[dict]:
    """每块屏一项：{monitor, wallpaper, preview(绝对路径 | None), bytes}。只在后端内部用。"""
    allowed = [install, _steam_library(install)]
    out: list[dict] = []
    seen: set[str] = set()
    for block in _we_user_blocks(cfg_path):
        selected = ((block.get("general") or {}).get("wallpaperconfig") or {})
        selected = selected.get("selectedwallpapers") if isinstance(selected, dict) else None
        if not isinstance(selected, dict):
            continue
        for name in sorted((str(k) for k in selected), key=_we_monitor_order):
            if not _WE_MONITOR_RE.match(name) or name in seen:
                continue
            entry = selected.get(name)
            file = str(entry.get("file") or "").strip() if isinstance(entry, dict) else ""
            if not file:
                continue
            seen.add(name)
            wallpaper = Path(file.replace("\\", "/"))
            preview = _we_preview_for(wallpaper, allowed)
            try:
                size = preview.stat().st_size if preview else 0
            except OSError:
                size = 0
            out.append({
                "monitor": name,
                "wallpaper": wallpaper.name[:60],
                "preview": preview,
                "bytes": size,
            })
    return out


def _we_detect() -> dict:
    """找到第一份能读的 WE 配置就收：第二个候选目录一般是同一份安装的副本，没必要合并。"""
    for install in _we_install_dirs():
        cfg = install / WE_CONFIG_NAME
        if not cfg.is_file():
            continue
        cands = _we_candidates(cfg, install)
        return {
            "installed": True,
            "reason": "" if cands else "no_selection",
            "monitors": [{
                "monitor": c["monitor"],
                "wallpaper": c["wallpaper"],
                # 绝对路径不外发：这里只给文件名与大小，够设置页说清"取的是哪一张"
                "preview": ({"name": c["preview"].name, "bytes": c["bytes"]} if c["preview"] else None),
            } for c in cands],
            "_cands": cands,
        }
    return {"installed": False,
            "reason": "not_windows" if sys.platform != "win32" else "not_installed",
            "monitors": [], "_cands": []}


@router.get("/wallpaper-engine/status")
async def wallpaper_engine_status():
    """设置页那一行要先问：装没装、当前每块屏在放什么、有没有可取的预览图。"""
    found = _we_detect()
    found.pop("_cands", None)
    return {"code": 0, "data": found, "message": "ok"}


@router.post("/wallpaper-engine/background")
async def use_wallpaper_engine_background():
    """取 WE 当前壁纸的预览图当背景图：落盘走 _store_background，与用户上传同一道门口。"""
    for cand in _we_detect()["_cands"]:
        preview = cand.get("preview")
        if not isinstance(preview, Path):
            continue
        try:
            raw = preview.read_bytes()
        except OSError:
            continue
        stored = _store_background(raw)
        stored["monitor"] = cand["monitor"]
        stored["wallpaper"] = cand["wallpaper"]
        return {"code": 0, "data": stored, "message": "ok"}
    raise HTTPException(status_code=400, detail="没有可取的 Wallpaper Engine 壁纸预览图")


# ── 导入的字体 ──────────────────────────────
# sfnt 版本号 / woff 魔数 → (扩展名, MIME)。ttcf 是字体合集，浏览器不认，单独拒掉：
# 它的头四字节和别的 sfnt 不同族，混进来只会得到一个装在 20MB 里的"字体"，页面上一个像素都不变。
_FONT_MAGIC: tuple[tuple[bytes, str, str], ...] = (
    (b"wOF2", ".woff2", "font/woff2"),
    (b"wOFF", ".woff", "font/woff"),
    (b"OTTO", ".otf", "font/otf"),
    (b"ttcf", "", ""),
    (b"\x00\x01\x00\x00", ".ttf", "font/ttf"),
    (b"true", ".ttf", "font/ttf"),
)

# 认不出的扩展名一律回落 .bin：只有 _sniff_font 认过的四种会落盘，
# 反查表就只为那四种服务，兜底分支是给"文件被人手工塞进 data/theme/fonts/"准备的。
_FONT_MIME_BY_EXT = {".woff2": "font/woff2", ".woff": "font/woff", ".otf": "font/otf", ".ttf": "font/ttf"}


def _sniff_font(raw: bytes) -> str:
    """返回扩展名。认不出来的直接拒：这个字节串会被 @font-face 反复请求并交给字体引擎解析。"""
    for magic, ext, _mime in _FONT_MAGIC:
        if raw.startswith(magic):
            if not ext:
                raise HTTPException(status_code=400, detail="字体合集（.ttc / .ttcf）浏览器用不了，请导出成单个 .ttf / .otf / .woff2")
            return ext
    raise HTTPException(status_code=400, detail="只支持 WOFF2 / WOFF / TTF / OTF 字体文件")


def _font_id(raw: bytes) -> str:
    """id 取内容哈希：同一份字体第二次导入得到同一个 id，不会把 data/ 堆成十份副本。"""
    return "f" + hashlib.sha256(raw).hexdigest()[:10]


def _font_label(name: str) -> str:
    """把用户挑的文件名收成一句能显示的标签。

    只做显示：这个字符串永远不进 CSS——@font-face 的家庭名是由校验过的 id 拼出来的
    （见前端 importedFontFamily），所以标签里就算带引号、反斜杠、尖括号也污染不到样式表。
    """
    base = re.split(r"[/\\]", str(name or ""))[-1]
    base = re.sub(r"\.(woff2|woff|ttf|otf)$", "", base, flags=re.IGNORECASE)
    base = "".join(ch for ch in base if ch.isprintable() and ch not in '<>"\'&').strip()
    return (base or "导入的字体")[:64]


def _font_path(fid: str) -> Path | None:
    if not _FONT_ID_RE.match(fid) or not FONT_DIR.is_dir():
        return None
    for p in FONT_DIR.glob(f"{fid}.*"):
        if p.is_file() and not p.name.startswith(f"{fid}.tmp"):
            return p
    return None


@router.get("/fonts")
async def list_fonts():
    """本机 data/theme/fonts/ 里实际存着的字体。

    状态里的 fonts.imported 是"用户导入过哪些"，这份是"这台机器上有哪些"——
    两者可以不一致（换设备、装机版重装），前端据此决定要不要给某个 id 发 @font-face。
    """
    items = []
    if FONT_DIR.is_dir():
        for p in sorted(FONT_DIR.glob("*")):
            if not p.is_file() or ".tmp" in p.name:
                continue
            fid = p.stem
            if not _FONT_ID_RE.match(fid):
                continue
            stat = p.stat()
            items.append({"id": fid, "format": p.suffix.lstrip(".").lower(),
                          "bytes": stat.st_size, "stamp": int(stat.st_mtime * 1000)})
    return {"code": 0, "data": {"items": items}, "message": "ok"}


@router.get("/font/{fid}")
async def get_font(fid: str):
    path = _font_path(fid)
    if not path:
        raise HTTPException(status_code=404, detail="没有这个字体")
    mime = _FONT_MIME_BY_EXT.get(path.suffix.lower(), "application/octet-stream")
    # 长缓存是安全的：id 就是内容哈希，同 id 换了内容就不叫同一个 id 了
    return FileResponse(str(path), media_type=mime,
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.post("/font")
async def save_font(req: FontRequest):
    raw_b64 = (req.data or "").strip()
    if raw_b64.startswith("data:"):
        raw_b64 = raw_b64.split(",", 1)[-1]
    if not raw_b64 or not _B64_RE.match(raw_b64):
        raise HTTPException(status_code=400, detail="字体内容不是有效的 base64")
    try:
        raw = base64.b64decode(raw_b64, validate=False)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"字体解码失败: {exc}")
    if not raw:
        raise HTTPException(status_code=400, detail="字体是空的")
    if len(raw) > MAX_FONT_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"字体超过 {MAX_FONT_BYTES // 1024 // 1024}MB，请先子集化或换一个小的")
    ext = _sniff_font(raw)
    fid = _font_id(raw)
    if not _FONT_ID_RE.match(fid):      # 生成规则改了也别把不合规的名字带进文件系统
        raise HTTPException(status_code=500, detail="字体 id 生成异常")
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    target = FONT_DIR / f"{fid}{ext}"
    # 与背景图同一套：先写临时名再换，写一半断掉的残骸不会被 GET 当成字体发出去
    tmp = FONT_DIR / f"{fid}.tmp{ext}"
    tmp.write_bytes(raw)
    tmp.replace(target)
    return {"code": 0, "data": {"id": fid, "format": ext.lstrip("."), "bytes": len(raw),
                                "label": _font_label(req.name)},
            "message": "ok"}


@router.delete("/font/{fid}")
async def delete_font(fid: str):
    if not _FONT_ID_RE.match(fid):
        raise HTTPException(status_code=400, detail="字体 id 不合法")
    path = _font_path(fid)
    if not path:
        return {"code": 0, "data": {"removed": 0}, "message": "ok"}
    try:
        path.unlink()
    except OSError as exc:
        # Windows 上正在被页面使用的字体会被系统锁住；说清楚下一步该干什么，比抛 500 有用
        raise HTTPException(status_code=409, detail="这个字体正被界面占用，先把它换掉再移除") from exc
    return {"code": 0, "data": {"removed": 1, "id": fid}, "message": "ok"}
