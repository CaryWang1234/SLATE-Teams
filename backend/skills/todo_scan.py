"""Skill: scan text files for TODO/FIXME style markers."""

from __future__ import annotations

from pathlib import Path
from typing import Any


SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", "dist", "build"}
MARKERS = ("TODO", "FIXME", "HACK", "XXX", "待办", "修复")


def execute(directory: str = ".", markers: str = "", limit: int = 100, **_kw: Any) -> dict[str, Any]:
    root = Path(directory or ".").expanduser().resolve()
    if not root.exists():
        return {"error": f"directory not found: {root}"}
    if not root.is_dir():
        return {"error": f"not a directory: {root}"}

    active_markers = [item.strip() for item in str(markers or "").split(",") if item.strip()] or list(MARKERS)
    try:
        max_items = max(1, min(int(limit), 500))
    except (TypeError, ValueError):
        max_items = 100

    results: list[dict[str, Any]] = []
    scanned = 0
    for path in root.rglob("*"):
        if len(results) >= max_items:
            break
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        if not path.is_file():
            continue
        scanned += 1
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for line_no, line in enumerate(text.splitlines(), 1):
            if any(marker.lower() in line.lower() for marker in active_markers):
                results.append({
                    "path": str(path.relative_to(root)).replace("\\", "/"),
                    "line": line_no,
                    "text": line.strip()[:300],
                })
                if len(results) >= max_items:
                    break

    return {
        "root": str(root),
        "markers": active_markers,
        "scanned_files": scanned,
        "count": len(results),
        "items": results,
        "truncated": len(results) >= max_items,
    }
