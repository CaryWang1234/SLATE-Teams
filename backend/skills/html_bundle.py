# -*- coding: utf-8 -*-
"""
html_bundle — 便携网页打包 工具（零依赖，仅标准库）。

改编自外部项目 hyperbinder：将一个 html 页面及其相对路径引用的
css / js 合并为单个 html 文件，便于单文件分发与双击打开。

规则：
  * 相对路径的 <link rel="stylesheet"> 内联为 <style>，
    CSS 内的相对 url()/@import 重写为相对 HTML 的路径；
  * 相对路径的 <script src> 内联为 <script>，对 </script 做转义；
  * CDN / 绝对路径 / 协议相对链接保留外链并给出警告；
  * 图片、字体等二进制资源不转 data URI：输出文件需与资源保持相对位置，
    因此缺省输出到源 html 同目录。
"""

from __future__ import annotations

import html as html_mod
import os
import re
from pathlib import Path
from typing import Any

from backend.skills.call_ctx import CallCancelled, CallContext

# 按文档出现顺序同时匹配 <link ...> 标签与完整 <script>...</script> 元素
TAG_RE = re.compile(
    r"<link\b[^>]*>"
    r"|<script\b[^>]*?>.*?</script\s*>",
    re.I | re.S,
)
SCRIPT_OPEN_RE = re.compile(r"<script\b[^>]*>", re.I)
SRC_ATTR_RE = re.compile(r"\ssrc\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)
ATTR_RE = re.compile(
    r"([^\s=/]+)\s*(?:=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+)))?"
)
META_CHARSET_RE = re.compile(r"(<meta[^>]*charset\s*=\s*[\"']?)[^\"'>;\s]+", re.I)
URL_RE = re.compile(r"""url\(\s*(['"]?)([^'")]*?)\1\s*\)""", re.I)
IMPORT_STR_RE = re.compile(r"""@import\s+(['"])([^'"]+)\1""", re.I)
SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]*:")


def _posix(path: str) -> str:
    """统一展示/输出用正斜杠路径。"""
    return path.replace(os.sep, "/")


def _read_text_auto(path: str) -> tuple[str, str]:
    """读取文本：优先 utf-8(带 BOM)，失败回退 gbk。返回 (text, encoding)。"""
    with open(path, "rb") as f:
        raw = f.read()
    for enc in ("utf-8-sig", "gbk"):
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace"), "utf-8"


def _parse_attrs(open_tag: str) -> dict[str, str]:
    """粗解析标签属性，键小写，值做 HTML 实体反转义。"""
    attrs = {}
    body = open_tag[open_tag.find(" ") + 1:] if " " in open_tag else ""
    body = body.rstrip("/>").rstrip()
    for m in ATTR_RE.finditer(body):
        key = m.group(1).lower()
        val = m.group(2) if m.group(2) is not None else (
            m.group(3) if m.group(3) is not None else m.group(4))
        attrs[key] = html_mod.unescape(val) if val is not None else ""
    return attrs


def _classify_href(href: str) -> tuple[str, str]:
    """判定引用类型。返回 ('relative', '') 或 ('external'/'skip', 原因)。"""
    h = (href or "").strip().replace("\\", "/")
    if not h or h.startswith("#") or h.startswith("?"):
        return "skip", "片段/查询引用"
    if SCHEME_RE.match(h):
        return "external", "scheme/CDN 链接"
    if h.startswith("//"):
        return "external", "协议相对链接"
    if h.startswith("/"):
        return "external", "根绝对路径"
    return "relative", ""


def _url_to_path(url: str) -> str:
    """去掉查询串与片段，得到可落盘的相对路径。"""
    return url.strip().replace("\\", "/").split("#")[0].split("?")[0]


def _rel_to_html(html_dir: str, base_dir: str, target: str) -> tuple[str, str]:
    """把相对 base_dir 的资源路径换算为相对 html_dir 的 posix 路径。"""
    abs_path = os.path.normpath(os.path.join(base_dir, target.replace("/", os.sep)))
    return _posix(os.path.relpath(abs_path, html_dir)), abs_path


class _Report:
    def __init__(self) -> None:
        self.inlined: list[tuple[str, str, int]] = []
        self.kept: list[tuple[str, str, str]] = []
        self.warnings: list[str] = []
        self.assets: list[str] = []
        self.src_bytes = 0
        self.inlined_bytes = 0
        self.out_bytes = 0

    def add_asset(self, display: str) -> None:
        if display not in self.assets:
            self.assets.append(display)


def _rewrite_url_target(target: str, css_dir: str, html_dir: str, report: _Report, context: str) -> str:
    """重写单个 url()/@import 目标；相对路径换算为相对 HTML 的路径。"""
    t = target.strip()
    kind, _ = _classify_href(t)
    if kind in ("skip", "external"):
        return target
    path = _url_to_path(t)
    display, abs_path = _rel_to_html(html_dir, css_dir, path)
    report.add_asset(display)
    if not os.path.isfile(abs_path):
        report.warnings.append(f"{context} 引用的资源缺失（路径已重写，仍可能 404）: {display}")
    return display


def _rewrite_css(css_text: str, css_dir: str, html_dir: str, report: _Report, display: str) -> str:
    """把 CSS 内相对 url() 与 @import 字符串形式重写为相对 HTML 的路径。"""
    context = f"样式表 {display}"

    def url_sub(m: re.Match) -> str:
        quote, target = m.group(1), m.group(2)
        new = _rewrite_url_target(target, css_dir, html_dir, report, context)
        return f"url({quote}{new}{quote})"

    def import_sub(m: re.Match) -> str:
        quote, target = m.group(1), m.group(2)
        new = _rewrite_url_target(target, css_dir, html_dir, report, context)
        if new != target:
            report.warnings.append(f"样式表 {display} 的 @import 仍为外部请求（路径已重写）: {new}")
        return f"@import {quote}{new}{quote}"

    css_text = URL_RE.sub(url_sub, css_text)
    css_text = IMPORT_STR_RE.sub(import_sub, css_text)
    return css_text


def _read_resource(abs_path: str, kind: str, href: str, report: _Report) -> str | None:
    """读取待内联资源；缺失时记录警告并返回 None。"""
    if not os.path.isfile(abs_path):
        report.warnings.append(f"{kind} 引用的文件不存在，保留原标签: {href}")
        report.kept.append((kind, href, "文件缺失"))
        return None
    text, enc = _read_text_auto(abs_path)
    if enc.lower().replace("-", "") not in ("utf8", "utf8sig"):
        report.warnings.append(f"{kind} 使用 {enc} 编码，已按该编码读取并转为 utf-8: {href}")
    return text


def _handle_link(tag: str, html_dir: str, report: _Report) -> str:
    attrs = _parse_attrs(tag)
    href = attrs.get("href")
    if href is None:
        return tag
    rel = (attrs.get("rel") or "").lower()
    kind, reason = _classify_href(href)
    if "stylesheet" not in rel.split():
        if kind == "relative":
            report.kept.append(("link", href, "非 stylesheet，不内联"))
        return tag
    if kind != "relative":
        report.kept.append(("link", href, reason))
        return tag
    display, abs_path = _rel_to_html(html_dir, html_dir, _url_to_path(href))
    css_text = _read_resource(abs_path, "link", href, report)
    if css_text is None:
        return tag
    css_text = _rewrite_css(css_text, os.path.dirname(abs_path), html_dir, report, display)
    css_text = re.sub(r"</style", r"<\\/style", css_text, flags=re.I)
    size = os.path.getsize(abs_path)
    report.inlined_bytes += size
    report.inlined.append(("style", display, size))
    return f'<style data-hyperbinder-src="{html_mod.escape(display, quote=True)}">{css_text}</style>'


def _handle_script(tag: str, html_dir: str, report: _Report) -> str:
    open_tag = SCRIPT_OPEN_RE.match(tag).group(0)
    attrs = _parse_attrs(open_tag)
    src = attrs.get("src")
    if src is None:
        return tag  # 纯内联脚本原样保留
    kind, reason = _classify_href(src)
    if kind != "relative":
        report.kept.append(("script", src, reason))
        return tag
    display, abs_path = _rel_to_html(html_dir, html_dir, _url_to_path(src))
    js_text = _read_resource(abs_path, "script", src, report)
    if js_text is None:
        return tag
    js_text = re.sub(r"</script", r"<\\/script", js_text, flags=re.I)
    new_open = SRC_ATTR_RE.sub("", open_tag, count=1).rstrip()
    if new_open.endswith("/>"):
        new_open = new_open[:-2]
    elif new_open.endswith(">"):
        new_open = new_open[:-1]
    new_open += f' data-hyperbinder-src="{html_mod.escape(display, quote=True)}">'
    size = os.path.getsize(abs_path)
    report.inlined_bytes += size
    report.inlined.append(("script", display, size))
    return new_open + js_text + "</script>"


def _tag_ref(tag: str) -> str:
    """取标签上的 href/src，用于逐资源进度文案。"""
    m = re.search(r"""\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""", tag, re.I)
    if not m:
        return ""
    return m.group(1) or m.group(2) or m.group(3) or ""


def _bundle(src: str, out: str | None = None, ctx: CallContext | None = None) -> tuple[str, _Report]:
    """打包入口。返回 (输出路径, Report)。失败抛 ValueError，用户取消抛 CallCancelled。"""
    src = os.path.abspath(src)
    if not os.path.isfile(src):
        raise ValueError(f"源文件不存在: {src}")
    if out is None:
        root, _ = os.path.splitext(src)
        out = root + ".bundled.html"
    out = os.path.abspath(out)
    if out == src:
        raise ValueError("输出路径不能与源文件相同")

    html_dir = os.path.dirname(src)
    text, enc = _read_text_auto(src)
    if enc.lower().replace("-", "") not in ("utf8", "utf8sig"):
        # 非 utf-8 源：转码后同步修正 charset 声明，避免浏览器按旧编码解析
        text = META_CHARSET_RE.sub(r"\1utf-8", text)

    report = _Report()
    report.src_bytes = os.path.getsize(src)

    pieces, pos = [], 0
    matches = list(TAG_RE.finditer(text))
    total = len(matches)
    done = 0
    out_bytes = 0
    for m in matches:
        pieces.append(text[pos:m.start()])
        tag = m.group(0)
        inlined_before = len(report.inlined)
        if tag.lower().startswith("<link"):
            pieces.append(_handle_link(tag, html_dir, report))
        else:
            pieces.append(_handle_script(tag, html_dir, report))
        pos = m.end()
        done += 1
        if ctx is not None:
            if ctx.cancelled:
                raise CallCancelled()  # 尚未写出文件，取消不留半成品
            ref = _tag_ref(tag)
            verdict = "内联" if len(report.inlined) > inlined_before else "保留外链"
            ctx.progress(progress=done, total=total, message=f"{ref} · {verdict}")
            chunk = f"[{done}/{total}] {verdict} {ref}"
            ctx.output(chunk, stream="log", offset=out_bytes)
            out_bytes += len(chunk.encode("utf-8")) + 1
    pieces.append(text[pos:])
    result = "".join(pieces)

    out_dir = os.path.dirname(out)
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    if os.path.normcase(out_dir) != os.path.normcase(html_dir):
        report.warnings.append(
            "输出目录与源 html 不同目录：未内联的相对资源（图片/字体等）不会跟随，"
            "可能无法显示；建议输出到源同目录或自行拷贝资源。")

    with open(out, "wb") as f:
        f.write(result.encode("utf-8"))
    report.out_bytes = os.path.getsize(out)
    return out, report


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def execute(src: str = "", out: str = "", **_kwargs) -> dict[str, Any]:
    """将 html 及其相对路径引用的 css/js 合并为单个 html 文件（一次性返回）。

    参数：
    - src : 源 html 文件路径（必填）
    - out : 输出路径（可选，缺省为源同目录 <原名>.bundled.html；
            建议保持同目录，图片/字体等未内联资源依赖相对位置）
    """
    return _run(src, out)


def run_stream(ctx: CallContext, **params: Any) -> dict[str, Any]:
    """流式打包：逐资源报进度与去向；关流即停，且不写出文件。"""
    return _run(params.get("src", ""), params.get("out", ""), ctx)


def _run(src: Any, out: Any, ctx: CallContext | None = None) -> dict[str, Any]:
    src_path = str(src or "").strip()
    if not src_path:
        return {"error": "缺少 src 参数：请提供源 html 文件路径"}
    src_path = os.path.expanduser(src_path)
    out_path = os.path.expanduser(str(out or "").strip()) if str(out or "").strip() else None

    try:
        out_file, report = _bundle(src_path, out_path, ctx)
    except CallCancelled:
        return {"message": "cancelled", "cancelled": True, "note": "用户中途取消，未写出打包文件"}
    except (ValueError, OSError) as e:
        return {"error": f"打包失败: {e}"}

    n_css = sum(1 for k, _, _ in report.inlined if k == "style")
    n_js = sum(1 for k, _, _ in report.inlined if k == "script")
    return {
        "message": "ok",
        "file_path": out_file,
        "inlined_styles": n_css,
        "inlined_scripts": n_js,
        "kept_external": [
            {"type": kind, "href": href, "reason": reason}
            for kind, href, reason in report.kept
        ],
        "relative_assets": report.assets,
        "warnings": report.warnings,
        "size_before": report.src_bytes + report.inlined_bytes,
        "size_after": report.out_bytes,
    }
