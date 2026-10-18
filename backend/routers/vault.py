"""Markdown 文库：Obsidian 风格的笔记管理。"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter

router = APIRouter(prefix="/vault", tags=["vault"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
VAULT_DIR = DATA_DIR / "vault"


def _ensure_vault() -> None:
    VAULT_DIR.mkdir(parents=True, exist_ok=True)


def _safe_path(rel: str) -> Path:
    """将相对路径解析为 VAULT_DIR 下的绝对路径，防止路径穿越。"""
    rel = rel.replace("\\", "/").strip("/")
    target = (VAULT_DIR / rel).resolve()
    vault_root = str(VAULT_DIR.resolve())
    # 分隔符边界检查：`data/vault-x/...` 是 `data/vault` 的字符串前缀但不在 vault 内
    if target != Path(vault_root) and not str(target).startswith(vault_root + os.sep):
        raise ValueError("路径不合法")
    return target


def _parse_front_matter(content: str) -> tuple[dict[str, Any], str]:
    """解析 YAML front matter（简易实现，不依赖 PyYAML）。"""
    meta: dict[str, Any] = {}
    body = content
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            fm_text = content[3:end].strip()
            body = content[end + 3:].strip()
            for line in fm_text.split("\n"):
                line = line.strip()
                if not line or ":" not in line:
                    continue
                key, _, val = line.partition(":")
                key = key.strip()
                val = val.strip()
                if val.startswith("[") and val.endswith("]"):
                    items = [v.strip().strip("\"'") for v in val[1:-1].split(",") if v.strip()]
                    meta[key] = items
                else:
                    meta[key] = val.strip("\"'")
    return meta, body


def _build_front_matter(meta: dict[str, Any]) -> str:
    """将元数据序列化为 YAML front matter。"""
    if not meta:
        return ""
    lines = ["---"]
    for key, val in meta.items():
        if isinstance(val, list):
            lines.append(f"{key}: [{', '.join(str(v) for v in val)}]")
        else:
            lines.append(f"{key}: {val}")
    lines.append("---")
    return "\n".join(lines)


def _extract_tags(content: str) -> list[str]:
    """从内容中提取标签：front matter 的 tags 字段 + 行内 #tag。"""
    tags: set[str] = set()
    meta, body = _parse_front_matter(content)
    for t in meta.get("tags", []):
        if t:
            tags.add(str(t).lower())
    for m in re.finditer(r"(?:^|\s)#([a-zA-Z\u4e00-\u9fff][\w\u4e00-\u9fff/-]{0,30})", body):
        tags.add(m.group(1).lower())
    return sorted(tags)


def _extract_wikilinks(content: str) -> list[str]:
    """从内容中提取 [[wiki-link]] 目标列表。"""
    _, body = _parse_front_matter(content)
    links: list[str] = []
    for m in re.finditer(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", body):
        links.append(m.group(1).strip())
    return links


# ── 目录树 ──────────────────────────────────────────────────────────────────

@router.get("/tree")
async def get_tree() -> dict[str, Any]:
    _ensure_vault()
    tree: list[dict[str, Any]] = []

    def _scan(dir_path: Path, rel_prefix: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        if not dir_path.is_dir():
            return items
        for entry in sorted(dir_path.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            rel = f"{rel_prefix}/{entry.name}" if rel_prefix else entry.name
            if entry.is_dir():
                children = _scan(entry, rel)
                items.append({"type": "folder", "name": entry.name, "path": rel, "children": children})
            elif entry.suffix == ".md":
                size = entry.stat().st_size
                items.append({"type": "note", "name": entry.stem, "path": rel, "size": size})
        return items

    tree = _scan(VAULT_DIR, "")
    return {"code": 0, "data": tree, "message": "ok"}


# ── 笔记 CRUD ──────────────────────────────────────────────────────────────

@router.post("/note")
async def create_note(body: dict[str, Any]) -> dict[str, Any]:
    _ensure_vault()
    rel_path = str(body.get("path", "")).strip()
    if not rel_path:
        return {"code": 1, "message": "路径不能为空"}
    if not rel_path.endswith(".md"):
        rel_path += ".md"
    try:
        target = _safe_path(rel_path)
    except ValueError:
        return {"code": 1, "message": "路径不合法"}
    if target.exists():
        return {"code": 1, "message": "笔记已存在"}
    target.parent.mkdir(parents=True, exist_ok=True)
    content = str(body.get("content", "") or "")
    tags = body.get("tags") if isinstance(body.get("tags"), list) else []
    if tags:
        fm = _build_front_matter({"tags": tags})
        content = f"{fm}\n\n{content}" if content else fm
    target.write_text(content, encoding="utf-8")
    return {"code": 0, "data": {"path": rel_path}, "message": "ok"}


@router.get("/note/{note_path:path}")
async def read_note(note_path: str) -> dict[str, Any]:
    _ensure_vault()
    try:
        target = _safe_path(note_path)
    except ValueError:
        return {"code": 1, "message": "路径不合法"}
    if not target.is_file():
        return {"code": 1, "message": "笔记不存在"}
    content = target.read_text(encoding="utf-8")
    meta, body = _parse_front_matter(content)
    tags = meta.get("tags", [])
    wikilinks = _extract_wikilinks(content)
    return {
        "code": 0,
        "data": {
            "path": note_path,
            "content": body,
            "raw": content,
            "tags": tags if isinstance(tags, list) else [],
            "wikilinks": wikilinks,
            "title": meta.get("title", target.stem),
        },
        "message": "ok",
    }


@router.put("/note/{note_path:path}")
async def save_note(note_path: str, body: dict[str, Any]) -> dict[str, Any]:
    _ensure_vault()
    try:
        target = _safe_path(note_path)
    except ValueError:
        return {"code": 1, "message": "路径不合法"}
    if not target.is_file():
        return {"code": 1, "message": "笔记不存在"}
    content = str(body.get("content", "") or "")
    tags = body.get("tags") if isinstance(body.get("tags"), list) else []
    title = str(body.get("title", "") or "").strip()
    meta: dict[str, Any] = {}
    if tags:
        meta["tags"] = tags
    if title:
        meta["title"] = title
    fm = _build_front_matter(meta)
    full_content = f"{fm}\n\n{content}" if fm else content
    target.write_text(full_content, encoding="utf-8")
    return {"code": 0, "data": None, "message": "ok"}


@router.delete("/note/{note_path:path}")
async def delete_note(note_path: str) -> dict[str, Any]:
    _ensure_vault()
    try:
        target = _safe_path(note_path)
    except ValueError:
        return {"code": 1, "message": "路径不合法"}
    if not target.is_file():
        return {"code": 1, "message": "笔记不存在"}
    target.unlink()
    return {"code": 0, "data": None, "message": "ok"}


# ── 文件夹 ─────────────────────────────────────────────────────────────────

@router.post("/folder")
async def create_folder(body: dict[str, Any]) -> dict[str, Any]:
    _ensure_vault()
    rel_path = str(body.get("path", "")).strip()
    if not rel_path:
        return {"code": 1, "message": "路径不能为空"}
    try:
        target = _safe_path(rel_path)
    except ValueError:
        return {"code": 1, "message": "路径不合法"}
    target.mkdir(parents=True, exist_ok=True)
    return {"code": 0, "data": {"path": rel_path}, "message": "ok"}


@router.delete("/folder/{folder_path:path}")
async def delete_folder(folder_path: str) -> dict[str, Any]:
    _ensure_vault()
    try:
        target = _safe_path(folder_path)
    except ValueError:
        return {"code": 1, "message": "路径不合法"}
    if not target.is_dir():
        return {"code": 1, "message": "文件夹不存在"}
    if any(target.iterdir()):
        return {"code": 1, "message": "文件夹不为空，无法删除"}
    target.rmdir()
    return {"code": 0, "data": None, "message": "ok"}


# ── 搜索 ───────────────────────────────────────────────────────────────────

@router.post("/search")
async def search_notes(body: dict[str, Any]) -> dict[str, Any]:
    _ensure_vault()
    query = str(body.get("query", "")).strip().lower()
    tag_filter = str(body.get("tag", "")).strip().lower()
    results: list[dict[str, Any]] = []

    if not VAULT_DIR.is_dir():
        return {"code": 0, "data": [], "message": "ok"}

    for md_file in VAULT_DIR.rglob("*.md"):
        rel = str(md_file.relative_to(VAULT_DIR)).replace("\\", "/")
        try:
            content = md_file.read_text(encoding="utf-8")
        except Exception:
            continue
        meta, note_body = _parse_front_matter(content)
        tags = meta.get("tags", []) if isinstance(meta.get("tags"), list) else []
        note_tags = [str(t).lower() for t in tags]

        if tag_filter and tag_filter not in note_tags:
            continue

        if query:
            title = str(meta.get("title", md_file.stem)).lower()
            searchable = f"{title} {note_body}".lower()
            if query not in searchable:
                continue
            # 在 searchable 中找到 query 位置，然后映射回 note_body
            abs_pos = searchable.find(query)
            title_len = len(title) + 1  # title + 空格
            if abs_pos < title_len:
                # query 在 title 中，从正文开头取摘要
                snippet_start = 0
            else:
                # query 在正文中，计算相对位置
                rel_pos = abs_pos - title_len
                snippet_start = max(0, rel_pos - 60)
            snippet = note_body[snippet_start:snippet_start + 200].strip()
            if snippet_start > 0:
                snippet = "..." + snippet
        else:
            snippet = note_body[:200].strip()

        results.append({
            "path": rel,
            "title": meta.get("title", md_file.stem),
            "tags": note_tags,
            "snippet": snippet,
            "size": md_file.stat().st_size,
        })

    results.sort(key=lambda x: x.get("title", "").lower())
    return {"code": 0, "data": results[:50], "message": "ok"}


# ── 标签 ───────────────────────────────────────────────────────────────────

@router.get("/tags")
async def list_tags() -> dict[str, Any]:
    _ensure_vault()
    all_tags: dict[str, int] = {}
    if VAULT_DIR.is_dir():
        for md_file in VAULT_DIR.rglob("*.md"):
            try:
                content = md_file.read_text(encoding="utf-8")
            except Exception:
                continue
            for tag in _extract_tags(content):
                all_tags[tag] = all_tags.get(tag, 0) + 1
    tags = [{"name": k, "count": v} for k, v in sorted(all_tags.items(), key=lambda x: -x[1])]
    return {"code": 0, "data": tags, "message": "ok"}


# ── 反向链接 ────────────────────────────────────────────────────────────────

@router.get("/backlinks/{note_name}")
async def get_backlinks(note_name: str) -> dict[str, Any]:
    _ensure_vault()
    note_name_clean = note_name.strip().lower()
    backlinks: list[dict[str, str]] = []

    if not VAULT_DIR.is_dir():
        return {"code": 0, "data": [], "message": "ok"}

    for md_file in VAULT_DIR.rglob("*.md"):
        rel = str(md_file.relative_to(VAULT_DIR)).replace("\\", "/")
        try:
            content = md_file.read_text(encoding="utf-8")
        except Exception:
            continue
        links = _extract_wikilinks(content)
        for link in links:
            if link.strip().lower() == note_name_clean:
                meta, body = _parse_front_matter(content)
                backlinks.append({
                    "path": rel,
                    "title": meta.get("title", md_file.stem),
                    "snippet": body[:120].strip(),
                })
                break

    return {"code": 0, "data": backlinks, "message": "ok"}
