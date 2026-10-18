# -*- coding: utf-8 -*-
"""
chart_create — 零依赖 SVG 图表生成 工具。

支持类型：
- bar  : 垂直柱状图
- hbar : 水平条形图
- line : 折线图
- pie  : 饼图（含图例）

data 支持三种写法：
1. JSON 数组：[{"label": "Q1", "value": 120}, ...]
2. JSON 对象：{"Q1": 120, "Q2": 90}
3. 纯文本  ："Q1:120, Q2:90" 或每行一条 "Q1:120"

输出落盘到数据目录 outputs/，返回 file_path 与 preview_url
（前端经 /api/files/output 提供内联预览）。
"""

from __future__ import annotations

import json
import math
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))

# 预设配色（与 ppt_create 风格呼应）
THEMES: dict[str, list[str]] = {
    "slate": ["#4a6fa5", "#6b8cae", "#8fa9c9", "#34557e", "#a8bfd7", "#2b4566", "#c3d3e4", "#1e3a5f"],
    "blue": ["#1f77b4", "#4292c6", "#6baed6", "#9ecae1", "#08519c", "#3182bd", "#c6dbef", "#08306b"],
    "green": ["#2d8659", "#4caf7d", "#74c69d", "#a3d9b1", "#1b5e3f", "#52b788", "#d8f3dc", "#0f3d2a"],
    "warm": ["#e07a5f", "#f2a541", "#d96c47", "#c9563a", "#f4a261", "#e76f51", "#ffd166", "#b5451b"],
    "gray": ["#5a5f6b", "#7c8290", "#9aa0ac", "#3d424d", "#b8bdc7", "#2a2e37", "#d5d9e0", "#17191f"],
}

AXIS_COLOR = "#8a8f98"
TEXT_COLOR = "#3a3f47"
TEXT_MUTED = "#8a8f98"
GRID_COLOR = "#e3e6ea"


def _esc(text: Any) -> str:
    """SVG 文本转义。"""
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _fmt_num(v: float) -> str:
    """数值标签格式化：整数去小数点。"""
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return f"{v:.2f}".rstrip("0").rstrip(".")


def _parse_data(raw: Any) -> list[dict[str, Any]]:
    """将 data 参数统一为 [{label, value}] 列表。"""
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict):
        items = [{"label": k, "value": v} for k, v in raw.items()]
    else:
        text = str(raw or "").strip()
        if not text:
            raise ValueError("data 不能为空")
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                items = [{"label": k, "value": v} for k, v in parsed.items()]
            elif isinstance(parsed, list):
                items = parsed
            else:
                raise ValueError("JSON 格式不支持")
        except (json.JSONDecodeError, ValueError):
            items = []
            for part in re.split(r"[,，\n]+", text):
                part = part.strip()
                if not part:
                    continue
                m = re.match(r"^(.+?)[:=：]\s*(-?[\d.]+)$", part)
                if not m:
                    raise ValueError(f"无法解析数据项: {part}（应为 标签:数值）")
                items.append({"label": m.group(1).strip(), "value": float(m.group(2))})

    result = []
    for it in items:
        if isinstance(it, dict):
            label = str(it.get("label", "")).strip() or f"项{len(result) + 1}"
            value = float(it.get("value", 0))
        else:
            raise ValueError(f"数据项格式不支持: {it}")
        result.append({"label": label, "value": value})
    if not result:
        raise ValueError("未解析到有效数据")
    return result[:24]  # 最多 24 项，防止图过挤


def _colors(theme: str, n: int) -> list[str]:
    """解析配色：预设名或逗号分隔色值列表，循环补足。"""
    theme = (theme or "slate").strip()
    if theme in THEMES:
        palette = THEMES[theme]
    else:
        customs = [c.strip() for c in theme.split(",") if re.match(r"^#?[0-9a-fA-F]{3,8}$", c.strip())]
        palette = [(c if c.startswith("#") else f"#{c}") for c in customs] or THEMES["slate"]
    return [palette[i % len(palette)] for i in range(n)]


def _svg_open(width: int, height: int, title: str) -> list[str]:
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="Segoe UI, Microsoft YaHei, sans-serif">',
        f'<rect width="{width}" height="{height}" fill="#ffffff"/>',
    ]
    if title:
        parts.append(f'<text x="{width / 2}" y="30" text-anchor="middle" font-size="17" '
                     f'font-weight="600" fill="{TEXT_COLOR}">{_esc(title)}</text>')
    return parts


def _render_bar(items: list[dict], colors: list[str], w: int, h: int) -> list[str]:
    parts = []
    top, bottom, left, right = 56, h - 40, 56, w - 20
    max_v = max(it["value"] for it in items)
    max_v = max_v if max_v > 0 else 1
    plot_h = bottom - top
    # 网格与刻度
    for i in range(5):
        v = max_v * i / 4
        y = bottom - plot_h * i / 4
        parts.append(f'<line x1="{left}" y1="{y:.1f}" x2="{right}" y2="{y:.1f}" stroke="{GRID_COLOR}" stroke-width="1"/>')
        parts.append(f'<text x="{left - 8}" y="{y + 4:.1f}" text-anchor="end" font-size="11" fill="{AXIS_COLOR}">{_fmt_num(v)}</text>')
    n = len(items)
    slot = (right - left) / n
    bar_w = min(slot * 0.62, 64)
    for i, it in enumerate(items):
        x = left + slot * i + (slot - bar_w) / 2
        bar_h = plot_h * max(it["value"], 0) / max_v
        y = bottom - bar_h
        parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{max(bar_h, 1):.1f}" rx="3" fill="{colors[i]}"/>')
        parts.append(f'<text x="{x + bar_w / 2:.1f}" y="{y - 6:.1f}" text-anchor="middle" font-size="11" fill="{TEXT_COLOR}">{_fmt_num(it["value"])}</text>')
        parts.append(f'<text x="{x + bar_w / 2:.1f}" y="{bottom + 18}" text-anchor="middle" font-size="11" fill="{AXIS_COLOR}">{_esc(it["label"][:10])}</text>')
    parts.append(f'<line x1="{left}" y1="{bottom}" x2="{right}" y2="{bottom}" stroke="{AXIS_COLOR}" stroke-width="1.2"/>')
    return parts


def _render_hbar(items: list[dict], colors: list[str], w: int, h: int) -> list[str]:
    parts = []
    top, bottom, left, right = 50, h - 20, 110, w - 70
    max_v = max(it["value"] for it in items)
    max_v = max_v if max_v > 0 else 1
    plot_w = right - left
    n = len(items)
    slot = (bottom - top) / n
    bar_h = min(slot * 0.62, 34)
    for i, it in enumerate(items):
        y = top + slot * i + (slot - bar_h) / 2
        bar_w = plot_w * max(it["value"], 0) / max_v
        parts.append(f'<text x="{left - 8}" y="{y + bar_h / 2 + 4:.1f}" text-anchor="end" font-size="12" fill="{TEXT_COLOR}">{_esc(it["label"][:10])}</text>')
        parts.append(f'<rect x="{left}" y="{y:.1f}" width="{max(bar_w, 1):.1f}" height="{bar_h:.1f}" rx="3" fill="{colors[i]}"/>')
        parts.append(f'<text x="{left + bar_w + 6:.1f}" y="{y + bar_h / 2 + 4:.1f}" font-size="11" fill="{AXIS_COLOR}">{_fmt_num(it["value"])}</text>')
    parts.append(f'<line x1="{left}" y1="{top}" x2="{left}" y2="{bottom}" stroke="{AXIS_COLOR}" stroke-width="1.2"/>')
    return parts


def _render_line(items: list[dict], colors: list[str], w: int, h: int) -> list[str]:
    parts = []
    top, bottom, left, right = 56, h - 40, 56, w - 24
    values = [it["value"] for it in items]
    lo, hi = min(values), max(values)
    if hi - lo < 1e-9:
        hi = lo + 1
    plot_h = bottom - top
    n = len(items)
    xs = [left + (right - left) * (i / (n - 1) if n > 1 else 0.5) for i in range(n)]
    ys = [bottom - plot_h * (v - lo) / (hi - lo) for v in values]
    # 网格与刻度
    for i in range(5):
        v = lo + (hi - lo) * i / 4
        y = bottom - plot_h * i / 4
        parts.append(f'<line x1="{left}" y1="{y:.1f}" x2="{right}" y2="{y:.1f}" stroke="{GRID_COLOR}" stroke-width="1"/>')
        parts.append(f'<text x="{left - 8}" y="{y + 4:.1f}" text-anchor="end" font-size="11" fill="{AXIS_COLOR}">{_fmt_num(v)}</text>')
    color = colors[0]
    points = " ".join(f"{x:.1f},{y:.1f}" for x, y in zip(xs, ys))
    parts.append(f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="2.4" stroke-linejoin="round"/>')
    for i, it in enumerate(items):
        parts.append(f'<circle cx="{xs[i]:.1f}" cy="{ys[i]:.1f}" r="4" fill="{color}"/>')
        parts.append(f'<text x="{xs[i]:.1f}" y="{ys[i] - 10:.1f}" text-anchor="middle" font-size="11" fill="{TEXT_COLOR}">{_fmt_num(it["value"])}</text>')
        parts.append(f'<text x="{xs[i]:.1f}" y="{bottom + 18}" text-anchor="middle" font-size="11" fill="{AXIS_COLOR}">{_esc(it["label"][:10])}</text>')
    parts.append(f'<line x1="{left}" y1="{bottom}" x2="{right}" y2="{bottom}" stroke="{AXIS_COLOR}" stroke-width="1.2"/>')
    return parts


def _render_pie(items: list[dict], colors: list[str], w: int, h: int) -> list[str]:
    parts = []
    total = sum(max(it["value"], 0) for it in items)
    if total <= 0:
        raise ValueError("饼图数据总和必须大于 0")
    cx, cy, r = (w - 180) / 2 + 20, (h + 30) / 2, min(h - 90, w - 260) / 2
    angle = -math.pi / 2
    for i, it in enumerate(items):
        frac = max(it["value"], 0) / total
        if frac <= 0:
            continue
        a2 = angle + frac * 2 * math.pi
        large = 1 if frac > 0.5 else 0
        x1, y1 = cx + r * math.cos(angle), cy + r * math.sin(angle)
        x2, y2 = cx + r * math.cos(a2), cy + r * math.sin(a2)
        if frac >= 0.9999:
            parts.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{colors[i]}"/>')
        else:
            parts.append(f'<path d="M {cx:.1f} {cy:.1f} L {x1:.1f} {y1:.1f} A {r:.1f} {r:.1f} 0 {large} 1 {x2:.1f} {y2:.1f} Z" fill="{colors[i]}"/>')
        angle = a2
    # 图例（右侧），最多显示 15 项避免溢出
    MAX_LEGEND = 15
    lx = w - 170
    legend_items = items[:MAX_LEGEND]
    ly = max(60, cy - len(legend_items) * 11)
    for i, it in enumerate(legend_items):
        pct = max(it["value"], 0) / total * 100
        y = ly + i * 22
        parts.append(f'<rect x="{lx}" y="{y - 9}" width="12" height="12" rx="2" fill="{colors[i]}"/>')
        parts.append(f'<text x="{lx + 18}" y="{y + 1}" font-size="11" fill="{TEXT_COLOR}">{_esc(it["label"][:8])} {_fmt_num(it["value"])} ({pct:.1f}%)</text>')
    if len(items) > MAX_LEGEND:
        parts.append(f'<text x="{lx + 18}" y="{ly + len(legend_items) * 22 + 1}" font-size="10" fill="{TEXT_MUTED}">…还有 {len(items) - MAX_LEGEND} 项</text>')
    return parts


def execute(data: Any = None, type: str = "bar", title: str = "", theme: str = "slate",
            width: int = 760, height: int = 430, file_name: str = "", output_dir: str = "", **_kwargs) -> dict[str, Any]:
    """生成 SVG 图表并落盘，返回文件路径与预览链接。"""
    if data is None or (isinstance(data, str) and not data.strip()):
        return {"message": "缺少 data 参数：支持 JSON 数组 [{label,value}]、JSON 对象 {标签:数值} 或文本 \"A:1, B:2\""}

    chart_type = (type or "bar").strip().lower()
    renderers = {"bar": _render_bar, "hbar": _render_hbar, "line": _render_line, "pie": _render_pie}
    if chart_type not in renderers:
        return {"message": f"不支持的图表类型: {chart_type}（可选 bar / hbar / line / pie）"}

    try:
        items = _parse_data(data)
    except (ValueError, TypeError) as e:
        return {"message": f"数据解析失败: {e}"}

    width = max(420, min(int(width or 760), 1600))
    height = max(300, min(int(height or 430), 1000))
    colors = _colors(theme, len(items))

    parts = _svg_open(width, height, title)
    try:
        parts.extend(renderers[chart_type](items, colors, width, height))
    except ValueError as e:
        return {"message": str(e)}
    parts.append("</svg>")

    out_dir = Path(output_dir.strip()) if (output_dir or "").strip() else DATA_DIR / "outputs"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_title = re.sub(r'[\\/:*?"<>|\s]+', "_", (title or "").strip())[:20] or chart_type
    fname = (file_name.strip() if file_name else f"chart_{safe_title}_{stamp}.svg")
    if not fname.lower().endswith(".svg"):
        fname += ".svg"
    out_path = out_dir / fname
    out_path.write_text("\n".join(parts), encoding="utf-8")

    return {
        "message": "ok",
        "chart_type": chart_type,
        "item_count": len(items),
        "file_path": str(out_path),
        "preview_url": f"/api/files/output?name={out_path.name}",
    }
