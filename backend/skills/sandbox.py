"""安全沙箱工具集：路径验证、敏感目录防护、输出截断。

所有文件操作技能（file_peek / file_create / file_edit）共用此模块，
确保 AI 无法通过路径穿越访问系统敏感区域。
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

# ── 敏感路径黑名单 ────────────────────────────────
# 即使 AI 给出绝对路径，也不允许读写这些系统区域

# Windows 敏感根目录
_WIN_SENSITIVE = (
    "C:\\Windows",
    "C:\\$Recycle.Bin",
    "C:\\$WinDir",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData",
    "C:\\Recovery",
    "C:\\System Volume Information",
)

# Unix 敏感根目录
_UNIX_SENSITIVE = (
    "/etc/shadow",
    "/etc/passwd-",
    "/etc/sudoers",
    "/boot",
    "/proc",
    "/sys",
    "/dev",
    "/var/run",
    "/var/log",
)

# 敏感文件名模式（密钥 / 凭据文件）
# 意图：拦截 .env 系列、SSH 私钥、credentials/secrets 系列，以及任意 *.pem/*.key/*.p12 等后缀
_SENSITIVE_FILENAMES = re.compile(
    r"^(\.env(\..*)?|"
    r"id_rsa|id_dsa|id_ecdsa|id_ed25519|"
    r"credentials(\.\w+)?|secrets(\.\w+)?|\.htpasswd|"
    r".+\.(pem|key|p12|pfx|keystore|jks|p8|cer|crt))$",
    re.I,
)

# 最大输出大小（字符数）— 防止巨量输出撑爆内存 / 上下文
MAX_OUTPUT_CHARS = 50_000

# 最大文件操作大小（字节）— 防止操作超大文件
MAX_FILE_SIZE = 5 * 1024 * 1024  # 5 MB

# 最大请求参数长度
MAX_PARAM_LENGTH = 200_000  # 200K chars for content params


def is_path_safe(file_path: str) -> tuple[bool, str]:
    """验证文件路径是否安全。

    返回 (is_safe, reason)：
    - 安全时返回 (True, "")
    - 不安全时返回 (False, "原因")
    """
    if not file_path:
        return False, "文件路径不能为空"

    # 路径长度限制
    if len(file_path) > 1024:
        return False, "文件路径过长"

    try:
        resolved = Path(file_path).resolve()
    except (OSError, ValueError) as e:
        return False, f"无效的文件路径: {e}"

    resolved_str = str(resolved)

    # 检查是否指向敏感系统目录
    # Windows（路径大小写不敏感，统一小写比较防止 `c:\windows` 绕过）
    for sensitive in _WIN_SENSITIVE:
        try:
            sens_resolved = Path(sensitive).resolve()
            sens_str = str(sens_resolved)
            if os.name == "nt":
                if resolved_str.lower() == sens_str.lower() or resolved_str.lower().startswith(sens_str.lower() + os.sep):
                    return False, f"禁止访问系统目录: {sensitive}"
            elif resolved_str == sens_str or resolved_str.startswith(sens_str + os.sep):
                return False, f"禁止访问系统目录: {sensitive}"
        except OSError:
            # 该路径在当前系统不存在，跳过
            pass

    # Unix
    for sensitive in _UNIX_SENSITIVE:
        if resolved_str == sensitive or resolved_str.startswith(sensitive + "/"):
            return False, f"禁止访问系统路径: {sensitive}"

    # 检查敏感凭据文件
    if _SENSITIVE_FILENAMES.match(resolved.name):
        return False, f"禁止访问敏感凭据文件: {resolved.name}"

    # 路径中不允许包含空字节（防止 null byte injection）
    if "\x00" in file_path:
        return False, "文件路径包含非法字符"

    return True, ""


def validate_file_size(file_path: str, max_size: int = MAX_FILE_SIZE) -> tuple[bool, str]:
    """检查文件大小是否在限制内。"""
    try:
        size = Path(file_path).resolve().stat().st_size
        if size > max_size:
            mb = max_size / (1024 * 1024)
            return False, f"文件过大（{size / (1024*1024):.1f}MB > {mb:.0f}MB 限制）"
    except OSError:
        pass  # 文件可能尚不存在（创建场景）
    return True, ""


def truncate_output(text: str, max_chars: int = MAX_OUTPUT_CHARS) -> tuple[str, bool]:
    """截断过大的输出文本。

    返回 (truncated_text, was_truncated)。
    """
    if not text or len(text) <= max_chars:
        return text, False
    return text[:max_chars] + f"\n\n... [输出已截断：原始 {len(text)} 字符，仅保留前 {max_chars} 字符]", True


def sanitize_param(value: Any, max_length: int = MAX_PARAM_LENGTH, name: str = "参数") -> tuple[str, bool]:
    """验证字符串参数长度。

    返回 (sanitized_value, is_ok)。
    """
    if value is None:
        return "", True
    s = str(value)
    if len(s) > max_length:
        return s[:max_length], False
    return s, True


def validate_skill_params(params: Any) -> str | None:
    """统一验证技能参数大小。返回错误信息或 None。"""
    if params is None:
        return None
    if not isinstance(params, dict):
        return "参数必须是键值对对象"
    for key, value in params.items():
        if isinstance(value, str) and len(value) > MAX_PARAM_LENGTH:
            return f"参数 {key} 过长（{len(value)} 字符 > {MAX_PARAM_LENGTH} 限制）"
    return None
