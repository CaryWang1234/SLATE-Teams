"""工具工厂：让 SLATE 自生产适配自身的工具。

根据描述生成符合 SLATE 工具规范的 Python 模块，落到 **data/evolved/**（用户数据区），
由 backend/evolution.py 负责装载、启用/停用、留底与回滚。
标准 MCP 协议端点见 backend/routers/mcp.py。

产物不落 backend/skills/：那是源码目录，一次重装就把攒下来的自生产工具全冲掉，
而且"程序往自己源码树里写文件"本身就越过了「零自主修改」这条线。
"""

from __future__ import annotations

import re
from typing import Any

from backend import evolution

# 工具模板（占位符用 __XXX__ 包裹，避免与用户代码中的 {} 冲突）
TOOL_TEMPLATE = '''"""__DESCRIPTION__

由工具工厂自动生成。
"""

from __future__ import annotations

from typing import Any


def execute(__PARAMS__) -> dict[str, Any]:
    """执行工具逻辑。

    Args:
__PARAM_DOCS__
    Returns:
        dict: 执行结果。
    """
    # ── 参数校验 ──
__VALIDATIONS__

    # ── 核心逻辑 ──
__BODY__

    return {"status": "ok", "message": "工具执行成功"}
'''


def _clean_text(text: Any) -> str:
    """折叠空白为单行并去掉会破坏 docstring 的三连引号。"""
    return " ".join(str(text or "").split()).replace('"""', "'''")


def _sanitize_name(name: str) -> str:
    """清理工具名称：只留 a-z0-9_（工具名就是文件名，也是模型调用时写的那串）。

    截到 48 是跟 evolution 那条正则对齐的——留下 64 位会在落盘那一步被判定"名字不合法"，
    等于把一个本来能救的调用推成一次莫名失败。
    """
    cleaned = re.sub(r"[^0-9a-z_]+", "_", str(name or "").strip().lower())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    if cleaned[:1].isdigit():
        cleaned = f"tool_{cleaned}"
    return cleaned[:48]


def _generate_params(param_specs: list[dict]) -> tuple[str, str, str]:
    """根据参数规格生成函数签名、文档和校验代码。

    Returns:
        (params_str, param_docs, validations)
    """
    params = []
    docs = []
    validations = []

    for spec in param_specs:
        name = _sanitize_name(spec.get("name", ""))
        if not name:
            continue

        ptype = spec.get("type", "str")
        required = spec.get("required", True)
        default = spec.get("default", "")
        desc = _clean_text(spec.get("description", ""))

        # 函数签名：默认值必须生成合法的 Python 字面量，
        # 否则 default 含引号/换行/非数值时会生成语法错误的文件
        if ptype == "int":
            try:
                dv = int(default)
            except (TypeError, ValueError):
                dv = 0
            params.append(f"{name}: int = {dv}")
        elif ptype == "float":
            try:
                dv = float(default)
            except (TypeError, ValueError):
                dv = 0.0
            params.append(f"{name}: float = {dv}")
        elif ptype == "bool":
            params.append(f"{name}: bool = {bool(default)}")
        elif ptype == "list":
            params.append(f"{name}: list = None")
        elif ptype == "dict":
            params.append(f"{name}: dict = None")
        else:
            params.append(f"{name}: str = {repr(str(default))}" if default else f"{name}: str = ''")

        # 文档
        type_desc = f"({ptype})" if ptype else ""
        req_desc = "[必填]" if required else "[可选]"
        docs.append(f"        {name} {type_desc}: {desc} {req_desc}")

        # 校验
        if required and ptype == "str":
            validations.append(f'    if not {name}:')
            validations.append(f'        return {{"error": "参数 {name} 不能为空"}}')
        elif required and ptype in ("list", "dict"):
            validations.append(f'    if {name} is None:')
            validations.append(f'        return {{"error": "参数 {name} 不能为空"}}')

    return ", ".join(params), "\n".join(docs), "\n".join(validations)


def execute(
    tool_name: str = "",
    description: str = "",
    params: list = None,
    body: str = "",
    overwrite: bool = False,
    **_kw: Any,
) -> dict[str, Any]:
    """创建或覆盖一个自进化工具。

    Args:
        tool_name: 工具名称（英文，将作为模块名）
        description: 工具功能描述
        params: 参数规格列表，每项包含 name/type/required/default/description
        body: 工具核心逻辑代码（Python 代码字符串）
        overwrite: 是否覆盖已有的同名自进化工具

    Returns:
        dict: 包含 tool_name, file_path, description 等信息
    """
    name = _sanitize_name(tool_name)
    if not name:
        return {"error": "tool_name 不能为空，且只能包含字母数字下划线"}

    if not description:
        return {"error": "description 不能为空"}

    if not body or not body.strip():
        return {"error": "body 不能为空，请提供工具的核心逻辑代码"}

    # 与内置工具同名是自找没趣：那条调用路径先命中内置，生成的这份永远不会被跑到。
    # 与其让用户攒一个死文件，不如当场说清楚，换个名字再来。
    if name in evolution.builtin_names():
        return {"error": f"{name} 已是内置工具名，自生成的同名工具会被内置顶掉；请换一个名字"}

    existing = evolution.read_manifest(name)
    if existing and not overwrite:
        return {
            "error": f"工具 {name} 已存在，设置 overwrite=true 可覆盖（覆盖前会自动留底，可在「扩展 → 新功能」里回滚）",
            "existing_path": str(evolution.EVOLVED_DIR / f"{name}.py"),
        }

    param_list = params or []
    params_str, param_docs, validations = _generate_params(param_list)

    # 确保 body 有正确的缩进
    body_lines = body.strip().split("\n")
    indented = "\n".join("    " + line if line.strip() else "" for line in body_lines)

    # 生成代码（占位符替换，避免 .format 与用户代码中的 {} 冲突）
    code = (TOOL_TEMPLATE
            .replace("__DESCRIPTION__", _clean_text(description))
            .replace("__PARAMS__", params_str)
            .replace("__PARAM_DOCS__", param_docs or "        无参数")
            .replace("__VALIDATIONS__", validations or "    # 无需校验")
            .replace("__BODY__", indented))

    result = evolution.save_tool(name, description, param_list, code, note="ok")
    if result["code"] != 0:
        return {"error": result["message"]}

    data = result["data"]
    # 装载一次：语法过了不代表 import 得过（比如 body 里引用了没装的包）。
    # 当场报出来，比模型下次调用时才发现"装载失败"省一整轮。
    module, load_error = evolution.load_module(name)
    if load_error:
        return {
            "warning": f"工具已写入但装载失败：{load_error}",
            "tool_name": name,
            "file_path": data["file_path"],
            "description": description,
        }

    return {
        "status": "ok",
        "tool_name": name,
        "file_path": data["file_path"],
        "description": description,
        "params_count": len(param_list),
        "backed_up": data.get("backed_up", ""),
        "message": (f"工具 {name} 创建成功，已登记到「扩展 → 新功能」"
                    + ("（覆盖前已留底，可随时回滚）" if data.get("backed_up") else "")),
    }
