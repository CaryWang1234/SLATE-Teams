"""Skill: test a regular expression against sample text.

Security: ReDoS protection via input size limits and match iteration caps.
"""

from __future__ import annotations

import re
import signal
import sys
import threading
from typing import Any

# ReDoS 防护：最大输入长度
MAX_PATTERN_LENGTH = 10_000
MAX_TEXT_LENGTH = 100_000
# 匹配超时（秒）
REGEX_TIMEOUT = 5


def execute(pattern: str = "", text: str = "", flags: str = "", limit: int = 20, **_kw: Any) -> dict[str, Any]:
    if not pattern:
        return {"error": "pattern is required"}

    # ReDoS 防护：输入长度限制
    if len(pattern) > MAX_PATTERN_LENGTH:
        return {"error": f"正则表达式过长（{len(pattern)} > {MAX_PATTERN_LENGTH}）"}
    if len(text) > MAX_TEXT_LENGTH:
        return {"error": f"测试文本过长（{len(text)} > {MAX_TEXT_LENGTH}）"}

    flag_value = 0
    flag_text = str(flags or "").lower()
    if "i" in flag_text:
        flag_value |= re.IGNORECASE
    if "m" in flag_text:
        flag_value |= re.MULTILINE
    if "s" in flag_text:
        flag_value |= re.DOTALL

    try:
        max_matches = max(1, min(int(limit), 200))
    except (TypeError, ValueError):
        max_matches = 20

    try:
        regex = re.compile(pattern, flag_value)
    except re.error as exc:
        return {"valid": False, "error": str(exc)}

    # ReDoS 防护：带超时的匹配
    matches = []
    timed_out = False

    if sys.platform != "win32":
        # Unix: 使用 signal.alarm 实现超时
        def _timeout_handler(signum, frame):
            raise TimeoutError("regex match timeout")

        old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
        signal.alarm(REGEX_TIMEOUT)
        try:
            for match in regex.finditer(str(text or "")):
                matches.append({
                    "match": match.group(0),
                    "span": list(match.span()),
                    "groups": list(match.groups()),
                    "groupdict": match.groupdict(),
                })
                if len(matches) >= max_matches:
                    break
        except TimeoutError:
            timed_out = True
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)
    else:
        # Windows: 使用线程 + 超时
        result_holder: dict[str, Any] = {"matches": [], "error": None}

        stop_event = threading.Event()
        
        def _run_matches():
            try:
                results = []
                for match in regex.finditer(str(text or "")):
                    if stop_event.is_set():
                        break
                    results.append({
                        "match": match.group(0),
                        "span": list(match.span()),
                        "groups": list(match.groups()),
                        "groupdict": match.groupdict(),
                    })
                    if len(results) >= max_matches:
                        break
                result_holder["matches"] = results
            except Exception as e:
                result_holder["error"] = str(e)

        t = threading.Thread(target=_run_matches, daemon=True)
        t.start()
        t.join(timeout=REGEX_TIMEOUT)
        if t.is_alive():
            timed_out = True
            stop_event.set()  # 通知线程尽快退出
        else:
            if result_holder["error"]:
                return {"valid": False, "error": result_holder["error"]}
            matches = result_holder["matches"]

    result = {
        "valid": True,
        "count": len(matches),
        "matches": matches,
        "truncated": len(matches) >= max_matches,
    }
    if timed_out:
        result["warning"] = f"匹配超时（{REGEX_TIMEOUT}秒），可能存在 ReDoS 风险，请简化正则表达式"
    return result
