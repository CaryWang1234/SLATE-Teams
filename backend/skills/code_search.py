"""技能：全局代码搜索。

在当前项目中按文本/正则搜索文件内容（类似 VSCode Ctrl+Shift+F）。
默认搜索整个项目根目录，scope 可缩小到项目内子目录。
纯 Python 零依赖：os.walk 剪枝 + ThreadPoolExecutor 并发行级匹配。
"""

from __future__ import annotations

import fnmatch
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from backend.skills.text_io import read_text_file

# 跳过超过 1MB 的文件（避免大文件/二进制误判拖慢搜索）
MAX_FILE_BYTES = 1_000_000
# 扫描文件数护栏，防止海量小文件打满资源
MAX_SCANNED_FILES = 20_000
DEFAULT_LIMIT = 50
MAX_LIMIT = 500


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return default


def _resolve_scope(root: Path, scope: str) -> tuple[Path | None, str | None]:
    """解析搜索范围，返回 (目录, 错误)。root 必须已 resolve。"""
    scope_raw = (scope or "").strip()
    if not scope_raw:
        return root, None
    target = Path(scope_raw).expanduser()
    if not target.is_absolute():
        target = root / scope_raw
    try:
        target = target.resolve()
        target.relative_to(root)
    except (OSError, ValueError):
        return None, f"scope 超出项目范围: {scope_raw}"
    if not target.exists():
        return None, f"scope 不存在: {scope_raw}"
    if not target.is_dir():
        return None, f"scope 不是目录: {scope_raw}"
    return target, None


def _collect_candidates(root_dir: Path, ignore_dirs: set, text_exts: set, text_names: set) -> list[Path]:
    """递归收集可搜索的文本文件（剪枝忽略目录、白名单扩展名、大小上限）。"""
    candidates: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        dirnames[:] = [d for d in dirnames if d not in ignore_dirs]
        for name in filenames:
            path = Path(dirpath) / name
            if path.suffix.lower() not in text_exts and name.lower() not in text_names:
                continue
            try:
                if path.stat().st_size > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            candidates.append(path)
            if len(candidates) >= MAX_SCANNED_FILES:
                return candidates
    return candidates


def _match_file(path: Path, root_dir: Path, pattern: re.Pattern, glob: str) -> list[dict]:
    """在单个文件中做行级匹配，返回命中列表。失败文件静默跳过。"""
    rel = path.relative_to(root_dir).as_posix()
    if glob:
        g = glob.strip()
        if not (fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(path.name, g)):
            return []
    try:
        content = read_text_file(path).content
    except (OSError, UnicodeError, ValueError):
        return []
    hits: list[dict] = []
    for n, line in enumerate(content.splitlines(), 1):
        m = pattern.search(line)
        if m:
            hits.append({
                "file": rel,
                "line": n,
                "column": m.start() + 1,
                "text": line.strip()[:300],
            })
    return hits


def execute(
    query: str = "",
    scope: str = "",
    case_sensitive: bool = False,
    glob: str = "",
    limit: int = DEFAULT_LIMIT,
    project: str = "",
    **_kw: Any,
) -> dict[str, Any]:
    """全局代码搜索：默认搜索当前项目根，scope 可缩小到项目内子目录。

    project 可以指定别的项目（id/路径/唯一名称）：多项目并行时，后台那一轮
    不能靠"用户此刻在看哪个目录"来定位代码，否则它会搜到前台项目的文件上。
    """
    # 延迟导入避免循环依赖（projects.py 仅依赖 backend.skills.text_io，不依赖本模块）
    from backend.routers.projects import IGNORE_DIRS, TEXT_EXTS, TEXT_NAMES, _resolve_project

    q = (query or "").strip()
    if not q:
        return {"error": "缺少搜索关键词 query"}

    project_info = _resolve_project(project)
    if not project_info or not project_info.get("path"):
        return {"error": "未打开项目，无法确定搜索范围"}

    root = Path(project_info["path"]).resolve()
    root_dir, err = _resolve_scope(root, scope)
    if err:
        return {"error": err}

    try:
        flags = 0 if _to_bool(case_sensitive) else re.IGNORECASE
        pattern = re.compile(q, flags)
    except re.error as e:
        return {"error": f"无效的正则: {e}"}

    try:
        limit = max(1, min(int(limit), MAX_LIMIT))
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT

    candidates = _collect_candidates(root_dir, IGNORE_DIRS, TEXT_EXTS, TEXT_NAMES)
    matches: list[dict] = []
    scanned = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(_match_file, p, root_dir, pattern, glob): p for p in candidates}
        try:
            for fut in as_completed(futures):
                scanned += 1
                hits = fut.result()
                if hits:
                    matches.extend(hits)
                    if len(matches) >= limit:
                        break
        finally:
            for f in futures:
                f.cancel()

    matches = matches[:limit]
    return {
        "matches": matches,
        "count": len(matches),
        "scope": str(root_dir),
        "scanned_files": scanned,
        "truncated": len(matches) >= limit,
    }
