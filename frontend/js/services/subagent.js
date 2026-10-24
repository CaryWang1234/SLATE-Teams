/**
 * SLATE SubAgent 并行引擎
 * 主模型通过 subagent_run 工具一次性派出多个子代理，各自以独立的迷你
 * Agent Loop（streamChat + 文本协议工具调用）并行执行，互不共享上下文；
 * 全部结束后汇总结果回注主循环。
 * tools 相关函数经 deps 注入，避免与 tools.js 循环导入。
 */

import { state, getModelKey } from "../store.js?v=20261024-001";
import { streamChat } from "./api.js?v=20261024-001";
import { isTruncatedUnexecutable } from "./agent_common.js?v=20261024-001";
import { aiModelFor } from "./ai_features.js?v=20261024-001";

export const SUBAGENT_MAX_PARALLEL = 5;     // 单次派出的并行上限
export const SUBAGENT_MAX_ROUNDS = 8;       // 每个子代理的工具轮次预算
export const SUBAGENT_OUTPUT_LIMIT = 4000;  // 单个子代理结果回注主模型的最大字符数

const SUBAGENT_SYSTEM_PREFIX = `你是主代理派出的子代理，负责独立完成一个明确的子任务。

工作纪律：
1. 只专注自己的任务，不与用户对话，最终产出会被主代理汇总使用。
2. 需要信息时主动调用工具获取，不要臆测。
3. 禁止调用 subagent_run（子代理不得再派生子代理）。
4. 任务完成或信息已足够时，停止调用工具，直接输出最终结论：完整、自包含、结构清晰（可用要点列表），包含主代理需要的全部细节；不要输出工具调用块，不要输出"我将要…"的过程描述。
`;

// ── 进度事件总线（chat.js 订阅渲染实时面板）──────────────────
// 事件：{type:"start", specs, total} / {type:"text", index, text}
//      {type:"progress", index, round, toolCalls} / {type:"end", index, status, summary}
// 契约：emit(类型, 载荷) —— 类型与载荷分两参传，总线在这里合成上面那种单个事件对象。
// 曾经声明成 emit(event) 而调用点全按 (type, payload) 传，监听方拿到的是字符串、
// event.type 恒 undefined，整块实时面板静默不渲染（见 chat.js 的 subagentEvents.on）。

const listeners = new Set();

export const subagentEvents = {
  on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit(type, payload = {}) {
    const event = { type: String(type || ""), ...(payload || {}) };
    for (const fn of listeners) {
      try { fn(event); } catch { /* 渲染失败不影响执行 */ }
    }
  },
};

// ── 主循环 AbortSignal 桥接（chat.js 在生成开始/结束时设置）────

let activeSignal = null;

export function setSubAgentSignal(signal) {
  activeSignal = signal || null;
}

export function getSubAgentSignal() {
  return activeSignal;
}

// ── 引擎 ────────────────────────────────────────────────────

function normalizeSpecs(specs) {
  return (Array.isArray(specs) ? specs : [])
    .map((s, i) => ({
      name: String(s?.name || "").trim() || `子代理 ${i + 1}`,
      task: String(s?.task || "").trim(),
    }))
    .filter(s => s.task);
}

/**
 * 事件账本上的 spawn 边：一次 subagent_run 的账本行（parentCallId）派生出 N 个子代理行（childId）。
 * 只发 subagent.*，不发 call.*——白板步骤卡按 call. 前缀投影，
 * 把子代理也记成步骤卡会让"一次工具调用"在板上长出 N 张卡。
 * 缺 ledger 或缺 parentCallId（不经 kernel 的调用路径，如团队面板直跑工具）时整句静默：
 * 挂不上父调用的边是假边，宁缺勿造。
 */
const NOOP_SPAWN = { childId: "", started() {}, finished() {} };

function spawnHandle(ledger, parentCallId, index, label) {
  if (!ledger || !parentCallId) return NOOP_SPAWN;
  const childId = `${parentCallId}s${index}`;
  const emit = (type, data) => {
    try {
      ledger.emit(type, { callId: childId, parentCallId, tool: label, data });
    } catch { /* 账本失败绝不影响子代理执行 */ }
  };
  return {
    childId,
    started: (task) => emit("subagent.started", { task: previewHead(task, 120) }),
    finished: (result) => emit("subagent.finished", {
      status: result.status, rounds: result.rounds, toolCalls: result.toolCalls,
    }),
  };
}

function previewTail(text, max = 60) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(-max) : s;
}

function previewHead(text, max = 120) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** 单个子代理：独立迷你工具循环。任何异常都不外抛，转为 failed/stopped 结果。 */
async function runOneSubAgent(spec, index, deps, signal) {
  const { detect, strip, exec, toolsPrompt } = deps;
  // 事件带出处：后台批次跑完时用户可能已经切到别场会话，实时面板不该画到那一场头上
  const scope = String(deps.scopeConvId || "");
  const target = aiModelFor("subagent", state.currentModel);
  const modelId = target.id;
  const baseUrl = target.base_url;
  const apiKey = target.key;

  const spawn = spawnHandle(deps.ledger || null, deps.parentCallId || "", index, spec.name);
  spawn.started(spec.task);

  const messages = [
    { role: "system", content: SUBAGENT_SYSTEM_PREFIX + toolsPrompt },
    { role: "user", content: spec.task },
  ];

  let rounds = 0;
  let toolCalls = 0;
  let lastOutput = "";

  const finish = (status, output) => {
    const result = { name: spec.name, task: spec.task, status, output, toolCalls, rounds };
    spawn.finished(result);
    subagentEvents.emit("end", { index, status, summary: previewTail(output, 80), convId: scope });
    return result;
  };

  // 模型没配好就一条请求都不发（子代理可能一次并行五个，静默失败会被当成"任务太难"）
  if (!target.usable) return finish("failed", "子代理模型不可用：未选择模型或未配置 API Key");

  try {
    for (let round = 0; round < SUBAGENT_MAX_ROUNDS; round++) {
      if (signal?.aborted) return finish("stopped", lastOutput);
      rounds = round + 1;

      let content = "";
      let lastEmit = 0;
      for await (const chunk of streamChat({
        model: modelId,
        provider: target.provider,
        messages,
        api_key: apiKey,
        base_url: baseUrl,
        temperature: 0.3,
        stream: true,
        signal,
      })) {
        content += chunk;
        const now = Date.now();
        if (now - lastEmit > 300) {
          lastEmit = now;
          subagentEvents.emit("text", { index, text: previewTail(content), convId: scope });
        }
      }
      lastOutput = strip(content).trim();

      const calls = detect(content);
      if (!calls.length) return finish(signal?.aborted ? "stopped" : "done", lastOutput);
      if (signal?.aborted) return finish("stopped", lastOutput);

      // 递归守卫 + 截断守卫 + 执行工具（与主循环同款执行器，天然带校验与高危审批）
      const resultParts = [];
      for (const call of calls) {
        if (call.name === "subagent_run") {
          resultParts.push("[工具 subagent_run] 未执行：子代理不允许再派生子代理，请自行完成该部分任务。");
          continue;
        }
        if (isTruncatedUnexecutable(call)) {
          resultParts.push(`[工具 ${call.name}] 未执行：该调用因输出长度上限被截断、参数不完整。请拆分为更小的调用后重试。`);
          continue;
        }
        toolCalls++;
        const res = await exec(call.name, call.params);
        const text = typeof res?.output === "string" ? res.output : JSON.stringify(res ?? {});
        resultParts.push(`[工具 ${call.name}] ${text.length > 2000 ? text.slice(0, 2000) + "…（已截断）" : text}`);
      }

      subagentEvents.emit("progress", { index, round: rounds, toolCalls, convId: scope });

      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: `[工具结果]\n${resultParts.join("\n\n")}\n\n请继续推进任务；若任务已完成，直接输出最终结论（纯文本，不带工具调用块）。`,
      });
    }
    return finish("max_rounds", lastOutput);
  } catch (e) {
    const stopped = signal?.aborted || e?.name === "AbortError";
    return finish(stopped ? "stopped" : "failed", stopped ? lastOutput : `执行出错: ${e?.message || e}`);
  }
}

/**
 * 并行执行多个子代理。
 * @param {Array<{name?, task}>} specs 子代理定义
 * @param {{detect, strip, exec, toolsPrompt, ledger?, parentCallId?}} deps
 *        由 tools.js 注入的工具函数；ledger + parentCallId 来自事件账本，
 *        只在这一对都在时给每个子代理记一行 spawn 边（星图用）
 * @param {AbortSignal|null} signal 主循环的中断信号
 * @returns {{results: Array, skipped: number}}
 */
export async function runSubAgents(specs, deps, signal = null) {
  const sig = signal || getSubAgentSignal();
  const all = normalizeSpecs(specs);
  const list = all.slice(0, SUBAGENT_MAX_PARALLEL);
  const skipped = Math.max(0, all.length - SUBAGENT_MAX_PARALLEL);

  subagentEvents.emit("start", { specs: list, total: all.length, convId: String(deps?.scopeConvId || "") });

  const results = await Promise.all(
    list.map((spec, i) => runOneSubAgent(spec, i, deps, sig)),
  );
  return { results, skipped };
}
