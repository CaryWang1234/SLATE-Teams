/**
 * SLATE Mobile — 聊天核心
 * 复用桌面纯逻辑（adapter/buildMessages、api/streamChat、tools 解析与执行、markdown 渲染），
 * 自写移动渲染：消息气泡 / 思考折叠卡 / 工具卡片 / 流式续写
 * 工具循环与桌面共用 agent_loop kernel，只注入移动端 policy/view/io（无目标模式，保留去重与轮数上限）
 */

import {
  state, getModelKey, setMessages, addMessage, updateLastAssistantMessage, subscribe, estimateTokens, contextBudgetOf, takeLoopExit, effectiveConstitution, activeModeFor,
} from "../store.js?v=20261017-001";
import { fmtTokens } from "../services/usage.js?v=20261017-001";
import { get, post, patch, streamChat, REASONING_PREFIX, REASONING_INLINE_PREFIX } from "../services/api.js?v=20261017-001";
import { buildMessages, getDefaultParams, getOutputMaxTokens } from "../services/adapter.js?v=20261017-001";
import { detectToolCalls, detectDsmlCalls, hasToolMarkup, stripToolCalls, hasTruncatedTail, executeToolCalls } from "../services/tools.js?v=20261017-001";
import { dedupeToolCalls, MOBILE_TOOL_RESULT_STATUS, MOBILE_FAILED_LINE, formatToolResultForModel, buildToolFollowupInstruction, isHistorySummary } from "../services/agent_common.js?v=20261017-001";
import { createAgentLoop } from "../services/agent_loop.js?v=20261017-001";
import { takeBgEvents, bgWakeText, startBgPolling } from "../services/bg_tasks.js?v=20261017-001";
import { aiModelFor, isAiFeatureOn } from "../services/ai_features.js?v=20261017-001";
import { openRun as openLedgerRun, projectChat } from "../services/agent_ledger.js?v=20261017-001";
import { toolLabel } from "../services/tool_meta.js?v=20261017-001";
import { compressedThread } from "../services/thread_compress.js?v=20261017-001";
import { autoGenerateSessionTitle } from "../services/session_title.js?v=20261017-001";
import { renderMarkdown } from "../services/markdown.js?v=20261017-001";
import { mToast, t } from "./m-ui.js?v=20261017-001";
import { mountRoundSummary, renderRoundSummary } from "../components/round_summary.js?v=20261017-001";
import { mHandleStructured } from "./m-auth.js?v=20261017-001";
import { setTopbarTitle, switchTab } from "./m-app.js?v=20261017-001";

const MAX_TOOL_ROUNDS = 8;
const MAX_CONTINUE_ROUNDS = 6;

let _generating = false;
let _abortCtrl = null;
let _convSeq = 0;

// ── 工具函数 ──────────────────────────────────

function $id(id) { return document.getElementById(id); }

function isAbortError(err) {
  return err?.name === "AbortError" || /abort/i.test(String(err?.message || ""));
}

function getAllModels() {
  const all = [];
  for (const models of Object.values(state.modelRegistry || {})) all.push(...models);
  all.push(...(state.customModels || []));
  return all;
}

function findModelById(modelId) {
  return getAllModels().find(m => m.id === modelId) || null;
}

function mFindProvider(modelId) {
  return (findModelById(modelId) || state.currentModel)?.provider;
}

function normalizeMessage(msg) {
  const content = String(msg?.content ?? "");
  return {
    ...msg,
    id: msg?.id || "",
    role: ["system", "user", "assistant"].includes(msg?.role) ? msg.role : "assistant",
    content,
    hidden: msg?.hidden === true || msg?.metadata?.hidden === true || msg?.model === "[tool_results]",
  };
}

// ── 流式分块（与桌面同协议：\x00\x01R\x01\x00 前缀为思考） ──

const REASONING_MARKER_RE = /\x00?\x01R\x01\x00?/g;

function stripReasoningMarks(text) {
  return String(text || "").replace(REASONING_MARKER_RE, "");
}

function stripReasoningFromContent(text) {
  const s = String(text || "");
  REASONING_MARKER_RE.lastIndex = 0;
  const match = REASONING_MARKER_RE.exec(s);
  if (!match) return s;
  return s.slice(0, match.index);
}

function splitStreamChunk(chunk) {
  const text = String(chunk || "");
  if (!text) return [];
  if (text.startsWith(REASONING_PREFIX)) {
    return [{ type: "reasoning", text: stripReasoningMarks(text.slice(REASONING_PREFIX.length)) }];
  }
  if (text.startsWith(REASONING_INLINE_PREFIX)) {
    return [{ type: "reasoning", text: stripReasoningMarks(text.slice(REASONING_INLINE_PREFIX.length)) }];
  }
  const parts = [];
  let lastIndex = 0;
  let mode = "content";
  REASONING_MARKER_RE.lastIndex = 0;
  let match;
  while ((match = REASONING_MARKER_RE.exec(text))) {
    if (match.index > lastIndex) parts.push({ type: mode, text: stripReasoningMarks(text.slice(lastIndex, match.index)) });
    mode = "reasoning";
    lastIndex = REASONING_MARKER_RE.lastIndex;
  }
  if (!parts.length) return [{ type: "content", text }];
  if (lastIndex < text.length) parts.push({ type: mode, text: stripReasoningMarks(text.slice(lastIndex)) });
  return parts.filter(p => p.text);
}

/** 渲染助手内容：剥离推理标记与工具调用块后做 Markdown */
function renderAssistantHtml(content) {
  const clean = stripReasoningFromContent(String(content || ""));
  const display = hasToolMarkup(clean) ? stripToolCalls(clean) : clean;
  const html = renderMarkdown(display);
  return `<div class="m-msg-content">${html}</div>`;
}

// ── 滚动锚定：贴底时流式跟随，上翻时不动 ──

function scrollEl() { return $id("m-chat-scroll"); }

function isSticky() {
  const el = scrollEl();
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function keepScrolled() {
  const el = scrollEl();
  if (el && isSticky()) el.scrollTop = el.scrollHeight;
}

// ── 消息气泡 ──────────────────────────────────

function appendUserBubble(text) {
  const el = scrollEl();
  if (!el) return null;
  const wrap = document.createElement("div");
  wrap.className = "m-msg m-msg-user";
  wrap.innerHTML = `<div class="m-bubble">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
  el.appendChild(wrap);
  keepScrolled();
  return wrap;
}

function appendAssistantBubble() {
  const el = scrollEl();
  if (!el) return null;
  const wrap = document.createElement("div");
  wrap.className = "m-msg m-msg-assistant";
  wrap.innerHTML = `<div class="m-bubble"><div class="m-msg-content"></div></div>`;
  el.appendChild(wrap);
  keepScrolled();
  return wrap;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ── 思考折叠卡片 ──────────────────────────────

function createThinkingPanel(wrap) {
  const panel = document.createElement("div");
  panel.className = "m-thinking";
  panel.innerHTML = `
    <div class="m-thinking-head"><span>${t("思考过程")}</span><span class="m-thinking-toggle">▾</span></div>
    <div class="m-thinking-body"></div>`;
  panel.querySelector(".m-thinking-head").addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    panel.querySelector(".m-thinking-toggle").textContent = panel.classList.contains("collapsed") ? "▸" : "▾";
  });
  const bubble = wrap.querySelector(".m-bubble");
  if (bubble) wrap.insertBefore(panel, bubble);
  else wrap.appendChild(panel);
  return panel;
}

function updateThinkingPanel(panel, text) {
  if (!panel) return;
  const body = panel.querySelector(".m-thinking-body");
  if (body) body.textContent = text;
  if (text && panel.classList.contains("collapsed")) {
    panel.classList.remove("collapsed");
    panel.querySelector(".m-thinking-toggle").textContent = "▾";
  }
}

// ── 工具卡片 ──────────────────────────────────

function addToolCard(wrap, call, status, summary) {
  const card = document.createElement("div");
  card.className = "m-tool-card";
  card.innerHTML = `
    <div class="m-tool-head">
      <span class="m-tool-status ${status === "done" ? "m-tool-ok" : status === "error" ? "m-tool-err" : "m-tool-spin"}">${status === "done" ? "✓" : status === "error" ? "✗" : "◌"}</span>
      <span class="m-tool-name"></span>
      <span class="m-tool-summary"></span>
    </div>
    <div class="m-tool-body"><pre></pre></div>`;
  card.querySelector(".m-tool-name").textContent = toolLabel(call.name, call.params);
  card.querySelector(".m-tool-summary").textContent = summary || "";
  card.querySelector("pre").textContent = JSON.stringify(call.params ?? {}, null, 2);
  card.querySelector(".m-tool-head").addEventListener("click", () => card.classList.toggle("open"));
  wrap.appendChild(card);
  keepScrolled();
  return card;
}

function updateToolCard(card, status, summary) {
  if (!card) return;
  const badge = card.querySelector(".m-tool-status");
  badge.className = `m-tool-status ${status === "done" ? "m-tool-ok" : status === "error" ? "m-tool-err" : "m-tool-spin"}`;
  badge.textContent = status === "done" ? "✓" : status === "error" ? "✗" : "◌";
  const s = card.querySelector(".m-tool-summary");
  if (s && summary) s.textContent = summary;
}

function toolSummary(result) {
  let output = String(result?.output || "");
  if (output.startsWith("{")) {
    try {
      const parsed = JSON.parse(output);
      if (typeof parsed.output === "string") output = parsed.output;
      else if (typeof parsed.error === "string") output = parsed.error;
    } catch (e) { /* 保持原样 */ }
  }
  if (result?.success === false) return output.slice(0, 80) || t("执行失败");
  return output.slice(0, 80) || t("完成");
}

// ── 流式续写（截断接续，与桌面同协议） ─────────

const CONTINUE_PROMPT_TOOL = "你上一次的输出达到长度上限被截断了。请从被截断的精确位置继续输出：不要重复已输出的任何内容，不要输出任何解释、前言或代码围栏标记，一直续写到工具调用以 ◈◆◆ 闭合为止。";
const CONTINUE_PROMPT_TEXT = "你上一次的输出达到长度上限被截断了。请从被截断的精确位置继续输出：不要重复已输出的任何内容，不要输出任何解释或前言，一直续写到内容完整结束为止。";
const CONTINUE_PROMPT_FILE = "你上一次的输出达到长度上限被截断了，当时你正在写文件内容（原样格式）。请继续输出剩余的文件内容：不要重发 ◈◈◈ 工具头，不要重发路径行，不要加任何解释、前言或代码围栏标记，保持原样直写直到内容完整，最后以单独一行 ◈◆◆ 结束。";

function buildContinuePrompt(content) {
  let base;
  if (hasTruncatedTail(content)) {
    const calls = detectToolCalls(content);
    const lastName = calls[calls.length - 1]?.name;
    base = (lastName === "file_create" || lastName === "file_append") ? CONTINUE_PROMPT_FILE : CONTINUE_PROMPT_TOOL;
  } else {
    base = CONTINUE_PROMPT_TEXT;
  }
  const anchor = String(content || "").slice(-60);
  if (!anchor.trim()) return base;
  return `${base}\n你最后输出的内容是（直接从它之后接续，不要重复这部分）：\n<<<\n${anchor}\n>>>`;
}

function stripOverlap(oldContent, newPart) {
  const maxCheck = Math.min(oldContent.length, newPart.length, 400);
  for (let len = maxCheck; len > 8; len--) {
    if (oldContent.endsWith(newPart.slice(0, len))) return newPart.slice(len);
  }
  return newPart;
}

/**
 * 单轮流式生成：写入 wrap 气泡，返回 { content, finishReason }
 */
async function mStreamAssistant({ wrap, modelId, apiKey, baseUrl, params, signal, history }) {
  let content = "";
  let reasoningText = "";
  let panel = null;
  const meta = {};
  const contentEl = wrap?.querySelector(".m-msg-content");
  // 与桌面同口径：这一场生效的模式决定"有没有工具"、追加哪段提示词、推理强度用哪档
  const mode = activeModeFor();
  const toolMode = mode.id === "chat" ? "none" : "text";
  const messages = buildMessages(history, effectiveConstitution(), toolMode, { mode });
  try {
    for await (const chunk of streamChat({
      model: modelId,
      provider: mFindProvider(modelId),
      messages,
      api_key: apiKey,
      base_url: baseUrl,
      temperature: params?.temperature ?? 0.7,
      max_tokens: params?.max_tokens ?? getOutputMaxTokens(),
      // 与桌面同源：档位存在 store 里（desktop_state.json），手机遥控时不该回落到 auto；
      // 模式强制档（经济 low / 狂暴 high）优先于输入栏选的那档
      reasoning_effort: mode.effort || state.reasoningEffort || "auto",
      stream: true,
      signal,
      meta,
    })) {
      for (const part of splitStreamChunk(chunk)) {
        if (part.type === "reasoning") {
          reasoningText += part.text;
          if (!panel) panel = createThinkingPanel(wrap);
          updateThinkingPanel(panel, reasoningText);
        } else {
          content += part.text;
          if (contentEl) contentEl.innerHTML = renderAssistantHtml(content);
        }
        keepScrolled();
      }
    }
  } catch (err) {
    if (!isAbortError(err)) {
      console.warn("[SLATE-Mobile] 流式生成失败:", err);
      content = content
        ? `${content}\n\n${t("续写失败: {msg}", { msg: err.message })}`
        : t("请求失败: {msg}", { msg: err.message });
      if (contentEl) contentEl.innerHTML = renderAssistantHtml(content);
    }
  }
  if (panel) {
    panel.classList.add("collapsed");
    panel.querySelector(".m-thinking-toggle").textContent = "▸";
  }
  return { content, finishReason: meta.finishReason || "", reasoning: reasoningText };
}

/** 截断续写：最多 6 轮，拼回同一气泡 */
async function mContinueTruncated(wrap, content, modelId, apiKey, baseUrl, params, signal, finishReason = "") {
  let fr = finishReason;
  let reasoning = "";
  for (let round = 1; round <= MAX_CONTINUE_ROUNDS; round++) {
    const stuck = hasTruncatedTail(content) || fr === "length";
    if (signal?.aborted || !stuck) break;
    const contPrompt = buildContinuePrompt(content);
    const history = state.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    history.push({ role: "assistant", content });
    history.push({ role: "user", content: contPrompt });
    history._modelId = modelId;
    const { content: part, finishReason: fr2, reasoning: rs } = await mStreamAssistant({ wrap, modelId, apiKey, baseUrl, params, signal, history });
    fr = fr2;
    if (rs) reasoning += rs;
    if (!part.trim()) break;
    content += stripOverlap(content, part);
    if (signal?.aborted) break;
  }
  if (!signal?.aborted && hasTruncatedTail(content)) {
    mToast(t("输出仍不完整，已要求模型拆分重试"), 3200);
  }
  return { content, reasoning };
}

// ── Agent 循环：kernel + 移动装配 ─────────────────────────

// 移动侧策略：只保留去重催办与结果回灌，无目标模式/自主推进的空轮决策
const mobilePolicy = {
  beginRun() {
    // 收口请求只属于发起它的那一场运行：新运行开头作废，否则上一条的收尾会把这一条停掉
    takeLoopExit();
    return {};
  },
  openRun(run) {
    return openLedgerRun({ conversationId: run.genConvId || "", mode: "mobile", budget: run.maxRounds });
  },
  dedupRound(run) {
    const { round, maxRounds, dupRounds } = run;
    return {
      action: "nudge",
      hiddenMsg: {
        role: "user",
        content: `[系统] ${round + 1}/${maxRounds} 轮：你本轮发出的工具调用与上一轮完全相同，已拦截未重复执行。${dupRounds >= 2 ? "已连续多轮相同调用，必须换思路。" : ""}若上轮结果不符合预期，请换思路（拆分任务、改用其他工具、或先读取文件查看现状）；若任务已推进，直接继续剩余工作或输出结论。`,
        model: "[dedup]",
        hidden: true,
      },
    };
  },
  emptyRound(run) {
    // 模型调过收口工具后给出的最终汇报：退出原因要如实写，别报成普通收尾
    if (run?.extra?.loopExit) {
      return { action: "break", exitReason: `模型已调 ${run.extra.loopExit.mode === "target" ? "exit_target_mode" : "exit_autopilot"} 收口` };
    }
    // 后台任务的消息到了：移动端不自己开新一场（没有空闲续跑），但在跑的循环里
    // 照样把消息交给模型——事件取走即清，一条事件最多唤醒一次，不会自转。
    // takeBgEvents 只给"归属是这一场"的：池子里若只剩别的项目的消息，这里就什么都不念。
    const events = takeBgEvents();
    if (events.length) {
      return {
        action: "nudge",
        kind: "bg_event",
        hiddenMsg: { role: "user", content: bgWakeText(events), model: "[bg_task]", hidden: true },
      };
    }
    return { action: "break" }; // 模型收尾，无工具调用
  },
  async postExec(run) {
    // 收口工具在移动侧同样要取走：留在 store 里会把下一场运行一开场就停掉
    const exit = takeLoopExit();
    if (exit) run.extra.loopExit = exit;
    // 结构化结果（file_edit/file_create 未自动落盘）→ 底部 diff sheet 确认
    for (let i = 0; i < run.results.length; i++) {
      const result = run.results[i];
      const card = run.cards?.[i];
      const structured = result?._structured;
      if (structured && ["file_edit", "file_create"].includes(structured._type) && structured.applied !== "auto" && structured.applied !== true) {
        updateToolCard(card, "running", t("等待确认…"));
        const decision = await mHandleStructured(structured);
        if (decision === "accepted" || decision === "applied") updateToolCard(card, "done", t("已写入磁盘"));
        else if (decision === "rejected") updateToolCard(card, "error", t("已拒绝写入"));
        else updateToolCard(card, "error", t("未确认"));
      } else {
        updateToolCard(card, result.success ? "done" : "error", toolSummary(result));
      }
    }
  },
  finish(run) {
    // 本轮总结：移动侧只给读（卡片上不出现「撤销」）。kernel 的 finish 不被 await，
    // 所以挂载完成后自己重排一次，不能等外层 finally 那一趟全量渲染。
    mountRoundSummary(run, () => mRenderAllMessages());
  },
  buildFeeds(run) {
    const { calls, results, round, maxRounds } = run;
    // 工具结果回灌模型（hidden user 消息，不渲染）
    const toolResultText = `[${round + 1}/${maxRounds} 轮]\n`
      + results.map((r, i) => formatToolResultForModel(calls[i], r, MOBILE_TOOL_RESULT_STATUS)).join("\n\n")
      + "\n\n" + buildToolFollowupInstruction({ round, maxRounds, results, failedLine: MOBILE_FAILED_LINE, prefix: "\n" });
    return [{ role: "user", content: toolResultText, model: "[tool_results]", hidden: true }];
  },
};

// 移动侧视图：正文回显 + 工具卡片挂在当前气泡上（无进度条、无白板步骤卡）
const mobileView = {
  renderBubble(el, content) {
    const contentEl = el?.querySelector(".m-msg-content");
    if (contentEl) contentEl.innerHTML = renderAssistantHtml(content);
  },
  toolCards: {
    // 移动侧工具卡是人工确认门的载体，按 index 供 postExec 回写，不走账本投影
    begin(run) {
      return run.calls.map(call => addToolCard(run.bubble, call, "running", ""));
    },
  },
};

// 移动侧 IO：调用探测、工具执行、结果落库、新建气泡流式续写
const mobileIo = {
  detectCalls(lastMsg) {
    return dedupeToolCalls([
      ...detectToolCalls(lastMsg.content),
      ...detectDsmlCalls(lastMsg.content),
    ]);
  },
  execute(calls, opts) {
    return executeToolCalls(calls, opts);
  },
  async commitResults(run) {
    const { lastMsg } = run;
    lastMsg.toolResults = [
      ...(lastMsg.toolResults || []),
      ...projectChat(run.ledger, run.round),
    ];
    if (lastMsg.id) {
      try {
        await patch(`/chat/messages/${lastMsg.id}`, { content: lastMsg.content, metadata: { toolResults: lastMsg.toolResults, ledgerRunId: run.ledger?.runId || "" } });
      } catch (e) { console.warn("[SLATE-Mobile] 工具结果保存失败:", e); }
    }
  },
  async streamTurn(run) {
    const { signal, genConvId } = run;
    const { modelId, apiKey, baseUrl, params } = run.opts;
    const followUp = { role: "assistant", content: "", model: modelId };
    addMessage(followUp);
    const wrap = appendAssistantBubble();
    const history = state.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    history._modelId = modelId;
    const { content: followContent, finishReason } = await mStreamAssistant({ wrap, modelId, apiKey, baseUrl, params, signal, history });

    let finalContent = followContent;
    if (hasTruncatedTail(finalContent) || finishReason === "length") {
      const cont = await mContinueTruncated(wrap, finalContent, modelId, apiKey, baseUrl, params, signal, finishReason);
      finalContent = cont.content;
    }

    // 持久化并更新本地状态（会话已切换时跳过本地列表更新，内容仍写回归属会话）
    followUp.content = finalContent;
    if (state.currentConversationId === genConvId) updateLastAssistantMessage(finalContent);
    if (genConvId) {
      try {
        const saved = await post(`/chat/conversations/${genConvId}/messages`, { role: "assistant", content: finalContent, model: modelId });
        if (saved.code === 0 && saved.data?.id) followUp.id = saved.data.id;
      } catch (e) { console.warn("[SLATE-Mobile] 助手消息保存失败:", e); }
    }
    const contentEl = wrap.querySelector(".m-msg-content");
    if (contentEl) contentEl.innerHTML = renderAssistantHtml(finalContent);
    keepScrolled();
    return { bubble: wrap, message: followUp, content: finalContent };
  },
};

const mobileAgentLoop = createAgentLoop({ policy: mobilePolicy, view: mobileView, io: mobileIo });

/**
 * 工具循环：解析最后一条 assistant 的工具调用 → 执行 → 结果回灌 →
 * 新建气泡流式续写，直到模型收尾 / 轮数上限 / 手动停止 / 会话切换
 * wrap 为当前含工具调用的助手气泡元素；每轮续写后更新为新气泡
 */
async function mRunToolLoop(wrap, modelId, apiKey, baseUrl, params, signal) {
  // 本循环归属会话：之后即使切换到新会话，旧循环也只读写自己的会话
  const mode = activeModeFor();
  await mobileAgentLoop({
    bubble: wrap,
    modelId,
    apiKey,
    baseUrl,
    params,
    signal,
    // 模式给了轮数就用它（经济 12 / 狂暴 40），没给才用移动端默认的 8
    maxRounds: Number(mode.rounds) > 0 ? Number(mode.rounds) : MAX_TOOL_ROUNDS,
    // 白名单一路带到工具执行（mobileIo.execute → executeToolCalls → tools.js modeAllowsTool）
    mode,
    genConvId: state.currentConversationId,
  });
}

// ── 压缩检查（与桌面同逻辑，静默执行） ─────────

async function mCheckCompress(modelId, apiKey, baseUrl) {
  // 与桌面共用同一档开关：手机上也别在后台偷偷发这一趟
  if (!isAiFeatureOn("context_compress")) return;
  try {
    const msgs = state.messages.map(m => ({ role: m.role, content: m.content }));
    // 与桌面同一个预算口径：手机和桌面看的是同一个"什么时候压缩"
    const res = await post("/chat/compress", { messages: msgs, keep_recent_rounds: 2, max_tokens: contextBudgetOf(modelId) });
    if (res.code !== 0 || !res.data?.need_compress) return;
    const { compress_prompt, compress_count } = res.data;
    const target = aiModelFor("context_compress", { id: modelId, base_url: baseUrl, key: apiKey });
    if (!target.usable) return;
    let summary = "";
    try {
      for await (const chunk of streamChat({
        model: target.id,
        provider: mFindProvider(target.id) || target.provider,
        messages: [{ role: "user", content: compress_prompt }],
        api_key: target.key,
        base_url: target.base_url,
        temperature: 0.3,
        max_tokens: 1024,
        stream: true,
      })) {
        for (const part of splitStreamChunk(chunk)) {
          if (part.type === "content") summary += part.text;
        }
      }
    } catch (e) {
      console.warn("[SLATE-Mobile] 压缩摘要生成失败:", e);
      return;
    }
    if (!summary.trim()) return;
    const summaryMsg = { role: "system", content: `[历史摘要]: ${summary.trim()}` };
    // 保留段要从本地消息对象现取：keep_messages 只是投影副本，带着它重建会把
    // 隐藏轮（[系统警告]、工具结果投喂）的 hidden 抹掉，手机上就多出一条条系统气泡
    setMessages(compressedThread(summaryMsg, state.messages, compress_count));
    mToast(t("上下文已压缩：{n} 条消息已摘要", { n: compress_count }));
  } catch (e) {
    console.warn("[SLATE-Mobile] 压缩检查失败:", e);
  }
}

// ── 发送消息 ──────────────────────────────────

export async function mSendMessage(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return;
  if (_generating) {
    mToast(t("正在生成中，请稍候"));
    return;
  }
  if (!state.currentModel?.id) {
    mToast(t("请先在设置中选择模型"));
    switchTab("settings");
    return;
  }

  // 模式也可以指定模型（自定义模式才有）：连 base_url / Key 一起换
  const mobileMode = activeModeFor();
  const sendModel = (mobileMode.model && findModelById(mobileMode.model)) || state.currentModel;
  const modelId = sendModel.id;
  const apiKey = getModelKey(modelId) || "";
  const baseUrl = sendModel.base_url || "";
  const params = getDefaultParams(modelId);
  _generating = true;
  _abortCtrl = new AbortController();
  const signal = _abortCtrl.signal;

  const inputEl = $id("m-chat-input");
  if (inputEl) {
    inputEl.value = "";
    inputEl.style.height = "auto";
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }
  setSendBtnState();
  hideEmptyState();

  try {
    // 无会话时先创建
    if (!state.currentConversationId) {
      const res = await post("/chat/conversations", {
        title: text.slice(0, 30),
        project: state.project?.name || "",
        project_id: state.project?.project_id || "",
      });
      if (res.code === 0) {
        state.currentConversationId = res.data.id;
        const conv = state.conversations.find(c => c.id === state.currentConversationId);
        if (conv) setTopbarTitle(conv.title);
      } else {
        mToast(res.message || t("创建会话失败"), 3200);
        return;
      }
    }
    const genConvId = state.currentConversationId;

    // 保存并渲染用户消息
    const userMsg = { role: "user", content: text, model: "" };
    addMessage(userMsg);
    appendUserBubble(text);
    try {
      const saved = await post(`/chat/conversations/${genConvId}/messages`, { role: "user", content: text, model: "" });
      if (saved.code === 0 && saved.data?.id) userMsg.id = saved.data.id;
    } catch (e) { console.warn("[SLATE-Mobile] 用户消息保存失败:", e); }

    // 助手占位气泡 → 流式生成
    const assistantMsg = { role: "assistant", content: "", model: modelId };
    addMessage(assistantMsg);
    const wrap = appendAssistantBubble();
    const history = state.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    history._modelId = modelId;
    const { content: fullContent, finishReason, reasoning: firstReasoning } = await mStreamAssistant({ wrap, modelId, apiKey, baseUrl, params, signal, history });
    if (signal?.aborted) return;

    let finalContent = fullContent;
    let reasoning = firstReasoning || "";
    if (hasTruncatedTail(finalContent) || finishReason === "length") {
      const cont = await mContinueTruncated(wrap, finalContent, modelId, apiKey, baseUrl, params, signal, finishReason);
      if (signal?.aborted) return;
      finalContent = cont.content;
      if (cont.reasoning) reasoning += cont.reasoning;
    }

    // 落库助手消息（reasoning 仅存本地，供重渲染恢复思考卡片）
    assistantMsg.content = finalContent;
    assistantMsg.reasoning = reasoning || undefined;
    updateLastAssistantMessage(finalContent);
    const contentEl = wrap.querySelector(".m-msg-content");
    if (contentEl) contentEl.innerHTML = renderAssistantHtml(finalContent);
    keepScrolled();
    try {
      const saved = await post(`/chat/conversations/${genConvId}/messages`, { role: "assistant", content: finalContent, model: modelId });
      if (saved.code === 0 && saved.data?.id) assistantMsg.id = saved.data.id;
    } catch (e) { console.warn("[SLATE-Mobile] 助手消息保存失败:", e); }

    // 工具循环：有工具调用则自动推进（简化版，无 harness/autopilot nudge）
    if (!signal?.aborted && genConvId === state.currentConversationId) {
      await mRunToolLoop(wrap, modelId, apiKey, baseUrl, params, signal);
    }

    // 后台压缩检查
    if (!signal?.aborted) mCheckCompress(modelId, apiKey, baseUrl);
    // 自动会话标题：与桌面共用同一个模块、同一档开关、同一套「只换占位标题」的判据。
    // 标题就地写回 state.conversations 并 notify，手机端的会话列表与顶栏跟着这条通知走。
    if (!signal?.aborted) {
      autoGenerateSessionTitle({
        convId: genConvId,
        model: { id: modelId, provider: mFindProvider(modelId), base_url: baseUrl, key: apiKey },
      });
    }
  } catch (err) {
    console.error("[SLATE-Mobile] 发送失败", err);
    if (!isAbortError(err)) mToast(t("发送失败: {msg}", { msg: err.message }), 3200);
  } finally {
    _generating = false;
    _abortCtrl = null;
    setSendBtnState();
    mRenderAllMessages();
    keepScrolled();
  }
}

export function mStopGenerating() {
  if (_generating && _abortCtrl) _abortCtrl.abort();
}

export function isGenerating() {
  return _generating;
}

function setSendBtnState() {
  const btn = $id("m-btn-send");
  if (!btn) return;
  if (_generating) {
    btn.textContent = "■";
    btn.classList.add("stop");
    btn.setAttribute("aria-label", t("停止"));
  } else {
    btn.textContent = "↑";
    btn.classList.remove("stop");
    btn.setAttribute("aria-label", t("发送"));
  }
}

function hideEmptyState() {
  const empty = $id("m-chat-emptystate");
  if (empty) empty.style.display = "none";
}

function showEmptyStateIfNeeded() {
  const empty = $id("m-chat-emptystate");
  if (!empty) return;
  const visible = state.messages.some(m => !m.hidden);
  empty.style.display = visible ? "none" : "";
}

// ── 全量渲染（生成结束后 / 会话加载时） ────────

export function mRenderAllMessages() {
  const el = scrollEl();
  if (!el) return;
  el.querySelectorAll(".m-msg").forEach(n => n.remove());
  for (const msg of state.messages) {
    if (msg.hidden) continue;
    const wrap = document.createElement("div");
    wrap.className = `m-msg ${msg.role === "user" ? "m-msg-user" : "m-msg-assistant"}`;
    if (isHistorySummary(msg)) {
      // 压缩摘要不该长得像模型刚说的一句话：折叠，展开才铺全文
      const body = String(msg.content || "").replace(/^\s*\[历史摘要\]\s*:?\s*/, "");
      wrap.className = "m-msg m-msg-system";
      wrap.innerHTML = `<details class="m-summary-fold"><summary>${escapeHtml(t("更早的对话已压缩为摘要"))} · ≈ ${escapeHtml(fmtTokens(estimateTokens(body)))} tokens</summary><div class="m-summary-body">${escapeHtml(body)}</div></details>`;
      el.appendChild(wrap);
      continue;
    }
    if (msg.role === "user") {
      wrap.innerHTML = `<div class="m-bubble">${escapeHtml(String(msg.content || "")).replace(/\n/g, "<br>")}</div>`;
    } else {
      wrap.innerHTML = renderAssistantHtml(msg.content);
      if (msg.reasoning) {
        const panel = createThinkingPanel(wrap);
        updateThinkingPanel(panel, String(msg.reasoning));
        panel.classList.add("collapsed");
        panel.querySelector(".m-thinking-toggle").textContent = "▸";
      }
      // 历史工具结果卡片
      for (const tr of (Array.isArray(msg.toolResults) ? msg.toolResults : [])) {
        const card = addToolCard(wrap, tr.call, tr.result?.success === false ? "error" : "done", toolSummary(tr.result));
        card.querySelector("pre").textContent += `\n\n--- 输出 ---\n${String(tr.result?.output || "")}`;
      }
      // 本轮总结：手机上只看，撤回回到桌面做
      if (msg.roundSummary?.runId) wrap.appendChild(renderRoundSummary(msg.roundSummary, { readOnly: true }));
    }
    el.appendChild(wrap);
  }
  showEmptyStateIfNeeded();
  el.scrollTop = el.scrollHeight;
}

// ── 会话加载/切换 ─────────────────────────────

export async function mLoadConversation(convId) {
  const seq = ++_convSeq;
  state.currentConversationId = convId;
  const conv = state.conversations.find(c => c.id === convId);
  if (conv?.title) setTopbarTitle(conv.title);
  try {
    const res = await get(`/chat/conversations/${convId}/messages`);
    if (seq !== _convSeq) return;
    if (res.code === 0) setMessages((res.data || []).map(normalizeMessage));
  } catch (e) {
    if (seq !== _convSeq) return;
    setMessages([]);
    mToast(t("加载会话失败: {msg}", { msg: e.message }), 3200);
  }
  if (seq === _convSeq) mRenderAllMessages();
}

export async function mNewConversation() {
  if (_generating) {
    mToast(t("正在生成中，请稍候"));
    return;
  }
  state.currentConversationId = null;
  setMessages([]);
  setTopbarTitle("SLATE");
  mRenderAllMessages();
  const empty = $id("m-chat-emptystate");
  if (empty) empty.style.display = "";
  switchTab("chat");
  const inputEl = $id("m-chat-input");
  if (inputEl) inputEl.focus();
}

// ── 初始化 ────────────────────────────────────

export function initMChat() {
  const btn = $id("m-btn-send");
  if (btn) {
    btn.addEventListener("click", () => {
      if (_generating) mStopGenerating();
      else {
        const inputEl = $id("m-chat-input");
        mSendMessage(inputEl?.value || "");
      }
    });
  }
  // store 变更全量重渲染仅在空闲时进行（流式期间直接操作 DOM，避免打断）
  subscribe("messages", () => {
    if (_generating) return;
    mRenderAllMessages();
  });
  // 后台任务：移动端不进面板，但至少要轮询，才能把事件交给在跑的循环。
  // 空态时它自己退到 20 秒慢探，不会一直打后端。
  startBgPolling();
}

export { t };
