"""技能：PDF 办公文档处理（基于 pdfplumber）。

支持动作：
- info: 获取 PDF 元信息（页数、尺寸、元数据）
- extract: 提取文本内容（支持指定页码范围，如 "1-3,5"）
- tables: 提取表格数据（返回二维数组 JSON）

适用于阅读 PDF 资料、提取合同/报告正文、抽取表格数据等办公场景。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

MAX_CHARS = 30000
MAX_TABLES = 10
MAX_TABLE_ROWS = 100


def _open_pdf(file_path: str):
    """打开 PDF，返回 pdfplumber 文档对象。"""
    try:
        import pdfplumber
    except ImportError:
        raise RuntimeError("pdfplumber 未安装，PDF 解析当前不可用（缺的是运行环境依赖，要用户自行装 pdfplumber）。请把缺依赖的情况告诉用户，不要自行执行安装命令。")
    p = Path(os.path.expanduser(file_path or ""))
    if not p.is_file():
        raise FileNotFoundError(f"文件不存在: {file_path}")
    if p.suffix.lower() != ".pdf":
        raise ValueError(f"不是 PDF 文件: {p.name}")
    return pdfplumber.open(str(p)), p


def _parse_pages(pages: str, total: int) -> list[int]:
    """解析页码表达式（1-based），如 "1-3,5"、"all"、空串表示全部。"""
    text = (pages or "").strip().lower()
    if not text or text == "all":
        return list(range(1, total + 1))
    result: list[int] = []
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            try:
                a, b = part.split("-", 1)
                result.extend(range(int(a), int(b) + 1))
            except ValueError:
                continue
        else:
            try:
                result.append(int(part))
            except ValueError:
                continue
    return [n for n in dict.fromkeys(result) if 1 <= n <= total]


def execute(
    action: str = "",
    file_path: str = "",
    pages: str = "",
    max_chars: int = MAX_CHARS,
    **_kw: Any,
) -> dict[str, Any]:
    """PDF 办公文档工具。

    Args:
        action: 操作类型 - info/extract/tables
        file_path: PDF 文件路径（必填）
        pages: 页码范围（extract/tables 时使用，如 "1-3,5" 或 "all"，默认全部）
        max_chars: 文本提取最大字符数（默认 30000）

    Returns:
        dict: 操作结果。
    """
    if not action:
        return {"error": "action 不能为空，可选: info/extract/tables"}
    if not file_path:
        return {"error": "file_path 不能为空"}

    try:
        pdf, p = _open_pdf(file_path)
    except (RuntimeError, FileNotFoundError, ValueError) as e:
        return {"error": str(e)}

    try:
        total = len(pdf.pages)

        # ── info ─────────────────────────────────────
        if action == "info":
            meta = pdf.metadata or {}
            first = pdf.pages[0] if total else None
            return {
                "status": "ok",
                "file": p.name,
                "pages": total,
                "size_bytes": p.stat().st_size,
                "page_size": [round(first.width, 1), round(first.height, 1)] if first else None,
                "metadata": {k: str(v)[:200] for k, v in meta.items() if v},
            }

        if action not in ("extract", "tables"):
            return {"error": f"未知操作: {action}，可选: info/extract/tables"}

        page_nums = _parse_pages(pages, total)
        if not page_nums:
            return {"error": f"pages 无有效页码（PDF 共 {total} 页）"}

        # ── extract ──────────────────────────────────
        if action == "extract":
            cap = min(max(int(max_chars or MAX_CHARS), 500), 100000)
            chunks: list[str] = []
            length = 0
            truncated = False
            for n in page_nums:
                text = (pdf.pages[n - 1].extract_text() or "").strip()
                if not text:
                    continue
                if length + len(text) > cap:
                    chunks.append(text[: max(0, cap - length)])
                    truncated = True
                    break
                chunks.append(text)
                length += len(text)
            return {
                "status": "ok",
                "file": p.name,
                "pages_extracted": page_nums if not truncated else page_nums[: len(chunks)],
                "total_pages": total,
                "text": "\n\n".join(chunks),
                "char_count": length,
                "truncated": truncated,
            }

        # ── tables ───────────────────────────────────
        tables_out: list[dict[str, Any]] = []
        for n in page_nums:
            if len(tables_out) >= MAX_TABLES:
                break
            for table in pdf.pages[n - 1].extract_tables():
                if not table:
                    continue
                cleaned = [
                    [("" if cell is None else str(cell).replace("\n", " ").strip()) for cell in row]
                    for row in table[:MAX_TABLE_ROWS]
                ]
                tables_out.append({
                    "page": n,
                    "rows": len(table),
                    "truncated_rows": len(table) > MAX_TABLE_ROWS,
                    "data": cleaned,
                })
                if len(tables_out) >= MAX_TABLES:
                    break
        if not tables_out:
            return {"status": "ok", "message": "未在指定页面中发现表格", "tables": []}
        return {
            "status": "ok",
            "file": p.name,
            "table_count": len(tables_out),
            "tables": tables_out,
        }
    except Exception as e:
        return {"error": f"PDF 处理失败 ({action}): {e}"}
    finally:
        try:
            pdf.close()
        except Exception:
            pass
