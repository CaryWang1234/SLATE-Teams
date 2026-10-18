# -*- coding: utf-8 -*-
"""
python_api_extract — Python 库公共 API 提取 工具（零依赖）。

改编自外部项目 pyparser：递归提取目标包/模块的公共 API
（函数签名、docstring、类方法与属性、源码位置、调用示例），
输出 JSON 或 Markdown 文档，落盘到数据目录 outputs/，
返回 file_path 与 preview_url。

target 支持：
1. 已安装的包名（如 requests / json）
2. 本地 .py 文件路径
3. 本地包目录（含 __init__.py）或含多个 .py 的目录
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
import inspect
import json
import os
import pkgutil
import re
import sys
import textwrap
import warnings
from datetime import datetime
from pathlib import Path
from types import ModuleType
from typing import Any, Optional

from backend.skills.sandbox import is_path_safe

DATA_DIR = Path(os.environ.get("SLATE_DATA_DIR", Path(__file__).resolve().parent.parent.parent / "data"))

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------


def _get_version(lib_name: str) -> str:
    """尝试获取库的版本号，失败则返回 'unknown'。"""
    try:
        mod = importlib.import_module(lib_name)
        for attr in ("__version__", "VERSION", "version"):
            if hasattr(mod, attr):
                return str(getattr(mod, attr))
        return "unknown"
    except Exception:
        return "unknown"


def _safe_import(name: str, package: Optional[str] = None) -> Optional[ModuleType]:
    """安全导入模块，捕获所有异常，避免因副作用导致崩溃。"""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return importlib.import_module(name, package=package)
    except Exception:
        return None


def _is_c_extension(obj: Any) -> bool:
    """判断对象是否为 C 扩展实现（inspect 无法获取源码）。"""
    try:
        inspect.getfile(obj)
        return False
    except (TypeError, OSError):
        return True


def _get_source_info(obj: Any) -> tuple[str, int]:
    """获取对象的源码文件路径和起始行号，失败返回 ('N/A', 0)。"""
    try:
        file_path = inspect.getfile(obj)
        line_number = inspect.getsourcelines(obj)[1]
        return file_path, line_number
    except (TypeError, OSError):
        return "N/A", 0


def _format_signature(obj: Any) -> str:
    """获取签名；C 扩展降级为 [C Extension] 标记。"""
    try:
        return str(inspect.signature(obj))
    except (ValueError, TypeError):
        if _is_c_extension(obj):
            return "[C Extension]"
        return "(?)"


def _extract_docstring(obj: Any) -> str:
    """提取文档字符串第一行作为简要描述；缺失则返回 'N/A'。"""
    raw = inspect.getdoc(obj)
    if raw:
        return raw.split("\n", 1)[0].strip()
    return "N/A"


def _split_params(params_str: str) -> list[str]:
    """智能分割函数参数（考虑嵌套括号）。"""
    parts = []
    depth = 0
    current = []
    for ch in params_str:
        if ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            if ch in "([{":
                depth += 1
            elif ch in ")]}":
                depth -= 1
            current.append(ch)
    if current:
        parts.append("".join(current))
    return parts


def _generate_example_call(func_name: str, sig: str) -> str:
    """基于签名字符串生成调用示例。"""
    if sig in ("[C Extension]", "(?)", ""):
        return ""
    try:
        match = re.match(r"\((.*)\)", sig.split("->")[0].strip())
        if not match:
            return f"{func_name}()"
        params_str = match.group(1).strip()
        if not params_str:
            return f"{func_name}()"

        parts = [p.strip() for p in _split_params(params_str)]
        filtered = []
        for p in parts:
            name_only = p.split(":")[0].split("=")[0].strip()
            if name_only in ("self", "cls", "*", "**", "/"):
                continue
            if name_only.startswith("_"):
                continue
            if p.startswith("*") or p.startswith("**"):
                continue
            filtered.append(p)
        if len(filtered) > 3:
            return ""

        args = []
        for p in filtered:
            name_only = p.split(":")[0].split("=")[0].strip()
            if "=" in p:
                args.append(f"{name_only}={p.split('=', 1)[1].strip()}")
            else:
                args.append(f"{name_only}=...")
        return f"{func_name}({', '.join(args)})"
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# 模块发现
# ---------------------------------------------------------------------------

def _should_skip_module(name: str) -> bool:
    """跳过私有模块与 __pycache__。"""
    for part in name.split("."):
        if part.startswith("_") or part == "__pycache__":
            return True
    return False


def _walk_package(paths: list[str], prefix: str, max_depth: int, current_depth: int, result: list[str]) -> None:
    """递归遍历包路径，收集子模块名。"""
    if max_depth >= 0 and current_depth >= max_depth:
        return
    for _, module_name, is_pkg in pkgutil.walk_packages(paths, prefix=prefix + "."):
        if _should_skip_module(module_name):
            continue
        result.append(module_name)
        if is_pkg:
            try:
                sub_mod = _safe_import(module_name)
                if sub_mod:
                    _track_module(module_name, sub_mod)
                if sub_mod and hasattr(sub_mod, "__path__"):
                    _walk_package(list(sub_mod.__path__), module_name, max_depth, current_depth + 1, result)
            except Exception:
                pass


def _discover_submodules(package: ModuleType, max_depth: int) -> list[str]:
    """递归发现包内的所有子模块。"""
    if not hasattr(package, "__path__"):
        return []
    result: list[str] = []
    _walk_package(list(package.__path__), package.__name__, max_depth, 0, result)
    return result


# 本次提取期间注册进 sys.modules 的临时模块（名字 → 原值，None 表示原本不存在）
_tmp_modules: dict[str, Any] = {}


def _track_module(name: str, mod: Any) -> None:
    """记录并注册临时模块，结束后由 _restore_tmp_modules 恢复。"""
    if name not in _tmp_modules:
        _tmp_modules[name] = sys.modules.get(name)
    sys.modules[name] = mod


def _restore_tmp_modules() -> None:
    """恢复被临时注册的 sys.modules 条目（含 exec 失败留下的半初始化残留）。"""
    while _tmp_modules:
        name, orig = _tmp_modules.popitem()
        if orig is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = orig


def _register_package_in_sys_modules(package_path: Path, pkg_name: str) -> None:
    """将文件系统上的包注册到 sys.modules（临时，结束后恢复）。"""
    init_file = package_path / "__init__.py"
    if not init_file.exists():
        return
    spec = importlib.util.spec_from_file_location(pkg_name, str(init_file))
    if spec is None:
        return
    mod = importlib.util.module_from_spec(spec)
    mod.__path__ = [str(package_path)]
    _track_module(pkg_name, mod)
    try:
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
    except Exception:
        pass


def _discover_modules_from_path(target: str, max_depth: int = -1) -> tuple[str, list[str]]:
    """从文件系统路径发现模块，返回 (包名, 模块名列表)。"""
    target_path = Path(target).resolve()
    if not target_path.exists():
        raise FileNotFoundError(f"路径不存在: {target}")

    if target_path.is_file() and target_path.suffix == ".py":
        spec = importlib.util.spec_from_file_location(target_path.stem, str(target_path))
        if spec is None:
            raise ImportError(f"无法从文件创建模块: {target}")
        mod = importlib.util.module_from_spec(spec)
        _track_module(target_path.stem, mod)
        try:
            spec.loader.exec_module(mod)  # type: ignore[union-attr]
        except Exception as e:
            raise ImportError(f"加载模块失败: {target_path} — {e}")
        return target_path.stem, [target_path.stem]

    # 包目录：注册后按包名导入（父目录临时加入 sys.path）
    init_file = target_path / "__init__.py"
    if init_file.exists():
        pkg_name = target_path.name
        parent = str(target_path.parent)
        inserted = parent not in sys.path
        if inserted:
            sys.path.insert(0, parent)
        try:
            _register_package_in_sys_modules(target_path, pkg_name)
            mod = _safe_import(pkg_name)
        finally:
            if inserted and parent in sys.path:
                sys.path.remove(parent)
        if mod is None:
            raise ImportError(f"包导入失败: {pkg_name}")
        submodules = _discover_submodules(mod, max_depth)
        return pkg_name, [pkg_name] + submodules

    # 普通目录：逐个加载其中的 .py 文件
    module_names: list[str] = []
    for py_file in sorted(target_path.glob("*.py")):
        if py_file.name.startswith("_"):
            continue
        name = py_file.stem
        spec = importlib.util.spec_from_file_location(name, str(py_file))
        if spec is None:
            continue
        mod = importlib.util.module_from_spec(spec)
        _track_module(name, mod)
        try:
            spec.loader.exec_module(mod)  # type: ignore[union-attr]
        except Exception:
            continue
        module_names.append(name)
    if not module_names:
        raise ImportError(f"目录中没有可导入的 .py 文件: {target}")
    return target_path.name, module_names


# ---------------------------------------------------------------------------
# API 提取核心
# ---------------------------------------------------------------------------

def _is_defined_in_module(obj: Any, module: ModuleType) -> bool:
    """检查对象是否定义在当前模块中（而非从其他模块导入）。"""
    try:
        return getattr(obj, "__module__", None) == module.__name__
    except Exception:
        return False


def _extract_function_info(name: str, obj: Any) -> Optional[dict[str, Any]]:
    """提取单个函数/方法的详细信息。"""
    file_path, line_number = _get_source_info(obj)
    signature_str = _format_signature(obj)
    return {
        "name": name,
        "signature": signature_str,
        "docstring": _extract_docstring(obj),
        "file_path": file_path,
        "line_number": line_number,
        "example_call": _generate_example_call(name, signature_str),
    }


def _get_method_kind(cls: type, method_name: str, method_obj: Any) -> str:
    """判断方法类型：instance_method / static_method / class_method。"""
    try:
        raw = inspect.getattr_static(cls, method_name, None)
        if isinstance(raw, staticmethod):
            return "static_method"
        if isinstance(raw, classmethod):
            return "class_method"
        return "instance_method"
    except Exception:
        return "instance_method"


def _extract_class_attributes(cls: type) -> list[str]:
    """提取类的公共数据属性：__init__ AST 中的 self.xxx 赋值 + 类级注解。"""
    attrs: set[str] = set()
    try:
        source = textwrap.dedent(inspect.getsource(cls.__init__))
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == "self":
                        if not t.attr.startswith("_"):
                            attrs.add(t.attr)
            elif isinstance(node, ast.AnnAssign):
                t = node.target
                if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == "self":
                    if not t.attr.startswith("_"):
                        attrs.add(t.attr)
    except (TypeError, OSError, SyntaxError):
        pass
    try:
        hints = inspect.get_annotations(cls, eval_str=False)
        for attr_name in hints:
            if not attr_name.startswith("_") and not callable(getattr(cls, attr_name, None)):
                attrs.add(attr_name)
    except Exception:
        pass
    return sorted(attrs)


def _extract_class_info(name: str, obj: type) -> Optional[dict[str, Any]]:
    """提取类及其方法、属性的详细信息。"""
    file_path, line_number = _get_source_info(obj)
    methods: list[dict[str, Any]] = []
    for method_name, method_obj in inspect.getmembers(obj, inspect.isroutine):
        if method_name.startswith("_") and method_name != "__init__":
            continue
        method_info = _extract_function_info(method_name, method_obj)
        if method_info:
            method_info["kind"] = _get_method_kind(obj, method_name, method_obj)
            methods.append(method_info)
    methods.sort(key=lambda m: m["name"])
    return {
        "name": name,
        "docstring": _extract_docstring(obj),
        "file_path": file_path,
        "line_number": line_number,
        "methods": methods,
        "attributes": _extract_class_attributes(obj),
    }


def extract_module_api(module: ModuleType, module_name: str, is_top_level: bool = False) -> dict[str, Any]:
    """提取单个模块的公共 API：{functions, classes}。"""
    functions: list[dict[str, Any]] = []
    classes: list[dict[str, Any]] = []
    for name, obj in inspect.getmembers(module):
        if name.startswith("_"):
            continue
        if not is_top_level and not _is_defined_in_module(obj, module):
            continue
        if inspect.isfunction(obj) or inspect.isbuiltin(obj):
            info = _extract_function_info(name, obj)
            if info:
                functions.append(info)
        elif inspect.isclass(obj):
            info = _extract_class_info(name, obj)
            if info:
                classes.append(info)
    functions.sort(key=lambda f: f["name"])
    classes.sort(key=lambda c: c["name"])
    return {"functions": functions, "classes": classes}


# ---------------------------------------------------------------------------
# Markdown 输出
# ---------------------------------------------------------------------------

def _format_as_markdown(data: dict[str, Any]) -> str:
    """将 API 数据格式化为 Markdown 文本。"""
    lines: list[str] = []
    lines.append(f"# {data['library_name']} API Documentation")
    lines.append(f"**Version**: {data['version']}")
    lines.append("")
    for module_name, module_data in sorted(data["modules"].items()):
        lines.append(f"## Module `{module_name}`")
        lines.append("")
        funcs = module_data.get("functions", [])
        if funcs:
            lines.append("### Functions")
            lines.append("")
            for f in funcs:
                lines.append(f"#### `{f['name']}`")
                lines.append(f"- **Signature**: `{f['signature']}`")
                lines.append(f"- **Description**: {f['docstring']}")
                if f.get("file_path") and f["file_path"] != "N/A":
                    lines.append(f"- **Source Position**: `{f['file_path']}:{f['line_number']}`")
                if f.get("example_call"):
                    lines.append(f"- **Example Call**: `{f['example_call']}`")
                lines.append("")
        classes = module_data.get("classes", [])
        if classes:
            lines.append("### Classes")
            lines.append("")
            for cls in classes:
                lines.append(f"#### `{cls['name']}`")
                lines.append(f"- **Description**: {cls['docstring']}")
                if cls.get("file_path") and cls["file_path"] != "N/A":
                    lines.append(f"- **Source Position**: `{cls['file_path']}:{cls['line_number']}`")
                if cls.get("attributes"):
                    lines.append(f"- **Attributes**: {', '.join(f'`{a}`' for a in cls['attributes'])}")
                lines.append("")
                methods = cls.get("methods", [])
                if methods:
                    lines.append("**Methods**:")
                    lines.append("")
                    for m in methods:
                        kind_label = {
                            "static_method": "Static Method",
                            "class_method": "Class Method",
                            "instance_method": "Instance Method",
                        }.get(m.get("kind", ""), "方法")
                        lines.append(f"- **{m['name']}** ({kind_label})")
                        lines.append(f"  - Signature: `{m['signature']}`")
                        lines.append(f"  - Description: {m['docstring']}")
                        if m.get("example_call"):
                            lines.append(f"  - Example Call: `{m['example_call']}`")
                        lines.append("")
                lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def execute(target: str = "", depth: int = 1, format: str = "json",
            file_name: str = "", output_dir: str = "", **_kwargs) -> dict[str, Any]:
    """提取 Python 库/模块的公共 API 文档。

    参数：
    - target    : 已安装包名（如 requests）或本地 .py 文件 / 包目录路径
    - depth     : 子模块递归深度，-1 不限（默认 1，建议不超过 3）
    - format    : json / markdown（默认 json）
    - file_name : 输出文件名（可选，默认按目标名+时间戳生成）
    - output_dir: 输出目录（可选，默认数据目录 outputs/）
    """
    tgt = str(target or "").strip()
    if not tgt:
        return {"error": "缺少 target 参数：请提供包名（如 requests）或本地 .py 文件/目录路径"}

    fmt = str(format or "json").strip().lower()
    if fmt not in ("json", "markdown", "md"):
        return {"error": f"不支持的输出格式: {format}（可选 json / markdown）"}
    fmt = "markdown" if fmt == "md" else fmt

    try:
        max_depth = int(depth)
    except (TypeError, ValueError):
        max_depth = 1

    is_path = os.path.exists(tgt) and (os.path.isdir(tgt) or tgt.endswith(".py"))
    try:
        if is_path:
            lib_name, module_names = _discover_modules_from_path(tgt, max_depth)
        else:
            lib_name = tgt
            top_mod = _safe_import(lib_name)
            if top_mod is None:
                return {"error": f"导入失败: {lib_name}，请确认已安装或路径正确"}
            submodules = _discover_submodules(top_mod, max_depth)
            module_names = [lib_name] + submodules

        module_names = sorted(set(module_names))
        if not module_names:
            return {"error": f"未发现任何模块: {tgt}"}

        result: dict[str, Any] = {
            "library_name": lib_name,
            "version": _get_version(lib_name) if not is_path else "local",
            "modules": {},
        }
        for mod_name in module_names:
            mod = _safe_import(mod_name)
            if mod is None:
                continue
            _track_module(mod_name, mod)
            module_api = extract_module_api(mod, mod_name, is_top_level=(mod_name == lib_name))
            if module_api["functions"] or module_api["classes"]:
                result["modules"][mod_name] = module_api

        if not result["modules"]:
            return {"error": f"未提取到任何公共 API（目标可能全为私有成员或 C 扩展）: {tgt}"}

        # 落盘（输出目录禁止指向系统敏感区域；文件名禁止路径穿越）
        out_dir = Path(output_dir).expanduser() if output_dir else DATA_DIR / "outputs"
        safe_dir, dir_reason = is_path_safe(str(out_dir.resolve()))
        if not safe_dir:
            return {"error": f"输出目录不合法: {dir_reason}"}
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_name = re.sub(r"[^\w.-]", "_", lib_name)[:48] or "api"
        ext = ".md" if fmt == "markdown" else ".json"
        out_name = (file_name.strip() if file_name else f"apidoc_{safe_name}_{stamp}")
        out_name = re.sub(r"[\\/:*?\"<>|\s]", "_", out_name)
        if not out_name.endswith(ext):
            out_name += ext
        out_path = (out_dir / out_name).resolve()
        out_dir_resolved = out_dir.resolve()
        # 双保险：解析后必须仍位于输出目录内
        if out_path != out_dir_resolved and not str(out_path).startswith(str(out_dir_resolved) + os.sep):
            return {"error": "输出文件名不合法"}
        out_path = out_dir / out_name

        if fmt == "markdown":
            out_path.write_text(_format_as_markdown(result), encoding="utf-8")
        else:
            out_path.write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str), encoding="utf-8")

        func_count = sum(len(m["functions"]) for m in result["modules"].values())
        class_count = sum(len(m["classes"]) for m in result["modules"].values())
        return {
            "message": "ok",
            "library_name": lib_name,
            "version": result["version"],
            "format": fmt,
            "module_count": len(result["modules"]),
            "function_count": func_count,
            "class_count": class_count,
            "file_path": str(out_path),
            "preview_url": f"/api/files/output?name={out_path.name}",
        }
    except (FileNotFoundError, ImportError) as e:
        return {"error": str(e)}
    finally:
        _restore_tmp_modules()
