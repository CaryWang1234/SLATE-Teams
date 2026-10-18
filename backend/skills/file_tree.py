"""技能：扫描目录树（支持递归、过滤、快速模式）。

特性：
- 使用 os.scandir() 快速扫描（比 Path.iterdir() 快 3-10 倍）
- 支持递归扫描（depth 控制深度）
- 支持 glob 模式过滤（pattern 参数）
- 支持隐藏文件过滤
- 缓存 stat 调用减少系统调用
"""

from __future__ import annotations

import os
import fnmatch
from pathlib import Path
from typing import Any


def _format_size(size_bytes: int) -> str:
    """格式化文件大小。"""
    if size_bytes < 1024:
        return f"{size_bytes}B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f}KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f}MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.2f}GB"


def _scan_dir_fast(
    directory: Path,
    max_depth: int = 1,
    pattern: str = "",
    include_hidden: bool = False,
    current_depth: int = 0,
) -> list[dict[str, Any]]:
    """使用 os.scandir() 快速扫描目录。"""
    items = []
    
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                name = entry.name
                
                # 过滤隐藏文件
                if not include_hidden and name.startswith("."):
                    continue

                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    is_file = entry.is_file(follow_symlinks=False)
                except PermissionError:
                    items.append({
                        "name": name,
                        "type": "dir" if entry.is_dir() else "file",
                        "error": "无权限访问",
                    })
                    continue
                
                # 过滤模式：只对文件生效。目录必须始终进入递归，
                # 否则 recursive=True + pattern="*.py" 时任何目录都不匹配而被跳过，
                # 子目录内容会被静默丢弃
                if pattern and is_file and not fnmatch.fnmatch(name, pattern):
                    continue
                
                item: dict[str, Any] = {
                    "name": name,
                    "type": "dir" if is_dir else "file",
                    "path": str(Path(directory) / name),
                }
                
                # 获取文件大小（仅文件）
                if is_file:
                    try:
                        stat = entry.stat(follow_symlinks=False)
                        item["size"] = _format_size(stat.st_size)
                        item["size_bytes"] = stat.st_size
                    except OSError:
                        item["size"] = "?"
                
                # 递归扫描子目录
                if is_dir and current_depth < max_depth:
                    item["children"] = _scan_dir_fast(
                        Path(directory) / name,
                        max_depth=max_depth,
                        pattern=pattern,
                        include_hidden=include_hidden,
                        current_depth=current_depth + 1,
                    )
                
                items.append(item)
    except PermissionError:
        raise PermissionError(f"无权限访问: {directory}")
    
    # 排序：目录在前，文件在后，按名称排序
    items.sort(key=lambda x: (0 if x["type"] == "dir" else 1, x["name"].lower()))
    
    return items


def execute(
    directory: str = ".",
    recursive: bool = False,
    depth: int = 1,
    pattern: str = "",
    include_hidden: bool = False,
    **_: Any,
) -> dict[str, Any]:
    """扫描目录树，支持递归和过滤。

    Args:
        directory: 目录路径
        recursive: 是否递归扫描（默认 False）
        depth: 递归深度（默认 1，仅当 recursive=True 时生效）
        pattern: glob 模式过滤（如 "*.py", "*.txt"）
        include_hidden: 是否包含隐藏文件（默认 False）
    """
    target = Path(directory).resolve()
    
    if not target.is_dir():
        return {"error": f"目录不存在: {directory}"}
    
    max_depth = depth if recursive else 1
    
    try:
        items = _scan_dir_fast(
            target,
            max_depth=max_depth,
            pattern=pattern,
            include_hidden=include_hidden,
        )
    except PermissionError as e:
        return {"error": str(e)}
    except OSError as e:
        return {"error": f"扫描失败: {e}"}
    
    # 统计信息
    dir_count = sum(1 for i in items if i["type"] == "dir")
    file_count = sum(1 for i in items if i["type"] == "file")
    
    result = {
        "directory": str(target),
        "count": len(items),
        "dirs": dir_count,
        "files": file_count,
        "items": items,
    }
    
    if recursive:
        result["depth"] = max_depth
    if pattern:
        result["pattern"] = pattern
    
    return result
