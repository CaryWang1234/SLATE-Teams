"""技能：CSS 调色 —— 基于用户描述生成 CSS 配色方案。"""

from __future__ import annotations

from typing import Any

# 预设配色方案
PRESETS: dict[str, dict[str, str]] = {
    "warm": {
        "primary": "#E07A5F", "primary-hover": "#C96A52",
        "secondary": "#F2CC8F", "accent": "#81B29A",
        "bg": "#FFFAF0", "bg-alt": "#FFF3E0", "surface": "#FFFFFF",
        "text": "#3D405B", "text-secondary": "#6B7280", "text-muted": "#9CA3AF",
        "border": "#E5E7EB", "border-hover": "#3D405B",
    },
    "cool": {
        "primary": "#3B82F6", "primary-hover": "#2563EB",
        "secondary": "#8B5CF6", "accent": "#06B6D4",
        "bg": "#F8FAFC", "bg-alt": "#F1F5F9", "surface": "#FFFFFF",
        "text": "#0F172A", "text-secondary": "#475569", "text-muted": "#94A3B8",
        "border": "#E2E8F0", "border-hover": "#0F172A",
    },
    "nature": {
        "primary": "#059669", "primary-hover": "#047857",
        "secondary": "#84CC16", "accent": "#F59E0B",
        "bg": "#F0FDF4", "bg-alt": "#ECFDF5", "surface": "#FFFFFF",
        "text": "#1A1A1A", "text-secondary": "#4B5563", "text-muted": "#9CA3AF",
        "border": "#D1D5DB", "border-hover": "#1A1A1A",
    },
    "mono": {
        "primary": "#000000", "primary-hover": "#333333",
        "secondary": "#666666", "accent": "#999999",
        "bg": "#FFFFFF", "bg-alt": "#F8F8F8", "surface": "#FFFFFF",
        "text": "#000000", "text-secondary": "#666666", "text-muted": "#999999",
        "border": "#DDDDDD", "border-hover": "#000000",
    },
    "dark": {
        "primary": "#60A5FA", "primary-hover": "#93C5FD",
        "secondary": "#A78BFA", "accent": "#34D399",
        "bg": "#0F172A", "bg-alt": "#1E293B", "surface": "#1E293B",
        "text": "#F1F5F9", "text-secondary": "#CBD5E1", "text-muted": "#64748B",
        "border": "#334155", "border-hover": "#F1F5F9",
    },
    "sunset": {
        "primary": "#F97316", "primary-hover": "#EA580C",
        "secondary": "#EC4899", "accent": "#8B5CF6",
        "bg": "#FFF7ED", "bg-alt": "#FFF1E0", "surface": "#FFFFFF",
        "text": "#1C1917", "text-secondary": "#57534E", "text-muted": "#A8A29E",
        "border": "#E7E5E4", "border-hover": "#1C1917",
    },
    "ocean": {
        "primary": "#0284C7", "primary-hover": "#0369A1",
        "secondary": "#0891B2", "accent": "#0D9488",
        "bg": "#F0F9FF", "bg-alt": "#E0F2FE", "surface": "#FFFFFF",
        "text": "#0C4A6E", "text-secondary": "#075985", "text-muted": "#7DD3FC",
        "border": "#BAE6FD", "border-hover": "#0C4A6E",
    },
    "rose": {
        "primary": "#E11D48", "primary-hover": "#BE123C",
        "secondary": "#F43F5E", "accent": "#FB923C",
        "bg": "#FFF1F2", "bg-alt": "#FFE4E6", "surface": "#FFFFFF",
        "text": "#1F2937", "text-secondary": "#4B5563", "text-muted": "#9CA3AF",
        "border": "#FECDD3", "border-hover": "#1F2937",
    },
}

# 关键词到配色的映射（长关键词优先，避免短词提前匹配导致死映射）
KEYWORD_MAP = {
    "海洋": "ocean", "海": "ocean", "ocean": "ocean", "天蓝": "ocean", "水": "ocean",
    "玫瑰": "rose", "红": "rose", "粉": "rose", "rose": "rose", "热情": "rose",
    "日落": "sunset", "夕阳": "sunset", "sunset": "sunset", "橙": "sunset",
    "自然": "nature", "绿色": "nature", "绿": "nature", "清新": "nature", "nature": "nature",
    "黑白": "mono", "灰": "mono", "单色": "mono", "极简": "mono", "mono": "mono", "素": "mono",
    "暗": "dark", "深色": "dark", "黑夜": "dark", "dark": "dark", "night": "dark",
    "暖": "warm", "温暖": "warm", "warm": "warm", "橙色": "warm", "橘": "warm",
    "冷": "cool", "冷静": "cool", "cool": "cool", "蓝色": "cool", "蓝": "cool",
}


def _match_preset(description: str) -> str:
    """根据描述关键词匹配预设配色。"""
    desc_lower = description.lower()
    for keyword, preset_name in KEYWORD_MAP.items():
        if keyword in desc_lower:
            return preset_name
    return "cool"  # 默认


def execute(description: str = "", component: str = "page", **_kw: Any) -> dict[str, Any]:
    """
    根据用户描述生成 CSS 配色方案。

    参数:
        description: 风格描述（如"温暖的橙色系"、"冷色调科技感"、"深色模式"）
        component: 目标组件（page / card / button / nav / form / code）
    """
    style = str(_kw.get("style") or "").strip()
    desc = " ".join(part for part in (description.strip(), style) if part) or "简洁现代风格"
    comp = component.strip() or "page"

    preset_name = _match_preset(desc)
    colors = PRESETS[preset_name]

    # 生成组件级 CSS 变量
    component_vars: dict[str, dict[str, str]] = {
        "page": {
            "--color-primary": colors["primary"],
            "--color-primary-hover": colors["primary-hover"],
            "--color-secondary": colors["secondary"],
            "--color-accent": colors["accent"],
            "--bg": colors["bg"],
            "--bg-alt": colors["bg-alt"],
            "--surface": colors["surface"],
            "--text": colors["text"],
            "--text-secondary": colors["text-secondary"],
            "--text-muted": colors["text-muted"],
            "--border": colors["border"],
            "--border-hover": colors["border-hover"],
        },
        "card": {
            "--card-bg": colors["surface"],
            "--card-border": colors["border"],
            "--card-shadow": "0 1px 3px rgba(0,0,0,0.08)",
            "--card-radius": "6px",
            "--card-padding": "16px",
        },
        "button": {
            "--btn-bg": colors["primary"],
            "--btn-fg": "#FFFFFF",
            "--btn-hover-bg": colors["primary-hover"],
            "--btn-border": colors["primary"],
            "--btn-radius": "6px",
            "--btn-padding": "8px 20px",
        },
        "nav": {
            "--nav-bg": colors["surface"],
            "--nav-border": colors["border"],
            "--nav-text": colors["text"],
            "--nav-active": colors["primary"],
            "--nav-muted": colors["text-muted"],
        },
        "form": {
            "--input-bg": colors["surface"],
            "--input-border": colors["border"],
            "--input-focus-border": colors["primary"],
            "--input-text": colors["text"],
            "--input-placeholder": colors["text-muted"],
            "--input-radius": "6px",
        },
        "code": {
            "--code-bg": "#1e1e1e",
            "--code-fg": "#d4d4d4",
            "--code-keyword": "#569CD6",
            "--code-string": "#CE9178",
            "--code-comment": "#6A9955",
            "--code-radius": "6px",
        },
    }

    vars_map = component_vars.get(comp, component_vars["page"])

    css_lines = [f"/* {comp} — {desc} (preset: {preset_name}) */"]
    css_lines.append(f".{comp} {{")
    for var, val in vars_map.items():
        css_lines.append(f"  {var}: {val};")
    css_lines.append("}")

    # 深色模式变体（如果原方案不是 dark）
    if preset_name != "dark":
        dark = PRESETS["dark"]
        dark_map = {
            "--bg": dark["bg"], "--bg-alt": dark["bg-alt"],
            "--surface": dark["surface"],
            "--text": dark["text"], "--text-secondary": dark["text-secondary"],
            "--text-muted": dark["text-muted"],
            "--border": dark["border"], "--border-hover": dark["border-hover"],
            "--color-primary": dark["primary"],
        }
        dark_lines = ["", "/* 深色模式 */", f'[data-theme="dark"] .{comp} {{']
        for var, val in dark_map.items():
            if var in vars_map:
                dark_lines.append(f"  {var}: {val};")
        dark_lines.append("}")
        css_text = "\n".join(css_lines) + "\n" + "\n".join(dark_lines)
    else:
        css_text = "\n".join(css_lines)

    return {
        "css": css_text,
        "preset": preset_name,
        "component": comp,
        "description": desc,
        "colors": colors,
        "note": f"配色方案基于描述「{desc}」匹配为 {preset_name} 风格。可自由调整各变量值。",
    }
