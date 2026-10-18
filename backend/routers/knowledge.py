"""Lightweight local vector knowledge base."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from backend import scope_overlay

router = APIRouter(prefix="/knowledge", tags=["knowledge"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
DB_PATH = DATA_DIR / "knowledge.db"
CHAT_DB_PATH = DATA_DIR / "chat_history.db"
VECTOR_DIMS = 256


def _get_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=10.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS knowledge_docs (
            id TEXT PRIMARY KEY,
            title TEXT DEFAULT '',
            source TEXT DEFAULT '',
            kind TEXT DEFAULT 'note',
            content TEXT DEFAULT '',
            metadata TEXT DEFAULT '',
            created_at REAL,
            updated_at REAL,
            project_id TEXT DEFAULT ''
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            id TEXT PRIMARY KEY,
            doc_id TEXT,
            chunk_index INTEGER,
            content TEXT DEFAULT '',
            vector TEXT DEFAULT '',
            terms TEXT DEFAULT '',
            created_at REAL,
            FOREIGN KEY (doc_id) REFERENCES knowledge_docs(id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc_id ON knowledge_chunks(doc_id)")
    # P4 的分项目归属：''= 本机全局（今天的全部存量文档天然落在这一档，不做迁移）。
    # 加列而不是建新库：老库直接能用，读不到列的旧版本也不会因为一条 ALTER 打不开面板。
    cols = {str(r["name"]) for r in conn.execute("PRAGMA table_info(knowledge_docs)").fetchall()}
    if "project_id" not in cols:
        conn.execute("ALTER TABLE knowledge_docs ADD COLUMN project_id TEXT DEFAULT ''")
    conn.commit()
    return conn


def _tokenize(text: str) -> list[str]:
    lowered = text.lower()
    words = re.findall(r"[a-z0-9_+\-.#]{2,}|[\u4e00-\u9fff]{1,4}", lowered)
    grams: list[str] = []
    chinese = "".join(re.findall(r"[\u4e00-\u9fff]", lowered))
    for size in (2, 3, 4):
        grams.extend(chinese[i:i + size] for i in range(max(0, len(chinese) - size + 1)))
    return [w for w in words + grams if w.strip()]


def _hash_vector(text: str) -> list[float]:
    vector = [0.0] * VECTOR_DIMS
    for token in _tokenize(text):
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        bucket = int.from_bytes(digest[:4], "little") % VECTOR_DIMS
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vector[bucket] += sign
    norm = math.sqrt(sum(v * v for v in vector)) or 1.0
    return [round(v / norm, 6) for v in vector]


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    return sum(x * y for x, y in zip(a, b))


def _split_chunks(text: str, max_chars: int = 900, overlap: int = 120) -> list[str]:
    clean = re.sub(r"\n{3,}", "\n\n", str(text or "").strip())
    if not clean:
        return []
    parts = re.split(r"(?<=\n\n)|(?<=[。！？.!?])\s*", clean)
    chunks: list[str] = []
    current = ""
    for part in parts:
        if not part:
            continue
        if len(current) + len(part) > max_chars and current:
            chunks.append(current.strip())
            current = current[-overlap:] + part
        else:
            current += part
    if current.strip():
        chunks.append(current.strip())
    return chunks or [clean[:max_chars]]


def upsert_document(
    *,
    doc_id: str | None = None,
    title: str,
    content: str,
    source: str = "",
    kind: str = "note",
    metadata: dict[str, Any] | None = None,
    project_id: str = "",
) -> str:
    doc_id = doc_id or str(uuid.uuid4())[:12]
    now = time.time()
    chunks = _split_chunks(content)
    conn = _get_db()
    conn.execute(
        """
        INSERT INTO knowledge_docs (id, title, source, kind, content, metadata, created_at, updated_at, project_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title=excluded.title,
            source=excluded.source,
            kind=excluded.kind,
            content=excluded.content,
            metadata=excluded.metadata,
            updated_at=excluded.updated_at,
            project_id=excluded.project_id
        """,
        (doc_id, title, source, kind, content, json.dumps(metadata or {}, ensure_ascii=False), now, now,
         str(project_id or "")),
    )
    conn.execute("DELETE FROM knowledge_chunks WHERE doc_id = ?", (doc_id,))
    for index, chunk in enumerate(chunks):
        terms = " ".join(sorted(set(_tokenize(chunk)))[:500])
        conn.execute(
            "INSERT INTO knowledge_chunks (id, doc_id, chunk_index, content, vector, terms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4())[:12], doc_id, index, chunk, json.dumps(_hash_vector(chunk)), terms, now),
        )
    conn.commit()
    conn.close()
    return doc_id


def delete_document(doc_id: str) -> None:
    conn = _get_db()
    conn.execute("DELETE FROM knowledge_chunks WHERE doc_id = ?", (doc_id,))
    conn.execute("DELETE FROM knowledge_docs WHERE id = ?", (doc_id,))
    conn.commit()
    conn.close()


def _title_key(raw: Any) -> str:
    """标题归一化：覆盖判定按它比，大小写和首尾空白不算两份。"""
    return str(raw or "").strip().lower()


def merge_docs_by_scope(rows: list[dict[str, Any]], project_id: str) -> list[dict[str, Any]]:
    """一个项目视野下该看见哪几条（带 title/project_id 的记录，文档级与分块级都用它）：
    项目文档全留，同名全局文档被顶掉，别的项目的文档不进这一项目的视野；
    没项目时只看全局那批（`project_id=''`）。

    为什么不是"有项目文档就屏蔽整个全局库"：长期记忆是 `memory:<id>` 那批全局文档，
    屏蔽掉等于用户一进项目、自己攒下来的知识就凭空消失。知识库是数据不是配置，
    数据只做同名覆盖，不做整体屏蔽。
    """
    pid = str(project_id or "")
    if not pid:
        out = []
        for row in rows:
            if str(row.get("project_id") or ""):
                continue
            row["scope"] = "global"
            out.append(row)
        return out
    own_titles = {_title_key(d.get("title")) for d in rows if str(d.get("project_id") or "") == pid}
    kept: list[dict[str, Any]] = []
    for doc in rows:
        own = str(doc.get("project_id") or "")
        if own == pid:
            doc["scope"] = "project"
        elif own:
            continue
        else:
            doc["scope"] = "global"
            if _title_key(doc.get("title")) in own_titles:
                continue
        kept.append(doc)
    return kept


def search_knowledge(query: str, limit: int = 6, category: str = "", project_id: str = "") -> list[dict[str, Any]]:
    query = str(query or "").strip()
    if not query:
        return []
    q_vector = _hash_vector(query)
    q_terms = set(_tokenize(query))
    conn = _get_db()
    pid = scope_overlay.canonical_project_id(project_id)

    # 构建 SQL，支持按 category 过滤
    if category:
        rows = conn.execute("""
            SELECT c.id, c.doc_id, c.chunk_index, c.content, c.vector, c.terms,
                   d.title, d.source, d.kind, d.created_at, d.updated_at, d.project_id
            FROM knowledge_chunks c
            JOIN knowledge_docs d ON d.id = c.doc_id
            WHERE d.kind = ? OR d.metadata LIKE ?
        """, (category, f'%"category": "{category}"%')).fetchall()
    else:
        rows = conn.execute("""
            SELECT c.id, c.doc_id, c.chunk_index, c.content, c.vector, c.terms,
                   d.title, d.source, d.kind, d.created_at, d.updated_at, d.project_id
            FROM knowledge_chunks c
            JOIN knowledge_docs d ON d.id = c.doc_id
        """).fetchall()
    conn.close()

    docs = merge_docs_by_scope([dict(r) for r in rows], pid)
    allowed = {(d["id"], d["doc_id"]) for d in docs}
    scope_of = {d["id"]: d["scope"] for d in docs}

    ranked = []
    for row in rows:
        if (row["id"], row["doc_id"]) not in allowed:
            continue
        try:
            vector = json.loads(row["vector"] or "[]")
        except json.JSONDecodeError:
            vector = []
        terms = set((row["terms"] or "").split())
        keyword_score = len(q_terms & terms) / max(1, min(len(q_terms), 12))
        score = (_cosine(q_vector, vector) * 0.72) + (keyword_score * 0.28)
        if score <= 0:
            continue
        item = dict(row)
        item.pop("vector", None)
        item.pop("terms", None)
        item["score"] = round(float(score), 4)
        item["scope"] = scope_of.get(row["id"], "global")
        ranked.append(item)
    # 同分先给项目那份：覆盖版要能被看出来，也别让一条高分全局片段把它挤出 topK
    ranked.sort(key=lambda x: (x["scope"] != "project", -x["score"]))
    return ranked[: max(1, min(20, int(limit or 6)))]


@router.get("/docs")
async def list_docs(project: str = "") -> dict[str, Any]:
    conn = _get_db()
    rows = conn.execute("""
        SELECT d.id, d.title, d.source, d.kind, substr(d.content, 1, 520) AS content, d.created_at, d.updated_at,
               d.project_id,
               COUNT(c.id) AS chunk_count,
               LENGTH(d.content) AS content_length
        FROM knowledge_docs d
        LEFT JOIN knowledge_chunks c ON c.doc_id = d.id
        GROUP BY d.id
        ORDER BY d.updated_at DESC
    """).fetchall()
    conn.close()
    pid = scope_overlay.canonical_project_id(project)
    return {"code": 0, "data": merge_docs_by_scope([dict(r) for r in rows], pid),
            "message": "ok", "project_id": pid}


@router.post("/docs")
async def create_doc(body: dict[str, Any]) -> dict[str, Any]:
    content = str(body.get("content", "")).strip()
    if not content:
        return {"code": 1, "message": "内容不能为空"}
    pid = scope_overlay.canonical_project_id(body.get("project"))
    doc_id = upsert_document(
        doc_id=body.get("id"),
        title=str(body.get("title") or "未命名知识").strip(),
        source=str(body.get("source") or "").strip(),
        kind=str(body.get("kind") or "note").strip(),
        content=content,
        metadata=body.get("metadata") if isinstance(body.get("metadata"), dict) else {},
        project_id=pid,
    )
    return {"code": 0, "data": {"id": doc_id, "project_id": pid, "scope": "project" if pid else "global"},
            "message": "ok"}


@router.delete("/docs/{doc_id}")
async def remove_doc(doc_id: str, project: str = "") -> dict[str, Any]:
    """删除一份知识文档。带着项目来删＝只允许删这一项目自己那批里的：
    否则用户在项目面板上点一下删除，把本机全局那份（可能是长期记忆）一起带走了。
    """
    pid = scope_overlay.canonical_project_id(project)
    if pid:
        conn = _get_db()
        row = conn.execute("SELECT project_id FROM knowledge_docs WHERE id = ?", (doc_id,)).fetchone()
        conn.close()
        if row is None:
            return {"code": 1, "message": "这份知识文档不存在"}
        if str(row["project_id"] or "") != pid:
            return {"code": 1, "message": "这份不是当前项目的文档，没动它（全局那批请到「本机全局」视图里删）"}
    delete_document(doc_id)
    return {"code": 0, "data": None, "message": "ok"}


@router.post("/search")
async def search(body: dict[str, Any]) -> dict[str, Any]:
    results = search_knowledge(
        str(body.get("query", "")),
        int(body.get("limit", 6) or 6),
        str(body.get("category", "") or "").strip(),
        str(body.get("project", "") or "").strip(),
    )
    return {"code": 0, "data": results, "message": "ok"}


@router.post("/reindex-memories")
async def reindex_memories() -> dict[str, Any]:
    if not CHAT_DB_PATH.exists():
        return {"code": 0, "data": {"count": 0}, "message": "ok"}
    conn = sqlite3.connect(str(CHAT_DB_PATH), timeout=10.0)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, category, content FROM memories").fetchall()
    conn.close()
    count = 0
    for row in rows:
        content = str(row["content"] or "").strip()
        if not content:
            continue
        upsert_document(
            doc_id=f"memory:{row['id']}",
            title=f"长期记忆 · {row['category'] or 'general'}",
            source="long-term-memory",
            kind="memory",
            content=content,
            metadata={"memory_id": row["id"], "category": row["category"]},
        )
        count += 1
    return {"code": 0, "data": {"count": count}, "message": "ok"}
