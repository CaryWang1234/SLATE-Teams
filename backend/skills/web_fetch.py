"""工具：获取网页内容。抓取 URL 并提取标题/描述/正文，支持 JS 渲染与 PDF。

参数:
- url       : 完整的 http(s) URL
- mode      : text（默认，提取正文纯文本/Markdown）/ html（返回原始 HTML）
- max_chars : 内容截断长度（默认 20000，上限 60000）
- render_js : auto（默认，直连失败或正文过短时自动用无头浏览器渲染）/ on（强制渲染）/ off（永不渲染）

实现：
1. httpx 直连抓取（支持重定向与编码处理）
2. 正文提取优先 trafilatura（Markdown 保留列表/表格结构），未安装或失败时降级为正则提取
3. PDF 通过 pdfplumber 提取文本
4. 疑似 JS 渲染页面（正文过短/直连失败）自动降级到 Playwright 无头浏览器渲染后重新提取
"""

from __future__ import annotations

import html as html_mod
import io
import re
from typing import Any

import httpx

DEFAULT_MAX_CHARS = 20000
MAX_CHARS_LIMIT = 60000
MIN_READABLE_CHARS = 300
TIMEOUT = 20.0
RENDER_WAIT_MS = 1500
RENDER_TIMEOUT_MS = 20000
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def execute(
    url: str = "",
    mode: str = "text",
    max_chars: int = DEFAULT_MAX_CHARS,
    render_js: str = "auto",
    **_: Any,
) -> dict[str, Any]:
    """抓取网页并返回标题/描述/正文。"""
    url = (url or "").strip()
    if not url:
        return {"error": "url 不能为空"}
    if not re.match(r"^https?://", url, re.I):
        return {"error": "需要完整的 http(s) URL"}
    render_mode = (render_js or "auto").strip().lower()
    if render_mode not in ("auto", "on", "off"):
        render_mode = "auto"

    try:
        limit = max(1000, min(int(max_chars or DEFAULT_MAX_CHARS), MAX_CHARS_LIMIT))
    except (TypeError, ValueError):
        limit = DEFAULT_MAX_CHARS

    # ── 直连抓取 ──────────────────────────────────
    fetch_error: Exception | None = None
    try:
        resp = httpx.get(url, headers=HEADERS, timeout=TIMEOUT, follow_redirects=True)
        resp.raise_for_status()
        final_url = str(resp.url)
        content_type = resp.headers.get("content-type", "").lower()
    except Exception as e:
        fetch_error = e
        final_url = url
        content_type = ""
        resp = None

    # PDF：直连成功且命中 PDF
    if resp is not None and ("pdf" in content_type or url.lower().split("?")[0].endswith(".pdf")):
        return _extract_pdf(resp.content, final_url, limit)

    # 非 HTML 直连成功：直接返回文本
    if resp is not None and not _looks_like_html(content_type, resp.text):
        truncated = len(resp.text) > limit
        return {
            "url": final_url,
            "title": "",
            "render_used": False,
            "truncated": truncated,
            "text_length": len(resp.text),
            "content": resp.text[:limit],
        }

    # ── HTML 提取 ─────────────────────────────────
    if resp is not None:
        result = _extract_page(resp.text, final_url, mode, limit)
        if result is not None:
            # 强制渲染（on）或疑似 JS 渲染页（auto：HTML 大但可见文本少）→ 渲染降级
            if render_mode == "on" or (render_mode == "auto" and _should_render(resp.text, result.get("text_length", 0))):
                rendered = _render_with_playwright(url)
                if rendered:
                    r = _extract_page(rendered, final_url, mode, limit)
                    if r is not None:
                        r["render_used"] = True
                        return r
            result["render_used"] = False
            return result

    # 直连失败或内容不可用：渲染降级
    if render_mode != "off" and (render_mode == "on" or fetch_error is not None):
        rendered = _render_with_playwright(url)
        if rendered:
            result = _extract_page(rendered, final_url, mode, limit)
            if result is not None:
                result["render_used"] = True
                return result

    if fetch_error is not None:
        return {"error": f"抓取失败: {fetch_error}"}
    return {"error": "无法提取页面内容（可能是空页面或需要登录）"}


# ── 内容类型判断 ──────────────────────────────────


def _looks_like_html(content_type: str, text: str) -> bool:
    if "html" in content_type or "xml" in content_type:
        return True
    stripped = (text or "").lstrip().lower()
    return stripped.startswith("<!doctype html") or stripped.startswith("<html")


def _should_render(html_text: str, extracted_len: int) -> bool:
    """HTML 体量不小但提取出的正文过短 → 大概率是 JS 动态渲染页。"""
    return len(html_text) > 10000 and extracted_len < MIN_READABLE_CHARS


# ── 页面提取 ──────────────────────────────────────


def _extract_page(html_text: str, final_url: str, mode: str, limit: int) -> dict[str, Any] | None:
    title = _extract_title(html_text)
    description = _extract_meta_description(html_text)

    if mode == "html":
        body = html_text
    else:
        body = _extract_readable(html_text)

    if body is None:
        return None

    truncated = len(body) > limit
    return {
        "url": final_url,
        "title": title,
        "description": description,
        "truncated": truncated,
        "text_length": len(body),
        "content": body[:limit],
    }


def _extract_readable(html_text: str) -> str | None:
    """正文提取：trafilatura 优先（保留 Markdown 结构），失败降级正则。"""
    trafilatura_text = _extract_via_trafilatura(html_text)
    if trafilatura_text and len(trafilatura_text) >= MIN_READABLE_CHARS:
        return trafilatura_text

    fallback = _html_to_text(html_text)
    if fallback:
        return fallback
    return None


def _extract_via_trafilatura(html_text: str) -> str:
    try:
        import trafilatura
    except ImportError:
        return ""
    try:
        return (trafilatura.extract(
            html_text,
            output_format="markdown",
            include_comments=False,
            include_tables=True,
            include_links=False,
        ) or "").strip()
    except Exception:
        return ""


# ── PDF 提取 ─────────────────────────────────────


def _extract_pdf(data: bytes, final_url: str, limit: int) -> dict[str, Any]:
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            pages = []
            for page in pdf.pages:
                text = page.extract_text() or ""
                if text.strip():
                    pages.append(text)
            body = "\n\n".join(pages)
    except Exception as e:
        return {"error": f"PDF 解析失败: {e}"}
    truncated = len(body) > limit
    return {
        "url": final_url,
        "title": "",
        "description": "",
        "render_used": False,
        "truncated": truncated,
        "text_length": len(body),
        "content": body[:limit],
    }


# ── Playwright 渲染降级 ───────────────────────────


def _render_with_playwright(url: str) -> str | None:
    """用无头浏览器渲染页面并返回渲染后的 HTML；不可用时返回 None。

    同步 Playwright 禁止在运行中的 asyncio 事件循环线程内调用（MCP 主调用路径在循环内），
    因此实际渲染提交到一次性工作线程执行。
    """
    import concurrent.futures
    wait_s = (RENDER_TIMEOUT_MS + RENDER_WAIT_MS) / 1000 + 60
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="slate-render") as pool:
            return pool.submit(_render_with_playwright_sync, url).result(timeout=wait_s)
    except Exception:
        return None


def _render_with_playwright_sync(url: str) -> str | None:
    """实际渲染（工作线程内执行）。"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None
    playwright = None
    browser = None
    try:
        playwright = sync_playwright().start()
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(
            user_agent=HEADERS["User-Agent"],
            locale="zh-CN",
        )
        page.goto(url, wait_until="domcontentloaded", timeout=RENDER_TIMEOUT_MS)
        page.wait_for_timeout(RENDER_WAIT_MS)
        return page.content()
    except Exception:
        return None
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
        if playwright is not None:
            try:
                playwright.stop()
            except Exception:
                pass


# ── 提取 ──────────────────────────────────────


def _extract_title(html: str) -> str:
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", html)
    return _clean_text(m.group(1)) if m else ""


def _extract_meta_description(html: str) -> str:
    m = re.search(
        r'(?is)<meta[^>]*name=["\']description["\'][^>]*content=["\'](.*?)["\']',
        html,
    ) or re.search(
        r'(?is)<meta[^>]*content=["\'](.*?)["\'][^>]*name=["\']description["\']',
        html,
    ) or re.search(
        r'(?is)<meta[^>]*property=["\']og:description["\'][^>]*content=["\'](.*?)["\']',
        html,
    )
    return _clean_text(m.group(1)) if m else ""


def _html_to_text(html: str) -> str:
    """HTML → 纯文本：移除脚本样式与标签，保留段落结构，压缩空白。"""
    html = re.sub(r"(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?is)<br\s*/?>|</p>|</div>|</li>|</tr>|</h[1-6]>|</section>|</article>", "\n", html)
    text = re.sub(r"(?s)<[^>]+>", " ", html)
    text = html_mod.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def _clean_text(raw: str) -> str:
    return html_mod.unescape(re.sub(r"(?s)<[^>]+>", "", raw or "")).strip()
