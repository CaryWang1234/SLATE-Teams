"""Skill: summarize plain text with lightweight extractive rules."""

from __future__ import annotations

import re
from collections import Counter
from typing import Any


def _sentences(text: str) -> list[str]:
    # 中文分句：句号/感叹号/问号后不需要空格（直接切分）
    parts = re.split(r"(?<=[。！？.!?])|\n+", text)
    return [part.strip() for part in parts if part.strip()]


def _keywords(text: str, limit: int) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}", text.lower())
    stop = {
        "the", "and", "for", "with", "that", "this", "from", "into", "have",
        "has", "not", "are", "was", "were", "you", "your", "about",
    }
    counts = Counter(word for word in words if word not in stop)
    return [word for word, _count in counts.most_common(limit)]


def execute(text: str = "", max_points: int = 5, keyword_limit: int = 12, **_kw: Any) -> dict[str, Any]:
    source = str(text or "").strip()
    if not source:
        return {"error": "text is required"}

    try:
        point_count = max(1, min(int(max_points), 12))
    except (TypeError, ValueError):
        point_count = 5
    try:
        key_count = max(1, min(int(keyword_limit), 30))
    except (TypeError, ValueError):
        key_count = 12

    sentences = _sentences(source)
    selected = sentences[:point_count] if sentences else [source[:500]]
    return {
        "summary": "\n".join(f"- {item}" for item in selected),
        "keywords": _keywords(source, key_count),
        "stats": {
            "chars": len(source),
            "sentences": len(sentences),
            "summary_points": len(selected),
        },
    }
