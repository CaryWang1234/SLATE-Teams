"""技能：读取文件内容（支持多种编码、行范围、快速模式）。

特性：
- 支持多种编码：utf-8, gbk, gb2312, latin-1 等
- 自动检测编码（尝试多种编码）
- 支持行范围读取（start_line/end_line）
- 支持 tail 模式（读取最后 N 行）
- 快速模式：不统计总行数（大文件更快）
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.skills.sandbox import is_path_safe, validate_file_size, truncate_output
from backend.skills.text_io import COMMON_TEXT_ENCODINGS, detect_text_encoding

MAX_LINES = 50
DEFAULT_LINES = 30

# 常用编码列表（按优先级排序）
COMMON_ENCODINGS = list(COMMON_TEXT_ENCODINGS)


def _detect_encoding(file_path: Path) -> str:
    """尝试多种编码读取文件，返回第一个成功的编码。"""
    raw = file_path.read_bytes()[:8192]
    enc, _with_errors = detect_text_encoding(raw)
    return enc


def _read_lines_fast(file_path: Path, encoding: str, errors: str = "replace") -> list[str]:
    """快速读取所有行（内存允许的情况下）。"""
    try:
        with file_path.open("r", encoding=encoding, errors=errors) as f:
            return f.readlines()
    except PermissionError:
        raise PermissionError(f"无权限读取: {file_path}")
    except UnicodeDecodeError as e:
        raise ValueError(f"编码错误 ({encoding}): {e}")


def _read_range(file_path: Path, encoding: str, start: int, end: int, errors: str = "replace") -> tuple[list[str], int]:
    """读取指定行范围，返回 (lines, total_lines)。

    之前 `i > end` 时先 total += 1 再 break 导致 total 多计 1 行；
    且 break 后总行数永远数不完。现在数完全部行，total 恒为文件总行数
    （文件受 5MB 上限约束，全量计数开销可接受）。
    """
    lines = []
    total = 0
    try:
        with file_path.open("r", encoding=encoding, errors=errors) as f:
            for i, line in enumerate(f, 1):
                total += 1
                if start <= i <= end:
                    lines.append(line.rstrip("\n\r"))
    except PermissionError:
        raise PermissionError(f"无权限读取: {file_path}")
    return lines, total


def _read_tail(file_path: Path, encoding: str, n: int, errors: str = "replace") -> tuple[list[str], int]:
    """读取最后 N 行，返回 (lines, total_lines)。"""
    all_lines, total = _read_range(file_path, encoding, 1, 1 << 31, errors)
    return all_lines[-n:], total


def execute(
    file_path: str = "",
    lines: int = DEFAULT_LINES,
    encoding: str = "",
    auto_detect: bool = False,
    start_line: int = 0,
    end_line: int = 0,
    tail: bool = False,
    fast: bool = False,
    **_: Any,
) -> dict[str, Any]:
    """读取文件内容，支持多种编码和行范围。

    Args:
        file_path: 文件路径
        lines: 读取行数（默认 30，上限 50）
        encoding: 文件编码（如 "utf-8", "gbk", "gb2312"），空串则使用 utf-8
        auto_detect: 是否自动检测编码（尝试多种常见编码）
        start_line: 起始行号（1-based，与 end_line 配合使用）
        end_line: 结束行号（1-based）
        tail: 是否读取最后 N 行（类似 tail 命令）
        fast: 快速模式（不统计总行数，大文件更快）
    """
    if not file_path:
        return {"error": "文件路径不能为空"}

    # 沙箱路径验证
    safe, reason = is_path_safe(file_path)
    if not safe:
        return {"error": reason}

    target = Path(file_path).resolve()
    if not target.is_file():
        return {"error": f"文件不存在: {file_path}"}

    # 文件大小检查
    size_ok, size_reason = validate_file_size(str(target))
    if not size_ok:
        return {"error": size_reason}

    # 安全检查：禁止读取二进制文件
    blocked_suffixes = {".exe", ".dll", ".so", ".dylib", ".bin", ".png", ".jpg", ".gif", ".ico", ".pdf"}
    if target.suffix.lower() in blocked_suffixes:
        return {"error": "不支持读取二进制文件"}

    # 确定编码
    if auto_detect:
        enc = _detect_encoding(target)
    elif encoding:
        enc = encoding.strip().lower()
    else:
        enc = "utf-8"

    line_count = min(lines, MAX_LINES)

    try:
        # 行范围模式
        if start_line > 0 or end_line > 0:
            start = max(1, start_line)
            end = end_line if end_line > 0 else start + line_count - 1
            content_lines, total_lines = _read_range(target, enc, start, end)
        
        # tail 模式
        elif tail:
            content_lines, total_lines = _read_tail(target, enc, line_count)
        
        # 快速模式（不统计总行数）
        elif fast:
            all_lines = _read_lines_fast(target, enc)
            content_lines = [l.rstrip("\n\r") for l in all_lines[:line_count]]
            total_lines = -1  # 未知
        
        # 默认模式：读取前 N 行（_read_range 已数完全部行，total 即文件总行数）
        else:
            content_lines, total_lines = _read_range(target, enc, 1, line_count)

    except PermissionError as e:
        return {"error": str(e)}
    except ValueError as e:
        return {"error": str(e)}
    except OSError as e:
        return {"error": f"读取失败: {e}"}

    content_text = "\n".join(content_lines)
    content_text, was_truncated = truncate_output(content_text)

    result = {
        "file": str(target),
        "encoding": enc,
        "total_lines": total_lines,
        "returned_lines": len(content_lines),
        "content": content_text,
        "truncated": (total_lines > len(content_lines) if total_lines >= 0 else False) or was_truncated,
    }

    # 如果是行范围或 tail 模式，返回范围信息
    if start_line > 0 or end_line > 0:
        result["range"] = f"{start}-{end}"
    elif tail:
        result["mode"] = "tail"

    return result
