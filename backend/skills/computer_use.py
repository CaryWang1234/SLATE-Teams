"""技能：桌面自动化 / Computer Use（基于 pyautogui + Pillow + pygetwindow）。

支持动作：
- screenshot: 截取全屏或指定区域截图（落盘 outputs/，返回预览链接）
- click: 鼠标点击指定坐标
- double_click: 双击
- right_click: 右键点击
- type: 输入文字（含非 ASCII 字符时自动走剪贴板粘贴）
- press: 按下单个按键（可重复多次，如 enter/tab/f5）
- hotkey: 按下组合键（如 ctrl+c, alt+tab）
- scroll: 鼠标滚轮滚动
- move: 移动鼠标到指定坐标
- drag: 拖拽到指定坐标
- wait: 等待指定秒数（用于等待界面响应后再继续操作）
- position: 获取当前鼠标位置
- screen_size: 获取屏幕分辨率
- locate: 在屏幕上查找图片位置（图像识别，需要参考图片）
- clipboard: 读取或写入系统剪贴板（不传 text 为读取，传 text 为写入）
- window_list: 列出所有可见窗口标题
- window_focus: 按标题模糊匹配激活（置前）窗口
- window_minimize: 最小化窗口
- window_maximize: 最大化窗口
- window_restore: 还原窗口
- window_close: 关闭窗口

适用于自动化桌面操作、UI 测试、屏幕截图、办公软件操作等场景。
"""

from __future__ import annotations

import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any

# ── 安全设置 ──────────────────────────────────────

# pyautogui 安全配置
_FAILSAFE = True      # 鼠标移到左上角时中止
_PAUSE = 0.02         # 每次操作后的全局暂停；保持响应速度，必要等待用 action=wait

_PAG = None
_GW = None

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))

# 全部动作清单（错误提示与文档共用）
_ACTIONS = (
    "screenshot/click/double_click/right_click/type/press/hotkey/scroll/move/drag/"
    "wait/position/screen_size/locate/clipboard/"
    "window_list/window_focus/window_minimize/window_maximize/window_restore/window_close"
)


def _get_pyautogui():
    """延迟导入并配置 pyautogui。"""
    global _PAG
    if _PAG is not None:
        return _PAG
    try:
        import pyautogui
    except ImportError:
        raise RuntimeError(
            "pyautogui 未安装，桌面自动化这项能力当前不可用"
            "（缺的是 SLATE 运行环境的依赖，需要用户在终端里装 pyautogui）。"
            "请把缺依赖的情况告诉用户，不要自行执行安装命令。"
        )
    pyautogui.FAILSAFE = _FAILSAFE
    pyautogui.PAUSE = _PAUSE
    pyautogui.MINIMUM_DURATION = 0
    _PAG = pyautogui
    return pyautogui


def _get_gw():
    """延迟导入 pygetwindow（随 pyautogui 一起安装）。"""
    global _GW
    if _GW is not None:
        return _GW
    try:
        import pygetwindow as gw
    except ImportError:
        raise RuntimeError(
            "pygetwindow 未安装，窗口管理这项能力当前不可用"
            "（缺的是 SLATE 运行环境的依赖，需要用户在终端里装 pygetwindow）。"
            "请把缺依赖的情况告诉用户，不要自行执行安装命令。"
        )
    _GW = gw
    return gw


def _screenshot_path(name: str = "", ext: str = "jpg") -> Path:
    """生成截图保存路径（落盘 outputs/，便于前端经 /api/files/output 预览）。"""
    out = DATA_DIR / "outputs"
    out.mkdir(parents=True, exist_ok=True)
    ts = int(time.time() * 1000)
    safe = re.sub(r'[\\/:*?"<>|\s]+', "_", (name or "").strip())[:20] or "screenshot"
    return out / f"{safe}_{ts}.{ext}"


def _parse_coords(x: Any, y: Any) -> tuple[int, int] | None:
    """解析坐标参数，返回 (x, y) 或 None。"""
    if x is None or y is None:
        return None
    try:
        return int(x), int(y)
    except (ValueError, TypeError):
        return None


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None or value == "":
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on", "y"}


def _parse_region(region: str) -> tuple[int, int, int, int] | None:
    if not region:
        return None
    parts = [int(p.strip()) for p in region.split(",")]
    if len(parts) != 4:
        raise ValueError("region 格式应为 'x,y,w,h'")
    if parts[2] <= 0 or parts[3] <= 0:
        raise ValueError("region 的宽高必须大于 0")
    return tuple(parts)


def _find_window(title: str):
    """按标题模糊匹配第一个可见窗口，返回窗口对象或 None。"""
    gw = _get_gw()
    keyword = title.strip().lower()
    for win in gw.getAllWindows():
        t = (win.title or "").strip()
        if t and keyword in t.lower():
            return win
    return None


def execute(
    action: str = "",
    x: int | str = 0,
    y: int | str = 0,
    text: str = "",
    keys: str = "",
    clicks: int = 1,
    interval: float = 0.0,
    duration: float = 0.0,
    seconds: float = 1.0,
    repeats: int = 1,
    button: str = "left",
    region: str = "",
    screenshot_name: str = "",
    image_path: str = "",
    confidence: float = 0.8,
    scroll_amount: int = 3,
    title: str = "",
    fast: bool | str = True,
    screenshot_format: str = "jpeg",
    quality: int | str = 80,
    max_width: int | str = 0,
    max_height: int | str = 0,
    **_kw: Any,
) -> dict[str, Any]:
    """桌面自动化工具。通过 pyautogui 控制鼠标键盘、管理窗口并截取屏幕。

    Args:
        action: 操作类型，见模块文档（screenshot/click/type/press/hotkey/window_* 等）
        x: X 坐标（click/move/drag/type 时使用）
        y: Y 坐标（click/move/drag/type 时使用）
        text: 输入文字（action=type/clipboard 时使用）
        keys: 按键（action=hotkey 时逗号分隔如 "ctrl,c"；action=press 时单个键名如 "enter"）
        clicks: 点击次数（默认 1）
        interval: 多次点击间隔秒数（默认 0）
        duration: 鼠标移动耗时秒数（默认 0.25）
        seconds: 等待秒数（action=wait 时使用，默认 1）
        repeats: 按键重复次数（action=press 时使用，默认 1）
        button: 鼠标按键 - left/right/middle（默认 left）
        region: 截图区域 "x,y,w,h"（可选，默认全屏）
        screenshot_name: 截图文件名前缀（可选）
        image_path: 参考图片路径（action=locate 时必填）
        confidence: 图像匹配置信度 0-1（默认 0.8）
        scroll_amount: 滚动格数（正数向上，负数向下，默认 3）
        title: 窗口标题关键词（action=window_focus/window_minimize/... 时必填，模糊匹配）
        fast: 快速模式，减少动作间暂停（默认 true）
        screenshot_format: 截图格式 jpeg/png（默认 jpeg，更快更小）
        quality: jpeg 质量 1-95（默认 80）
        max_width/max_height: 截图保存前等比缩放上限；0 表示不缩放

    Returns:
        dict: 操作结果。
    """
    started = time.perf_counter()
    if not action:
        return {"error": f"action 不能为空，可选: {_ACTIONS}"}
    action = action.strip()
    fast_mode = _to_bool(fast, True)

    # ── 不依赖 pyautogui 的动作（未安装 pyautogui 时仍可用） ──

    if action == "wait":
        try:
            sec = max(0.0, min(float(seconds), 60.0))
            time.sleep(sec)
            return {"status": "ok", "message": f"已等待 {sec} 秒"}
        except Exception as e:
            return {"error": f"桌面操作失败 (wait): {e}"}

    if action == "clipboard":
        try:
            import pyperclip
            if text:
                pyperclip.copy(text)
                return {"status": "ok", "message": f"已写入剪贴板 ({len(text)} 字符)"}
            content = pyperclip.paste() or ""
            return {"status": "ok", "text": content, "length": len(content)}
        except Exception as e:
            return {"error": f"桌面操作失败 (clipboard): {e}"}

    if action.startswith("window_"):
        try:
            gw = _get_gw()

            if action == "window_list":
                titles = [w.title for w in gw.getAllWindows() if (w.title or "").strip()]
                return {"status": "ok", "count": len(titles), "windows": titles[:30], "elapsed_ms": int((time.perf_counter() - started) * 1000)}

            if not title:
                return {"error": f"{action} 操作需要提供 title 参数（窗口标题关键词，模糊匹配）"}
            win = _find_window(title)
            if win is None:
                visible = [w.title for w in gw.getAllWindows() if (w.title or "").strip()][:20]
                return {"status": "not_found", "message": f"未找到标题包含「{title}」的窗口", "windows": visible, "elapsed_ms": int((time.perf_counter() - started) * 1000)}

            op = action[len("window_"):]
            if op == "focus":
                try:
                    if win.isMinimized:
                        win.restore()
                except Exception:
                    pass
                win.activate()
            elif op == "minimize":
                win.minimize()
            elif op == "maximize":
                win.maximize()
            elif op == "restore":
                win.restore()
            elif op == "close":
                win.close()
            else:
                return {"error": f"未知操作: {action}，可选: {_ACTIONS}"}
            return {"status": "ok", "window": win.title, "message": f"已对窗口「{win.title}」执行 {op}", "elapsed_ms": int((time.perf_counter() - started) * 1000)}
        except Exception as e:
            return {"error": f"桌面操作失败 ({action}): {e}"}

    # ── 需要 pyautogui 的动作 ──

    try:
        pag = _get_pyautogui()
        pag.PAUSE = 0.0 if fast_mode else _PAUSE
    except RuntimeError as e:
        return {"error": str(e)}

    try:
        # ── screenshot ───────────────────────────────
        if action == "screenshot":
            fmt = str(screenshot_format or "jpeg").strip().lower()
            if fmt in {"jpg", "jpeg"}:
                ext = "jpg"
                pil_fmt = "JPEG"
            elif fmt == "png":
                ext = "png"
                pil_fmt = "PNG"
            else:
                return {"error": "screenshot_format 仅支持 jpeg 或 png"}
            crop = _parse_region(region)
            img = pag.screenshot(region=crop) if crop else pag.screenshot()
            original_size = img.size
            limit_w = max(0, int(max_width or 0))
            limit_h = max(0, int(max_height or 0))
            if limit_w or limit_h:
                scale_w = (limit_w / img.width) if limit_w and img.width > limit_w else 1.0
                scale_h = (limit_h / img.height) if limit_h and img.height > limit_h else 1.0
                scale = min(scale_w, scale_h)
                if scale < 1.0:
                    img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))))
            path = _screenshot_path(screenshot_name, ext)
            if pil_fmt == "JPEG":
                img = img.convert("RGB")
                q = max(1, min(95, int(quality or 80)))
                img.save(str(path), format=pil_fmt, quality=q, optimize=False)
            else:
                img.save(str(path), format=pil_fmt, optimize=False)
            return {
                "status": "ok",
                "screenshot_path": str(path),
                "file_path": str(path),
                "preview_url": f"/api/files/output?name={path.name}",
                "size": img.size,
                "original_size": original_size,
                "format": ext,
                "elapsed_ms": int((time.perf_counter() - started) * 1000),
            }

        # ── click ────────────────────────────────────
        if action == "click":
            coords = _parse_coords(x, y)
            if not coords:
                return {"error": "click 操作需要有效的 x, y 坐标"}
            pag.click(coords[0], coords[1], clicks=clicks, interval=interval, button=button)
            return {"status": "ok", "message": f"已点击 ({coords[0]}, {coords[1]}) button={button} clicks={clicks}", "elapsed_ms": int((time.perf_counter() - started) * 1000)}

        # ── double_click ─────────────────────────────
        if action == "double_click":
            coords = _parse_coords(x, y)
            if not coords:
                return {"error": "double_click 操作需要有效的 x, y 坐标"}
            pag.doubleClick(coords[0], coords[1])
            return {"status": "ok", "message": f"已双击 ({coords[0]}, {coords[1]})", "elapsed_ms": int((time.perf_counter() - started) * 1000)}

        # ── right_click ──────────────────────────────
        if action == "right_click":
            coords = _parse_coords(x, y)
            if not coords:
                return {"error": "right_click 操作需要有效的 x, y 坐标"}
            pag.rightClick(coords[0], coords[1])
            return {"status": "ok", "message": f"已右键点击 ({coords[0]}, {coords[1]})", "elapsed_ms": int((time.perf_counter() - started) * 1000)}

        # ── type ─────────────────────────────────────
        if action == "type":
            if not text:
                return {"error": "type 操作需要提供 text 参数"}
            # 如果有坐标，先点击该位置
            coords = _parse_coords(x, y)
            if coords:
                pag.click(coords[0], coords[1])
                if not fast_mode:
                    time.sleep(0.05)
            # typewrite 仅支持 ASCII；含任何非 ASCII 字符（中文、全角符号等）走剪贴板粘贴
            if any(ord(c) > 127 for c in text):
                import pyperclip
                pyperclip.copy(text)
                pag.hotkey('ctrl', 'v')
                return {"status": "ok", "message": f"已通过剪贴板粘贴文字 ({len(text)} 字符)", "elapsed_ms": int((time.perf_counter() - started) * 1000)}
            else:
                pag.typewrite(text, interval=interval if interval else (0.0 if fast_mode else 0.02))
                return {"status": "ok", "message": f"已输入文字 ({len(text)} 字符)", "elapsed_ms": int((time.perf_counter() - started) * 1000)}

        # ── press ────────────────────────────────────
        if action == "press":
            if not keys:
                return {"error": "press 操作需要提供 keys 参数（单个键名，如 'enter'/'tab'/'f5'/'esc'）"}
            key = keys.strip().split(",")[0].strip()
            n = max(1, int(repeats))
            pag.press(key, presses=n, interval=interval if interval else (0.0 if fast_mode else 0.03))
            return {"status": "ok", "message": f"已按下按键 {key} x{n}", "elapsed_ms": int((time.perf_counter() - started) * 1000)}

        # ── hotkey ───────────────────────────────────
        if action == "hotkey":
            if not keys:
                return {"error": "hotkey 操作需要提供 keys 参数（逗号分隔，如 'ctrl,c'）"}
            key_list = [k.strip() for k in keys.split(",") if k.strip()]
            if not key_list:
                return {"error": "keys 不能为空"}
            pag.hotkey(*key_list)
            return {"status": "ok", "message": f"已按下组合键: {'+'.join(key_list)}", "elapsed_ms": int((time.perf_counter() - started) * 1000)}

        # ── scroll ───────────────────────────────────
        if action == "scroll":
            coords = _parse_coords(x, y)
            if coords:
                pag.scroll(scroll_amount, x=coords[0], y=coords[1])
            else:
                pag.scroll(scroll_amount)
            direction = "向上" if scroll_amount > 0 else "向下"
            return {"status": "ok", "message": f"已滚动 {direction} {abs(scroll_amount)} 格", "elapsed_ms": int((time.perf_counter() - started) * 1000)}

        # ── move ─────────────────────────────────────
        if action == "move":
            coords = _parse_coords(x, y)
            if not coords:
                return {"error": "move 操作需要有效的 x, y 坐标"}
            move_duration = 0.0 if fast_mode and not duration else max(0.0, float(duration))
            pag.moveTo(coords[0], coords[1], duration=move_duration)
            return {"status": "ok", "message": f"已移动鼠标到 ({coords[0]}, {coords[1]})", "elapsed_ms": int((time.perf_counter() - started) * 1000)}

        # ── drag ─────────────────────────────────────
        if action == "drag":
            coords = _parse_coords(x, y)
            if not coords:
                return {"error": "drag 操作需要有效的 x, y 坐标"}
            pag.dragTo(coords[0], coords[1], duration=max(0.0, float(duration)), button=button)
            return {"status": "ok", "message": f"已拖拽到 ({coords[0]}, {coords[1]})", "elapsed_ms": int((time.perf_counter() - started) * 1000)}

        # ── position ─────────────────────────────────
        if action == "position":
            pos = pag.position()
            return {"status": "ok", "x": pos.x, "y": pos.y, "elapsed_ms": int((time.perf_counter() - started) * 1000)}

        # ── screen_size ──────────────────────────────
        if action == "screen_size":
            size = pag.size()
            return {"status": "ok", "width": size.width, "height": size.height, "elapsed_ms": int((time.perf_counter() - started) * 1000)}

        # ── locate（图像识别定位） ────────────────────
        if action == "locate":
            if not image_path:
                return {"error": "locate 操作需要提供 image_path 参数（参考图片路径）"}
            if not Path(image_path).is_file():
                return {"error": f"参考图片不存在: {image_path}"}
            try:
                location = pag.locateOnScreen(image_path, confidence=confidence)
            except (TypeError, NotImplementedError):
                return {"error": "图像定位需要 opencv，当前运行环境没有它（要用户自行安装）。"
                                 "请改用坐标或窗口标题定位，并把缺 opencv 这件事告诉用户，不要自行执行安装命令。"}
            if location is None:
                return {"status": "not_found", "message": "未在屏幕上找到匹配的图片", "elapsed_ms": int((time.perf_counter() - started) * 1000)}
            center = pag.center(location)
            return {
                "status": "ok",
                "x": center.x,
                "y": center.y,
                "width": location.width,
                "height": location.height,
                "message": f"已定位到 ({center.x}, {center.y})",
                "elapsed_ms": int((time.perf_counter() - started) * 1000),
            }

        return {"error": f"未知操作: {action}，可选: {_ACTIONS}"}

    except Exception as e:
        return {"error": f"桌面操作失败 ({action}): {e}"}
