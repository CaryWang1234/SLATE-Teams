# -*- coding: utf-8 -*-
"""Actions 路由：data/actions/<id>.yml，一文件一份流程说明书。

设计见 ACTIONS-DESIGN.md。P0 是读（目录、详情、试校验），P1 补上写：
整份覆盖写入、删除、以及 `.history/` 留底与回滚。写入口本身不设二次确认——
用户侧的审批门在前端（面板编辑器 + `actions_write` 工具都要人明示点确认），
后端保证的是「进来的东西必须能解析」，以及「覆盖/删除之前必先留底」。

不抛 500：所有失败都回 {code:-1, message:中文}（与 diagnostics 同口径），
否则前端只会看到一个没有上下文的请求错误。
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from backend import scope_overlay
from backend.data_io import atomic_write_text
from backend.skills.code_scan import SECRET_PATTERNS
from backend.slate_yaml import (
    MAX_FILE_BYTES,
    SayError,
    load_action,
    parse,
    validate_action,
    ACTION_ID_RE,
)

router = APIRouter(prefix="/actions", tags=["actions"])
logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))
ACTIONS_DIR = DATA_DIR / "actions"
HISTORY_DIR = ACTIONS_DIR / ".history"
HISTORY_KEEP = 5
# 留底时间戳定宽，字典序即时序；restore 入参先按这条正则消毒，再谈拼路径
HISTORY_TS_RE = re.compile(r"^\d{8}T\d{6}(?:-\d{1,2})?$")


class ActionDraft(BaseModel):
    content: str = ""
    # 落点：""|global＝本机全局那份，project＝这个项目自己那份（写进 <项目>/.slate/actions/）。
    # 缺省走全局，和 P4 之前的行为逐字一致；面板与工具都要显式点名才落到项目里。
    scope: str = ""


class ActionRestore(BaseModel):
    ts: str = ""
    scope: str = ""


def _clean_id(raw: Any) -> str:
    """先消毒再拼路径：不合法直接返回空串，绝不拿去 join。"""
    text = str(raw or "").strip()
    return text if ACTION_ID_RE.match(text) else ""


def _action_path(clean_id: str, base: Path | None = None) -> Path | None:
    """解析后必须仍在该落点的目录内，挡住 ../ 与符号链接外逃。"""
    if not clean_id:
        return None
    root = base or ACTIONS_DIR
    base_dir = root.resolve()
    target = (base_dir / f"{clean_id}.yml").resolve()
    return target if target.parent == base_dir else None


def _scope_base(project_id: str, scope: str) -> Path | None:
    """写盘落点：project 必须项目在册（否则 None，调用方回错误，绝不偷偷写到全局去）。"""
    if scope == "project":
        return scope_overlay.project_actions_dir(project_id)
    return ACTIONS_DIR


def _read_target(clean_id: str, project_id: str) -> Path | None:
    """读取落点：同 id 的项目版顶掉全局版（这就是"生效的那一份"）。"""
    if not clean_id:
        return None
    base = scope_overlay.project_actions_dir(project_id)
    if base:
        local = _action_path(clean_id, base)
        if local and local.is_file():
            return local
    return _action_path(clean_id, ACTIONS_DIR)


def _history_dir_of(target: Path | None) -> Path:
    """留底跟着落点走：项目那份的历史留在项目自己的 .slate/actions/.history 里，
    不与全局那份混在同一堆时间戳中。"""
    return (target.parent / ".history") if target else HISTORY_DIR


def _history_dir_for(base: Path | None) -> Path | None:
    """按写入落点算它的留底目录；落点都拿不到（项目不在册）时返回 None。"""
    return (base / ".history") if base else None


def _read_source(path: Path) -> str:
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            raise SayError(f"文件超过 {MAX_FILE_BYTES} 字节上限")
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise SayError(f"读取失败：{exc.__class__.__name__}") from exc


def _secret_warnings(text: str) -> list[str]:
    """明文凭证不阻断写入，但必须说清楚：Action 会长期进系统提示，等于把 Key 摆给模型。
    正则口径直接复用 code_scan，两处各写一份必然漂移。"""
    return sorted({
        f"内容疑似「{rule.category}」（{rule.description}）。Action 会注入系统提示，建议改成引用环境变量或文件位置，不要写明文"
        for rule in SECRET_PATTERNS if rule.pattern.search(text)
    })


def _history_path(clean_id: str, raw_ts: Any, history_dir: Path | None = None) -> Path | None:
    """ts 先过正则再拼路径，解析后仍须留在该落点的 .history 内。"""
    ts = str(raw_ts or "").strip()
    if not clean_id or not HISTORY_TS_RE.match(ts):
        return None
    base = (history_dir or HISTORY_DIR).resolve()
    target = (base / f"{clean_id}.{ts}.yml").resolve()
    return target if target.parent == base else None


def _history_versions(clean_id: str, history_dir: Path | None = None) -> list[dict[str, Any]]:
    base = history_dir or HISTORY_DIR
    if not clean_id or not base.is_dir():
        return []
    prefix = f"{clean_id}."
    out: list[dict[str, Any]] = []
    for entry in base.iterdir():
        if not entry.is_file() or not entry.name.endswith(".yml") or not entry.name.startswith(prefix):
            continue
        ts = entry.name[:-4][len(prefix):]
        if not HISTORY_TS_RE.match(ts):
            continue
        try:
            size = entry.stat().st_size
        except OSError:
            continue
        out.append({"ts": ts, "bytes": size})
    out.sort(key=lambda item: item["ts"], reverse=True)
    return out


def _prune_history(clean_id: str, history_dir: Path | None = None) -> None:
    for entry in _history_versions(clean_id, history_dir)[HISTORY_KEEP:]:
        try:
            path = _history_path(clean_id, entry["ts"], history_dir)
            if path:
                path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Action %s 旧留底清理失败: %s", clean_id, exc)


def _backup(clean_id: str, path: Path, history_dir: Path | None = None) -> str:
    """覆盖/删除前留底，返回留底时间戳（没有旧文件则空串）。

    留底失败绝不允许把写入也一起废掉——用户点了保存就该落盘；但也不假装留了底。
    """
    if not path.is_file():
        return ""
    base = history_dir or HISTORY_DIR
    try:
        source = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        logger.warning("Action %s 留底读取失败: %s", clean_id, exc)
        return ""
    try:
        base.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        target = base / f"{clean_id}.{stamp}.yml"
        suffix = 1
        while target.exists():
            target = base / f"{clean_id}.{stamp}-{suffix}.yml"
            suffix += 1
        atomic_write_text(target, source)
    except OSError as exc:
        logger.warning("Action %s 留底写入失败: %s", clean_id, exc)
        return ""
    _prune_history(clean_id, base)
    return target.name[:-4][len(clean_id) + 1:]


def _write_action(clean_id: str, text: str, *, note: str,
                  project_id: str = "", scope: str = "") -> dict[str, Any]:
    """PUT 与回滚共用的唯一落盘路径：体积 → 解析 → 留底 → 原子写。
    两条入口分开写两遍的话，早晚会有一条偷偷少做一次校验。

    scope=project 但项目不在册 → 直接拒绝。这里绝不"退而写进全局"：用户点名要
    存进这个项目，偷偷写到本机全局那份会连带影响所有别的项目。
    """
    if scope == "project" and not project_id:
        return {"code": -1, "data": None, "message": "要写进项目那一份，得先在项目视野里（未打开项目）"}
    base = _scope_base(project_id, scope)
    if base is None:
        return {"code": -1, "data": None, "message": "项目不在册或目录已搬走，没写；这份改动落不到项目里"}
    path = _action_path(clean_id, base)
    if not path:
        return {"code": -1, "data": None, "message": "Action 路径不合法"}
    size = len(text.encode("utf-8"))
    if size > MAX_FILE_BYTES:
        return {"code": -1, "data": None, "message": f"内容 {size} 字节，超过 {MAX_FILE_BYTES} 字节上限"}
    try:
        spec, warnings = load_action(text, action_id=clean_id)
    except SayError as exc:
        return {"code": -1, "data": None, "message": f"Action {clean_id} 校验未通过：{exc}"}
    created = not path.is_file()
    try:
        base.mkdir(parents=True, exist_ok=True)
        backed_up = _backup(clean_id, path, _history_dir_of(path))
        atomic_write_text(path, text)
    except OSError as exc:
        return {"code": -1, "data": None, "message": f"写入失败：{exc.__class__.__name__}"}
    return {
        "code": 0,
        "data": {
            "id": clean_id,
            "path": str(path),
            "scope": scope or "global",
            "created": created,
            "stepCount": len(spec["steps"]),
            "inputCount": len(spec["inputs"]),
            "warnings": [*warnings, *_secret_warnings(text)],
            "backedUp": backed_up,
        },
        "message": note,
    }


def _describe(clean_id: str, spec: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": clean_id,
        "name": spec["name"],
        "description": spec["description"],
        "when": spec["when"],
        "tags": spec["tags"],
        "author": spec["author"],
        "stepCount": len(spec["steps"]),
        "inputCount": len(spec["inputs"]),
        # 黑板工作流视图要靠这一格判断"跑完会不会往黑板回写"，故摘要里带上落点；
        # 步骤正文仍只在 /actions/{id} 详情里给，摘要膨胀会撑大系统提示的目录注入。
        "outputDestination": spec["output"]["destination"],
    }


def _load_all(project_id: str = "") -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """返回 (可用 Action 摘要, 解析失败的文件)。失败的文件必须露出来，
    否则用户改坏一个 yml 只会看到它凭空消失。

    目录是"全局 + 项目覆盖"合并后的那一份：同 id 时项目版顶掉全局版，
    每条摘要带 `scope`（project|global），界面据此写明现在看的是哪一份。
    """
    specs: list[dict[str, Any]] = []
    broken: list[dict[str, str]] = []
    for clean_id, path, scope in scope_overlay.effective_action_files(project_id):
        if not _clean_id(clean_id):
            broken.append({"id": path.name, "error": "文件名不合法：只允许小写字母开头的 a-z0-9_-",
                           "scope": scope})
            continue
        try:
            spec, _warnings = load_action(_read_source(path), action_id=clean_id)
        except SayError as exc:
            broken.append({"id": clean_id, "error": str(exc) or exc.reason, "scope": scope})
            continue
        except Exception as exc:  # 解析器不该有未穷尽路径，兜住以免一个坏文件拖垮整个面板
            logger.warning("Action %s 解析异常: %s", clean_id, exc)
            broken.append({"id": clean_id, "error": f"解析异常：{exc.__class__.__name__}", "scope": scope})
            continue
        item = _describe(clean_id, spec)
        item["scope"] = scope
        specs.append(item)
    specs.sort(key=lambda item: str(item["id"]))
    return specs, broken


@router.get("")
async def list_actions(project: str = "") -> dict[str, Any]:
    """Action 目录（只给摘要，正文按 id 另取）。带 project 时给的是合并后的生效目录。"""
    pid = scope_overlay.canonical_project_id(project)
    specs, broken = _load_all(pid)
    return {
        "code": 0,
        "data": {"path": str(ACTIONS_DIR), "actions": specs, "broken": broken,
                 "project_id": pid, "scope": "project" if pid else "global"},
        "message": "ok",
    }


@router.post("/validate")
async def validate_draft(body: ActionDraft) -> dict[str, Any]:
    """试校验一段草稿：不落盘，供编辑器实时报错定位到行。"""
    text = str(body.content or "")
    try:
        spec, warnings = validate_action(parse(text))
    except SayError as exc:
        return {
            "code": 0,
            "data": {"ok": False, "errors": [{"line": exc.line, "reason": exc.reason}], "warnings": []},
            "message": "校验未通过",
        }
    return {
        "code": 0,
        "data": {"ok": True, "errors": [], "warnings": [*warnings, *_secret_warnings(text)], "action": spec},
        "message": "ok",
    }


@router.get("/{action_id}")
async def get_action(action_id: str, project: str = "", scope: str = "") -> dict[str, Any]:
    """单个 Action 的完整结构 + 原文（面板与 actions_read 工具共用）。

    缺省给"生效的那一份"（同 id 项目版顶掉全局版）；`?scope=global` 指名要看全局那份，
    编辑器里"覆盖只改了项目版、全局还在动"这件事必须能被用户亲眼看到，否则文案说不服人。
    """
    clean_id = _clean_id(action_id)
    if not clean_id:
        return {"code": -1, "data": None, "message": f"无效的 Action 名称: {action_id}"}
    pid = scope_overlay.canonical_project_id(project)
    if scope == "global":
        path = _action_path(clean_id, ACTIONS_DIR)
    elif scope == "project":
        path = _action_path(clean_id, scope_overlay.project_actions_dir(pid))
    else:
        path = _read_target(clean_id, pid)
    if not path or not path.is_file():
        return {"code": -1, "data": None, "message": f"Action 不存在: {clean_id}"}
    try:
        source = _read_source(path)
        spec, warnings = load_action(source, action_id=clean_id)
    except SayError as exc:
        return {"code": -1, "data": None, "message": f"Action {clean_id} 无法解析：{exc}"}
    return {
        "code": 0,
        "data": {"action": spec, "raw": source, "path": str(path), "warnings": warnings,
                 "scope": "project" if path.parent == scope_overlay.project_actions_dir(pid) else "global"},
        "message": "ok",
    }


@router.put("/{action_id}")
async def put_action(action_id: str, body: ActionDraft, project: str = "") -> dict[str, Any]:
    """整份覆盖写入一个 Action（面板保存与 actions_write 共用）。落点由 body.scope 点名。"""
    clean_id = _clean_id(action_id)
    if not clean_id:
        return {"code": -1, "data": None, "message": f"无效的 Action 名称: {action_id}"}
    pid = scope_overlay.canonical_project_id(project)
    return _write_action(clean_id, str(body.content or ""), note="已写入",
                         project_id=pid, scope=body.scope or "global")


@router.delete("/{action_id}")
async def delete_action(action_id: str, project: str = "", scope: str = "") -> dict[str, Any]:
    """删除一份 Action：先留底再删，给用户留「我反悔了」的出口。

    带 `?scope=project` 删的是项目那份——摘掉覆盖之后，全局那份会重新生效，
    这不是"把这一份流程整个删掉"。这个区别必须回在 message 里，光靠图标看不出来。
    """
    clean_id = _clean_id(action_id)
    if not clean_id:
        return {"code": -1, "data": None, "message": f"无效的 Action 名称: {action_id}"}
    pid = scope_overlay.canonical_project_id(project)
    if scope == "project":
        base = scope_overlay.project_actions_dir(pid)
    elif scope == "global":
        base = ACTIONS_DIR
    else:
        return {"code": -1, "data": None, "message": "删哪一份要说清楚：项目那份还是全局那份"}
    path = _action_path(clean_id, base)
    if not path or not path.is_file():
        return {"code": -1, "data": None, "message": f"Action 不存在: {clean_id}"}
    history = _history_dir_of(path)
    backed_up = _backup(clean_id, path, history)
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        return {"code": -1, "data": None, "message": f"删除失败：{exc.__class__.__name__}"}
    falls_back = scope == "project" and (ACTIONS_DIR / f"{clean_id}.yml").is_file()
    return {
        "code": 0,
        "data": {"removed": clean_id, "scope": scope, "backedUp": backed_up,
                 "path": str(history), "falls_back_to_global": falls_back},
        "message": "已摘掉项目覆盖，这一份回到全局那一份" if falls_back else "已删除",
    }


@router.get("/{action_id}/history")
async def list_history(action_id: str, project: str = "", scope: str = "") -> dict[str, Any]:
    """某份 Action 的留底清单（最新在前）。留底按落点各存一处，所以这里也要说清看的是哪一份。"""
    clean_id = _clean_id(action_id)
    if not clean_id:
        return {"code": -1, "data": None, "message": f"无效的 Action 名称: {action_id}"}
    history = _history_base(project, scope)
    if history is None:
        return {"code": -1, "data": None, "message": "项目不在册或目录已搬走，取不到它自己的留底"}
    return {
        "code": 0,
        "data": {"id": clean_id, "keep": HISTORY_KEEP, "scope": scope or "global",
                 "versions": _history_versions(clean_id, history)},
        "message": "ok",
    }


def _history_base(project: str, scope: str) -> Path | None:
    """按 scope 取该落点的留底目录。

    点名要项目那份、但项目不在册时返回 None 并由调用方报错——这时候悄悄去看全局的留底，
    用户会把另一份文件的历史当成这一份的。
    """
    if scope == "project":
        base = scope_overlay.project_actions_dir(scope_overlay.canonical_project_id(project))
        return _history_dir_for(base)
    return _history_dir_for(ACTIONS_DIR)


@router.get("/{action_id}/history/{ts}")
async def read_history(action_id: str, ts: str, project: str = "", scope: str = "") -> dict[str, Any]:
    """读一个留底的原文：回滚前得让人看清楚要恢复什么。"""
    clean_id = _clean_id(action_id)
    history = _history_base(project, scope)
    if history is None:
        return {"code": -1, "data": None, "message": "项目不在册或目录已搬走，取不到它自己的留底"}
    path = _history_path(clean_id, ts, history)
    if not clean_id:
        return {"code": -1, "data": None, "message": f"无效的 Action 名称: {action_id}"}
    if not path or not path.is_file():
        return {"code": -1, "data": None, "message": f"历史版本不存在: {clean_id} @ {ts}"}
    try:
        source = _read_source(path)
    except SayError as exc:
        return {"code": -1, "data": None, "message": f"历史版本读取失败：{exc}"}
    return {
        "code": 0,
        "data": {"id": clean_id, "ts": ts, "content": source, "bytes": len(source.encode("utf-8"))},
        "message": "ok",
    }


@router.post("/{action_id}/history/restore")
async def restore_history(action_id: str, body: ActionRestore, project: str = "") -> dict[str, Any]:
    """回滚到某个留底。回滚也是写：解析不了的旧版本不许直接盖回去，落点也按 body.scope 点名。"""
    clean_id = _clean_id(action_id)
    if not clean_id:
        return {"code": -1, "data": None, "message": f"无效的 Action 名称: {action_id}"}
    history = _history_base(project, body.scope)
    if history is None:
        return {"code": -1, "data": None, "message": "项目不在册或目录已搬走，取不到它自己的留底"}
    path = _history_path(clean_id, body.ts, history)
    if not path or not path.is_file():
        return {"code": -1, "data": None, "message": f"历史版本不存在: {clean_id} @ {body.ts}"}
    try:
        source = _read_source(path)
    except SayError as exc:
        return {"code": -1, "data": None, "message": f"历史版本读取失败：{exc}"}
    try:
        load_action(source, action_id=clean_id)
    except SayError as exc:
        return {"code": -1, "data": None, "message": f"该历史版本已无法解析，不回滚：{exc}"}
    return _write_action(clean_id, source, note="已回滚")
