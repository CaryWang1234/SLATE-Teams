"""JSON 文件原子写入工具。

直接 write_text 覆盖在写入中途崩溃会留下半截文件；损坏后各模块的
_load_* 往往静默返回空值，下一次保存会把空值写回，造成数据永久丢失
（定时任务 / MCP 配置等）。统一走临时文件 + os.replace 原子替换。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def atomic_write_text(path: Path, text: str) -> None:
    """原子写入 UTF-8 文本（临时文件 + os.replace），避免中途崩溃损坏原文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def atomic_write_json(path: Path, data: Any) -> None:
    """原子写入 JSON（临时文件 + os.replace），避免中途崩溃损坏原文件。"""
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2))


def backup_corrupt(path: Path) -> None:
    """原文件损坏时先备份（.corrupt 后缀）再写，防止空数据覆盖造成永久丢失。"""
    try:
        if path.exists():
            path.replace(path.with_name(path.name + ".corrupt"))
    except OSError:
        pass
