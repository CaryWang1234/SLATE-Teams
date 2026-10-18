"""工具：网络搜索与网页抓取（Bing + DuckDuckGo 双引擎，免 API Key），让模型获取实时数据。

mode:
- search：关键词搜索，返回标题/链接/摘要
- fetch ：抓取 query 指定的 URL 正文（纯文本，截断至 8000 字符；精读请优先用 web_fetch）

engine:
- auto（默认）：并发 Bing + DuckDuckGo 搜索，合并去重，结果更全更准
- bing：仅 Bing（中文结果质量好）
- ddg ：仅 DuckDuckGo

实现：Bing 通过 HTML 端点正则解析；DuckDuckGo 优先使用 ddgs 库，未安装时降级为
httpx 直连 HTML 端点解析。
"""

from __future__ import annotations

import base64
import concurrent.futures
import html as html_mod
import re
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse

import httpx

DEFAULT_RESULTS = 5
MAX_RESULTS = 10
FETCH_MAX_CHARS = 8000
TIMEOUT = 15.0
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def execute(
    query: str = "",
    mode: str = "search",
    max_results: int = DEFAULT_RESULTS,
    engine: str = "auto",
    **_: Any,
) -> dict[str, Any]:
    """执行网络搜索或网页抓取。"""
    query = (query or "").strip()
    if not query:
        return {"error": "query 不能为空"}

    if mode == "fetch":
        return _fetch(query)

    try:
        limit = max(1, min(int(max_results or DEFAULT_RESULTS), MAX_RESULTS))
    except (TypeError, ValueError):
        limit = DEFAULT_RESULTS

    engine_mode = (engine or "auto").strip().lower()
    if engine_mode not in ("auto", "bing", "ddg"):
        engine_mode = "auto"
    return _search(query, limit, engine_mode)


# ── 搜索 ──────────────────────────────────────


def _search(query: str, limit: int, engine: str) -> dict[str, Any]:
    if engine == "bing":
        results = _search_via_bing(query, limit)
        if not results:
            return {"error": "Bing 未获得搜索结果（网络异常或请求被限流），请稍后重试"}
        return {"query": query, "engine": "bing", "count": len(results), "results": results}

    if engine == "ddg":
        results = _search_via_ddgs(query, limit)
        if not results:
            return {"error": "DuckDuckGo 未获得搜索结果（网络异常或请求被限流），请稍后重试"}
        return {"query": query, "engine": "ddg", "count": len(results), "results": results}

    # auto：并发双引擎，合并去重
    bing_results, ddg_results = _search_both(query, limit)
    merged = _merge_dedupe(bing_results, ddg_results)[:limit]
    if not merged:
        return {"error": "未获得搜索结果（网络异常或请求被限流），请稍后重试"}
    engines = []
    if bing_results:
        engines.append("bing")
    if ddg_results:
        engines.append("ddg")
    return {
        "query": query,
        "engine": "+".join(engines) or "none",
        "count": len(merged),
        "results": merged,
    }


def _search_both(query: str, limit: int) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """并发请求 Bing 与 DuckDuckGo，单引擎失败静默跳过。"""
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        bing_fut = pool.submit(_search_via_bing, query, limit)
        ddg_fut = pool.submit(_search_via_ddgs, query, limit)
        bing_results = bing_fut.result(timeout=TIMEOUT + 5) or []
        ddg_results = ddg_fut.result(timeout=TIMEOUT + 5) or []
    return bing_results, ddg_results


def _merge_dedupe(*lists: list[dict[str, str]]) -> list[dict[str, str]]:
    """多引擎结果按 URL 归一化去重，Bing 结果优先保留。"""
    seen: set[str] = set()
    merged: list[dict[str, str]] = []
    for items in lists:
        for item in items:
            url = item.get("url", "")
            if not url:
                continue
            key = _normalize_url(url)
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(item)
    return merged


def _normalize_url(url: str) -> str:
    """URL 归一化：去除常见跟踪参数与锚点，仅比较主路径与剩余参数键值。"""
    try:
        parsed = urlparse(url)
        pairs = []
        for k, vals in parse_qs(parsed.query, keep_blank_values=True).items():
            if k.lower().startswith(("utm_", "fbclid", "gclid", "ref", "source")):
                continue
            for v in vals:
                pairs.append(f"{k}={v}")
        clean_query = "&".join(pairs)
        path = parsed.path.rstrip("/") or "/"
        return f"{parsed.netloc.lower()}{path}?{clean_query}".rstrip("?")
    except Exception:
        return url.lower()


# ── Bing 搜索 ─────────────────────────────────


def _search_via_bing(query: str, limit: int) -> list[dict[str, str]]:
    """通过 cn.bing.com HTML 端点搜索并解析结果。"""
    url = f"https://cn.bing.com/search?q={quote(query)}&count={limit}&setlang=zh-hans"
    try:
        resp = httpx.get(url, headers=HEADERS, timeout=TIMEOUT, follow_redirects=True)
        resp.raise_for_status()
    except Exception:
        return []
    return _parse_bing_results(resp.text, limit)


def _parse_bing_results(html: str, limit: int) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    # 每个结果一个 <li class="b_algo"> 块；标题链接在 h2 a，摘要在 .b_caption p
    blocks = re.findall(r'(?is)<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>(.*?)</li>', html)
    for block in blocks:
        title_m = re.search(r'(?is)<h2[^>]*>.*?<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', block)
        if not title_m:
            continue
        url = _clean_bing_url(html_mod.unescape(title_m.group(1)))
        title = _clean_text(re.sub(r"(?s)<[^>]+>", "", title_m.group(2)))
        if not url or not title:
            continue
        snippet_m = re.search(r'(?is)<p[^>]*>(.*?)</p>', block)
        snippet = _clean_text(snippet_m.group(1)) if snippet_m else ""
        results.append({"title": title, "url": url, "snippet": snippet})
        if len(results) >= limit:
            break
    return results


def _clean_bing_url(href: str) -> str:
    """Bing 结果多为直接 URL；跳转链接（ck/a）解出 base64url 编码的真实地址。"""
    href = href.strip()
    if href.startswith("//"):
        href = "https:" + href
    parsed = urlparse(href)
    if "bing.com" in parsed.netloc and parsed.path.startswith("/ck/a"):
        encoded = parse_qs(parsed.query).get("u", [""])[0]
        # Bing 的 u 参数是 "a1" + base64url，先剥前缀再解码，否则 12bit 错位解出乱码
        if encoded.startswith("a1"):
            encoded = encoded[2:]
        if encoded:
            try:
                # base64url：补 padding 后解码
                padded = encoded + "=" * (-len(encoded) % 4)
                return unquote(base64.urlsafe_b64decode(padded).decode("utf-8", errors="replace"))
            except Exception:
                return href
    return href


# ── DuckDuckGo 搜索 ──────────────────────────


def _search_via_ddgs(query: str, limit: int) -> list[dict[str, str]]:
    """优先用 ddgs 库（兼容旧包名 duckduckgo_search）。"""
    ddgs_cls = None
    try:
        from ddgs import DDGS as ddgs_cls  # type: ignore
    except ImportError:
        try:
            from duckduckgo_search import DDGS as ddgs_cls  # type: ignore
        except ImportError:
            return []
    try:
        with ddgs_cls(headers=HEADERS) as ddgs:
            raw = list(ddgs.text(query, max_results=limit))
    except Exception:
        raw = []
    if not raw:
        return _search_via_http(query, limit)
    results = []
    for item in raw:
        url = item.get("href") or item.get("url") or ""
        if not url:
            continue
        results.append({
            "title": _clean_text(item.get("title", "")),
            "url": url,
            "snippet": _clean_text(item.get("body") or item.get("snippet", "")),
        })
    return results


def _search_via_http(query: str, limit: int) -> list[dict[str, str]]:
    """降级方案：直连 DuckDuckGo HTML 端点解析结果。"""
    try:
        resp = httpx.post(
            "https://html.duckduckgo.com/html/",
            data={"q": query},
            headers=HEADERS,
            timeout=TIMEOUT,
            follow_redirects=True,
        )
        resp.raise_for_status()
    except Exception:
        return []

    results = []
    anchors = re.findall(
        r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
        resp.text,
        re.S,
    )
    snippets = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', resp.text, re.S)
    for i, (href, title) in enumerate(anchors):
        url = _normalize_ddg_url(href)
        if not url:
            continue
        results.append({
            "title": _clean_text(title),
            "url": url,
            "snippet": _clean_text(snippets[i]) if i < len(snippets) else "",
        })
        if len(results) >= limit:
            break
    return results


def _normalize_ddg_url(href: str) -> str:
    """DDG 结果链接多为跳转形式，解出真实 URL。"""
    href = html_mod.unescape(href).strip()
    if href.startswith("//"):
        href = "https:" + href
    parsed = urlparse(href)
    if "duckduckgo.com" in parsed.netloc and parsed.path.startswith("/l/"):
        uddg = parse_qs(parsed.query).get("uddg", [""])[0]
        if uddg:
            return unquote(uddg)
    return href


# ── 网页抓取（fetch 模式，向后兼容） ──────────


def _fetch(url: str) -> dict[str, Any]:
    if not re.match(r"^https?://", url, re.I):
        return {"error": "fetch 模式需要完整的 http(s) URL"}
    try:
        resp = httpx.get(url, headers=HEADERS, timeout=TIMEOUT, follow_redirects=True)
        resp.raise_for_status()
    except Exception as e:
        return {"error": f"抓取失败: {e}"}

    content_type = resp.headers.get("content-type", "")
    if "html" not in content_type and "text" not in content_type:
        return {"error": f"不支持的内容类型: {content_type or '未知'}（精读网页请使用 web_fetch 工具）"}

    text = _html_to_text(resp.text)
    truncated = len(text) > FETCH_MAX_CHARS
    return {
        "url": str(resp.url),
        "truncated": truncated,
        "content": text[:FETCH_MAX_CHARS],
    }


def _html_to_text(html: str) -> str:
    """HTML → 纯文本：移除脚本样式与标签，压缩空白。"""
    html = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?is)<br\s*/?>|</p>|</div>|</li>|</h[1-6]>", "\n", html)
    text = re.sub(r"(?s)<[^>]+>", " ", html)
    text = html_mod.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def _clean_text(raw: str) -> str:
    return html_mod.unescape(re.sub(r"(?s)<[^>]+>", "", raw or "")).strip()
