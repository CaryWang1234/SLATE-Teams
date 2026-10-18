"""专家包（Expert Pack）：persona.md + rules.md + data.json + knowledge/ + skills/

专家包以目录形式存放于 data/experts/{id}/，可打包为 .zip 导入/导出，
在对话与团队模式中注入专家人格与规则。
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Form, UploadFile, File
from fastapi.responses import Response

router = APIRouter(prefix="/experts", tags=["experts"])

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
EXPERTS_DIR = DATA_DIR / "experts"

ALLOWED_FOLDERS = ("knowledge", "skills")
CORE_FILES = ("persona.md", "rules.md", "data.json")
MAX_ENTRIES = 500
MAX_TOTAL_SIZE = 50 * 1024 * 1024  # zip 解压后总大小上限 50MB

_ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


def _new_id() -> str:
    return uuid.uuid4().hex[:10]


def _pack_dir(expert_id: str) -> Path | None:
    if not _ID_RE.match(str(expert_id or "")):
        return None
    d = EXPERTS_DIR / expert_id
    return d if d.is_dir() else None


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        try:
            return path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return ""


def _read_data_json(d: Path) -> dict[str, Any]:
    path = d / "data.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(_read_text(path) or "{}")
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def _list_folder(d: Path, folder: str) -> list[dict[str, Any]]:
    base = d / folder
    if not base.is_dir():
        return []
    items = []
    for p in sorted(base.rglob("*")):
        if p.is_file():
            items.append({
                "name": p.relative_to(base).as_posix(),
                "size": p.stat().st_size,
            })
    return items


def _pack_summary(expert_id: str, d: Path) -> dict[str, Any]:
    data = _read_data_json(d)
    persona = _read_text(d / "persona.md").strip()
    rules = _read_text(d / "rules.md").strip()
    return {
        "id": expert_id,
        "name": str(data.get("name") or expert_id),
        "description": str(data.get("description") or ""),
        "version": str(data.get("version") or "1.0"),
        "author": str(data.get("author") or ""),
        "has_persona": bool(persona),
        "has_rules": bool(rules),
        "knowledge_count": len(_list_folder(d, "knowledge")),
        "skills_count": len(_list_folder(d, "skills")),
        "updated_at": data.get("updated_at") or (d.stat().st_mtime if d.exists() else 0),
    }


def _pack_detail(expert_id: str, d: Path) -> dict[str, Any]:
    summary = _pack_summary(expert_id, d)
    summary.update({
        "persona": _read_text(d / "persona.md"),
        "rules": _read_text(d / "rules.md"),
        "knowledge": _list_folder(d, "knowledge"),
        "skills": _list_folder(d, "skills"),
    })
    return summary


def _write_data_json(d: Path, data: dict[str, Any]) -> None:
    d.mkdir(parents=True, exist_ok=True)
    (d / "data.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _safe_rel_name(name: str) -> str | None:
    """清洗子目录内文件名：禁止路径穿越与绝对路径（含盘符），仅保留相对路径。"""
    name = str(name or "").replace("\\", "/").strip()
    if not name or name.startswith("/"):
        return None
    if re.match(r"^[A-Za-z]:", name):
        return None
    parts = [p for p in name.split("/") if p and p not in (".", "..")]
    if not parts or ".." in name.split("/"):
        return None
    return "/".join(parts)


def _decode_zip_name(info: zipfile.ZipInfo) -> str:
    """zip 中文文件名兜底：未标记 UTF-8 时按 cp437→gbk 还原。"""
    if info.flag_bits & 0x800:
        return info.filename
    try:
        return info.filename.encode("cp437").decode("gbk")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return info.filename


@router.get("")
async def list_experts() -> dict[str, Any]:
    EXPERTS_DIR.mkdir(parents=True, exist_ok=True)
    items = []
    for d in sorted(EXPERTS_DIR.iterdir(), key=lambda p: p.stat().st_mtime if p.is_dir() else 0, reverse=True):
        if d.is_dir():
            items.append(_pack_summary(d.name, d))
    return {"code": 0, "data": items, "message": "ok"}


@router.post("")
async def create_expert(body: dict[str, Any]) -> dict[str, Any]:
    name = str(body.get("name") or "").strip() or "未命名专家"
    expert_id = _new_id()
    d = EXPERTS_DIR / expert_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "knowledge").mkdir(exist_ok=True)
    (d / "skills").mkdir(exist_ok=True)
    persona = str(body.get("persona") or "")
    rules = str(body.get("rules") or "")
    (d / "persona.md").write_text(persona, encoding="utf-8")
    (d / "rules.md").write_text(rules, encoding="utf-8")
    now = time.time()
    _write_data_json(d, {
        "name": name,
        "description": str(body.get("description") or ""),
        "version": "1.0",
        "author": str(body.get("author") or ""),
        "created_at": now,
        "updated_at": now,
    })
    return {"code": 0, "data": {"id": expert_id}, "message": "ok"}


@router.get("/{expert_id}")
async def get_expert(expert_id: str) -> dict[str, Any]:
    d = _pack_dir(expert_id)
    if not d:
        return {"code": 1, "message": "专家包不存在"}
    return {"code": 0, "data": _pack_detail(expert_id, d), "message": "ok"}


@router.put("/{expert_id}")
async def save_expert(expert_id: str, body: dict[str, Any]) -> dict[str, Any]:
    d = _pack_dir(expert_id)
    if not d:
        return {"code": 1, "message": "专家包不存在"}
    data = _read_data_json(d)
    data["name"] = str(body.get("name") or data.get("name") or expert_id).strip()
    data["description"] = str(body.get("description", data.get("description", "")))
    data["version"] = str(body.get("version", data.get("version", "1.0")))
    data["author"] = str(body.get("author", data.get("author", "")))
    data["updated_at"] = time.time()
    _write_data_json(d, data)
    if "persona" in body:
        (d / "persona.md").write_text(str(body.get("persona") or ""), encoding="utf-8")
    if "rules" in body:
        (d / "rules.md").write_text(str(body.get("rules") or ""), encoding="utf-8")
    return {"code": 0, "data": {"id": expert_id}, "message": "ok"}


@router.delete("/{expert_id}")
async def delete_expert(expert_id: str) -> dict[str, Any]:
    d = _pack_dir(expert_id)
    if not d:
        return {"code": 1, "message": "专家包不存在"}
    shutil.rmtree(d, ignore_errors=True)
    return {"code": 0, "data": None, "message": "ok"}


@router.post("/import")
async def import_expert(file: UploadFile = File(...)) -> dict[str, Any]:
    """导入 .zip 专家包：解压后须包含 persona.md / rules.md / data.json（允许位于单一根目录内）。"""
    raw = await file.read()
    if not raw:
        return {"code": 1, "message": "文件为空"}
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        return {"code": 1, "message": "不是有效的 zip 文件"}

    entries: list[tuple[str, zipfile.ZipInfo]] = []
    total_size = 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = _decode_zip_name(info).replace("\\", "/")
        if "__MACOSX" in name or name.endswith(".DS_Store"):
            continue
        parts = [p for p in name.split("/") if p and p != "."]
        if not parts or ".." in parts:
            continue
        total_size += info.file_size
        if total_size > MAX_TOTAL_SIZE or len(entries) >= MAX_ENTRIES:
            return {"code": 1, "message": "专家包过大或文件过多"}
        entries.append(("/".join(parts), info))

    if not entries:
        return {"code": 1, "message": "zip 内没有可用文件"}

    # 单一根目录包裹时剥离顶层
    roots = {p.split("/")[0] for p, _ in entries}
    strip_root = ""
    if len(roots) == 1 and all("/" in p for p, _ in entries):
        strip_root = next(iter(roots))

    files: dict[str, bytes] = {}
    for rel, info in entries:
        path = rel[len(strip_root) + 1:] if strip_root else rel
        parts = path.split("/")
        if parts[0] in ALLOWED_FOLDERS and len(parts) > 1:
            files[path] = zf.read(info)
        elif path in CORE_FILES:
            files[path] = zf.read(info)

    if not any(p in files for p in CORE_FILES):
        return {"code": 1, "message": "zip 中未找到 persona.md / rules.md / data.json"}

    expert_id = _new_id()
    d = EXPERTS_DIR / expert_id
    (d / "knowledge").mkdir(parents=True, exist_ok=True)
    (d / "skills").mkdir(exist_ok=True)
    for rel, content in files.items():
        clean = _safe_rel_name(rel)
        if not clean:
            continue
        target = d / clean
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)

    # data.json 缺失时用 persona 首行兜底命名
    if not (d / "data.json").exists():
        first_line = _read_text(d / "persona.md").strip().splitlines()
        _write_data_json(d, {
            "name": (first_line[0].lstrip("# ").strip() if first_line else "导入的专家") or "导入的专家",
            "description": "",
            "version": "1.0",
            "author": "",
            "created_at": time.time(),
            "updated_at": time.time(),
        })
    return {"code": 0, "data": {"id": expert_id}, "message": "ok"}


@router.get("/{expert_id}/export")
async def export_expert(expert_id: str):
    d = _pack_dir(expert_id)
    if not d:
        return {"code": 1, "message": "专家包不存在"}
    buf = io.BytesIO()
    name = _pack_summary(expert_id, d)["name"]
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(d.rglob("*")):
            if p.is_file():
                zf.write(p, p.relative_to(d).as_posix())
    encoded = "".join(c if ord(c) < 128 else "_" for c in name) or expert_id
    quoted = quote(f"{name}.zip")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=\"{encoded}.zip\"; filename*=UTF-8''{quoted}"},
    )


@router.get("/{expert_id}/file")
async def read_expert_file(expert_id: str, folder: str, name: str) -> dict[str, Any]:
    d = _pack_dir(expert_id)
    if not d or folder not in ALLOWED_FOLDERS:
        return {"code": 1, "message": "专家包或目录不存在"}
    clean = _safe_rel_name(name)
    if not clean:
        return {"code": 1, "message": "非法文件名"}
    path = d / folder / clean
    if not path.is_file():
        return {"code": 1, "message": "文件不存在"}
    return {"code": 0, "data": {"name": clean, "content": _read_text(path)}, "message": "ok"}


@router.post("/{expert_id}/files")
async def upload_expert_file(
    expert_id: str,
    folder: str = Form(...),
    file: UploadFile = File(...),
) -> dict[str, Any]:
    d = _pack_dir(expert_id)
    if not d:
        return {"code": 1, "message": "专家包不存在"}
    if folder not in ALLOWED_FOLDERS:
        return {"code": 1, "message": f"目录必须是 {'/'.join(ALLOWED_FOLDERS)}"}
    clean = _safe_rel_name(file.filename or "")
    if not clean:
        return {"code": 1, "message": "非法文件名"}
    target = d / folder / clean
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(await file.read())
    return {"code": 0, "data": {"name": clean}, "message": "ok"}


@router.delete("/{expert_id}/files")
async def delete_expert_file(expert_id: str, folder: str, name: str) -> dict[str, Any]:
    d = _pack_dir(expert_id)
    if not d or folder not in ALLOWED_FOLDERS:
        return {"code": 1, "message": "专家包或目录不存在"}
    clean = _safe_rel_name(name)
    if not clean:
        return {"code": 1, "message": "非法文件名"}
    path = d / folder / clean
    if path.is_file():
        path.unlink()
    return {"code": 0, "data": None, "message": "ok"}
