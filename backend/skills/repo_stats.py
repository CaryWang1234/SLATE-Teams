"""Skill: collect lightweight repository file statistics."""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any


SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", "dist", "build", ".idea", ".vscode"}


def execute(directory: str = ".", max_files: int = 5000, **_kw: Any) -> dict[str, Any]:
    root = Path(directory or ".").expanduser().resolve()
    if not root.exists():
        return {"error": f"directory not found: {root}"}
    if not root.is_dir():
        return {"error": f"not a directory: {root}"}

    try:
        file_limit = max(1, min(int(max_files), 50000))
    except (TypeError, ValueError):
        file_limit = 5000

    ext_counts: Counter[str] = Counter()
    dir_count = 0
    file_count = 0
    total_bytes = 0
    largest: list[dict[str, Any]] = []

    for path in root.rglob("*"):
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        if path.is_dir():
            dir_count += 1
            continue
        if not path.is_file():
            continue
        if file_count >= file_limit:
            break
        file_count += 1
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        total_bytes += size
        ext_counts[path.suffix.lower() or "[no extension]"] += 1
        largest.append({"path": str(path.relative_to(root)).replace("\\", "/"), "size": size})
        largest = sorted(largest, key=lambda item: item["size"], reverse=True)[:10]

    return {
        "root": str(root),
        "files": file_count,
        "directories": dir_count,
        "total_bytes": total_bytes,
        "extensions": dict(ext_counts.most_common(30)),
        "largest_files": largest,
        "truncated": file_count >= file_limit,
    }
