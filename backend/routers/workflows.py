"""Workflow 工作流定义读取与 DAG 校验。

工作流以 JSON 文件存放在 backend/workflows/ 目录，每个文件包含：
id、name、description、nodes（DAG 节点）、edges（依赖边）。
本路由只负责读取与校验；执行由前端引擎驱动（复用 /proxy/chat 与 /skills/execute）。
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import APIRouter

router = APIRouter(prefix="/workflows", tags=["workflows"])

PROJECT_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent.parent))
WORKFLOWS_DIR = PROJECT_ROOT / "backend" / "workflows"


def _input_refs(node: dict[str, Any]) -> list[str]:
    """提取节点 inputs 中的上游引用（$node_id 形式，$input 除外）。"""
    refs: list[str] = []
    inputs = node.get("inputs") or {}
    if not isinstance(inputs, dict):
        return refs
    for value in inputs.values():
        if isinstance(value, str) and value.startswith("$") and value != "$input":
            refs.append(value[1:])
    return refs


def _build_deps(workflow: dict[str, Any]) -> tuple[dict[str, set[str]], str | None]:
    """合并显式 edges 与 inputs 隐式引用，得到依赖表；返回 (deps, error)。"""
    nodes = workflow.get("nodes") or []
    ids = [n.get("id") for n in nodes if isinstance(n, dict)]
    id_set = set(ids)
    deps: dict[str, set[str]] = {node_id: set() for node_id in ids}

    def add_edge(src: str, dst: str) -> str | None:
        if src not in id_set:
            return f"依赖边引用了不存在的节点: {src}"
        if dst not in id_set:
            return f"依赖边引用了不存在的节点: {dst}"
        if src == dst:
            return f"节点 {src} 不能依赖自身"
        deps[dst].add(src)
        return None

    for edge in workflow.get("edges") or []:
        if not isinstance(edge, dict):
            return deps, "edges 中存在非法条目（应为 {from, to} 对象）"
        err = add_edge(str(edge.get("from", "")), str(edge.get("to", "")))
        if err:
            return deps, err

    for node in nodes:
        for ref in _input_refs(node):
            if ref not in id_set:
                return deps, f"节点 {node.get('id')} 的输入引用了不存在的节点: ${ref}"
            err = add_edge(ref, str(node.get("id")))
            if err:
                return deps, err
    return deps, None


def _validate(workflow: dict[str, Any]) -> tuple[list[str], str | None]:
    """校验工作流结构并做拓扑排序，返回 (order, error)。"""
    if not workflow.get("id"):
        return [], "缺少工作流 id"
    if not workflow.get("name"):
        return [], "缺少工作流 name"
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list) or len(nodes) == 0:
        return [], "nodes 不能为空"
    if len({str(n.get("id")) for n in nodes if isinstance(n, dict)}) != len(nodes):
        return [], "存在重复或缺失的节点 id"
    for node in nodes:
        if not isinstance(node, dict) or not node.get("id") or not node.get("name"):
            return [], "每个节点必须包含 id 和 name"

    deps, err = _build_deps(workflow)
    if err:
        return [], err

    # Kahn 拓扑排序：剩余节点即为环成员
    indegree = {node_id: len(preds) for node_id, preds in deps.items()}
    queue = deque(node_id for node_id, deg in indegree.items() if deg == 0)
    order: list[str] = []
    while queue:
        node_id = queue.popleft()
        order.append(node_id)
        for other, preds in deps.items():
            if node_id in preds:
                indegree[other] -= 1
                if indegree[other] == 0:
                    queue.append(other)
    if len(order) < len(deps):
        cyclic = [node_id for node_id in deps if node_id not in order]
        return [], f"DAG 存在环，涉及节点: {', '.join(cyclic)}"
    return order, None


def _load_workflows() -> list[dict[str, Any]]:
    """读取全部工作流定义（含校验结果）。"""
    items: list[dict[str, Any]] = []
    if not WORKFLOWS_DIR.is_dir():
        return items
    for path in sorted(WORKFLOWS_DIR.glob("*.json")):
        entry: dict[str, Any] = {"file": path.name}
        try:
            workflow = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            entry.update({"id": path.stem, "name": path.stem, "valid": False, "error": f"JSON 解析失败: {exc}"})
            items.append(entry)
            continue
        order, err = _validate(workflow)
        entry.update({
            "id": workflow.get("id") or path.stem,
            "name": workflow.get("name") or path.stem,
            "description": workflow.get("description") or "",
            "node_count": len(workflow.get("nodes") or []),
            "edge_count": len(workflow.get("edges") or []),
            "valid": err is None,
            "error": err or "",
            "order": order,
        })
        items.append(entry)
    return items


@router.get("")
async def list_workflows() -> dict[str, Any]:
    """列出全部工作流（摘要 + 校验状态）。"""
    return {"code": 0, "data": _load_workflows(), "message": "ok"}


@router.get("/{workflow_id}")
async def get_workflow(workflow_id: str) -> dict[str, Any]:
    """获取单个工作流完整定义；DAG 非法（如存在环）时返回错误信息。"""
    for entry in _load_workflows():
        if entry.get("id") == workflow_id:
            if not entry.get("valid"):
                return {"code": 1, "data": entry, "message": entry.get("error") or "工作流定义非法"}
            path = WORKFLOWS_DIR / entry["file"]
            workflow = json.loads(path.read_text(encoding="utf-8"))
            workflow["order"] = entry["order"]
            return {"code": 0, "data": workflow, "message": "ok"}
    return {"code": -1, "data": None, "message": f"工作流不存在: {workflow_id}"}


# ── 工作流管理（导入 / 导出 / 删除）────────────────────

# 内置工作流 ID 集合（不可删除）
_BUILTIN_IDS = {"default-dev-flow", "parallel-research"}


@router.post("/import")
async def import_workflow(body: dict[str, Any]) -> dict[str, Any]:
    """导入工作流 JSON 定义。"""
    data = body.get("data") or {}
    if not data.get("id") or not data.get("name"):
        return {"code": 1, "message": "工作流必须包含 id 和 name 字段"}
    wf_id = re.sub(r"[^\w\u4e00-\u9fff.-]", "-", str(data["id"]).strip()).strip(".")[:64]
    if not wf_id:
        return {"code": 1, "message": "无效的工作流 ID"}
    data["id"] = wf_id
    _, err = _validate(data)
    if err:
        return {"code": 1, "message": f"工作流校验失败: {err}"}
    path = WORKFLOWS_DIR / f"{wf_id}.json"
    try:
        WORKFLOWS_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as e:
        return {"code": 1, "message": f"写入失败: {e}"}
    return {"code": 0, "data": {"id": wf_id, "file": path.name}, "message": "ok"}


@router.get("/{workflow_id}/export")
async def export_workflow(workflow_id: str) -> dict[str, Any]:
    """导出单个工作流 JSON 定义。"""
    for entry in _load_workflows():
        if entry.get("id") == workflow_id:
            path = WORKFLOWS_DIR / entry["file"]
            try:
                workflow = json.loads(path.read_text(encoding="utf-8"))
                return {"code": 0, "data": workflow, "message": "ok"}
            except json.JSONDecodeError:
                return {"code": -1, "data": None, "message": f"工作流文件损坏: {entry['file']}"}
    return {"code": -1, "data": None, "message": f"工作流不存在: {workflow_id}"}


@router.delete("/{workflow_id}")
async def delete_workflow(workflow_id: str) -> dict[str, Any]:
    """删除自定义工作流（内置工作流不可删除）。"""
    if workflow_id in _BUILTIN_IDS:
        return {"code": 1, "message": "内置工作流不可删除"}
    for entry in _load_workflows():
        if entry.get("id") == workflow_id:
            path = WORKFLOWS_DIR / entry["file"]
            try:
                os.remove(path)
            except OSError as e:
                return {"code": 1, "message": f"删除失败: {e}"}
            return {"code": 0, "data": None, "message": "ok"}
    return {"code": -1, "data": None, "message": f"工作流不存在: {workflow_id}"}
