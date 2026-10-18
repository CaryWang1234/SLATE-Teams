"""技能：文件编辑 —— 支持 view/replace 协议 + diff 编辑 + 行操作 + 剪贴板。

操作类型：
- view: 带行号读取文件（供 AI 精确定位引用）
- replace: 精确字符串替换（唯一匹配 + 自动备份）
- edit: 基于 diff 的精确修改（old_text → new_text）
- replace_range: 按行号范围替换内容（1-based，预览 diff）
- read: 读取文件内容（支持行号范围）
- insert: 在指定行插入内容
- delete: 删除指定行范围
- copy: 复制内容到剪贴板
- paste: 从剪贴板粘贴到指定位置
- cut: 剪切内容（复制 + 删除）

剪贴板支持命名存储，可在多次操作间保持内容。
"""

from __future__ import annotations

import difflib
import json
from pathlib import Path
from typing import Any

from backend.skills.sandbox import is_path_safe, validate_file_size
from backend.skills.text_io import read_text_file

# 全局剪贴板存储（支持多个命名剪贴板）
_clipboards: dict[str, str] = {}


def _read_file(file_path: str, encoding: str = "") -> tuple[str | None, str | None, str]:
    """安全读取文件，返回 (content, error, detected_encoding)。"""
    target = Path(file_path)
    
    # 沙箱路径验证
    safe, reason = is_path_safe(file_path)
    if not safe:
        return None, reason, ""
    
    # 文件大小检查
    size_ok, size_reason = validate_file_size(file_path)
    if not size_ok:
        return None, size_reason, ""
    
    if not target.is_file():
        return None, f"文件不存在: {file_path}", ""
    
    # 禁止二进制文件
    blocked_suffixes = {".exe", ".dll", ".so", ".dylib", ".bin", ".png", ".jpg", ".gif", ".ico"}
    if target.suffix.lower() in blocked_suffixes:
        return None, "不支持编辑二进制文件", ""
    
    try:
        read = read_text_file(target, encoding)
        return read.content, None, read.encoding
    except PermissionError:
        return None, f"无权限读取: {file_path}", ""
    except Exception as e:
        return None, f"读取失败: {e}", ""


def _read_with_lines(file_path: str, encoding: str = "") -> tuple[list[str], str, str, str, str | None]:
    """共享辅助函数：读取文件，返回 (lines, content, line_ending, encoding, error)。

    line_ending 为 '\n' 或 '\r\n'，用于写回时保持原换行符。
    lines 不含行尾换行符。
    """
    content, error, detected_encoding = _read_file(file_path, encoding)
    if error:
        return [], "", "\n", "", error

    # 检测换行符
    line_ending = "\r\n" if "\r\n" in content else "\n"

    # 拆分为行（去掉所有行尾换行）
    lines = content.splitlines()

    return lines, content, line_ending, detected_encoding, None


def _generate_diff(original: str, content: str, filename: str) -> str:
    """生成 unified diff。"""
    diff_lines = list(difflib.unified_diff(
        original.splitlines(keepends=True),
        content.splitlines(keepends=True),
        fromfile=filename,
        tofile=filename,
        lineterm="",
    ))
    return "".join(diff_lines)


def _normalize_newlines(text: str, line_ending: str = "\n") -> str:
    """把调用方传入的换行统一到目标文件的换行风格。"""
    normalized = str(text).replace("\r\n", "\n").replace("\r", "\n")
    if line_ending == "\r\n":
        normalized = normalized.replace("\n", "\r\n")
    return normalized


def _count_diff_lines(diff_text: str) -> tuple[int, int]:
    added = sum(1 for line in diff_text.splitlines() if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in diff_text.splitlines() if line.startswith("-") and not line.startswith("---"))
    return added, removed


def _execute_view(
    file_path: str,
    start_line: int | None = None,
    end_line: int | None = None,
    encoding: str = "",
) -> dict[str, Any]:
    """view 操作：带行号读取文件内容。

    每行格式为 "{行号}: {代码内容}"，行号右对齐占 4 位。
    """
    lines, content, _le, detected_encoding, error = _read_with_lines(file_path, encoding)
    if error:
        return {"error": error}

    total = len(lines)

    # 校验范围
    if start_line is not None and start_line < 1:
        return {"error": f"start_line 必须 >= 1，收到 {start_line}"}
    if end_line is not None and end_line < 1:
        return {"error": f"end_line 必须 >= 1，收到 {end_line}"}
    if start_line is not None and end_line is not None and end_line < start_line:
        return {"error": f"end_line ({end_line}) 不能小于 start_line ({start_line})"}

    # 确定实际范围
    s = (start_line - 1) if start_line else 0          # 0-based
    e = end_line if end_line else total
    s = min(s, total)
    e = min(e, total)

    # 生成带行号的输出
    numbered: list[str] = []
    for idx in range(s, e):
        line_no = idx + 1  # 1-based
        numbered.append(f"{line_no:>4}: {lines[idx]}")

    return {
        "file": file_path,
        "total_lines": total,
        "range": f"{s + 1}-{e}" if (start_line or end_line) else f"1-{total}",
        "content": "\n".join(numbered),
        "line_count": e - s,
        "encoding": detected_encoding,
    }


def _execute_replace(
    file_path: str,
    old_str: str,
    new_str: str,
    encoding: str = "",
) -> dict[str, Any]:
    """replace 操作：精确字符串替换，只生成预览不写盘（落盘须经用户「接受」）。

    严格逻辑：
    1. old_str == new_str → 不变更
    2. count == 0 → 报错
    3. count > 1 → 报错
    4. count == 1 → 生成 new_content/diff 预览
    """
    if old_str is None or old_str == "":
        return {"error": "old_str 不能为空"}

    _lines, content, line_ending, detected_encoding, error = _read_with_lines(file_path, encoding)
    if error:
        return {"error": error}

    # 换行归一化：view 输出的内容已被 splitlines 去掉 \r，CRLF 文件必须归一化才能匹配
    old_str = _normalize_newlines(old_str, line_ending)
    new_str = _normalize_newlines(new_str, line_ending)

    # 新旧相同
    if old_str == new_str:
        return {"file": file_path, "action": "replace", "status": "unchanged", "message": "未修改，新旧内容相同"}

    # 统计匹配
    count = content.count(old_str)
    if count == 0:
        return {
            "file": file_path,
            "action": "replace",
            "status": "not_found",
            "error": "未找到精确匹配，请先 view 最新内容后重新复制 old_str",
        }
    if count > 1:
        return {
            "file": file_path,
            "action": "replace",
            "status": "ambiguous",
            "error": f"存在 {count} 处匹配，请在 old_str 前后增加 3 行唯一上下文以确保唯一匹配",
        }

    # 只生成预览，不写盘 —— 与 edit/replace_range 一致，落盘必须经用户点「接受」（/projects/apply-edit）
    new_content = content.replace(old_str, new_str, 1)
    diff_text = _generate_diff(content, new_content, Path(file_path).name)
    added, removed = _count_diff_lines(diff_text)
    pos = content.index(old_str)
    line_no = content[:pos].count("\n") + 1

    return {
        "file": str(Path(file_path)),
        "file_name": Path(file_path).name,
        "action": "replace",
        "status": "preview",
        "diff": diff_text,
        "applied": [{
            "index": 1,
            "line": line_no,
            "old_lines": old_str.count("\n") + 1,
            "new_lines": new_str.count("\n") + 1,
        }],
        "errors": [],
        "stats": {
            "edits_total": 1,
            "edits_applied": 1,
            "lines_added": added,
            "lines_removed": removed,
        },
        "new_content": new_content,
        "encoding": detected_encoding,
        "note": "编辑已预览。用户可选择「接受」写入文件、「拒绝」放弃、「复制」拷贝 diff。",
    }


def _execute_edit(file_path: str, edits: Any, encoding: str = "") -> dict[str, Any]:
    """执行 diff 编辑（原有逻辑）。"""
    # 解析 edits
    if isinstance(edits, str):
        try:
            edit_list = json.loads(edits)
        except json.JSONDecodeError as e:
            return {"error": f"edits 格式错误: {e}"}
    elif isinstance(edits, list):
        edit_list = edits
    else:
        return {"error": "edits 必须是 JSON 数组"}
    
    if not edit_list or not isinstance(edit_list, list):
        return {"error": "edits 不能为空"}
    
    _lines, content, line_ending, detected_encoding, error = _read_with_lines(file_path, encoding)
    if error:
        return {"error": error}
    
    original = content
    target = Path(file_path)
    applied: list[dict[str, Any]] = []
    errors: list[str] = []
    
    for i, edit in enumerate(edit_list):
        old_text = edit.get("old_text", "")
        new_text = edit.get("new_text", "")
        
        if not isinstance(old_text, str) or old_text == "":
            errors.append(f"第 {i + 1} 项缺少 old_text 或 old_text 为空")
            continue

        old_text = _normalize_newlines(old_text, line_ending)
        new_text = _normalize_newlines(new_text, line_ending)
        
        count = content.count(old_text)
        if count == 0:
            errors.append(f"第 {i + 1} 项: old_text 在文件中未找到；若已确认行号，建议改用 action=replace_range")
            continue
        if count > 1:
            errors.append(f"第 {i + 1} 项: old_text 在文件中出现 {count} 次，需更精确以唯一匹配；若已确认行号，建议改用 action=replace_range")
            continue
        
        pos = content.index(old_text)
        line_no = content[:pos].count("\n") + 1
        content = content[:pos] + new_text + content[pos + len(old_text):]
        
        applied.append({
            "index": i + 1,
            "line": line_no,
            "old_lines": old_text.count("\n") + 1,
            "new_lines": new_text.count("\n") + 1,
        })
    
    if errors and not applied:
        return {
            "file": str(target),
            "file_name": target.name,
            "diff": "",
            "applied": [],
            "errors": errors,
            "stats": {"edits_total": len(edit_list), "edits_applied": 0, "lines_added": 0, "lines_removed": 0},
            "new_content": original,
            "encoding": detected_encoding,
            "note": "所有编辑均未匹配。请检查 old_text 是否与文件内容完全一致。",
        }
    
    diff_text = _generate_diff(original, content, target.name)
    added, removed = _count_diff_lines(diff_text)
    
    return {
        "file": str(target),
        "file_name": target.name,
        "diff": diff_text,
        "applied": applied,
        "errors": errors,
        "stats": {
            "edits_total": len(edit_list),
            "edits_applied": len(applied),
            "lines_added": added,
            "lines_removed": removed,
        },
        "new_content": content,
        "encoding": detected_encoding,
        "note": "编辑已预览。用户可选择「接受」写入文件、「拒绝」放弃、「复制」拷贝 diff。",
    }


def _execute_replace_range(file_path: str, content: str, start_line: int, end_line: int, encoding: str = "") -> dict[str, Any]:
    """按 1-based 行号范围替换内容，适合先 view/read 后精确修改。"""
    if start_line < 1:
        return {"error": "start_line 必须 >= 1"}
    if end_line < start_line:
        return {"error": "end_line 必须 >= start_line"}

    lines, original, line_ending, detected_encoding, error = _read_with_lines(file_path, encoding)
    if error:
        return {"error": error}

    total = len(lines)
    if total == 0:
        return {"error": "空文件请使用 insert 或 replace 操作"}
    if start_line > total:
        return {"error": f"start_line 超出文件行数（当前 {total} 行）"}
    if end_line > total:
        return {"error": f"end_line 超出文件行数（当前 {total} 行）"}

    normalized_content = _normalize_newlines(content, line_ending)
    replacement_lines = normalized_content.splitlines()
    start = start_line - 1
    end = end_line
    new_lines = lines[:start] + replacement_lines + lines[end:]

    final_newline = original.endswith(("\n", "\r")) or (
        end_line == total and normalized_content.endswith(("\n", "\r"))
    )
    new_content = line_ending.join(new_lines)
    if final_newline and new_content:
        new_content += line_ending

    target = Path(file_path)
    diff_text = _generate_diff(original, new_content, target.name)
    added, removed = _count_diff_lines(diff_text)

    return {
        "file": str(target),
        "file_name": target.name,
        "action": "replace_range",
        "range": f"{start_line}-{end_line}",
        "diff": diff_text,
        "applied": [{
            "index": 1,
            "line": start_line,
            "old_lines": end_line - start_line + 1,
            "new_lines": len(replacement_lines),
        }],
        "errors": [],
        "stats": {
            "edits_total": 1,
            "edits_applied": 1,
            "lines_added": added,
            "lines_removed": removed,
        },
        "new_content": new_content,
        "encoding": detected_encoding,
        "note": "行范围替换已预览。用户可选择「接受」写入文件、「拒绝」放弃、「复制」拷贝 diff。",
    }


def _execute_read(file_path: str, start_line: int = 0, end_line: int = 0, encoding: str = "") -> dict[str, Any]:
    """读取文件内容（支持行号范围）。"""
    content, error, detected_encoding = _read_file(file_path, encoding)
    if error:
        return {"error": error}
    
    lines = content.splitlines(keepends=True)
    total = len(lines)
    
    # 处理行号范围
    if start_line > 0 or end_line > 0:
        start = max(1, start_line) - 1  # 转为 0-based
        end = min(total, end_line) if end_line > 0 else total
        selected = lines[start:end]
        return {
            "file": file_path,
            "total_lines": total,
            "range": f"{start + 1}-{end}",
            "content": "".join(selected),
            "line_count": len(selected),
            "encoding": detected_encoding,
        }
    
    return {
        "file": file_path,
        "total_lines": total,
        "content": content,
        "line_count": total,
        "encoding": detected_encoding,
    }


def _execute_insert(file_path: str, content: str, start_line: int, encoding: str = "") -> dict[str, Any]:
    """在指定行插入内容。"""
    if not content:
        return {"error": "content 不能为空"}
    if start_line < 1:
        return {"error": "start_line 必须 >= 1"}
    
    original, error, detected_encoding = _read_file(file_path, encoding)
    if error:
        return {"error": error}
    
    lines = original.splitlines(keepends=True)
    insert_pos = min(start_line - 1, len(lines))  # 0-based
    
    # 确保插入内容有换行符
    line_ending = "\r\n" if "\r\n" in original else "\n"
    content = _normalize_newlines(content, line_ending)
    if not content.endswith(line_ending):
        content += line_ending
    
    lines.insert(insert_pos, content)
    new_content = "".join(lines)
    
    return {
        "file": file_path,
        "action": "insert",
        "line": start_line,
        "inserted_lines": content.count("\n"),
        "new_content": new_content,
        "encoding": detected_encoding,
        "note": "插入已预览。用户可选择「接受」写入文件。",
    }


def _execute_delete(file_path: str, start_line: int, end_line: int, encoding: str = "") -> dict[str, Any]:
    """删除指定行范围。"""
    if start_line < 1:
        return {"error": "start_line 必须 >= 1"}
    if end_line < start_line:
        return {"error": "end_line 必须 >= start_line"}
    
    original, error, detected_encoding = _read_file(file_path, encoding)
    if error:
        return {"error": error}
    
    lines = original.splitlines(keepends=True)
    total = len(lines)
    
    # 越界检查
    if start_line > total:
        return {"error": f"start_line ({start_line}) 超出文件总行数 ({total})"}
    
    start = max(1, start_line) - 1  # 0-based
    end = min(total, end_line)
    
    deleted = lines[start:end]
    del lines[start:end]
    new_content = "".join(lines)
    
    return {
        "file": file_path,
        "action": "delete",
        "range": f"{start_line}-{end_line}",
        "deleted_lines": len(deleted),
        "deleted_content": "".join(deleted),
        "new_content": new_content,
        "encoding": detected_encoding,
        "note": "删除已预览。用户可选择「接受」写入文件。",
    }


def _execute_copy(file_path: str, start_line: int = 0, end_line: int = 0, clipboard_name: str = "default", encoding: str = "") -> dict[str, Any]:
    """复制内容到剪贴板。"""
    content, error, detected_encoding = _read_file(file_path, encoding)
    if error:
        return {"error": error}
    
    lines = content.splitlines(keepends=True)
    
    if start_line > 0 or end_line > 0:
        start = max(1, start_line) - 1
        end = min(len(lines), end_line) if end_line > 0 else len(lines)
        selected = "".join(lines[start:end])
    else:
        selected = content
    
    _clipboards[clipboard_name] = selected
    
    return {
        "file": file_path,
        "action": "copy",
        "clipboard": clipboard_name,
        "copied_lines": selected.count("\n"),
        "copied_chars": len(selected),
        "preview": selected[:200] + ("..." if len(selected) > 200 else ""),
        "encoding": detected_encoding,
    }


def _execute_paste(file_path: str, start_line: int, clipboard_name: str = "default", encoding: str = "") -> dict[str, Any]:
    """从剪贴板粘贴到指定位置。"""
    if clipboard_name not in _clipboards:
        return {"error": f"剪贴板 '{clipboard_name}' 为空"}
    
    clipboard_content = _clipboards[clipboard_name]
    
    if start_line < 1:
        return {"error": "start_line 必须 >= 1"}
    
    original, error, detected_encoding = _read_file(file_path, encoding)
    if error:
        return {"error": error}
    
    lines = original.splitlines(keepends=True)
    insert_pos = min(start_line - 1, len(lines))
    line_ending = "\r\n" if "\r\n" in original else "\n"
    clipboard_content = _normalize_newlines(clipboard_content, line_ending)
    
    lines.insert(insert_pos, clipboard_content)
    new_content = "".join(lines)
    
    return {
        "file": file_path,
        "action": "paste",
        "clipboard": clipboard_name,
        "line": start_line,
        "pasted_lines": clipboard_content.count("\n"),
        "new_content": new_content,
        "encoding": detected_encoding,
        "note": "粘贴已预览。用户可选择「接受」写入文件。",
    }


def _execute_cut(file_path: str, start_line: int, end_line: int, clipboard_name: str = "default", encoding: str = "") -> dict[str, Any]:
    """剪切内容（复制到剪贴板 + 删除）。"""
    if start_line < 1:
        return {"error": "start_line 必须 >= 1"}
    if end_line < start_line:
        return {"error": "end_line 必须 >= start_line"}
    
    original, error, detected_encoding = _read_file(file_path, encoding)
    if error:
        return {"error": error}
    
    lines = original.splitlines(keepends=True)
    total = len(lines)
    
    start = max(1, start_line) - 1
    end = min(total, end_line)
    
    cut_content = "".join(lines[start:end])
    _clipboards[clipboard_name] = cut_content
    
    del lines[start:end]
    new_content = "".join(lines)
    
    return {
        "file": file_path,
        "action": "cut",
        "clipboard": clipboard_name,
        "range": f"{start_line}-{end_line}",
        "cut_lines": len(cut_content.splitlines()),
        "cut_chars": len(cut_content),
        "new_content": new_content,
        "encoding": detected_encoding,
        "note": "剪切已预览（内容已存入剪贴板）。用户可选择「接受」写入文件。",
    }


def execute(
    file_path: str = "",
    action: str = "edit",
    edits: Any = None,
    content: str = "",
    old_str: str = "",
    new_str: str = "",
    start_line: int = 0,
    end_line: int = 0,
    clipboard_name: str = "default",
    encoding: str = "",
    **_kw: Any,
) -> dict[str, Any]:
    """
    文件编辑工具：支持 view/replace 协议 + diff 编辑 + 行操作 + 剪贴板。

    Args:
        file_path: 目标文件路径
        action: 操作类型 - view/replace/edit/replace_range/read/insert/delete/copy/paste/cut
        encoding: 可选编码；留空自动检测并尽量保留原编码
        edits: JSON 数组（edit 操作），每项含 old_text 和 new_text
        content: 要插入或替换的内容（insert/replace_range 操作）
        old_str: 要被替换的精确字符串（replace 操作）
        new_str: 替换后的新字符串（replace 操作）
        start_line: 起始行号（1-based，用于 view/replace_range/insert/delete/copy/paste/cut）
        end_line: 结束行号（1-based，用于 view/replace_range/delete/copy/cut）
        clipboard_name: 剪贴板名称（默认 "default"，支持多个命名剪贴板）
    """
    if not file_path:
        return {"error": "文件路径不能为空"}
    
    action = (action or "edit").strip().lower()
    
    if action == "view":
        return _execute_view(
            file_path,
            start_line=start_line if start_line > 0 else None,
            end_line=end_line if end_line > 0 else None,
            encoding=encoding,
        )
    
    if action == "replace":
        return _execute_replace(file_path, old_str, new_str, encoding)
    
    if action == "edit":
        if edits is None:
            return {"error": "edit 操作需要 edits 参数"}
        return _execute_edit(file_path, edits, encoding)

    if action == "replace_range":
        return _execute_replace_range(file_path, content, start_line, end_line, encoding)
    
    if action == "read":
        return _execute_read(file_path, start_line, end_line, encoding)
    
    if action == "insert":
        return _execute_insert(file_path, content, start_line, encoding)
    
    if action == "delete":
        return _execute_delete(file_path, start_line, end_line, encoding)
    
    if action == "copy":
        return _execute_copy(file_path, start_line, end_line, clipboard_name, encoding)
    
    if action == "paste":
        return _execute_paste(file_path, start_line, clipboard_name, encoding)
    
    if action == "cut":
        return _execute_cut(file_path, start_line, end_line, clipboard_name, encoding)
    
    return {"error": f"未知操作: {action}，可选: view/replace/edit/replace_range/read/insert/delete/copy/paste/cut"}
