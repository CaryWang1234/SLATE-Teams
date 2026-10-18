"""技能：创建文件 —— 预览新文件内容，用户确认后写入。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.skills.sandbox import is_path_safe, MAX_FILE_SIZE
from backend.skills.text_io import DEFAULT_TEXT_ENCODING


def execute(
    file_path: str = "",
    content: str = "",
    encoding: str = DEFAULT_TEXT_ENCODING,
    **_kw: Any,
) -> dict[str, Any]:
    """
    预览并创建新文件。

    参数:
        file_path: 新文件的绝对路径
        content: 文件内容
        encoding: 写入编码，默认 utf-8
    """
    if not file_path:
        return {"error": "文件路径不能为空"}

    # 沙箱路径验证
    safe, reason = is_path_safe(file_path)
    if not safe:
        return {"error": reason}

    target = Path(file_path)

    # 检查文件是否已存在
    if target.exists():
        return {"error": f"文件已存在: {file_path}，请使用 file_edit 工具编辑"}

    # 安全检查：禁止创建二进制文件
    blocked_suffixes = {".exe", ".dll", ".so", ".dylib", ".bin", ".png", ".jpg", ".gif", ".ico"}
    if target.suffix.lower() in blocked_suffixes:
        return {"error": "不支持创建二进制文件"}

    if not content and content != "":
        return {"error": "文件内容不能为空"}

    # 内容大小限制
    if len(content) > MAX_FILE_SIZE:
        mb = MAX_FILE_SIZE / (1024 * 1024)
        return {"error": f"文件内容过大（{len(content)/(1024*1024):.1f}MB > {mb:.0f}MB 限制）"}

    # 生成 diff 预览（以空文件为基准）
    import difflib
    diff_lines = list(difflib.unified_diff(
        [],
        content.splitlines(keepends=True),
        fromfile="/dev/null",
        tofile=str(target.name),
        lineterm="",
    ))
    diff_text = "".join(diff_lines)

    line_count = content.count("\n") + 1

    return {
        "file": str(target),
        "file_name": target.name,
        "file_path_rel": str(target.parent),
        "diff": diff_text,
        "content": content,
        "encoding": encoding or DEFAULT_TEXT_ENCODING,
        "stats": {
            "lines": line_count,
            "chars": len(content),
        },
        "note": "新文件已预览。用户可选择「接受」创建文件、「拒绝」放弃、「复制」拷贝内容。",
    }
