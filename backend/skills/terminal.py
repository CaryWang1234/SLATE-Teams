"""技能：终端会话（支持多会话、状态保持、进程管理）。

核心特性：
- 会话保持 cwd 与环境变量，跨命令可见（cd / $env:X 下一步仍生效）
- 支持创建/列出/关闭多个终端会话
- Windows：一条命令一次 powershell 进程（脚本尾部回报 cwd/env/exit 供会话吸收）
- POSIX：一条命令喂给常驻 bash（逐行读入即执行完整命令）
- 后台进程可真正终止（kill），超时/取消都杀掉整棵进程树
- 高危命令双层拦截（写死规则 + 用户审批）

会话管理：
- action="create"：创建新会话，返回 session_id
- action="list"：列出所有会话
- action="close"：关闭指定会话
- action="kill"：终止会话内正在运行的进程
- 默认 action=""：在指定会话（或 default）中执行命令
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from backend.subprocess_utils import hidden_subprocess_kwargs
from backend.skills.call_ctx import CallContext
from backend.skills.sandbox import truncate_output, MAX_OUTPUT_CHARS

# 默认工作目录
DEFAULT_WORK_DIR = "."
# 命令超时（秒）
TIMEOUT = 30
# 最大命令长度
MAX_COMMAND_LENGTH = 10_000
# 最大输出大小
MAX_OUTPUT = MAX_OUTPUT_CHARS
# Terminal pipes use UTF-8 regardless of the Windows ANSI/OEM code page.
TERMINAL_ENCODING = "utf-8"
# 禁止的命令前缀（无条件拦截）
# `rm -rf ~` 是 Mac/Linux 那侧的"把家目录抹了"：展开成 /Users/<name>，等于 rm -rf / 换个
# 写法，而 ~/ 带不带都命中同一个前缀。
BLOCKED_PREFIXES = ("rm -rf /", "rm -rf ~", "format c:", "format d:", "mkfs", "dd if=")

# 高危命令规则（写死）
HIGH_RISK_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\brm\b", re.I), "删除文件（rm）"),
    (re.compile(r"\b(rmdir|shred|unlink)\b", re.I), "删除文件/目录"),
    (re.compile(r"\b(del|erase)\b\s", re.I), "删除文件（del/erase）"),
    (re.compile(r"\brd\b\s", re.I), "删除目录（rd）"),
    (re.compile(r"\bri\b\s", re.I), "删除文件/目录（PowerShell ri 别名）"),
    (re.compile(r"Remove-Item", re.I), "删除文件（Remove-Item）"),
    (re.compile(r"\bdd\b(?=.*\bof=)", re.I), "磁盘写入（dd）"),
    (re.compile(r"\b(fdisk|diskpart|parted)\b", re.I), "磁盘分区操作"),
    (re.compile(r"\bdiskutil\s+(erase|reformat|partitionDisk|secureErase)", re.I), "抹掉/重分区磁盘卷（macOS diskutil）"),
    (re.compile(r"\b(shutdown|reboot|poweroff|halt)\b", re.I), "关机/重启"),
    (re.compile(r"\binit\s+[06]\b"), "关机/重启"),
    (re.compile(r"\bsudo\b", re.I), "提权执行（sudo）"),
    (re.compile(r"\b(taskkill|killall)\b", re.I), "强制结束进程"),
    (re.compile(r"\bkill\s+-9\b", re.I), "强制结束进程（kill -9）"),
    (re.compile(r"reg\s+(delete|add)\b", re.I), "修改注册表"),
    (re.compile(r"\bsc\s+(delete|stop)\b", re.I), "管理系统服务"),
    (re.compile(r"\bnet\s+user\b", re.I), "修改用户账户"),
    (re.compile(r"\b(takeown|icacls)\b", re.I), "修改文件所有权/权限"),
    (re.compile(r"\bchmod\s+(-R\s+)?777\b", re.I), "开放全部权限（chmod 777）"),
    (re.compile(r"git\s+push\s+[^;]*(--force\b|-f\b|--force-with-lease)", re.I), "Git 强制推送"),
    (re.compile(r"git\s+reset\s+--hard", re.I), "Git 硬重置（丢弃改动）"),
    (re.compile(r"git\s+clean\s+-[a-z]*f", re.I), "Git 清理未跟踪文件"),
    (re.compile(r"git\s+branch\s+-D\b", re.I), "Git 强制删除分支"),
    (re.compile(r"(drop\s+(database|table|schema)|truncate\s+table)", re.I), "数据库删表/删库"),
    (re.compile(r"(npm|pnpm|yarn)\s+(uninstall|remove)\s+(-g|--global)", re.I), "卸载全局依赖"),
]

PIPE_TO_SHELL = re.compile(
    r"(curl|wget|invoke-webrequest|iwr)[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh|Invoke-Expression|\biex\b",
    re.I,
)

WINDOWS_NATIVE_PREFIXES = (
    "python", "py", "node", "npm", "pnpm", "yarn", "npx",
    "git", "rg", "ripgrep", "grep", "findstr",
    "pip", "uv", "pytest", "ruff", "mypy",
    "cargo", "go", "java", "javac", "dotnet",
)

POWERSHELL_HINTS = re.compile(
    r"(^|\s)(Get-|Set-|New-|Remove-|Select-|Where-|ForEach-|Write-|Test-|"
    r"Start-|Stop-|Copy-|Move-|Invoke-)|\$env:|Select-String|Out-File|"
    r"\b(Measure-Object|Sort-Object|Format-Table|Format-List)\b",
    re.I,
)

# ── Windows：一次性 shell 调用 ─────────────────────────────────────
# 常驻 shell（-Command - 从 stdin 逐行吃命令）有三类吞命令的坑，都是实测出来的：
#   1) 多行块（foreach/if/here-string）在交互式续行模式下要再空一行才执行 —— 于是命令
#      永远不执行、超时、"(无输出)"；
#   2) 脏管道（`Get-ChildItem |`）把 shell 钉在续行状态，后面几条一起被吞；
#   3) 完成标记由 shell 自己 Write-Output 出来，和子进程直写的 stdout 抢跑，
#      上一条的输出会落到下一条的结果里。
# 改成"每条命令一次 powershell 进程"：脚本整体按脚本解析（不需要空行、续行状态不跨命令），
# 输出读到进程结束（不再有抢跑），会话状态（cwd / 环境变量 / 退出码）由脚本尾部的
# base64 单行回报，Python 侧吸收进 TerminalSession —— 于是"状态保持"这件事照旧成立。
# 命令主体还要从 stdin 喂、在运行时解析（见 _powershell_body_block）：拼进脚本文本里
# 的一句语法错误会让整个脚本解析失败，PowerShell 转而把错误用 CLIXML 吐到 stderr，
# 结果是"一行输出都没有 + 几百字节 XML 噪声 + 中文错误乱码 + 退出码丢失"。
STATE_TRAILER_PREFIX = "__SLATE_STATE__"
POWERSHELL_CANDIDATES = ("pwsh.exe", "powershell.exe")
_POWERSHELL_CACHE: dict[str, Any] = {}


def _resolve_powershell() -> tuple[str, bool]:
    """返回 (shell 可执行文件, 是否 PowerShell 7+)。pwsh 在就用它（原生认 &&）。"""
    if "shell" in _POWERSHELL_CACHE:
        return _POWERSHELL_CACHE["shell"], _POWERSHELL_CACHE["ps7"]
    shell, ps7 = "powershell.exe", False
    for candidate in POWERSHELL_CANDIDATES:
        try:
            probe = subprocess.run(
                [candidate, "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
                capture_output=True, text=True, timeout=10, encoding="utf-8", errors="replace",
                **hidden_subprocess_kwargs(),
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if probe.returncode == 0 and (probe.stdout or "").strip().isdigit():
            shell = candidate
            ps7 = int(probe.stdout.strip()) >= 7
            break
    _POWERSHELL_CACHE["shell"], _POWERSHELL_CACHE["ps7"] = shell, ps7
    return shell, ps7


def _split_top_level(command: str) -> tuple[list[str], list[str]]:
    """按引号/括号深度做顶层切分，返回 (段, 段间运算符)。切不开就原样一段（宁可不翻译）。"""
    parts: list[str] = []
    ops: list[str] = []
    buf: list[str] = []
    depth = 0
    quote = ""
    i = 0
    while i < len(command):
        ch = command[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = ""
            i += 1
            continue
        if ch in "\"'":
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        elif depth == 0 and (ch == "&" or ch == "|"):
            op = (ch * 2) if command.startswith(ch * 2, i) else ""
            if op in ("&&", "||"):
                parts.append("".join(buf))
                ops.append(op)
                buf = []
                i += len(op)
                continue
        buf.append(ch)
        i += 1
    parts.append("".join(buf))
    if quote or depth != 0 or len(parts) < 2:
        return [command], []
    return parts, ops


def translate_shell_chain(command: str, ps7: bool | None = None) -> str:
    """把 `A && B || C` 写成 Windows PowerShell 5.1 认的 if ($?) 嵌套（左结合）。

    PS7 原生支持这两个运算符，直接原样返回；带换行的命令不翻译 —— here-string（@" … "@）
    里的 && 认不出来（它不是普通引号），一旦拆进去就没法还原，宁可让 shell 报错。
    """
    if ("&&" not in command and "||" not in command) or "\n" in command:
        return command
    if ps7 is None:
        ps7 = _resolve_powershell()[1]
    if ps7:
        return command
    parts, ops = _split_top_level(command)
    if not ops:
        return command

    def indent(text: str) -> str:
        return "\n".join(("  " + line) if line.strip() else line for line in text.splitlines())

    def build(items: list[str], links: list[str]) -> str:
        head = items[0].strip()
        if not links:
            return head
        cond = "$?" if links[0] == "&&" else "-not $?"
        nested = build(items[1:], links[1:])
        return f"{head}\nif ({cond}) {{\n{indent(nested)}\n}}"

    return build(parts, ops)


def _powershell_state_script() -> str:
    """脚本尾部：把最终 cwd / 环境变量增量 / 退出码编成一整行 base64 JSON 带回来。"""
    return f"""$__slateCwd = (Get-Location).Path
$__slateNow = @{{}}
Get-ChildItem env: | ForEach-Object {{ $__slateNow[$_.Name] = $_.Value }}
$__slateDiff = @{{}}
foreach ($__slateK in $__slateNow.Keys) {{
  if (-not $__slateBase.ContainsKey($__slateK) -or $__slateBase[$__slateK] -ne $__slateNow[$__slateK]) {{ $__slateDiff[$__slateK] = $__slateNow[$__slateK] }}
}}
foreach ($__slateK in $__slateBase.Keys) {{
  if (-not $__slateNow.ContainsKey($__slateK)) {{ $__slateDiff[$__slateK] = $null }}
}}
$__slateJson = ConvertTo-Json -Compress -InputObject @{{ cwd = $__slateCwd; exit = $__slateExit; env = $__slateDiff }}
$__slateB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($__slateJson))
Write-Output ("{STATE_TRAILER_PREFIX}" + $__slateB64)
"""


def _powershell_preamble() -> str:
    """管道一律走 UTF-8；关掉进度条；顺带记录进来之前的环境变量，供尾部算增量。"""
    return """$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
chcp.com 65001 > $null
$__slateBase = @{}
Get-ChildItem env: | ForEach-Object { $__slateBase[$_.Name] = $_.Value }
$__slateSt = @{ errs = 0; aborted = $false }
"""


def _powershell_body_block() -> str:
    """命令主体从 stdin 读入、在运行时解析，绝不参与外壳脚本的解析。

    为什么非要绕这一道：把命令直接拼进 -EncodedCommand 的脚本文本里，一条语法错误
    （`Get-ChildItem |` 这种空管道元素）会让**整个脚本**解析失败 —— 主体一行不跑、
    尾部回报也不跑，而 PowerShell 把解析错误用 CLIXML 吐到重定向后的 stderr 上：
    几百字节的 XML 噪声 + 中文错误全成乱码 + 退出码丢失。改成运行时解析，
    解析错误就是我们 caught 住的一条普通错误，照常写进 stdout、照常回报状态。
    """
    return """$__slateCode = [Console]::In.ReadToEnd()
$__slateSb = $null
$__slateParseErr = ""
try { $__slateSb = [ScriptBlock]::Create($__slateCode) } catch {
  $__slateParseErr = $_.Exception.Message
}
if ($null -eq $__slateSb) {
  # 主体第一个 token 是被引号包起来的可执行文件路径时（`"C:\\Program Files\\x\\y.exe" -v`
  # 这种，中文路径带空格也常见），脚本块开头的字符串会被当成表达式起点，
  # 紧随其后的参数就成了"意外的标记"。调用运算符 & 能把语句拉回命令模式，再解析一次。
  # 只有第一条语句会踩这个坑：后续语句本来就按命令模式解析。
  try { $__slateSb = [ScriptBlock]::Create('& ' + $__slateCode) } catch { }
}
if ($null -eq $__slateSb) {
  $__slateSt.aborted = $true
  Write-Output ("[PARSE_ERROR] " + $__slateParseErr)
}
if ($null -ne $__slateSb) {
  try {
    & $__slateSb 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) {
        Write-Output $_.ToString()
        if ($_.FullyQualifiedErrorId -notlike 'NativeCommandError*') { $__slateSt.errs = $__slateSt.errs + 1 }
      } else {
        Write-Output $_
      }
    }
  } catch {
    $__slateSt.aborted = $true
    Write-Output ("[ERROR] " + $_.ToString())
  }
}
$__slateExit = 0
if ($__slateSt.aborted -or $__slateSt.errs -gt 0) { $__slateExit = 1 }
if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { $__slateExit = $LASTEXITCODE }
"""


def powershell_wrapper_script() -> str:
    """外壳脚本（每条命令都同一份，编码后作为进程参数传入）。"""
    return _powershell_preamble() + _powershell_body_block() + _powershell_state_script()


def powershell_command_body(command: str) -> str:
    """喂给 stdin 的命令主体：只做 &&/|| 翻译，不与外壳脚本拼接（见 _powershell_body_block）。"""
    return translate_shell_chain(command) + "\n"


def _powershell_argv(script: str) -> list[str]:
    shell, _ = _resolve_powershell()
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    # -EncodedCommand 走进程参数，不经过任何 shell 解析：引号/反引号/$ 都不可能被吞
    return [shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]


def _take_state_trailer(stdout: str) -> tuple[str, dict[str, Any]]:
    """从 stdout 末尾摘出状态行，返回（去掉状态行的 stdout，状态字典）。

    用 rfind 而不是逐行 startswith：命令最后一条输出没带换行时，状态串会直接接在
    那一行尾巴上，行首匹配就找不到它了（于是 cwd 悄悄退回原位，比报错更难查）。
    """
    idx = (stdout or "").rfind(STATE_TRAILER_PREFIX)
    if idx < 0:
        return (stdout or "").strip(), {}
    tail = stdout[idx + len(STATE_TRAILER_PREFIX):]
    line_end = tail.find("\n")
    payload = (tail if line_end < 0 else tail[:line_end]).strip()
    remainder = stdout[:idx] if line_end < 0 else (stdout[:idx] + tail[line_end + 1:])
    state: Any = {}
    try:
        state = json.loads(base64.b64decode(payload.encode("ascii")).decode("utf-8"))
    except Exception:
        state = {}
    return remainder.strip(), (state if isinstance(state, dict) else {})


def check_high_risk(command: str) -> str:
    """返回命中的高危原因；未命中返回空字符串。"""
    cmd = str(command or "").strip()
    if not cmd:
        return ""
    if PIPE_TO_SHELL.search(cmd):
        return "从网络下载并直接执行脚本"
    for seg in re.split(r"&&|\|\||;|\|", cmd):
        seg = seg.strip()
        if not seg:
            continue
        for pattern, reason in HIGH_RISK_PATTERNS:
            if pattern.search(seg):
                return reason
    return ""


def _get_shell() -> list[str]:
    """返回当前平台的 shell 命令。"""
    if sys.platform == "win32":
        # Windows: 优先 PowerShell，回退 cmd
        return ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-NoExit", "-Command", "-"]
    else:
        # Unix: 优先 bash，回退 sh
        return ["/bin/bash", "--norc", "--noprofile", "-i"]


def _command_with_marker(command: str, marker: str) -> str:
    if sys.platform == "win32":
        return (
            "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)\n"
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n"
            "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n"
            "$env:PYTHONIOENCODING = 'utf-8'\n"
            "$env:PYTHONUTF8 = '1'\n"
            "chcp.com 65001 > $null\n"
            f"{command}\n"
            "$slateExit = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n"
            f'Write-Output "{marker}:$slateExit"'
        )
    return f"{command}\nprintf '\\n{marker}:%s\\n' \"$?\""


def _strip_completion_marker(output: str, marker: str) -> tuple[str, int | None]:
    marker_prefix = f"{marker}:"
    exit_code: int | None = None
    kept: list[str] = []
    for line in output.splitlines():
        if marker_prefix in line:
            _, _, tail = line.partition(marker_prefix)
            match = re.match(r"\s*(-?\d+)", tail)
            if match:
                exit_code = int(match.group(1))
            continue
        kept.append(line)
    return "\n".join(kept).strip(), exit_code


def is_windows_native_command(command: str) -> bool:
    """Whether a Windows command can be run directly (no shell text transcoding).

    Windows PowerShell 5 decodes native stdout through the legacy code page in
    many cases, which corrupts UTF-8 output from Python/Node/Git. Direct capture
    keeps those bytes under Python's UTF-8 decoder.

    只认"带参数的原生命令"：裸 `python` / `node` 是"要个 REPL"，直连时它拿着 cmd.exe 的
    stdin 能一直挂到超时；PowerShell 那侧 stdin 在起进程前就读完关掉了，子进程拿到
    EOF 立刻退出。
    """
    cmd = (command or "").strip()
    if not cmd or "\n" in cmd or POWERSHELL_HINTS.search(cmd):
        return False
    tokens = re.split(r"\s+", cmd)
    if len(tokens) < 2:
        return False
    first = tokens[0].strip("\"'").lower()
    base = Path(first).stem.lower()
    return base in WINDOWS_NATIVE_PREFIXES


def _looks_like_windows_native_command(command: str) -> bool:
    return sys.platform == "win32" and is_windows_native_command(command)


# cd / Set-Location / chdir / sl（PowerShell 中 rd 也是 Remove-Item，不在此列）
_CD_RE = re.compile(r"^\s*(?:cd|chdir|sl|Set-Location)\s*(.*?)\s*$", re.I)


def _kill_process_tree(proc: subprocess.Popen) -> None:
    """杀掉整棵进程树：shell=True 时孙进程不会随父进程自己退出。"""
    try:
        if proc.poll() is not None:
            return
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                timeout=5,
                **hidden_subprocess_kwargs(),
            )
        else:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
    except Exception:
        pass


class TerminalSession:
    """持久化终端会话。"""

    def __init__(self, session_id: str, cwd: str):
        self.session_id = session_id
        self.cwd = Path(cwd).resolve()
        self.env = os.environ.copy()
        self.env["PYTHONIOENCODING"] = "utf-8"
        self.env["PYTHONUTF8"] = "1"
        self.env.setdefault("DOTNET_CLI_UI_LANGUAGE", "en")
        # 清理敏感环境变量
        for key in list(self.env.keys()):
            if key.upper() in ("AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "DATABASE_URL", "SECRET_KEY", "PRIVATE_KEY"):
                del self.env[key]
        
        self.process: subprocess.Popen | None = None
        self.output_buffer: list[str] = []
        self.error_buffer: list[str] = []
        self.running = False
        self.current_command = ""
        self._reader_thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()  # 保护并发 run_command
        
    def start(self) -> None:
        """启动常驻 shell 进程（仅 POSIX 路径需要）。

        Windows 不再养常驻 shell：每条命令一次 powershell 进程（见 _run_command_powershell），
        "会话"只剩 self.cwd / self.env 这份状态，由每条命令尾部的回报更新。
        """
        if sys.platform == "win32":
            return
        if self.process and self.process.poll() is None:
            return  # 已在运行
        
        shell_cmd = _get_shell()
        self.process = subprocess.Popen(
            shell_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(self.cwd),
            env=self.env,
            text=True,
            encoding=TERMINAL_ENCODING,
            errors="replace",
            bufsize=1,  # 行缓冲
            **hidden_subprocess_kwargs(),
        )
        self._start_reader_thread()
    
    def _start_reader_thread(self) -> None:
        """启动读取线程。"""
        self._stop_event.clear()
        self._reader_thread = threading.Thread(target=self._read_output, daemon=True)
        self._reader_thread.start()
    
    def _read_output(self) -> None:
        """异步读取 stdout/stderr（缓冲区有上限，防止内存爆炸）。"""
        if not self.process:
            return
        
        MAX_BUFFER_LINES = 10_000  # 每缓冲区最多保留 10k 行
        
        def read_stream(stream, buffer):
            try:
                for line in iter(stream.readline, ""):
                    if self._stop_event.is_set():
                        break
                    buffer.append(line)
                    # 超过上限时丢弃最旧的行（保留最近 N 行）
                    if len(buffer) > MAX_BUFFER_LINES * 1.2:
                        del buffer[:len(buffer) - MAX_BUFFER_LINES]
            except Exception:
                pass
        
        stdout_thread = threading.Thread(target=read_stream, args=(self.process.stdout, self.output_buffer), daemon=True)
        stderr_thread = threading.Thread(target=read_stream, args=(self.process.stderr, self.error_buffer), daemon=True)
        stdout_thread.start()
        stderr_thread.start()
        stdout_thread.join()
        stderr_thread.join()

    def _collect(
        self,
        argv: str | list[str],
        timeout: float,
        ctx: CallContext | None,
        *,
        shell: bool = False,
        stdin_text: str | None = None,
    ) -> dict[str, Any]:
        """跑一个一次性子进程：输出读到进程结束，超时/取消都杀掉整棵树。

        不等任何"完成标记"再收工 —— 标记由 shell 自己 Write-Output，和子进程直写的
        stdout 抢跑，早收工就会把上一条命令的尾巴记到下一条头上。

        stdin_text 非空时用一条独立线程写入后立刻关闭：写大命令不能挡在读取线程前面
        （管道缓冲区满了会互等），关掉 stdin 则让误起的交互式程序直接 EOF 退出。
        """
        stdout_lines: list[str] = []
        stderr_lines: list[str] = []

        def pump(stream, sink: list[str]) -> None:
            try:
                for line in iter(stream.readline, ""):
                    sink.append(line)
            except Exception:
                pass

        proc = subprocess.Popen(
            argv,
            cwd=str(self.cwd),
            env=self.env,
            shell=shell,
            stdin=(subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding=TERMINAL_ENCODING,
            errors="replace",
            bufsize=1,
            **hidden_subprocess_kwargs(),
        )
        self.process = proc   # 停止按钮/action="kill" 要能拿到它杀整棵树
        readers = [
            threading.Thread(target=pump, args=(proc.stdout, stdout_lines), daemon=True),
            threading.Thread(target=pump, args=(proc.stderr, stderr_lines), daemon=True),
        ]
        for reader in readers:
            reader.start()
        if stdin_text is not None:
            def feed() -> None:
                try:
                    proc.stdin.write(stdin_text)
                    proc.stdin.flush()
                except Exception:
                    pass
                finally:
                    try:
                        proc.stdin.close()
                    except Exception:
                        pass
            threading.Thread(target=feed, daemon=True).start()
        deadline = time.monotonic() + max(float(timeout or TIMEOUT), 0.1)
        timed_out = False
        cancelled = False
        emitted = 0
        out_bytes = 0
        while proc.poll() is None:
            if ctx is not None:
                fresh = stdout_lines[emitted:]
                if fresh:
                    chunk = "".join(fresh)
                    ctx.output(chunk, stream="stdout", offset=out_bytes)
                    out_bytes += len(chunk.encode("utf-8"))
                    emitted = len(stdout_lines)
                if ctx.cancelled:
                    cancelled = True
                    break
            if time.monotonic() >= deadline:
                timed_out = True
                break
            time.sleep(0.05)
        if cancelled or timed_out:
            _kill_process_tree(proc)
        # 收割退出码：读取线程还在并排排水，这里 wait 不会被管道卡住；
        # 不 wait 的话 kill 完 returncode 仍是 None，"命令失败"会被写成"成功"。
        try:
            proc.wait(timeout=5 if (cancelled or timed_out) else 2)
        except Exception:
            pass
        for reader in readers:
            reader.join(timeout=2)
        self.process = None
        return {
            "stdout": "".join(stdout_lines),
            "stderr": "".join(stderr_lines),
            "returncode": proc.returncode,
            "timed_out": timed_out,
            "cancelled": cancelled,
        }

    def _shape_result(
        self,
        command: str,
        stdout: str,
        stderr: str,
        exit_code: int | None,
        run: dict[str, Any],
        timeout: float,
    ) -> dict[str, Any]:
        base: dict[str, Any] = {
            "command": command,
            "session_id": self.session_id,
            "work_dir": str(self.cwd),
        }
        output = (stdout or "").strip()
        errors = (stderr or "").strip()
        if errors:
            output += f"\n[STDERR]\n{errors}"
        if run.get("cancelled"):
            partial, truncated = truncate_output(output or "(无输出)")
            return {**base, "error": "已取消：连接已关闭，命令进程已终止", "output": partial,
                    "truncated": truncated, "cancelled": True}
        if run.get("timed_out"):
            partial, truncated = truncate_output(output or "(无输出)")
            return {**base, "error": f"命令超时（{timeout}s）", "output": partial, "truncated": truncated}
        output, truncated = truncate_output(output or "(无输出)")
        return {**base, "output": output, "exit_code": exit_code, "truncated": truncated}

    def _run_command_powershell(self, command: str, timeout: float = TIMEOUT, ctx: CallContext | None = None) -> dict[str, Any]:
        """Windows 主路径：一条命令一次 powershell 进程，状态靠脚本尾部回报吸收回会话。"""
        self.current_command = command
        self.running = True
        try:
            run = self._collect(
                _powershell_argv(powershell_wrapper_script()),
                timeout,
                ctx,
                stdin_text=powershell_command_body(command),
            )
            stdout, state = _take_state_trailer(run["stdout"])
            exit_code = state.get("exit", run["returncode"])
            # 语法错误/进程被杀时脚本跑不到尾部：退回进程退出码，别把失败报成 0
            if exit_code is None:
                exit_code = run["returncode"]
            if state:
                self._adopt_state(state)
            return self._shape_result(command, stdout, run["stderr"], exit_code, run, timeout)
        except Exception as e:
            return {"error": f"执行失败: {e}"}
        finally:
            self.running = False
            self.current_command = ""

    def _adopt_state(self, state: dict[str, Any]) -> None:
        """把脚本回报的 cwd / 环境变量增量吸收进会话（跨命令状态就靠这一步）。"""
        new_cwd = str(state.get("cwd") or "").strip()
        if new_cwd:
            try:
                resolved = Path(new_cwd).resolve()
                self.cwd = resolved
            except OSError:
                pass
        env = state.get("env")
        if isinstance(env, dict):
            for key, value in env.items():
                if value is None:
                    self.env.pop(str(key), None)
                else:
                    self.env[str(key)] = str(value)

    def _run_command_direct(self, command: str, timeout: float = TIMEOUT, ctx: CallContext | None = None) -> dict[str, Any]:
        """Run a Windows native command without PowerShell's text transcoding."""
        self.current_command = command
        self.running = True
        try:
            run = self._collect(command, timeout, ctx, shell=True)
            return self._shape_result(command, run["stdout"], run["stderr"], run["returncode"], run, timeout)
        except Exception as e:
            return {"error": f"执行失败: {e}"}
        finally:
            self.running = False
            self.current_command = ""
    
    def _apply_cd(self, command: str) -> bool:
        """识别 cd 类命令并同步 self.cwd，保证后续原生命令在新目录执行。

        原生命令（git/python/pytest…）绕开 shell 直接以 self.cwd 作为
        工作目录启动；若 shell 内 cd 后 Python 侧不更新，原生命令会在旧目录跑。
        目标目录不存在时不更新（与 shell 行为一致，cd 失败 cwd 不变）。
        """
        m = _CD_RE.match(command)
        if not m:
            return False
        target = m.group(1).strip().strip("\"'")
        try:
            if not target:
                self.cwd = Path.home()
            else:
                new_path = Path(target)
                if not new_path.is_absolute():
                    new_path = self.cwd / new_path
                resolved = new_path.resolve()
                if resolved.is_dir():
                    self.cwd = resolved
        except OSError:
            pass
        return True

    def run_command(self, command: str, timeout: float = TIMEOUT, ctx: CallContext | None = None) -> dict[str, Any]:
        """在会话中执行命令。"""
        with self._lock:  # 防止并发串扰
            return self._run_command_locked(command, timeout, ctx)

    def _run_command_locked(self, command: str, timeout: float = TIMEOUT, ctx: CallContext | None = None) -> dict[str, Any]:
        """在持有锁的情况下执行命令（内部方法）。"""
        if sys.platform == "win32":
            # Windows 一律一次性进程。cwd 不在这里预先应用：脚本跑完会把最终位置回报回来，
            # 预先应用会让 `cd backend` 被算两次（Python 一次、shell 一次），
            # shell 立刻回"找不到路径 …\backend\backend"。
            if _looks_like_windows_native_command(command):
                return self._run_command_direct(command, timeout, ctx)
            return self._run_command_powershell(command, timeout, ctx)

        # POSIX 仍走常驻 shell：bash 读入完整命令即执行，没有 PowerShell 的续行/抢跑问题
        self._apply_cd(command)

        if not self.process or self.process.poll() is not None:
            self.start()
        
        if not self.process or not self.process.stdin:
            return {"error": "Shell 进程未启动"}
        
        # 清空缓冲区
        self.output_buffer.clear()
        self.error_buffer.clear()
        self.current_command = command
        self.running = True
        
        try:
            # 发送命令
            marker = f"__SLATE_DONE_{uuid.uuid4().hex}__"
            self.process.stdin.write(_command_with_marker(command, marker) + "\n")
            self.process.stdin.flush()
            
            deadline = time.monotonic() + max(float(timeout or TIMEOUT), 0.1)
            timed_out = False
            cancelled = False
            emitted = 0
            out_bytes = 0
            while True:
                if ctx is not None:
                    current = len(self.output_buffer)
                    if current < emitted:  # 缓冲区丢弃过旧行，索引已失效
                        emitted = current
                    fresh = self.output_buffer[emitted:current]
                    if fresh:
                        chunk = "".join(fresh)
                        ctx.output(chunk, stream="stdout", offset=out_bytes)
                        out_bytes += len(chunk.encode("utf-8"))
                        emitted = current
                    if ctx.cancelled:
                        cancelled = True
                        break
                output_snapshot = "".join(self.output_buffer)
                if marker in output_snapshot:
                    break
                if self.process.poll() is not None:
                    break
                if time.monotonic() >= deadline:
                    timed_out = True
                    break
                time.sleep(0.05)
            
            # 收集输出
            output = "".join(self.output_buffer).strip()
            errors = "".join(self.error_buffer).strip()
            output, exit_code = _strip_completion_marker(output, marker)
            
            if errors:
                output += f"\n[STDERR]\n{errors}"
            
            if cancelled or timed_out:
                partial, was_truncated = truncate_output(output or "(无输出)")
                self.kill_process()
                reason = "已取消：连接已关闭，命令进程已终止" if cancelled else f"命令超时（{timeout}s）"
                return {
                    "error": reason,
                    "command": command,
                    "session_id": self.session_id,
                    "work_dir": str(self.cwd),
                    "output": partial,
                    "truncated": was_truncated,
                    **({"cancelled": True} if cancelled else {}),
                }

            # 截断
            output, was_truncated = truncate_output(output or "(无输出)")
            
            return {
                "command": command,
                "session_id": self.session_id,
                "work_dir": str(self.cwd),
                "output": output,
                "exit_code": exit_code,
                "truncated": was_truncated,
            }
        except Exception as e:
            return {"error": f"执行失败: {e}"}
        finally:
            self.running = False
            self.current_command = ""
    
    def kill_process(self) -> None:
        """终止 shell 进程及其所有子进程（进程树）。"""
        self._stop_event.set()
        if self.process:
            try:
                pid = self.process.pid
                if sys.platform == "win32":
                    # Windows: 用 taskkill /T 杀整个进程树
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(pid)],
                        timeout=5,
                        **hidden_subprocess_kwargs(),
                    )
                else:
                    # Unix: terminate + wait，失败时 kill -9
                    self.process.terminate()
                    self.process.wait(timeout=2)
            except Exception:
                try:
                    if sys.platform != "win32":
                        self.process.kill()
                except Exception:
                    pass
            finally:
                self.process = None
    
    def close(self) -> None:
        """关闭会话。"""
        self.kill_process()


# 全局会话存储
_sessions: dict[str, TerminalSession] = {}


def _get_or_create_session(session_id: str, cwd: str) -> TerminalSession:
    """获取或创建会话。"""
    if session_id not in _sessions:
        _sessions[session_id] = TerminalSession(session_id, cwd)
    return _sessions[session_id]


def execute(**params: Any) -> dict[str, Any]:
    return _execute(**params)


def run_stream(ctx: CallContext, **params: Any) -> dict[str, Any]:
    return _execute(ctx=ctx, **params)


def _execute(
    command: str = "",
    work_dir: str = DEFAULT_WORK_DIR,
    approved: bool = False,
    background: bool = False,
    action: str = "",
    session_id: str = "default",
    timeout: float = TIMEOUT,
    ctx: CallContext | None = None,
    **_: Any,
) -> dict[str, Any]:
    """在持久化终端会话中执行命令或管理会话。

    Args:
        command: 要执行的命令（action="" 时必填）
        work_dir: 工作目录（创建新会话时使用）
        approved: 高危命令是否已获用户批准
        background: 已废弃，保留兼容
        action: 操作类型 - create/list/close/kill 或空（执行命令）
        session_id: 会话 ID（默认 "default"）
        timeout: 命令超时秒数（默认 30）
        ctx: 流式调用上下文（进度/输出/取消），/execute 路径为 None
    """
    # ── 会话管理操作 ─────────────────────────────
    
    if action == "create":
        cwd = Path(work_dir).resolve()
        if not cwd.is_dir():
            return {"error": f"工作目录不存在: {work_dir}"}
        
        # 生成唯一 session_id（如果已存在）
        if session_id in _sessions:
            base_id = session_id
            session_id = f"{base_id}_{uuid.uuid4().hex[:6]}"
        
        session = _get_or_create_session(session_id, str(cwd))
        session.start()
        return {
            "message": f"会话已创建: {session_id}",
            "session_id": session_id,
            "work_dir": str(session.cwd),
        }
    
    if action == "list":
        sessions = []
        for sid, sess in _sessions.items():
            sessions.append({
                "session_id": sid,
                "work_dir": str(sess.cwd),
                "running": sess.running,
                "current_command": sess.current_command,
                "process_alive": sess.process is not None and sess.process.poll() is None,
            })
        return {"sessions": sessions, "count": len(sessions)}
    
    if action == "close":
        if session_id not in _sessions:
            return {"error": f"会话不存在: {session_id}"}
        _sessions[session_id].close()
        del _sessions[session_id]
        return {"message": f"会话已关闭: {session_id}"}
    
    if action == "kill":
        if session_id not in _sessions:
            return {"error": f"会话不存在: {session_id}"}
        sess = _sessions[session_id]
        if sess.process and sess.process.poll() is None:
            sess.kill_process()
            return {"message": f"会话 {session_id} 的进程已终止"}
        return {"message": f"会话 {session_id} 无运行中的进程"}
    
    # ── 命令执行 ─────────────────────────────────
    
    if not command:
        return {"error": "命令不能为空"}
    
    if len(command) > MAX_COMMAND_LENGTH:
        return {"error": f"命令过长（{len(command)} 字符 > {MAX_COMMAND_LENGTH} 限制）"}
    
    # 灾难级命令：无条件禁止
    cmd_lower = command.lower().strip()
    for prefix in BLOCKED_PREFIXES:
        if cmd_lower.startswith(prefix):
            return {"error": f"禁止执行的危险命令: {prefix}"}
    
    # 高危命令：未获用户批准即拦截
    risk_reason = check_high_risk(command)
    if risk_reason and not bool(approved):
        return {"error": f"高危命令（{risk_reason}）未获用户批准，已拦截: {command}"}
    
    # 获取或创建会话
    cwd = Path(work_dir).resolve()
    if not cwd.is_dir():
        return {"error": f"工作目录不存在: {work_dir}"}
    
    session = _get_or_create_session(session_id, str(cwd))
    
    # 执行命令
    result = session.run_command(command, timeout=timeout, ctx=ctx)
    return result
