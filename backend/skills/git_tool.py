"""技能：Git 仓库只读信息工具（基于标准库 subprocess，无第三方依赖）。

支持动作：
- status: 当前分支 + 工作区变更状态
- log: 最近提交记录（limit 控制条数）
- diff: 变更统计摘要（scope=unstaged 未暂存 / staged 已暂存 / all）
- branches: 本地与远程分支列表
- remotes: 远程仓库列表

安全约束：仅执行白名单内的只读 git 命令（status/log/diff/branch/remote/rev-parse），
不接受任意命令拼接，超时 30 秒自动终止。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

from backend.subprocess_utils import hidden_subprocess_kwargs

TIMEOUT = 30


def _git(directory: str, args: list[str]) -> tuple[int, str, str]:
    """在指定目录执行只读 git 命令，返回 (returncode, stdout, stderr)。"""
    cwd = Path(os.path.expanduser(directory or "")).resolve()
    if not cwd.is_dir():
        raise FileNotFoundError(f"目录不存在: {directory}")
    proc = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=TIMEOUT,
        **hidden_subprocess_kwargs(),
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def execute(
    action: str = "",
    directory: str = "",
    limit: int = 10,
    scope: str = "unstaged",
    **_kw: Any,
) -> dict[str, Any]:
    """Git 仓库只读信息工具。

    Args:
        action: 操作类型 - status/log/diff/branches/remotes
        directory: 仓库目录路径（必填，需为 git 仓库内目录）
        limit: 提交记录条数（action=log 时使用，默认 10，最大 50）
        scope: diff 范围（action=diff 时使用）- unstaged 未暂存 / staged 已暂存 / all 全部

    Returns:
        dict: 操作结果。
    """
    if not action:
        return {"error": "action 不能为空，可选: status/log/diff/branches/remotes"}
    if not directory:
        return {"error": "directory 不能为空（git 仓库目录路径）"}

    try:
        # 先确认是 git 仓库
        code, root, err = _git(directory, ["rev-parse", "--show-toplevel"])
        if code != 0:
            return {"error": f"不是 git 仓库: {err or directory}"}

        # ── status ───────────────────────────────────
        if action == "status":
            _, branch, _ = _git(directory, ["rev-parse", "--abbrev-ref", "HEAD"])
            code, out, _ = _git(directory, ["status", "--porcelain"])
            changes = [line for line in out.splitlines() if line.strip()] if out else []
            return {
                "status": "ok",
                "repo": root,
                "branch": branch,
                "clean": not changes,
                "change_count": len(changes),
                "changes": changes[:100],
                "truncated": len(changes) > 100,
            }

        # ── log ──────────────────────────────────────
        if action == "log":
            n = min(max(int(limit or 10), 1), 50)
            code, out, err = _git(directory, [
                "log", f"-{n}", "--pretty=format:%h|%an|%ad|%s", "--date=format:%Y-%m-%d %H:%M",
            ])
            if code != 0:
                return {"error": f"读取提交记录失败: {err}"}
            commits = []
            for line in out.splitlines():
                parts = line.split("|", 3)
                if len(parts) == 4:
                    commits.append({"hash": parts[0], "author": parts[1], "date": parts[2], "message": parts[3]})
            return {"status": "ok", "repo": root, "count": len(commits), "commits": commits}

        # ── diff ─────────────────────────────────────
        if action == "diff":
            if scope == "staged":
                args = ["diff", "--cached", "--stat"]
            elif scope == "all":
                args = ["diff", "HEAD", "--stat"]
            else:
                args = ["diff", "--stat"]
            code, out, err = _git(directory, args)
            if code != 0:
                return {"error": f"读取 diff 失败: {err}"}
            lines = out.splitlines() if out else []
            summary = lines[-1] if lines else "无变更"
            return {
                "status": "ok",
                "repo": root,
                "scope": scope if scope in ("staged", "all") else "unstaged",
                "summary": summary,
                "files": lines[:-1][:100] if len(lines) > 1 else [],
            }

        # ── branches ─────────────────────────────────
        if action == "branches":
            _, cur, _ = _git(directory, ["rev-parse", "--abbrev-ref", "HEAD"])
            _, out, _ = _git(directory, ["branch", "-a", "--format=%(refname:short)"])
            local, remote = [], []
            for name in (out.splitlines() if out else []):
                name = name.strip()
                if not name or "HEAD" in name:
                    continue
                (remote if name.startswith(("origin/", "upstream/")) else local).append(name)
            return {"status": "ok", "repo": root, "current": cur, "local": local, "remote": remote}

        # ── remotes ──────────────────────────────────
        if action == "remotes":
            code, out, err = _git(directory, ["remote", "-v"])
            if code != 0:
                return {"error": f"读取远程仓库失败: {err}"}
            remotes: dict[str, dict[str, str]] = {}
            for line in (out.splitlines() if out else []):
                parts = line.split()
                if len(parts) >= 2:
                    entry = remotes.setdefault(parts[0], {})
                    if "(fetch)" in line:
                        entry["fetch"] = parts[1]
                    elif "(push)" in line:
                        entry["push"] = parts[1]
            return {"status": "ok", "repo": root, "remotes": remotes}

        return {"error": f"未知操作: {action}，可选: status/log/diff/branches/remotes"}

    except FileNotFoundError as e:
        return {"error": str(e)}
    except subprocess.TimeoutExpired:
        return {"error": f"git 命令超时（{TIMEOUT}s）"}
    except Exception as e:
        return {"error": f"git 操作失败 ({action}): {e}"}
