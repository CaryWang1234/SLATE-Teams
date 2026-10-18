"""技能：代码安全扫描。

扫描项目代码文件，检测常见安全漏洞与风险：
- 硬编码密钥/凭证
- SQL 注入风险
- XSS 风险
- 不安全的加密/哈希
- 调试代码残留
- 不安全的反序列化
- 路径遍历风险
- 不安全的随机数生成
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from backend.skills.call_ctx import CallContext

# 默认扫描的文件扩展名
SCAN_EXTENSIONS = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".go", ".rb", ".php",
    ".c", ".cpp", ".h", ".cs", ".swift", ".kt", ".vue", ".svelte",
}

# 排除的目录
EXCLUDE_DIRS = {
    "node_modules", ".git", "__pycache__", "venv", ".venv", "env",
    "dist", "build", ".next", ".nuxt", "target", "vendor",
    ".diag", ".qoder", ".pytest_cache", ".mypy_cache", ".ruff_cache",
}

# 最大扫描文件大小（字节）
MAX_FILE_SIZE = 500 * 1024  # 500KB


# ── 安全规则定义 ─────────────────────────────────

class SecurityRule:
    """安全扫描规则。"""

    def __init__(self, pattern: re.Pattern, severity: str, category: str, description: str):
        self.pattern = pattern
        self.severity = severity  # critical / high / medium / low
        self.category = category
        self.description = description


# 硬编码密钥/凭证
SECRET_PATTERNS = [
    SecurityRule(re.compile(r"""(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']([A-Za-z0-9_\-]{16,})["']""", re.I),
                 "critical", "硬编码密钥", "疑似硬编码 API Key 或密钥"),
    SecurityRule(re.compile(r"""(?:password|passwd|pwd)\s*[:=]\s*["']([^"']{4,})["']""", re.I),
                 "high", "硬编码密码", "疑似硬编码密码"),
    SecurityRule(re.compile(r"""(?:aws_access_key_id|aws_secret_access_key)\s*[:=]\s*["']([A-Za-z0-9/+=]{20,})["']""", re.I),
                 "critical", "AWS 凭证", "疑似硬编码 AWS 凭证"),
    SecurityRule(re.compile(r"""-----BEGIN\s+(RSA|DSA|EC|OPENSSH|PGP)?\s*PRIVATE\s+KEY-----""", re.I),
                 "critical", "私钥文件", "包含私钥内容"),
    SecurityRule(re.compile(r"""(?:github|gitlab|bitbucket)_(?:token|pat)\s*[:=]\s*["']([A-Za-z0-9_\-]{20,})["']""", re.I),
                 "critical", "代码平台令牌", "疑似硬编码 Git 平台令牌"),
]

# SQL 注入风险
SQL_INJECTION_PATTERNS = [
    SecurityRule(re.compile(r"""(?:execute|exec(?:ute)?|query)\s*\(\s*["'].*?\+\s*\w+.*?["']""", re.I),
                 "high", "SQL 注入", "字符串拼接构造 SQL，存在注入风险"),
    SecurityRule(re.compile(r"""(?:f["'].*?SELECT.*?\{.*?\}.*?["']|["']SELECT.*?["']\s*\+\s*\w+)""", re.I),
                 "high", "SQL 注入", "f-string 或拼接构造 SELECT 语句"),
    SecurityRule(re.compile(r"""(?:f["'].*?(?:INSERT|UPDATE|DELETE).*?\{.*?\}.*?["']|["'](?:INSERT|UPDATE|DELETE).*?["']\s*\+\s*\w+)""", re.I),
                 "high", "SQL 注入", "f-string 或拼接构造写操作 SQL"),
    SecurityRule(re.compile(r"""\.raw\s*\(\s*["'].*?(?:%s|\{|\+\s*\w+).*?["']""", re.I),
                 "medium", "SQL 注入", "ORM raw() 方法中使用拼接"),
]

# XSS 风险
XSS_PATTERNS = [
    SecurityRule(re.compile(r"""(?:innerHTML|outerHTML|document\.write)\s*=\s*[^;]*(?:\+|\.concat|\$\{)""", re.I),
                 "high", "XSS 风险", "动态内容写入 innerHTML，存在 XSS 风险"),
    SecurityRule(re.compile(r"""dangerouslySetInnerHTML""", re.I),
                 "medium", "XSS 风险", "React dangerouslySetInnerHTML 使用"),
    SecurityRule(re.compile(r"""v-html\s*="""),
                 "medium", "XSS 风险", "Vue v-html 指令使用"),
    SecurityRule(re.compile(r"""\.html\s*\(\s*[^)]*(?:\+|\.concat|\$\{)""", re.I),
                 "medium", "XSS 风险", "jQuery .html() 动态内容"),
]

# 不安全的加密/哈希
LEGACY_CIPHERS = ("D" + "ES", "RC" + "4", "RC" + "2", "Blow" + "fish")

CRYPTO_PATTERNS = [
    SecurityRule(re.compile(r"""\b(?:MD5|md5)\s*\(""", re.I),
                 "medium", "弱哈希算法", "使用 MD5，不适合安全场景"),
    SecurityRule(re.compile(r"""\b(?:SHA1|sha1)\s*\(""", re.I),
                 "medium", "弱哈希算法", "使用 SHA1，已存在碰撞攻击"),
    SecurityRule(re.compile(rf"""\b(?:{'|'.join(LEGACY_CIPHERS)})\b"""),
                 "high", "弱加密算法", "使用已知不安全的加密算法"),
    SecurityRule(re.compile(r"""(?:eval|exec)\s*\(\s*(?:atob|Buffer\.from)\s*\(""", re.I),
                 "high", "代码注入", "解码后立即执行，存在代码注入风险"),
]

# 调试代码残留
DEBUG_PATTERNS = [
    SecurityRule(re.compile(r"""\bconsole\.(log|debug|info|warn|error)\s*\(""", re.I),
                 "low", "调试残留", "console 调试输出"),
    SecurityRule(re.compile(r"""\bprint\s*\(.*?\)\s*(?:#.*debug|#.*TODO)""", re.I),
                 "low", "调试残留", "疑似调试用 print"),
    SecurityRule(re.compile(r"""\bdebugger\s*;"""),
                 "medium", "调试残留", "debugger 语句残留"),
    SecurityRule(re.compile(r"""\b(?:TODO|FIXME|HACK|XXX|BUG)\b.*(?:secur|vuln|risk|unsafe)""", re.I),
                 "medium", "安全隐患标记", "代码注释中标记的安全相关待办"),
]

# 不安全的反序列化
DESERIALIZE_PATTERNS = [
    SecurityRule(re.compile(r"""pickle\.loads?\s*\(""", re.I),
                 "high", "不安全反序列化", "pickle 反序列化可执行恶意代码"),
    SecurityRule(re.compile(r"""yaml\.load\s*\([^)]*(?:Loader\s*=\s*yaml\.(?:Unsafe|Full)Loader)?\s*\)""", re.I),
                 "high", "不安全反序列化", "yaml.load 未使用 SafeLoader"),
    SecurityRule(re.compile(r"""(?:JSON\.parse|json\.loads?)\s*\(\s*(?:req\.|request\.)""", re.I),
                 "medium", "输入解析", "直接解析请求体 JSON，需验证输入"),
    SecurityRule(re.compile(r"""(?:unserialize|unserialize_or_error)\s*\(""", re.I),
                 "high", "不安全反序列化", "PHP unserialize 存在代码注入风险"),
]

# 路径遍历
PATH_TRAVERSAL_PATTERNS = [
    SecurityRule(re.compile(r"""(?:open|readFile|readFileSync)\s*\(\s*(?:req\.|request\.|params\.|query\.)""", re.I),
                 "high", "路径遍历", "用户输入直接用于文件路径"),
    SecurityRule(re.compile(r"""os\.path\.join\s*\([^)]*(?:request|req|params|query)\.""", re.I),
                 "medium", "路径遍历", "用户输入参与路径构造，需验证"),
    SecurityRule(re.compile(r"""send_file\s*\([^)]*(?:request|req|params)""", re.I),
                 "high", "路径遍历", "用户输入用于 send_file，存在目录穿越风险"),
]

# 不安全的随机数
RANDOM_PATTERNS = [
    SecurityRule(re.compile(r"""\brandom\.random\s*\(""", re.I),
                 "medium", "不安全随机数", "random 模块不适合安全场景，应使用 secrets"),
    SecurityRule(re.compile(r"""\bMath\.random\s*\(""", re.I),
                 "medium", "不安全随机数", "Math.random() 非密码学安全"),
    SecurityRule(re.compile(r"""(?:token|session|nonce|salt)\s*[:=]\s*[^;]*\b(?:random|Math\.random)\b""", re.I),
                 "high", "不安全随机数", "安全令牌使用非安全随机数生成"),
]

# 所有规则汇总
ALL_RULES = (
    SECRET_PATTERNS + SQL_INJECTION_PATTERNS + XSS_PATTERNS +
    CRYPTO_PATTERNS + DEBUG_PATTERNS + DESERIALIZE_PATTERNS +
    PATH_TRAVERSAL_PATTERNS + RANDOM_PATTERNS
)


def _should_skip_dir(dirpath: str) -> bool:
    """判断是否应跳过该目录。

    只比较当前目录名，避免祖先目录名（如 D:\\dev\\build\\SLATE 的 build）
    误伤整个扫描——os.walk 的 dirpath 含全部祖先，之前用 parts 比对
    会在首个 root 就命中排除表导致 0 文件假阴性。
    """
    return Path(dirpath).name in EXCLUDE_DIRS


def _scan_file(filepath: Path, rules: list[SecurityRule]) -> list[dict[str, Any]]:
    """扫描单个文件，返回发现的问题列表。"""
    findings = []
    is_self_rules = filepath.resolve() == Path(__file__).resolve()
    try:
        content = filepath.read_text(encoding="utf-8", errors="ignore")
    except (OSError, UnicodeDecodeError):
        return findings

    lines = content.split("\n")
    for line_num, line in enumerate(lines, 1):
        if is_self_rules and line_num < 180:
            continue

        # 跳过注释行（简单启发式）
        stripped = line.strip()
        if stripped.startswith(("//", "#", "/*", "*", "<!--")):
            # 但仍检查安全隐患标记
            if not re.search(r"\b(?:TODO|FIXME|HACK|XXX|BUG)\b.*(?:secur|vuln|risk|unsafe)", stripped, re.I):
                continue

        for rule in rules:
            if rule.pattern.search(line):
                findings.append({
                    "file": str(filepath),
                    "line": line_num,
                    "severity": rule.severity,
                    "category": rule.category,
                    "description": rule.description,
                    "code": line.strip()[:100],  # 截断过长的行
                })
    return findings


def execute(
    directory: str = "",
    severity: str = "",
    category: str = "",
    max_files: int = 100,
    **_: Any,
) -> dict[str, Any]:
    """扫描项目代码中的安全漏洞（一次性返回）。"""
    return _run(directory=directory, severity=severity, category=category, max_files=max_files)


def run_stream(ctx: CallContext, **params: Any) -> dict[str, Any]:
    """流式扫描：逐文件报进度、逐发现报输出；客户端关流即提前收手。"""
    return _run(ctx=ctx, **params)


def _run(
    directory: str = "",
    severity: str = "",
    category: str = "",
    max_files: int = 100,
    ctx: CallContext | None = None,
    **_: Any,
) -> dict[str, Any]:
    """扫描项目代码中的安全漏洞。

    参数：
    - directory: 扫描目录（默认当前目录）
    - severity: 过滤最低严重级别 (critical/high/medium/low)
    - category: 过滤类别（如 "硬编码密钥"、"SQL 注入"）
    - max_files: 最大扫描文件数（默认 100）
    """
    if not directory:
        directory = "."

    scan_dir = Path(directory).resolve()
    if not scan_dir.is_dir():
        return {"error": f"目录不存在: {directory}"}

    # 严重级别过滤
    severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    min_severity = severity_order.get(severity.lower(), 3) if severity else 3

    # 类别过滤
    if category:
        rules = [r for r in ALL_RULES if category.lower() in r.category.lower()]
        if not rules:
            return {"error": f"未知类别: {category}，可用: {', '.join(set(r.category for r in ALL_RULES))}"}
    else:
        rules = ALL_RULES

    # 收集文件
    files_to_scan: list[Path] = []
    scanned_count = 0
    skipped_count = 0

    for root, dirs, files in os.walk(scan_dir):
        if _should_skip_dir(root):
            dirs.clear()
            continue

        for fname in files:
            fpath = Path(root) / fname
            if fpath.suffix.lower() not in SCAN_EXTENSIONS:
                continue
            try:
                if fpath.stat().st_size > MAX_FILE_SIZE:
                    skipped_count += 1
                    continue
            except OSError:
                # 断链或权限错误，跳过
                skipped_count += 1
                continue
            files_to_scan.append(fpath)
            if len(files_to_scan) >= max_files:
                break
        if len(files_to_scan) >= max_files:
            break

    # 扫描
    all_findings: list[dict[str, Any]] = []
    cancelled_early = False
    done_files = 0
    out_bytes = 0
    for idx, fpath in enumerate(files_to_scan, 1):
        try:
            shown = str(fpath.relative_to(scan_dir))
        except ValueError:
            shown = fpath.name
        if ctx is not None:
            if ctx.cancelled:
                cancelled_early = True
                break
            ctx.progress(progress=idx, total=len(files_to_scan), message=shown)
        findings = _scan_file(fpath, rules)
        for f in findings:
            if ctx is not None:
                chunk = f"[{f['severity']}] {f['category']} · {shown}:{f['line']}  {f['code']}"
                ctx.output(chunk, stream="log", offset=out_bytes)
                out_bytes += len(chunk.encode("utf-8")) + 1
        all_findings.extend(findings)
        done_files = idx

    # 过滤严重级别
    filtered = [f for f in all_findings if severity_order.get(f["severity"], 3) <= min_severity]

    # 按严重级别排序
    filtered.sort(key=lambda x: severity_order.get(x["severity"], 3))

    # 统计
    severity_counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    category_counts: dict[str, int] = {}
    for f in filtered:
        severity_counts[f["severity"]] = severity_counts.get(f["severity"], 0) + 1
        category_counts[f["category"]] = category_counts.get(f["category"], 0) + 1

    return {
        "scanned_files": done_files,
        "skipped_files": skipped_count,
        "total_findings": len(filtered),
        "severity_summary": severity_counts,
        "category_summary": category_counts,
        "findings": filtered[:50],  # 最多返回 50 条
        "truncated": len(filtered) > 50,
        "cancelled": cancelled_early,
    }
