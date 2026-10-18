# -*- coding: utf-8 -*-
"""SAY-1：SLATE Action YAML 受限子集解析器（零依赖，不引入 PyYAML）。

为什么不用 PyYAML：backend/requirements.txt 至今没有它，routers/vault.py 与
plugin_adapter.py 都是刻意手搓的（打包体积与 hiddenimports 的既有前科）。
代价是"YAML"这个名字只能兑现一个**定死的子集**——所以这里的原则是：
凡是超出子集的写法一律带行号拒绝，而不是按 PyYAML 的口径悄悄解释成别的
意思。用户手写的文件要么被如实读懂，要么明确告诉他哪一行读不懂。

支持面（ACTIONS-DESIGN.md §3.2 的 5 条）：
  1. 顶层 key: value，缩进固定 2 空格，最大嵌套 2 层；
  2. value ∈ scalar / 引号串 / 块数组（- 开头，元素是 scalar 或一层映射）/ 字面块 |；
  3. # 只在结构层当整行注释；字面块内的 # 是正文；行尾 # 属于值本身；
  4. 禁止 & * --- > |其他 !! 与流式 [] {}；
  5. 布尔只认字面 true / false，不做 YAML 1.1 的 yes/no/on/off 陷阱。
"""

from __future__ import annotations

import re
from typing import Any

# ── 上限常量：守卫脚本 scripts/check_actions_contract.mjs 会逐个断言 ──
MAX_FILE_BYTES = 64_000
MAX_NAME_CHARS = 40
MAX_DESC_CHARS = 120
MAX_WHEN_CHARS = 200
MAX_INPUTS = 8
MAX_STEPS = 24
MAX_STEP_DETAIL_CHARS = 4_000
MAX_TOTAL_DETAIL_CHARS = 20_000
MAX_CHECK_CHARS = 200
MAX_TAGS = 8
MAX_OPTIONS = 20
MAX_TITLE_CHARS = 60

ACTION_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
_INPUT_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_INPUT_TYPES = ("text", "number", "textarea", "select")
_OUTPUT_DESTINATIONS = ("message", "file", "board")


class SayError(ValueError):
    """带行号的解析/校验错误（line=0 表示与具体行无关）。"""

    def __init__(self, reason: str, line: int = 0) -> None:
        super().__init__(f"第 {line} 行：{reason}" if line else reason)
        self.reason = reason
        self.line = line


# ── 行级原语 ─────────────────────────────────

def _indent_of(line: str, no: int) -> int:
    idx = 0
    while idx < len(line) and line[idx] == " ":
        idx += 1
    if idx < len(line) and line[idx] == "\t":
        raise SayError("禁止使用 Tab 缩进，请用空格", no)
    return idx


def _split_key(text: str, no: int) -> tuple[str, str] | None:
    """把 `key: value` 拆开；不是键值行返回 None。引号内的冒号不算分隔符。"""
    quote = ""
    for i, ch in enumerate(text):
        if quote:
            if ch == quote:
                quote = ""
            continue
        if ch in "\"'":
            quote = ch
            continue
        if ch == ":" and (i + 1 == len(text) or text[i + 1] == " "):
            return text[:i].strip(), text[i + 1:].strip()
    return None


def _scalar(raw: str, no: int) -> Any:
    """标量：只认引号串与裸文本，布尔只认 true/false，其余构造一律拒绝。"""
    text = raw.strip()
    if not text:
        return ""
    head = text[0]
    if head in "&*!`":
        raise SayError(f"不支持的 YAML 构造「{head}」锚点/别名/显式类型，请改写成普通文本", no)
    if head in "[{":
        raise SayError("不支持流式写法 [] / {}，数组请改写成每行一个「- 」（对象数组请换行缩进）", no)
    if head == ">":
        raise SayError("不支持折叠标量 >，多行正文请用 |", no)
    if head in "\"'":
        if len(text) < 2 or not text.endswith(head) or text == head:
            raise SayError("引号没有闭合", no)
        body = text[1:-1]
        if head == '"':
            return body.replace('\\"', '"').replace("\\\\", "\\").replace("\\n", "\n")
        return body.replace("''", "'")
    if text == "true":
        return True
    if text == "false":
        return False
    if text.lower() in ("yes", "no", "on", "off", "null", "~"):
        raise SayError(f"布尔只认 true / false（null 请整个字段删掉），收到「{text}」", no)
    return text


def _literal_block(lines: list[str], start: int, parent_indent: int, marker: str) -> tuple[str, int]:
    """`key: |` / `key: |-`：收走所有比 key 更深缩进的原文行。

    两种 chomp 在这里合成同一口径（都剥掉尾部空行）：说明书正文没有"必须保留
    末尾换行"的场景，留着只会让用户看不出文件差别却解析成两样。
    """
    if marker not in ("|", "|-"):
        raise SayError(f"不支持的块标量标记「{marker}」，只认 | 与 |-", start + 1)
    parts: list[str] = []
    block_indent: int | None = None
    i = start
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            parts.append("")
            i += 1
            continue
        indent = _indent_of(line, i + 1)
        if indent <= parent_indent:
            break
        if block_indent is None:
            block_indent = indent
        elif indent < block_indent:
            raise SayError("字面块内部缩进不一致", i + 1)
        parts.append(line[block_indent:])
        i += 1
    while parts and not parts[-1].strip():
        parts.pop()
    return "\n".join(parts), i


def _skip_noise(lines: list[str], i: int) -> int:
    while i < len(lines):
        stripped = lines[i].strip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue
        if stripped == "---":
            raise SayError("不支持多文档分隔符 ---", i + 1)
        break
    return i


def _parse_node(lines: list[str], i: int, indent: int) -> tuple[Any, int]:
    stripped = lines[i].strip()
    if stripped == "-" or stripped.startswith("- "):
        return _parse_sequence(lines, i, indent)
    return _parse_mapping(lines, i, indent)


def _parse_mapping(lines: list[str], i: int, indent: int) -> tuple[dict, int]:
    out: dict[str, Any] = {}
    while True:
        i = _skip_noise(lines, i)
        if i >= len(lines):
            break
        line_indent = _indent_of(lines[i], i + 1)
        if line_indent < indent:
            break
        if line_indent > indent:
            raise SayError("缩进与上层条目不对齐（每级固定 2 空格）", i + 1)
        text = lines[i].strip()
        if text == "-" or text.startswith("- "):
            break
        split = _split_key(text, i + 1)
        if split is None:
            raise SayError("缺少「键: 值」结构（冒号后要有一个空格）", i + 1)
        key, rest = split
        if not key:
            raise SayError("键名为空", i + 1)
        if rest.startswith("|"):
            value, i = _literal_block(lines, i + 1, line_indent, rest)
        elif rest:
            value = _scalar(rest, i + 1)
            i += 1
        else:
            nxt = _skip_noise(lines, i + 1)
            if nxt < len(lines) and _indent_of(lines[nxt], nxt + 1) > line_indent:
                value, i = _parse_node(lines, nxt, _indent_of(lines[nxt], nxt + 1))
            else:
                value = ""
                i += 1
        out[key] = value
    return out, i


def _parse_sequence(lines: list[str], i: int, indent: int) -> tuple[list, int]:
    out: list[Any] = []
    while True:
        i = _skip_noise(lines, i)
        if i >= len(lines):
            break
        line_indent = _indent_of(lines[i], i + 1)
        if line_indent < indent:
            break
        if line_indent > indent:
            raise SayError("数组元素缩进不一致（同一层的 - 必须对齐）", i + 1)
        text = lines[i].strip()
        if not (text == "-" or text.startswith("- ")):
            break
        body = text[1:].strip()
        if not body:
            nxt = _skip_noise(lines, i + 1)
            if nxt < len(lines) and _indent_of(lines[nxt], nxt + 1) > line_indent:
                value, i = _parse_node(lines, nxt, _indent_of(lines[nxt], nxt + 1))
            else:
                value, i = "", i + 1
            out.append(value)
            continue
        split = _split_key(body, i + 1)
        if split is None:
            out.append(_scalar(body, i + 1))
            i += 1
            continue
        # 「- key: value」＝该元素映射的首行：就地把这一行改写成正统缩进的键值行，
        # 再交给映射解析器，避免为对象数组单独写一套状态机。
        lines[i] = " " * (line_indent + 2) + body
        value, i = _parse_mapping(lines, i, line_indent + 2)
        out.append(value)
    return out, i


def parse(text: str) -> dict[str, Any]:
    """把 SAY-1 文本解析成 dict。顶层必须是映射；语法错误抛 SayError。"""
    if len(text.encode("utf-8")) > MAX_FILE_BYTES:
        raise SayError(f"文件超过 {MAX_FILE_BYTES} 字节上限")
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if lines and lines[0].startswith("﻿"):
        lines[0] = lines[0][1:]
    probe = _skip_noise(lines, 0)
    if probe >= len(lines):
        return {}
    if _indent_of(lines[probe], probe + 1) != 0:
        raise SayError("顶层键不能缩进", probe + 1)
    value, i = _parse_mapping(lines, probe, 0)
    tail = _skip_noise(lines, i)
    if tail < len(lines):
        raise SayError("此处内容与上层结构不匹配", tail + 1)
    return value


# ── Action 语义校验 ──────────────────────────

def _need_str(container: dict, key: str, limit: int, path: str) -> str:
    raw = container.get(key)
    if raw is None or raw == "":
        raise SayError(f"缺少必填字段 {path}")
    if not isinstance(raw, str):
        raise SayError(f"{path} 必须是文本")
    if len(raw) > limit:
        raise SayError(f"{path} 超过 {limit} 字（实际 {len(raw)} 字）")
    return raw


def _opt_str(container: dict, key: str, limit: int, path: str) -> str:
    raw = container.get(key)
    if raw is None or raw == "":
        return ""
    if not isinstance(raw, str):
        raise SayError(f"{path} 必须是文本")
    if len(raw) > limit:
        raise SayError(f"{path} 超过 {limit} 字（实际 {len(raw)} 字）")
    return raw


def _as_list(value: Any, path: str) -> list:
    if value is None or value == "":
        return []
    if not isinstance(value, list):
        raise SayError(f"{path} 必须是「- 」开头的块数组")
    return value


def _validate_inputs(raw: Any) -> list[dict[str, Any]]:
    items = _as_list(raw, "inputs")
    if len(items) > MAX_INPUTS:
        raise SayError(f"inputs 最多 {MAX_INPUTS} 个（实际 {len(items)}）")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for idx, item in enumerate(items):
        path = f"inputs[{idx}]"
        if not isinstance(item, dict):
            raise SayError(f"{path} 必须是「- key: value」形式的对象")
        key = _need_str(item, "key", 32, f"{path}.key")
        if not _INPUT_KEY_RE.match(key):
            raise SayError(f"{path}.key 只能用小写字母开头的 a-z0-9_（收到「{key}」）")
        if key in seen:
            raise SayError(f"{path}.key 重复：{key}")
        seen.add(key)
        itype = _opt_str(item, "type", 16, f"{path}.type") or "text"
        if itype not in _INPUT_TYPES:
            raise SayError(f"{path}.type 只能是 {'/'.join(_INPUT_TYPES)}（收到「{itype}」）")
        options = [str(o) for o in _as_list(item.get("options"), f"{path}.options")]
        for option in options:
            if len(option) > 60:
                raise SayError(f"{path}.options 单项超过 60 字")
        if len(options) > MAX_OPTIONS:
            raise SayError(f"{path}.options 最多 {MAX_OPTIONS} 项")
        if itype == "select" and not options:
            raise SayError(f"{path} 为 select 时必须给 options")
        required = item.get("required")
        if required is None:
            required = False
        if not isinstance(required, bool):
            raise SayError(f"{path}.required 只能是 true / false")
        out.append({
            "key": key,
            "label": _opt_str(item, "label", MAX_NAME_CHARS, f"{path}.label") or key,
            "type": itype,
            "required": required,
            "options": options,
        })
    return out


def _validate_steps(raw: Any) -> list[dict[str, Any]]:
    items = _as_list(raw, "steps")
    if not items:
        raise SayError("steps 必填：至少要有一步流程")
    if len(items) > MAX_STEPS:
        raise SayError(f"steps 最多 {MAX_STEPS} 步（实际 {len(items)}）")
    out: list[dict[str, Any]] = []
    total = 0
    for idx, item in enumerate(items):
        path = f"steps[{idx}]"
        if not isinstance(item, dict):
            out.append({"title": _scalar(str(item), 0)[:MAX_TITLE_CHARS], "tool": "", "detail": "", "check": ""})
            continue
        title = _need_str(item, "title", MAX_TITLE_CHARS, f"{path}.title")
        detail = item.get("detail") or ""
        if not isinstance(detail, str):
            raise SayError(f"{path}.detail 必须是文本（多行请用 |）")
        if len(detail) > MAX_STEP_DETAIL_CHARS:
            raise SayError(f"{path}.detail 超过 {MAX_STEP_DETAIL_CHARS} 字")
        total += len(detail)
        if total > MAX_TOTAL_DETAIL_CHARS:
            raise SayError(f"全部 steps.detail 合计超过 {MAX_TOTAL_DETAIL_CHARS} 字，请拆成两个 Action")
        out.append({
            "title": title,
            "tool": _opt_str(item, "tool", 40, f"{path}.tool"),
            "detail": detail,
            "check": _opt_str(item, "check", MAX_CHECK_CHARS, f"{path}.check"),
        })
    return out


_KNOWN_FIELDS = {
    "id", "name", "description", "when", "inputs", "steps",
    "output", "tags", "author", "version",
}


def validate_action(raw: dict[str, Any], *, action_id: str | None = None) -> tuple[dict[str, Any], list[str]]:
    """把解析结果校成规范结构。返回 (spec, warnings)；不合法抛 SayError。"""
    if not isinstance(raw, dict):
        raise SayError("顶层必须是键值映射")
    warnings: list[str] = []
    for key in raw:
        if key not in _KNOWN_FIELDS:
            warnings.append(f"未识别的字段「{key}」已忽略（可用字段：{', '.join(sorted(_KNOWN_FIELDS))}）")

    name = _need_str(raw, "name", MAX_NAME_CHARS, "name")
    description = _need_str(raw, "description", MAX_DESC_CHARS, "description")
    when = _opt_str(raw, "when", MAX_WHEN_CHARS, "when")
    version = _opt_str(raw, "version", 16, "version")
    inputs = _validate_inputs(raw.get("inputs"))
    steps = _validate_steps(raw.get("steps"))

    # id 是文件名给的：编辑器里还没落盘的草稿没有 id，此时只告警不失败，
    # 否则 POST /api/actions/validate 对新建文件永远用不了（见 ACTIONS-DESIGN.md §3.3）。
    spec_id = (action_id or str(raw.get("id") or "")).strip()
    if spec_id and not ACTION_ID_RE.match(spec_id):
        raise SayError(f"id 只能用小写字母开头的 a-z0-9_-，长度 ≤48（收到「{spec_id}」）")

    tags = [str(x).strip() for x in _as_list(raw.get("tags"), "tags") if str(x).strip()]
    if len(tags) > MAX_TAGS:
        raise SayError(f"tags 最多 {MAX_TAGS} 个")
    for tag in tags:
        if len(tag) > 24:
            raise SayError("tags 单项超过 24 字")

    author = _opt_str(raw, "author", 8, "author") or "user"
    if author not in ("user", "model"):
        raise SayError("author 只能是 user 或 model（它只是标注，不是权限开关）")

    output_raw = raw.get("output")
    output: dict[str, str] = {"format": "", "destination": "", "path": ""}
    if output_raw not in (None, ""):
        if not isinstance(output_raw, dict):
            raise SayError("output 必须是「- key: value」形式的对象（写成缩进键值）")
        output["format"] = _opt_str(output_raw, "format", 20, "output.format")
        output["destination"] = _opt_str(output_raw, "destination", 12, "output.destination")
        output["path"] = _opt_str(output_raw, "path", 200, "output.path")
        if output["destination"] and output["destination"] not in _OUTPUT_DESTINATIONS:
            raise SayError(f"output.destination 只能是 {'/'.join(_OUTPUT_DESTINATIONS)}")
        if output["destination"] == "file" and not output["path"]:
            raise SayError("output.destination 为 file 时必须给 output.path")

    if not spec_id:
        warnings.append("未写 id：以文件名（<id>.yml）作为 id")

    spec = {
        "id": spec_id,
        "name": name,
        "description": description,
        "when": when,
        "inputs": inputs,
        "steps": steps,
        "output": output,
        "tags": tags,
        "author": author,
        "version": version,
    }
    return spec, warnings


def load_action(text: str, *, action_id: str | None = None) -> tuple[dict[str, Any], list[str]]:
    """parse + validate 的便捷入口。"""
    return validate_action(parse(text), action_id=action_id)
