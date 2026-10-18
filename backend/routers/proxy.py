"""LLM API 代理路由：转发请求到各模型提供商，支持流式输出。

优化要点（参考 Agent 工程四层理论）：
- Context Engineering: 渐进式加载，按需构建请求体
- Harness Engineering: 共享连接池，统一超时与重试策略
- Loop Engineering: 请求追踪 ID，可观测性日志
- Graph Engineering: 多 provider 路由，统一接口抽象
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any
from urllib.parse import quote, urlparse

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/proxy", tags=["proxy"])
logger = logging.getLogger(__name__)

# 分段超时：connect 快失败，read 为两包数据间隔上限（流式长思考模型不误杀）
STREAM_TIMEOUT = httpx.Timeout(connect=15.0, read=180.0, write=30.0, pool=10.0)
REQUEST_TIMEOUT = httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=10.0)

# ── 共享 httpx 客户端池（连接复用，避免每次请求重建 TCP 连接） ─────────
# Harness Engineering: 构建稳定的执行环境，减少连接开销
_http_clients: dict[str, httpx.AsyncClient] = {}


def _compact_error_text(text: str, max_len: int = 1200) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text[:max_len] + "…" if len(text) > max_len else text


async def _read_response_text(resp: httpx.Response) -> str:
    try:
        await resp.aread()
        return resp.text
    except Exception:
        return ""


def _diagnose_status(status: int) -> str:
    if status in (401, 403):
        return "鉴权失败：请检查 API Key、Base URL、账号权限或服务商访问权限。"
    if status == 404:
        return "接口或模型不存在：请检查模型 ID、Base URL，以及是否误用了 Responses API。"
    if status == 408 or status == 504:
        return "上游响应超时：可能是网络波动、模型排队或代理链路过慢。"
    if status == 413:
        return "请求体过大：请压缩上下文、减少附件或降低历史消息数量。"
    if status == 429:
        return "触发限流或额度不足：请稍后重试，或检查服务商额度。"
    if status >= 500:
        return "上游服务器错误：通常不是本地输入问题，可稍后重试或切换模型。"
    if status == 400:
        return "请求格式被拒绝：常见原因是模型不支持当前参数、消息格式异常或 Responses API 不兼容。"
    return "上游请求失败。"


def _sse_error(message: str, *, trace_id: str = "", status: int | None = None, code: str = "upstream_error") -> str:
    payload = {
        "error": {
            "message": message,
            "type": code,
            "status": status,
            "trace_id": trace_id,
        }
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _sse_error_from_response(resp: httpx.Response, *, trace_id: str, api_name: str) -> str:
    text = _compact_error_text(await _read_response_text(resp))
    message = f"{api_name} 返回 HTTP {resp.status_code} {resp.reason_phrase or ''}。{_diagnose_status(resp.status_code)}"
    if text:
        message += f" 上游详情：{text}"
    logger.warning("[%s] %s", trace_id, message)
    return _sse_error(message, trace_id=trace_id, status=resp.status_code, code="http_error")


def _sse_error_from_exception(exc: Exception, *, trace_id: str, api_name: str) -> str:
    if isinstance(exc, httpx.ConnectTimeout):
        msg = f"{api_name} 连接超时：无法在限定时间内连接到上游 Base URL。请检查网络、代理/VPN、防火墙和 Base URL。"
        code = "connect_timeout"
    elif isinstance(exc, httpx.ReadTimeout):
        msg = f"{api_name} 读超时：已连接上游，但长时间没有收到新数据。可能是模型排队、长思考或代理链路中断。"
        code = "read_timeout"
    elif isinstance(exc, httpx.ConnectError):
        msg = f"{api_name} 连接失败：无法连接到上游。请检查 Base URL、DNS、代理/VPN、防火墙或本地模型服务是否启动。"
        code = "connect_error"
    elif isinstance(exc, httpx.RemoteProtocolError):
        msg = f"{api_name} 协议错误：上游提前断开或返回了不完整的流式响应。"
        code = "protocol_error"
    elif isinstance(exc, httpx.HTTPError):
        msg = f"{api_name} HTTP 客户端错误：{exc}"
        code = "http_client_error"
    else:
        msg = f"{api_name} 代理异常：{exc}"
        code = "proxy_error"
    logger.exception("[%s] %s", trace_id, msg)
    return _sse_error(msg, trace_id=trace_id, code=code)


async def _json_or_error(resp: httpx.Response, *, trace_id: str, api_name: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """读取非流式响应；失败时返回统一诊断对象。"""
    if resp.status_code >= 400:
        text = _compact_error_text(resp.text)
        message = f"{api_name} 返回 HTTP {resp.status_code} {resp.reason_phrase or ''}。{_diagnose_status(resp.status_code)}"
        if text:
            message += f" 上游详情：{text}"
        logger.warning("[%s] %s", trace_id, message)
        return None, {"code": -1, "data": None, "message": message}
    try:
        return resp.json(), None
    except json.JSONDecodeError:
        text = _compact_error_text(resp.text)
        message = f"{api_name} 返回了非 JSON 响应。请检查 Base URL 是否指向正确 API 端点。"
        if text:
            message += f" 响应片段：{text}"
        logger.warning("[%s] %s", trace_id, message)
        return None, {"code": -1, "data": None, "message": message}


def _get_client(base_url: str) -> httpx.AsyncClient:
    """获取或创建共享的 httpx 客户端（按 base_url 分组，复用连接池）。"""
    if base_url not in _http_clients:
        _http_clients[base_url] = httpx.AsyncClient(
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
            timeout=REQUEST_TIMEOUT,
        )
    return _http_clients[base_url]


def _get_stream_client(base_url: str) -> httpx.AsyncClient:
    """获取或创建流式专用客户端（更长 read 超时）。"""
    key = f"{base_url}__stream"
    if key not in _http_clients:
        _http_clients[key] = httpx.AsyncClient(
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=10),
            timeout=STREAM_TIMEOUT,
        )
    return _http_clients[key]

# ── 推理强度：UI 档位 → 厂商字段（2026-09 按各家官方文档核对） ────────
# UI 只有五档：auto（不下发任何字段）/ off / low / medium / high。
# 能力名描述的是「上游认哪种字段与取值形状」，不是厂商名：同一家厂商的不同代模型
# 会落到不同能力上（GLM-5.2 认 reasoning_effort，GLM-5.3 只认 max|high|low）。
# 能力取值与前端 chat.js 的 REASONING_LEVELS_BY_CAP 必须一致，
# 由 scripts/check_reasoning_effort.mjs 锁定，改一处就要过守卫。
REASONING_MAP: dict[str, dict[str, str]] = {
    # OpenAI：Chat Completions → reasoning_effort；Responses → reasoning.effort（同一批取值）
    "openai": {"off": "minimal", "low": "low", "medium": "medium", "high": "high"},
    # 认 OpenAI 词表且支持关闭的兼容端点：智谱 GLM-5.2、火山豆包、Ollama、llama.cpp
    # 这些家的 off 档写法是 none，不是 OpenAI 的 minimal
    "effort": {"off": "none", "low": "low", "medium": "medium", "high": "high"},
    # 强制思考、没有"关"这一档的家：Kimi K2.7-code/K3（low|high|max）、GLM-5.3*（max|high|low）
    # 中档在这两家的词表里不存在，收敛到各自的高档
    "effort_forced": {"low": "low", "medium": "high", "high": "max"},
    # Anthropic：新版用 output_config.effort，budget_tokens 已废弃，且没有"关"这一档
    "anthropic": {"low": "low", "medium": "medium", "high": "high"},
    # Google：generationConfig.thinking_level
    "gemini": {"off": "minimal", "low": "low", "medium": "medium", "high": "high"},
    # 只分开关的 OpenAI 兼容端点（DeepSeek 官方 thinking.type）：低/中/高统一收敛为"开"
    "binary": {"off": "disabled", "low": "enabled", "medium": "enabled", "high": "enabled"},
    # MiniMax 的开关枚举是 disabled|adaptive，没有 enabled；M2.x 关不掉但不会报错
    "adaptive": {"off": "disabled", "low": "adaptive", "medium": "adaptive", "high": "adaptive"},
    # 通义/文心系：布尔开关 enable_thinking，没有强弱档，低/中/高收敛为"开"
    "toggle": {"off": "off", "low": "on", "medium": "on", "high": "on"},
    # 未核实或自定义端点：一律不下发，宁可不生效也不能让上游 400
    "none": {},
}

# 这三个能力共用 reasoning_effort / reasoning.effort 词表，只是取值域不同
_EFFORT_CAPS = ("openai", "effort", "effort_forced")
# thinking 对象下只有 type 一个开关的家
_THINKING_CAPS = ("binary", "adaptive")
# enable_thinking=true 时 DashScope 对 max_tokens 的硬上限
TOGGLE_MAX_TOKENS = 32768

REASONING_LEVELS = ("auto", "off", "low", "medium", "high")

# 自定义模型（注册表没登记 id）按端点域名回落能力。逐条与前端
# chat.js 的 REASONING_CAP_BY_HOST 同源，守卫按字符串集合比对两侧，改一边就红。
# 只收录官方文档写明该字段的域名；猜不准的宁可留空（= none）。
REASONING_HOST_CAPS: tuple[tuple[str, str], ...] = (
    ("https://api.openai.com", "openai"),
    ("https://api.deepseek.com", "binary"),
    ("https://api.moonshot.cn", "effort_forced"),
    ("https://api.kimi.com", "effort_forced"),
    ("https://dashscope.aliyuncs.com", "toggle"),
    ("https://open.bigmodel.cn", "effort"),
    ("https://ark.cn-beijing.volces.com", "effort"),
    ("https://api.minimax.cn", "adaptive"),
    ("https://api.minimax.io", "adaptive"),
    ("https://qianfan.baidubce.com", "toggle"),
    ("http://localhost:11434", "effort"),
    ("http://127.0.0.1:11434", "effort"),
)


def _reasoning_level(body: dict[str, Any]) -> str:
    """归一化前端传来的档位；取值域外一律按 auto（不下发）。"""
    level = str(body.get("reasoning_effort") or "auto").strip().lower()
    return level if level in REASONING_LEVELS else "auto"


def _reasoning_capability(model_cfg: dict[str, Any], provider: str) -> str:
    """模型推理能力：注册表 reasoning 字段优先，自定义模型按端点回落，其余 none。"""
    cap = str(model_cfg.get("reasoning") or "").strip().lower()
    if cap in REASONING_MAP:
        return cap
    if provider == "anthropic":
        return "anthropic"
    if provider == "google":
        return "gemini"
    # 未登记 id 的自定义模型：只有端点域名能说明它认什么字段
    base_url = str(model_cfg.get("base_url") or "").strip().lower()
    for prefix, host_cap in REASONING_HOST_CAPS:
        if base_url.startswith(prefix):
            return host_cap
    return "none"


def _reasoning_value(cap: str, level: str) -> str | None:
    """按能力取厂商侧取值；auto 或该能力不支持该档时返回 None（即不下发）。"""
    if level == "auto":
        return None
    return REASONING_MAP.get(cap, {}).get(level) or None


# 字段名跟着协议走，取值跟着能力走：两者不匹配时宁可不发。
# 否则一个标了 anthropic 的模型走 OpenAI 兼容通道时，会把 anthropic 的取值塞进
# reasoning_effort，上游要么 400 要么静默解释成另一回事。


def _reasoning_payload(protocol: str, cap: str, level: str) -> dict[str, Any]:
    """返回要合并进请求体的字段片段；协议与能力不匹配、或档位为 auto 时返回 {}。"""
    value = _reasoning_value(cap, level)
    if not value:
        return {}
    if protocol == "chat":
        if cap in _EFFORT_CAPS:
            return {"reasoning_effort": value}
        if cap in _THINKING_CAPS:
            # 这一类只有 thinking.type 开关，没有 reasoning_effort
            return {"thinking": {"type": value}}
        if cap == "toggle":
            return {"enable_thinking": value == "on"}
        return {}
    if protocol == "responses" and cap in _EFFORT_CAPS:
        # Responses API 用嵌套 reasoning.effort，取值域与 Chat 侧同一批词表
        return {"reasoning": {"effort": value}}
    if protocol == "anthropic" and cap == "anthropic":
        # budget_tokens 已废弃，新版只认 output_config.effort
        return {"output_config": {"effort": value}}
    if protocol == "google" and cap == "gemini":
        return {"thinking_level": value}
    return {}


# 我们可能往请求体里加的推理强度字段。上游若明确抱怨其中某一个，就按它说的去掉重发。
_REASONING_FIELDS = ("reasoning_effort", "thinking", "thinking_level", "reasoning", "output_config", "enable_thinking")


def _without_reasoning(payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """剥掉本次注入的推理强度字段（含 generationConfig 内层），返回 (新体, 被剥掉的字段)。"""
    dropped = [k for k in _REASONING_FIELDS if k in payload]
    clean = {k: v for k, v in payload.items() if k not in _REASONING_FIELDS}
    gen = clean.get("generationConfig")
    if isinstance(gen, dict) and any(k in gen for k in _REASONING_FIELDS):
        dropped.append("generationConfig")
        clean["generationConfig"] = {k: v for k, v in gen.items() if k not in _REASONING_FIELDS}
    return clean, dropped


def _rejects_reasoning_field(payload: dict[str, Any], error_text: str) -> bool:
    """只有"上游点名抱怨了我们注入的那个字段"才值得重发一次。

    裸 400、鉴权失败、限流都不该被当成字段问题——那样会把真实错误掩盖成一次无谓重发。
    """
    low = (error_text or "").lower()
    if not low:
        return False
    return any(key in low for key in payload if key in _REASONING_FIELDS)


async def _post_json(client: httpx.AsyncClient, url: str, headers: dict[str, str],
                     payload: dict[str, Any], *, trace_id: str, api_name: str):
    """非流式 POST，带同一套字段降级：与 _stream_openai 的理由一致——

    思考强度是锦上添花，赌错上游字段不该让那条模型整条链路报错，
    所以只在上游点名抱怨我们注入的那个字段时剥掉重发一次。
    """
    resp = await client.post(url, json=payload, headers=headers)
    data, error = await _json_or_error(resp, trace_id=trace_id, api_name=api_name)
    if not error or not _rejects_reasoning_field(payload, str(error.get("message") or "")):
        return data, error
    clean, dropped = _without_reasoning(payload)
    if not dropped:
        return data, error
    logger.warning(f"[{trace_id}] {api_name} 上游拒绝推理强度字段 {dropped}，去掉该字段重发一次")
    resp = await client.post(url, json=clean, headers=headers)
    return await _json_or_error(resp, trace_id=trace_id, api_name=api_name)


# ── 模型注册表（2026-09 时效性校验） ──────────────────────────

MODEL_REGISTRY: dict[str, list[dict[str, Any]]] = {
    "international": [
        {"id": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "provider": "openai",
         "base_url": "https://api.openai.com/v1", "context_window": 1050000, "supports_responses": True, "reasoning": "openai"},
        {"id": "gpt-5.6-terra", "name": "GPT-5.6 Terra", "provider": "openai",
         "base_url": "https://api.openai.com/v1", "context_window": 1050000, "supports_responses": True, "reasoning": "openai"},
        {"id": "gpt-5.6-luna", "name": "GPT-5.6 Luna", "provider": "openai",
         "base_url": "https://api.openai.com/v1", "context_window": 1050000, "supports_responses": True, "reasoning": "openai"},
        {"id": "claude-fable-5-1", "name": "Claude Fable 5.1", "provider": "anthropic",
         "base_url": "https://api.anthropic.com", "context_window": 1000000, "reasoning": "anthropic"},
        {"id": "claude-fable-5", "name": "Claude Fable 5", "provider": "anthropic",
         "base_url": "https://api.anthropic.com", "context_window": 1000000, "reasoning": "anthropic"},
        {"id": "claude-opus-5", "name": "Claude Opus 5", "provider": "anthropic",
         "base_url": "https://api.anthropic.com", "context_window": 1000000, "reasoning": "anthropic"},
        {"id": "claude-sonnet-5", "name": "Claude Sonnet 5", "provider": "anthropic",
         "base_url": "https://api.anthropic.com", "context_window": 1000000, "reasoning": "anthropic"},
        {"id": "gemini-3.6-flash", "name": "Gemini 3.6 Flash", "provider": "google",
         "base_url": "https://generativelanguage.googleapis.com/v1beta", "context_window": 1048576, "reasoning": "gemini"},
        {"id": "gemini-3.1-pro-preview", "name": "Gemini 3.1 Pro", "provider": "google",
         "base_url": "https://generativelanguage.googleapis.com/v1beta", "context_window": 1048576, "reasoning": "gemini"},
        {"id": "gemini-3.5-flash-lite", "name": "Gemini 3.5 Flash-Lite", "provider": "google",
         "base_url": "https://generativelanguage.googleapis.com/v1beta", "context_window": 1048576, "reasoning": "gemini"},
    ],
    "domestic": [
        # 官方仅接受这两个模型名：deepseek-chat 已下线，识图/快速/专家模式已并入其中
        {"id": "deepseek-v4-pro", "name": "DeepSeek-V4-Pro", "provider": "openai",
         "base_url": "https://api.deepseek.com/v1", "context_window": 1048576, "reasoning": "binary"},
        {"id": "deepseek-flash", "name": "DeepSeek-V4.1-Flash", "provider": "openai",
         "base_url": "https://api.deepseek.com/v1", "context_window": 1048576, "reasoning": "binary"},
        {"id": "kimi-k3", "name": "Kimi K3", "provider": "openai",
         "base_url": "https://api.moonshot.cn/v1", "context_window": 1048576, "reasoning": "effort_forced"},
        # K2.7 Code 强制思考：thinking.type 只认 enabled，传 disabled 直接报错 → 没有可下发的档位
        {"id": "kimi-k2.7-code", "name": "Kimi K2.7 Code", "provider": "openai",
         "base_url": "https://api.moonshot.cn/v1", "context_window": 262144, "reasoning": "none"},
        {"id": "qwen3.8-max", "name": "Qwen3.8-Max", "provider": "openai",
         "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "context_window": 1000000, "supports_responses": True, "reasoning": "toggle"},
        {"id": "qwen3.8-flash", "name": "Qwen3.8-Flash", "provider": "openai",
         "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "context_window": 1000000, "supports_responses": True, "reasoning": "toggle"},
        {"id": "qwen3.7-max", "name": "Qwen3.7-Max", "provider": "openai",
         "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "context_window": 1000000, "supports_responses": True, "reasoning": "toggle"},
        {"id": "qwen3.7-plus", "name": "Qwen3.7-Plus", "provider": "openai",
         "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "context_window": 1000000, "supports_responses": True, "reasoning": "toggle"},
        # GLM-5.2 起支持 reasoning_effort（max|xhigh|high|medium|low|minimal|none）；
        # 5.3 系列强制思考且词表收窄为 max|high|low，没有 off 档
        {"id": "glm-5.2", "name": "GLM-5.2", "provider": "openai",
         "base_url": "https://open.bigmodel.cn/api/paas/v4", "context_window": 1048576, "reasoning": "effort"},
        {"id": "glm-5.3", "name": "GLM-5.3", "provider": "openai",
         "base_url": "https://open.bigmodel.cn/api/paas/v4", "context_window": 1048576, "reasoning": "effort_forced"},
        {"id": "glm-5.3-flash", "name": "GLM-5.3-Flash", "provider": "openai",
         "base_url": "https://open.bigmodel.cn/api/paas/v4", "context_window": 1048576, "reasoning": "effort_forced"},
        {"id": "doubao-seed-2-1-pro-260628", "name": "Doubao-Seed-2.1-Pro-260628", "provider": "openai",
         "base_url": "https://ark.cn-beijing.volces.com/api/v3", "context_window": 262144, "reasoning": "effort"},
        {"id": "doubao-seed-2-1-turbo-260628", "name": "Doubao-Seed-2.1-Turbo-260628", "provider": "openai",
         "base_url": "https://ark.cn-beijing.volces.com/api/v3", "context_window": 262144, "reasoning": "effort"},
        # MiniMax 的枚举是 disabled|adaptive（没有 enabled），且只有开关没有强弱档
        {"id": "MiniMax-M3", "name": "MiniMax M3", "provider": "openai",
         "base_url": "https://api.minimax.cn/v1", "context_window": 1000000, "supports_responses": True, "reasoning": "adaptive"},
        {"id": "ernie-5.1", "name": "ERNIE 5.1", "provider": "openai",
         "base_url": "https://qianfan.baidubce.com/v2", "context_window": 131072, "reasoning": "toggle"},
    ],
    "local": [
        # Ollama 的 OpenAI 兼容层官方写明支持 reasoning_effort（none|low|medium|high|max）；
        # 指向 LM Studio 时它按未知字段忽略，最坏是档位不生效而不是报错
        {"id": "local", "name": "本地模型 (Ollama/LM Studio)", "provider": "openai",
         "base_url": "http://localhost:11434/v1", "context_window": 8192, "reasoning": "effort"},
    ],
}


@router.get("/models")
async def list_models() -> dict[str, Any]:
    """返回所有预设模型列表。"""
    return {"code": 0, "data": MODEL_REGISTRY, "message": "ok"}


def _find_model(model_id: str, base_url: str | None = None, provider: str | None = None) -> dict[str, Any] | None:
    """在注册表中查找模型配置，未找到时构建自定义配置。"""
    for category_models in MODEL_REGISTRY.values():
        for m in category_models:
            if m["id"] == model_id:
                return m
    # 自定义模型
    if base_url:
        return {
            "id": model_id,
            "name": model_id,
            "provider": provider or "openai",
            "base_url": base_url,
            "context_window": 32768,
        }
    return None


# ── 上下文窗口探测（本地 / 自定义端点的「自动」要按真实窗口来）────────
# 厂商云端的窗口写死在 MODEL_REGISTRY 里，本地端点（Ollama / LM Studio / llama.cpp /
# vLLM）只能让用户在添加模型时手填。猜小了浪费上下文，猜大了直接吃上游 400，
# 所以这里按端点形态轮询几个公认入口，取第一个说得通的数；读不到就如实返回"没探测到"。
# 键名按"这台服务器实际会接多少"排序：正在服务的 n_ctx/num_ctx 优先于训练窗口，
# 否则会把 262144 的训练长度发给一个只开 4096 的服务。
CONTEXT_WINDOW_KEYS: tuple[str, ...] = (
    "num_ctx", "n_ctx", "total_n_ctx", "context_length", "max_model_len",
    "max_position_embeddings",
)
CONTEXT_WINDOW_MIN = 512
CONTEXT_WINDOW_MAX = 8_000_000
PROBE_TIMEOUT = httpx.Timeout(8.0, connect=4.0)
PROBE_STRING_BUDGET = 200_000  # 只在有界的字符串里试 JSON，别拿整段文档去解析


def _probe_roots(base_url: str) -> tuple[str, str]:
    """拆成 (兼容层根, 站点根)：/v1/models 与挂在站点根上的 /props、/api/show 不是同一处。"""
    raw = str(base_url or "").strip().rstrip("/")
    origin = re.sub(r"/v1$", "", raw)
    v1 = raw if raw.endswith("/v1") else f"{origin}/v1"
    return v1, origin


def _safe_probe_base(base_url: str) -> str:
    """只允许 http/https 且必须有主机名；Base URL 是用户配的，但别把这里变成任意请求转发器。"""
    try:
        parsed = urlparse(str(base_url or "").strip())
    except ValueError:
        return ""
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ""
    if any(ch in str(base_url) for ch in ("\r", "\n", " ", "\t")):
        return ""
    return str(base_url).strip().rstrip("/")


def _harvest_context_window(node: Any) -> int:
    """在任意 JSON 结构里按 CONTEXT_WINDOW_KEYS 的优先级找窗口数；找不到返回 0。

    两处形状必须认得，否则本地端点一个都探不到：Ollama 把窗口写成带架构前缀的
    `llama.context_length`，又把服务窗口包成 `{"num_ctx": {"default": 4096}}` 这种 schema 形状。
    """
    hits: list[tuple[int, int]] = []

    def accept(key: str, value: int) -> None:
        if key in CONTEXT_WINDOW_KEYS and CONTEXT_WINDOW_MIN <= value <= CONTEXT_WINDOW_MAX:
            hits.append((CONTEXT_WINDOW_KEYS.index(key), value))

    def walk(cur: Any, key: str, depth: int) -> None:
        if depth > 6:
            return
        leaf = str(key).rsplit(".", 1)[-1]
        if isinstance(cur, dict):
            default = cur.get("default")
            if isinstance(default, (int, float)) and not isinstance(default, bool):
                accept(leaf, int(default))
            for k, v in cur.items():
                walk(v, str(k).lower(), depth + 1)
        elif isinstance(cur, list):
            for item in cur[:200]:
                walk(item, leaf, depth + 1)
        elif isinstance(cur, bool):
            return
        elif isinstance(cur, (int, float)):
            accept(leaf, int(cur))
        elif isinstance(cur, str) and cur.startswith(("{", "[")) and len(cur) < PROBE_STRING_BUDGET:
            # Ollama 的 parameters / raw 是 JSON 字符串，不当字符串处理就当没有
            try:
                walk(json.loads(cur), leaf, depth + 1)
            except (json.JSONDecodeError, TypeError, ValueError):
                return

    walk(node, "", 0)
    if not hits:
        return 0
    best_rank = min(rank for rank, _ in hits)
    return min(value for rank, value in hits if rank == best_rank)


def _probe_plan(v1: str, origin: str, model: str) -> list[tuple[str, str, str, Any]]:
    """(标签, 方法, 完整 URL, 请求体或 None)；标签会回给前端，探测失败时能看出卡在哪一步。"""
    quoted = quote(model, safe="")
    return [
        ("ollama/api/show", "POST", f"{origin}/api/show", {"model": model}),
        ("openai/models/{id}", "GET", f"{v1}/models/{quoted}", None),
        ("llama.cpp/props", "GET", f"{origin}/props", None),
        ("llama.cpp/v1/props", "GET", f"{v1}/props", None),
        ("openai/models", "GET", f"{v1}/models", None),
    ]


def _pick_model_entry(node: Any, model: str) -> Any:
    """列表端点里只认这一条模型自己的对象，别把邻居的窗口当成它的。"""
    items = node.get("data") if isinstance(node, dict) else node
    if not isinstance(items, list):
        return None
    for item in items:
        if isinstance(item, dict) and str(item.get("id") or item.get("name") or "") == model:
            return item
    return None


@router.post("/probe-context")
async def probe_context(request: Request) -> dict[str, Any]:
    """探测某个端点上这个模型的真实上下文窗口；探不到时明确说探不到。"""
    body = await request.json()
    model = str(body.get("model") or "").strip()
    api_key = str(body.get("api_key") or "").strip()
    provider = str(body.get("provider") or "openai")
    base_url = _safe_probe_base(str(body.get("base_url") or ""))
    if not model or not base_url:
        return {"code": -1, "data": None, "message": "模型名与 Base URL 必填，且只支持 http/https 端点"}

    if provider == "anthropic":
        headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    else:
        headers = {"authorization": f"Bearer {api_key}"} if api_key else {}

    v1, origin = _probe_roots(base_url)
    tried: list[str] = []
    async with httpx.AsyncClient(timeout=PROBE_TIMEOUT, follow_redirects=False) as client:
        for label, method, url, payload in _probe_plan(v1, origin, model):
            tried.append(label)
            try:
                if method == "POST":
                    resp = await client.post(url, json=payload, headers=headers)
                else:
                    resp = await client.get(url, headers=headers)
            except httpx.HTTPError:
                continue
            if resp.status_code >= 400:
                continue
            try:
                data = resp.json()
            except (json.JSONDecodeError, ValueError):
                continue
            if label == "openai/models":
                data = _pick_model_entry(data, model)
                if data is None:
                    continue
            window = _harvest_context_window(data)
            if window:
                return {"code": 0,
                        "data": {"context_window": window, "source": label},
                        "message": "ok"}
    return {"code": 0,
            "data": {"context_window": 0, "source": "", "tried": tried},
            "message": "这个端点没有暴露上下文窗口，请按模型文档手填"}


def _build_openai_request(body: dict[str, Any], cap: str = "none", level: str = "auto") -> dict[str, Any]:
    """构建 OpenAI 兼容格式的请求体。"""
    payload: dict[str, Any] = {
        "model": body["model"],
        "messages": body["messages"],
        "stream": body.get("stream", False),
    }
    if "temperature" in body:
        payload["temperature"] = body["temperature"]
    if max_tokens := body.get("max_tokens"):
        payload["max_tokens"] = max_tokens
    # 原生工具调用：前端在支持时传入 tools 数组（OpenAI 格式），透传给上游
    if body.get("tools"):
        payload["tools"] = body["tools"]
    if body.get("tool_choice"):
        payload["tool_choice"] = body["tool_choice"]
    # 推理强度：字段名与取值都由协议/能力共同决定，不匹配即不下发
    payload.update(_reasoning_payload("chat", cap, level))
    # DashScope 开思考后 max_tokens 上限收紧到 32768，越界是整条 400 而不是截断输出，
    # 所以「不限量输出」在这类模型上要给一个能用的上限，而不是把请求打死。
    if cap == "toggle" and _reasoning_value(cap, level) == "on":
        if isinstance(payload.get("max_tokens"), int) and payload["max_tokens"] > TOGGLE_MAX_TOKENS:
            payload["max_tokens"] = TOGGLE_MAX_TOKENS
    return payload


def _build_responses_request(body: dict[str, Any], cap: str = "none", level: str = "auto") -> dict[str, Any]:
    """构建 OpenAI Responses API 格式的请求体。

    Responses API 是 Chat Completions 的演进版：
    - system 消息提取为顶层 instructions 字段
    - 其余消息放入 input 数组（保持 chat 格式兼容）
    - max_tokens → max_output_tokens
    """
    messages = body.get("messages", [])
    instructions_parts = []
    input_messages = []
    for msg in messages:
        if msg.get("role") == "system":
            content = msg.get("content", "")
            if isinstance(content, str):
                instructions_parts.append(content)
            elif isinstance(content, list):
                # 多模态 system 消息，提取文本部分
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        instructions_parts.append(part.get("text", ""))
        else:
            input_messages.append(msg)

    payload: dict[str, Any] = {
        "model": body["model"],
        "input": input_messages,
        "stream": body.get("stream", False),
    }
    if instructions_parts:
        payload["instructions"] = "\n\n".join(instructions_parts)
    if max_tokens := body.get("max_tokens"):
        payload["max_output_tokens"] = max_tokens
    if "temperature" in body:
        payload["temperature"] = body["temperature"]
    # 原生工具调用：Chat Completions 格式转 Responses 格式
    # {type:"function", function:{name,description,parameters}} → {type:"function", name, description, parameters}
    if body.get("tools"):
        converted = []
        for tool in body["tools"]:
            fn = tool.get("function", {}) if tool.get("type") == "function" else tool
            converted.append({
                "type": "function",
                "name": fn.get("name", ""),
                "description": fn.get("description", ""),
                "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
            })
        payload["tools"] = converted
    if body.get("tool_choice"):
        payload["tool_choice"] = body["tool_choice"]
    # 推理强度：只有 openai 能力在 Responses 侧有 reasoning.effort，其余不下发
    payload.update(_reasoning_payload("responses", cap, level))
    return payload


def _extract_responses_text(data: dict[str, Any]) -> str:
    """从 Responses API 非流式/完成事件中提取文本。"""
    text = data.get("output_text") or ""
    for item in data.get("output", []) or []:
        if item.get("type") == "message":
            for content in item.get("content", []) or []:
                if content.get("type") in ("output_text", "text"):
                    text += content.get("text", "")
        elif item.get("type") == "output_text":
            text += item.get("text", "")
    return text


def _parse_data_url(url: str) -> tuple[str, str] | None:
    """解析 data:MIME;base64,DATA 格式，返回 (mime, data)，非法时返回 None。"""
    m = re.match(r"^data:([^;]+);base64,(.+)$", url, re.DOTALL)
    if not m:
        return None
    return m.group(1), m.group(2)


def _to_anthropic_content(content: Any) -> Any:
    """将 OpenAI 多模态内容数组转为 Anthropic 格式；纯文本透传。"""
    if isinstance(content, str):
        return content
    parts: list[dict[str, Any]] = []
    for part in content or []:
        ptype = part.get("type")
        if ptype == "text":
            parts.append({"type": "text", "text": part.get("text", "")})
        elif ptype == "image_url":
            parsed = _parse_data_url(part.get("image_url", {}).get("url", ""))
            if parsed:
                mime, data = parsed
                parts.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}})
    return parts or [{"type": "text", "text": ""}]


def _to_gemini_parts(content: Any) -> list[dict[str, Any]]:
    """将 OpenAI 多模态内容数组转为 Gemini parts；纯文本包装为单 text part。"""
    if isinstance(content, str):
        return [{"text": content}]
    parts: list[dict[str, Any]] = []
    for part in content or []:
        ptype = part.get("type")
        if ptype == "text":
            parts.append({"text": part.get("text", "")})
        elif ptype == "image_url":
            parsed = _parse_data_url(part.get("image_url", {}).get("url", ""))
            if parsed:
                mime, data = parsed
                parts.append({"inline_data": {"mime_type": mime, "data": data}})
    return parts or [{"text": ""}]


def _build_anthropic_request(body: dict[str, Any], cap: str = "none", level: str = "auto") -> dict[str, Any]:
    """构建 Anthropic 格式请求体。"""
    messages = body.get("messages", [])
    system_msg = ""
    chat_messages = []
    for msg in messages:
        if msg["role"] == "system":
            system_msg = msg["content"] if isinstance(msg["content"], str) else _to_anthropic_content(msg["content"])
        else:
            # 防御：原生工具协议消息（role="tool"）在 Anthropic 无对应概念，转成 user 保留结果文本
            role = "user" if msg["role"] == "tool" else msg["role"]
            chat_messages.append({"role": role, "content": _to_anthropic_content(msg["content"])})

    payload: dict[str, Any] = {
        "model": body["model"],
        "messages": chat_messages,
        "max_tokens": body.get("max_tokens", 4096),
        "stream": body.get("stream", False),
    }
    if system_msg:
        payload["system"] = system_msg
    # 推理强度：output_config.effort（budget_tokens 已废弃）。该字段生效时上游会拒绝
    # temperature/top_p，因此只有真正下发 effort 才丢弃采样参数，其余保持原样。
    reasoning_fields = _reasoning_payload("anthropic", cap, level)
    if reasoning_fields:
        payload.update(reasoning_fields)
    elif "temperature" in body:
        payload["temperature"] = body["temperature"]
    return payload


async def _stream_openai(url: str, headers: dict[str, str], payload: dict[str, Any], trace_id: str = ""):
    """流式转发；上游点名拒绝我们注入的推理强度字段时，去掉那个字段重发一次。

    没有这层降级，「给更多模型开思考强度」就等于赌每家端点都认这个字段——
    赌错的代价是那条模型整条链路不可用，而不是档位不生效。
    """
    client = _get_stream_client(url.rsplit("/", 2)[0])  # 提取 base_url
    sink: dict[str, str] = {"text": ""}
    async for chunk in _stream_openai_attempt(client, url, headers, payload, trace_id, sink, True):
        yield chunk
    if not sink["text"]:
        return
    clean, dropped = _without_reasoning(payload)
    if not dropped:
        yield sink["text"]
        yield "data: [DONE]\n\n"
        return
    logger.warning(f"[{trace_id}] 上游拒绝推理强度字段 {dropped}，去掉该字段重发一次")
    async for chunk in _stream_openai_attempt(client, url, headers, clean, trace_id, {"text": ""}, False):
        yield chunk


async def _stream_openai_attempt(client, url: str, headers: dict[str, str], payload: dict[str, Any],
                                 trace_id: str, sink: dict[str, str], can_retry: bool):
    """OpenAI 兼容流式转发的一次尝试（共享客户端连接池）。
    标准化 reasoning 字段：delta.reasoning_content / delta.reasoning → delta.reasoning
    上游 400 且抱怨的是我们加的推理强度字段时，把错误交给 sink，由上层去掉字段重发。
    """
    yielded = False
    try:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code >= 400:
                err = await _sse_error_from_response(resp, trace_id=trace_id, api_name="Chat Completions")
                if can_retry and _rejects_reasoning_field(payload, err):
                    sink["text"] = err
                    return
                yield err
                yield "data: [DONE]\n\n"
                return
            async for line in resp.aiter_lines():
                if not line:
                    continue
                trimmed = line.strip()
                if not trimmed.startswith("data:"):
                    yield f"{line}\n\n"
                    continue
                data_str = trimmed[5:].strip()
                if data_str == "[DONE]":
                    yield f"{line}\n\n"
                    return
                try:
                    parsed = json.loads(data_str)
                    if parsed.get("error"):
                        yield _sse_error(_compact_error_text(json.dumps(parsed["error"], ensure_ascii=False)), trace_id=trace_id)
                        yield "data: [DONE]\n\n"
                        return
                    choices = parsed.get("choices")
                    if not choices or len(choices) == 0:
                        # Some providers (e.g. Qwen) send metadata-only chunks with empty choices; skip safely
                        continue
                    delta = choices[0].get("delta", {})
                    # 标准化 reasoning 字段
                    reasoning = delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking")
                    if reasoning:
                        delta["reasoning"] = reasoning
                        # 移除原始字段，保持干净
                        for k in ("reasoning_content", "reasoning", "thinking"):
                            if k in delta and k != "reasoning":
                                del delta[k]
                        parsed["choices"][0]["delta"] = delta
                    if delta.get("content") or delta.get("reasoning") or delta.get("tool_calls"):
                        yielded = True
                    yield f"data: {json.dumps(parsed, ensure_ascii=False)}\n\n"
                except json.JSONDecodeError:
                    yield f"{line}\n\n"
            if not yielded:
                yield _sse_error("Chat Completions 连接正常结束，但上游没有返回任何文本增量或完成信号。请检查模型是否支持流式输出、是否被内容过滤，或服务商是否返回了非标准 SSE。", trace_id=trace_id, code="empty_stream")
                yield "data: [DONE]\n\n"
    except Exception as exc:
        yield _sse_error_from_exception(exc, trace_id=trace_id, api_name="Chat Completions")
        yield "data: [DONE]\n\n"


async def _stream_responses(url: str, headers: dict[str, str], payload: dict[str, Any], trace_id: str = ""):
    """流式调用 Responses API，将事件转换为前端已适配的 Chat Completions SSE 格式。"""
    client = _get_stream_client(url.rsplit("/", 2)[0])
    try:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code >= 400:
                yield await _sse_error_from_response(resp, trace_id=trace_id, api_name="Responses API")
                yield "data: [DONE]\n\n"
                return
            sent_text_delta = False
            saw_completed = False
            # 原生工具调用累积：按出现顺序保存 {id, name, arguments}
            tool_calls_meta: list[dict[str, Any]] = []
            saw_tool_delta = False
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data_str = line[5:].strip()
                if data_str == "[DONE]":
                    yield "data: [DONE]\n\n"
                    continue
                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                # Responses API 流式事件解析
                obj_type = data.get("type", "")
                if obj_type in ("error", "response.failed", "response.incomplete"):
                    err = data.get("error") or data.get("response", {}).get("error") or data
                    yield _sse_error(f"Responses API 返回错误事件：{_compact_error_text(json.dumps(err, ensure_ascii=False))}", trace_id=trace_id)
                    yield "data: [DONE]\n\n"
                    return

                # 文本增量：response.output_text.delta
                if obj_type in ("response.output_text.delta", "response.text.delta"):
                    delta = data.get("delta", "")
                    if delta:
                        sent_text_delta = True
                        chunk = {"choices": [{"delta": {"content": delta}, "index": 0}]}
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                # 思考增量：response.reasoning_text.delta（Responses API）
                elif obj_type in ("response.reasoning_text.delta", "response.reasoning.delta"):
                    delta = data.get("delta", "")
                    if delta:
                        chunk = {"choices": [{"delta": {"reasoning": delta}, "index": 0}]}
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                # 原生工具调用：function_call 创建（携带 id 与函数名），转为 Chat Completions 流式格式
                elif obj_type == "response.output_item.added":
                    item = data.get("item") or {}
                    if item.get("type") == "function_call":
                        idx = len(tool_calls_meta)
                        call_id = item.get("id") or item.get("call_id") or f"fc_{idx}"
                        tool_calls_meta.append({"id": call_id, "name": item.get("name", ""), "arguments": ""})
                        saw_tool_delta = True
                        chunk = {"choices": [{"delta": {"tool_calls": [{"index": idx, "id": call_id, "type": "function", "function": {"name": item.get("name", ""), "arguments": ""}}]}, "index": 0}]}
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                # 原生工具调用：arguments 增量
                elif obj_type == "response.function_call_arguments.delta":
                    item_id = data.get("item_id")
                    delta_args = data.get("delta", "")
                    if delta_args:
                        for idx, call in enumerate(tool_calls_meta):
                            if call["id"] == item_id:
                                call["arguments"] += delta_args
                                saw_tool_delta = True
                                chunk = {"choices": [{"delta": {"tool_calls": [{"index": idx, "function": {"arguments": delta_args}}]}, "index": 0}]}
                                yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                                break

                elif obj_type in ("response.output_item.done", "response.content_part.done"):
                    item = data.get("item") or data.get("part") or {}
                    # 兼容只发 done 不发 delta 的实现：补齐缺失的调用创建/完整参数
                    if item.get("type") == "function_call":
                        call_id = item.get("id") or item.get("call_id") or ""
                        meta = next((c for c in tool_calls_meta if c["id"] == call_id), None)
                        if meta is None:
                            idx = len(tool_calls_meta)
                            meta = {"id": call_id or f"fc_{idx}", "name": item.get("name", ""), "arguments": ""}
                            tool_calls_meta.append(meta)
                            saw_tool_delta = True
                            chunk = {"choices": [{"delta": {"tool_calls": [{"index": idx, "id": meta["id"], "type": "function", "function": {"name": meta["name"], "arguments": ""}}]}, "index": 0}]}
                            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                        if item.get("arguments") and not meta["arguments"]:
                            meta["arguments"] = item["arguments"]
                            saw_tool_delta = True
                            idx = tool_calls_meta.index(meta)
                            chunk = {"choices": [{"delta": {"tool_calls": [{"index": idx, "function": {"arguments": item["arguments"]}}]}, "index": 0}]}
                            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                        continue
                    if sent_text_delta:
                        continue
                    text = ""
                    if item.get("type") in ("message", "output_text"):
                        for content in item.get("content", []) or []:
                            if isinstance(content, dict) and content.get("type") in ("output_text", "text"):
                                text += content.get("text", "")
                        if item.get("type") == "output_text":
                            text += item.get("text", "")
                    if text:
                        chunk = {"choices": [{"delta": {"content": text}, "index": 0}]}
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                # 完成信号
                elif obj_type == "response.completed":
                    saw_completed = True
                    response = data.get("response", {}) or {}
                    if not sent_text_delta:
                        final_text = _extract_responses_text(response)
                        if final_text:
                            chunk = {"choices": [{"delta": {"content": final_text}, "index": 0}]}
                            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                            sent_text_delta = True
                    status = response.get("status", "completed")
                    if status == "completed":
                        chunk = {"choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]}
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                        yield "data: [DONE]\n\n"
                        return

                # 兼容旧格式：某些 provider 直接在 data 内嵌 delta 字段
                elif "delta" in data and isinstance(data["delta"], str):
                    chunk = {"choices": [{"delta": {"content": data["delta"]}, "index": 0}]}
                    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            if not sent_text_delta and not saw_tool_delta and not saw_completed:
                yield _sse_error("Responses API 连接正常结束，但没有收到文本增量、工具调用或 completed 事件。请确认该模型/服务商是否真正支持 Responses API 流式输出，必要时关闭 Responses API 选项。", trace_id=trace_id, code="empty_stream")
                yield "data: [DONE]\n\n"
    except Exception as exc:
        yield _sse_error_from_exception(exc, trace_id=trace_id, api_name="Responses API")
        yield "data: [DONE]\n\n"


async def _stream_anthropic(url: str, headers: dict[str, str], payload: dict[str, Any], trace_id: str = ""):
    """流式转发 Anthropic API，转换为 OpenAI 兼容 SSE 格式（共享客户端）。"""
    client = _get_stream_client(url.rsplit("/", 2)[0])
    yielded = False
    try:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code >= 400:
                yield await _sse_error_from_response(resp, trace_id=trace_id, api_name="Anthropic")
                yield "data: [DONE]\n\n"
                return
            buffer = ""
            async for line in resp.aiter_lines():
                buffer += line + "\n"
                if line == "" and buffer.strip():
                    # 解析 Anthropic SSE 事件
                    event_type = ""
                    data_str = ""
                    for bline in buffer.strip().split("\n"):
                        if bline.startswith("event:"):
                            event_type = bline[6:].strip()
                        elif bline.startswith("data:"):
                            data_str = bline[5:].strip()
                    buffer = ""
                    if not data_str:
                        continue
                    try:
                        data = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue
                    # 转换为 OpenAI SSE 格式
                    if event_type == "content_block_delta":
                        delta = data.get("delta", {})
                        delta_type = delta.get("type", "")
                        # Anthropic 思考块（Extended Thinking）
                        if delta_type == "thinking_delta":
                            thinking = delta.get("thinking", "")
                            if thinking:
                                chunk = {
                                    "choices": [{"delta": {"reasoning": thinking}, "index": 0}]
                                }
                                yielded = True
                                yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                        # 普通文本块
                        else:
                            text = delta.get("text", "")
                            if text:
                                chunk = {
                                    "choices": [{"delta": {"content": text}, "index": 0}]
                                }
                                yielded = True
                                yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    elif event_type == "message_stop":
                        yield "data: [DONE]\n\n"
                        return
                    elif event_type == "error":
                        yield _sse_error(f"Anthropic 返回错误事件：{_compact_error_text(data_str)}", trace_id=trace_id)
                        yield "data: [DONE]\n\n"
                        return
            if not yielded:
                yield _sse_error("Anthropic 连接正常结束，但没有返回任何文本增量或完成信号。", trace_id=trace_id, code="empty_stream")
                yield "data: [DONE]\n\n"
    except Exception as exc:
        yield _sse_error_from_exception(exc, trace_id=trace_id, api_name="Anthropic")
        yield "data: [DONE]\n\n"


async def _stream_google(url: str, headers: dict[str, str], payload: dict[str, Any], trace_id: str = ""):
    """流式转发 Google Gemini（streamGenerateContent + alt=sse），转换为 OpenAI 兼容 SSE 格式。"""
    client = _get_stream_client(url.rsplit("/models/", 1)[0])
    yielded = False
    try:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code >= 400:
                yield await _sse_error_from_response(resp, trace_id=trace_id, api_name="Google")
                yield "data: [DONE]\n\n"
                return
            async for line in resp.aiter_lines():
                trimmed = line.strip()
                if not trimmed.startswith("data:"):
                    continue
                data_str = trimmed[5:].strip()
                if not data_str or data_str == "[DONE]":
                    continue
                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue
                if data.get("error"):
                    yield _sse_error(_compact_error_text(json.dumps(data["error"], ensure_ascii=False)), trace_id=trace_id)
                    yield "data: [DONE]\n\n"
                    return
                candidates = data.get("candidates") or []
                if not candidates:
                    continue
                cand = candidates[0]
                parts = (cand.get("content") or {}).get("parts") or []
                for part in parts:
                    text = part.get("text") or ""
                    if not text:
                        continue
                    yielded = True
                    # 思考摘要带 thought 标记：走 reasoning 通道，避免把思考当正文显示
                    delta_key = "reasoning" if part.get("thought") else "content"
                    chunk = {"choices": [{"delta": {delta_key: text}, "index": 0}]}
                    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                finish = cand.get("finishReason") or ""
                if finish == "STOP":
                    chunk = {"choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]}
                    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                if finish == "MAX_TOKENS":
                    chunk = {"choices": [{"delta": {}, "finish_reason": "length", "index": 0}]}
                    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                if finish in ("SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"):
                    if not yielded:
                        yield _sse_error(f"Gemini 内容被安全策略拦截（finishReason={finish}），未返回任何文本。请调整提问方式。", trace_id=trace_id, code="safety_filter")
                        yield "data: [DONE]\n\n"
                        return
            if not yielded:
                yield _sse_error("Google 连接正常结束，但没有返回任何文本增量。请检查模型 ID、API Key，或输出是否被安全策略拦截。", trace_id=trace_id, code="empty_stream")
                yield "data: [DONE]\n\n"
    except Exception as exc:
        yield _sse_error_from_exception(exc, trace_id=trace_id, api_name="Google")
        yield "data: [DONE]\n\n"


@router.post("/chat")
async def proxy_chat(request: Request) -> Any:
    """代理聊天请求到对应 LLM API。
    
    Loop Engineering: 每次请求分配唯一 trace_id，用于追踪和日志。
    """
    body = await request.json()
    model_id = body.get("model", "")
    api_key = body.get("api_key", "")
    custom_base_url = body.get("base_url")
    custom_provider = body.get("provider")
    is_stream = body.get("stream", False)
    
    # 生成请求追踪 ID（Loop Engineering: 可观测性）
    trace_id = str(uuid.uuid4())[:8]
    logger.info(f"[{trace_id}] 请求开始: model={model_id}, stream={is_stream}")

    model_cfg = _find_model(model_id, custom_base_url, custom_provider)
    if not model_cfg:
        logger.warning(f"[{trace_id}] 未知模型: {model_id}")
        return {"code": -1, "data": None, "message": f"未知模型: {model_id}"}

    provider = model_cfg["provider"]
    base_url = model_cfg["base_url"]

    # 推理强度：一次算出「模型能力 + 用户档位」，供各协议构建器共用
    reasoning_cap = _reasoning_capability(model_cfg, provider)
    reasoning_level = _reasoning_level(body)
    if reasoning_level != "auto" and reasoning_cap == "none":
        logger.info(f"[{trace_id}] 推理强度不下发（端点能力未知）: model={model_id}, level={reasoning_level}")

    # ── Anthropic ──
    if provider == "anthropic":
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        url = f"{base_url}/v1/messages"
        payload = _build_anthropic_request(body, reasoning_cap, reasoning_level)

        if is_stream:
            logger.info(f"[{trace_id}] Anthropic 流式请求: {url}")
            return StreamingResponse(
                _stream_anthropic(url, headers, payload, trace_id),
                media_type="text/event-stream",
            )

        client = _get_client(base_url)
        try:
            data, error = await _post_json(client, url, headers, payload, trace_id=trace_id, api_name="Anthropic")
            if error:
                return error
        except httpx.HTTPError as exc:
            msg = _sse_error_from_exception(exc, trace_id=trace_id, api_name="Anthropic")
            return {"code": -1, "data": None, "message": json.loads(msg[6:].strip()).get("error", {}).get("message", str(exc))}
        content = ""
        if "content" in data and data["content"]:
            content = data["content"][0].get("text", "")
        if not content.strip():
            return {"code": -1, "data": None, "message": "Anthropic 返回成功，但没有可显示文本。可能是内容过滤、工具调用块或服务商返回格式变化。"}
        logger.info(f"[{trace_id}] Anthropic 完成: {len(content)} 字符")
        return {
            "code": 0,
            "data": {
                "choices": [{"message": {"role": "assistant", "content": content}}],
                "usage": data.get("usage", {}),
            },
            "message": "ok",
        }

    # ── Google ──
    if provider == "google":
        headers = {"content-type": "application/json"}
        messages = body.get("messages", [])
        contents = []
        for msg in messages:
            # 防御：原生工具协议消息（role="tool"）转成 user，避免被误映射为 model
            role = "user" if msg["role"] in ("user", "tool") else "model"
            contents.append({"role": role, "parts": _to_gemini_parts(msg["content"])})
        payload: dict[str, Any] = {"contents": contents}
        gen_cfg: dict[str, Any] = {}
        if "temperature" in body:
            gen_cfg["temperature"] = body["temperature"]
        # 推理强度：thinking_level 与 temperature 同层，能力不匹配时只保留原有字段
        gen_cfg.update(_reasoning_payload("google", reasoning_cap, reasoning_level))
        if gen_cfg:
            payload["generationConfig"] = gen_cfg

        if is_stream:
            stream_url = f"{base_url}/models/{model_id}:streamGenerateContent?alt=sse&key={api_key}"
            logger.info(f"[{trace_id}] Google 流式请求: {stream_url}")
            return StreamingResponse(
                _stream_google(stream_url, headers, payload, trace_id),
                media_type="text/event-stream",
            )

        url = f"{base_url}/models/{model_id}:generateContent?key={api_key}"
        client = _get_client(base_url)
        try:
            data, error = await _post_json(client, url, headers, payload, trace_id=trace_id, api_name="Google")
            if error:
                return error
        except httpx.HTTPError as exc:
            msg = _sse_error_from_exception(exc, trace_id=trace_id, api_name="Google")
            return {"code": -1, "data": None, "message": json.loads(msg[6:].strip()).get("error", {}).get("message", str(exc))}
        text = ""
        thought_text = ""
        if "candidates" in data and data["candidates"]:
            parts = data["candidates"][0].get("content", {}).get("parts", [])
            for part in parts:
                part_text = part.get("text", "")
                if not part_text:
                    continue
                if part.get("thought"):
                    thought_text += part_text
                else:
                    text += part_text
        if not text.strip():
            # 只有思考摘要时退回用它，宁可不美观也不能整轮丢内容
            text = thought_text
        if not text.strip():
            return {"code": -1, "data": None, "message": "Google 返回成功，但没有可显示文本。请检查候选项是否被安全策略拦截，或模型返回格式是否变化。"}
        logger.info(f"[{trace_id}] Google 完成: {len(text)} 字符")
        return {
            "code": 0,
            "data": {
                "choices": [{"message": {"role": "assistant", "content": text}}],
                "usage": data.get("usageMetadata", {}),
            },
            "message": "ok",
        }

    # ── OpenAI 兼容（含国内模型、本地模型） ──
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    # Responses API 模式：模型支持且前端请求启用时使用
    use_responses = body.get("use_responses", False) and model_cfg.get("supports_responses", False)

    if use_responses:
        url = f"{base_url}/responses"
        payload = _build_responses_request(body, reasoning_cap, reasoning_level)

        if is_stream:
            logger.info(f"[{trace_id}] Responses API 流式请求: {url}")
            return StreamingResponse(
                _stream_responses(url, headers, payload, trace_id),
                media_type="text/event-stream",
            )

        client = _get_client(base_url)
        try:
            data, error = await _post_json(client, url, headers, payload, trace_id=trace_id, api_name="Responses API")
            if error:
                return error
        except httpx.HTTPError as exc:
            msg = _sse_error_from_exception(exc, trace_id=trace_id, api_name="Responses API")
            return {"code": -1, "data": None, "message": json.loads(msg[6:].strip()).get("error", {}).get("message", str(exc))}
        # 将 Responses API 响应转换为 Chat Completions 格式
        text = _extract_responses_text(data)
        if not text.strip():
            return {"code": -1, "data": None, "message": "Responses API 返回成功，但没有可显示文本。该模型/服务商可能不完整支持 Responses API，建议关闭 Responses API 选项后重试。"}
        logger.info(f"[{trace_id}] Responses API 完成: {len(text)} 字符")
        return {
            "code": 0,
            "data": {
                "choices": [{"message": {"role": "assistant", "content": text}}],
                "usage": data.get("usage", {}),
            },
            "message": "ok",
        }

    # 默认：Chat Completions API（curl 直连模式：base_url 即完整端点 URL，不拼接路径）
    url = base_url if provider == "curl" else f"{base_url}/chat/completions"
    payload = _build_openai_request(body, reasoning_cap, reasoning_level)

    if is_stream:
        logger.info(f"[{trace_id}] OpenAI 兼容流式请求: {url}")
        return StreamingResponse(
            _stream_openai(url, headers, payload, trace_id),
            media_type="text/event-stream",
        )

    client = _get_client(base_url)
    try:
        data, error = await _post_json(client, url, headers, payload, trace_id=trace_id, api_name="Chat Completions")
        if error:
            return error
    except httpx.HTTPError as exc:
        msg = _sse_error_from_exception(exc, trace_id=trace_id, api_name="Chat Completions")
        return {"code": -1, "data": None, "message": json.loads(msg[6:].strip()).get("error", {}).get("message", str(exc))}
    choices = data.get("choices")
    if not choices or len(choices) == 0:
        return {"code": -1, "data": None, "message": "Chat Completions 返回成功，但 choices 为空。可能是模型只返回了工具调用、内容过滤，或服务商返回格式变化。"}
    content = choices[0].get("message", {}).get("content", "")
    if not str(content or "").strip():
        return {"code": -1, "data": None, "message": "Chat Completions 返回成功，但没有可显示文本。可能是模型只返回了工具调用、内容过滤，或服务商返回格式变化。"}
    logger.info(f"[{trace_id}] OpenAI 兼容完成")
    return {"code": 0, "data": data, "message": "ok"}
