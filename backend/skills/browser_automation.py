"""技能：浏览器自动化（基于 Playwright）。

支持动作：
- launch: 启动浏览器（headless=True/False）
- navigate: 导航到指定 URL
- screenshot: 截取当前页面或指定元素截图
- click: 点击页面元素（CSS 选择器）
- type: 在输入框中输入文字
- get_text: 获取页面/元素的文本内容
- get_html: 获取页面 HTML
- evaluate: 执行 JavaScript 表达式
- scroll: 滚动页面
- wait: 等待元素出现
- close: 关闭浏览器

浏览器实例在多次调用间保持活跃，便于连续操作。
"""

from __future__ import annotations

import concurrent.futures
import os
import tempfile
import time
from pathlib import Path
from typing import Any

# ── 模块级浏览器状态（跨调用保持活跃） ──────────────

_browser = None       # Playwright browser 实例
_context = None       # BrowserContext
_page = None          # 当前 Page
_playwright = None    # Playwright 实例
_headless = True

# Playwright 同步 API 禁止在运行中的 asyncio 事件循环线程内调用（MCP/技能主路径都在循环内），
# 所有浏览器操作统一提交到该独立工作线程执行，跨调用状态由该线程保持
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="slate-browser")


def _ensure_browser() -> Any:
    """确保浏览器已启动，返回当前 page。"""
    global _browser, _context, _page, _playwright
    if _page is not None:
        return _page
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise RuntimeError(
            "playwright 未安装，浏览器自动化这项能力当前不可用"
            "（缺的是 SLATE 运行环境的依赖，需要用户在终端里装 playwright 与 chromium）。"
            "请把缺依赖的情况告诉用户，不要自行执行安装命令。"
        )
    _playwright = sync_playwright().start()
    _browser = _playwright.chromium.launch(headless=_headless)
    _context = _browser.new_context(
        viewport={"width": 1280, "height": 800},
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    )
    _page = _context.new_page()
    return _page


def _screenshot_path(name: str = "") -> str:
    """生成截图保存路径。"""
    tmp = Path(tempfile.gettempdir()) / "slate_browser"
    tmp.mkdir(parents=True, exist_ok=True)
    ts = int(time.time() * 1000)
    fname = f"{name or 'screenshot'}_{ts}.png"
    return str(tmp / fname)


def _execute_sync(
    action: str = "",
    url: str = "",
    selector: str = "",
    text: str = "",
    expression: str = "",
    headless: bool = True,
    screenshot_name: str = "",
    full_page: bool = False,
    timeout: int = 30000,
    **_kw: Any,
) -> dict[str, Any]:
    """浏览器自动化实际实现（在独立工作线程内执行，规避同步 Playwright 与 asyncio 冲突）。

    Args:
        action: 操作类型 - launch/navigate/screenshot/click/type/get_text/get_html/evaluate/scroll/wait/close
        url: 导航目标 URL（action=navigate 时必填）
        selector: CSS 选择器（click/type/get_text/wait 时使用）
        text: 输入文字（action=type 时必填）
        expression: JavaScript 表达式（action=evaluate 时必填）
        headless: 是否无头模式（action=launch 时生效，默认 True）
        screenshot_name: 截图文件名前缀（可选）
        full_page: 是否全页截图（默认 False，只截可视区域）
        timeout: 操作超时毫秒数（默认 30000）

    Returns:
        dict: 操作结果。
    """
    global _headless, _browser, _context, _page, _playwright

    if not action:
        return {"error": "action 不能为空，可选: launch/navigate/screenshot/click/type/get_text/get_html/evaluate/scroll/wait/close"}

    # ── launch: 启动/重启浏览器 ──────────────────────
    if action == "launch":
        # 先关闭已有实例（包括 playwright driver）
        if _browser:
            try:
                _browser.close()
            except Exception:
                pass
        if _playwright:
            try:
                _playwright.stop()
            except Exception:
                pass
        _browser = _context = _page = _playwright = None
        _headless = headless
        page = _ensure_browser()
        return {
            "status": "ok",
            "message": f"浏览器已启动（headless={headless}）",
            "url": page.url,
        }

    # ── close: 关闭浏览器 ──────────────────────────
    if action == "close":
        if _browser:
            try:
                _browser.close()
            except Exception:
                pass
        if _playwright:
            try:
                _playwright.stop()
            except Exception:
                pass
        _browser = _context = _page = _playwright = None
        return {"status": "ok", "message": "浏览器已关闭"}

    # ── 以下操作需要浏览器已启动 ──────────────────────
    try:
        page = _ensure_browser()
    except RuntimeError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"浏览器启动失败: {e}"}

    try:
        # ── navigate ─────────────────────────────────
        if action == "navigate":
            if not url:
                return {"error": "navigate 操作需要提供 url 参数"}
            page.goto(url, timeout=timeout, wait_until="domcontentloaded")
            return {
                "status": "ok",
                "url": page.url,
                "title": page.title(),
            }

        # ── screenshot ───────────────────────────────
        if action == "screenshot":
            path = _screenshot_path(screenshot_name)
            if selector:
                el = page.query_selector(selector)
                if not el:
                    return {"error": f"未找到元素: {selector}"}
                el.screenshot(path=path)
            else:
                page.screenshot(path=path, full_page=full_page)
            # 生成合法的 file URL（Windows 路径需转换为正斜杠）
            preview_url = Path(path).as_uri()
            return {
                "status": "ok",
                "screenshot_path": path,
                "preview_url": preview_url,
            }

        # ── click ────────────────────────────────────
        if action == "click":
            if not selector:
                return {"error": "click 操作需要提供 selector 参数"}
            page.click(selector, timeout=timeout)
            return {"status": "ok", "message": f"已点击: {selector}"}

        # ── type ─────────────────────────────────────
        if action == "type":
            if not selector:
                return {"error": "type 操作需要提供 selector 参数"}
            if not text:
                return {"error": "type 操作需要提供 text 参数"}
            page.fill(selector, text, timeout=timeout)
            return {"status": "ok", "message": f"已输入文字到: {selector}"}

        # ── get_text ─────────────────────────────────
        if action == "get_text":
            if selector:
                el = page.query_selector(selector)
                if not el:
                    return {"error": f"未找到元素: {selector}"}
                txt = el.inner_text()
            else:
                txt = page.inner_text("body")
            return {"status": "ok", "text": txt[:5000] if txt else ""}

        # ── get_html ─────────────────────────────────
        if action == "get_html":
            if selector:
                el = page.query_selector(selector)
                if not el:
                    return {"error": f"未找到元素: {selector}"}
                html = el.inner_html()
            else:
                html = page.content()
            return {"status": "ok", "html": html[:20000] if html else ""}

        # ── evaluate ─────────────────────────────────
        if action == "evaluate":
            if not expression:
                return {"error": "evaluate 操作需要提供 expression 参数"}
            result = page.evaluate(expression)
            return {"status": "ok", "result": result}

        # ── scroll ───────────────────────────────────
        if action == "scroll":
            # 默认向下滚动 500px
            delta = int(text) if text else 500
            page.mouse.wheel(0, delta)
            return {"status": "ok", "message": f"已滚动 {delta}px"}

        # ── wait ─────────────────────────────────────
        if action == "wait":
            if not selector:
                return {"error": "wait 操作需要提供 selector 参数"}
            page.wait_for_selector(selector, timeout=timeout, state="visible")
            return {"status": "ok", "message": f"元素已出现: {selector}"}

        return {"error": f"未知操作: {action}，可选: launch/navigate/screenshot/click/type/get_text/get_html/evaluate/scroll/wait/close"}

    except Exception as e:
        return {"error": f"浏览器操作失败 ({action}): {e}"}


def execute(
    action: str = "",
    url: str = "",
    selector: str = "",
    text: str = "",
    expression: str = "",
    headless: bool = True,
    screenshot_name: str = "",
    full_page: bool = False,
    timeout: int = 30000,
    **_kw: Any,
) -> dict[str, Any]:
    """浏览器自动化工具（入口）。通过 Playwright 控制 Chromium 浏览器。

    实际操作提交到独立工作线程执行：同步 Playwright 在运行中的 asyncio 事件循环
    线程内直接调用会抛异常，而 MCP/技能主调用路径均在循环内。

    Args:
        action: 操作类型 - launch/navigate/screenshot/click/type/get_text/get_html/evaluate/scroll/wait/close
        url: 导航目标 URL（action=navigate 时必填）
        selector: CSS 选择器（click/type/get_text/wait 时使用）
        text: 输入文字（action=type 时必填）
        expression: JavaScript 表达式（action=evaluate 时必填）
        headless: 是否无头模式（action=launch 时生效，默认 True）
        screenshot_name: 截图文件名前缀（可选）
        full_page: 是否全页截图（默认 False，只截可视区域）
        timeout: 操作超时毫秒数（默认 30000）

    Returns:
        dict: 操作结果。
    """
    wait_s = max(90, timeout / 1000 + 60)
    try:
        return _executor.submit(
            _execute_sync, action=action, url=url, selector=selector, text=text,
            expression=expression, headless=headless, screenshot_name=screenshot_name,
            full_page=full_page, timeout=timeout, **_kw,
        ).result(timeout=wait_s)
    except concurrent.futures.TimeoutError:
        return {"error": "浏览器操作超时（执行线程仍在后台运行，请稍后重试）"}
    except Exception as e:
        return {"error": f"浏览器操作失败: {e}"}
