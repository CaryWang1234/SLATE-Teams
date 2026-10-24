/**
 * SLATE Agent 事件账本：一次工具循环 = 一个 run，run 内事件按 seq 全序落账。
 *
 * 由 agent_loop kernel 驱动，所以桌面、移动、白板看到的是同一份账：
 *   projectChat(ledger, round) → 聊天工具卡片要的 [{call, result}]
 *   projectSteps(ledger)       → 白板步骤卡要的卡片描述符（幂等，可反复投影）
 *
 * 两个序空间不混用：`seq` 是前端逻辑序（每 run 单调，落库后靠 UNIQUE(run_id,seq) 幂等），
 * DB 自增 `id` 只是物理序。callId 形如 r{round}c{index}，跨轮唯一，卡片以它为键复用。
 *
 * 内存账存全量（投影要原文参数与完整输出），上行才裁成摘要：参数与输出各留 2000 字符
 * 加字节数，落库的是 digest。账本失败绝不影响聊天——上行一律 fire-and-forget，异常只 warn。
 */

import { post } from "./api.js?v=20261024-001";
import { toolLabel, toolArgsSummary } from "./tool_meta.js?v=20261024-001";

const DIGEST_MAX = 2000;
const MAX_PENDING = 500;
const APPEND_PATH = "/events/append";

function digestOf(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return { clip: text.slice(0, DIGEST_MAX), bytes: text.length };
}

/** 内存事件 → 上行事件：丢掉原文，只留摘要与度量 */
function toWire(event) {
  const data = { ...(event.data || {}) };
  if (typeof event.round === "number") data.round = event.round;
  if ("call" in data) delete data.call;
  if ("args" in data) {
    const d = digestOf(data.args);
    data.argsDigest = d.clip;
    data.argsBytes = d.bytes;
    delete data.args;
  }
  if ("result" in data) {
    const output = typeof data.result?.output === "string" ? data.result.output : String(data.result?.output ?? "");
    const d = digestOf(output);
    data.resultDigest = d.clip;
    data.bytes = d.bytes;
    data.truncated = d.clip.length < d.bytes;
    delete data.result;
  }
  return {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    callId: event.callId || "",
    // 父调用非空 = 这一行是别人派生出来的（子代理），星图据此画 spawn 边。
    // 服务端 events.py 一直在收这列，此前只是前端从没填过。
    parentCallId: event.parentCallId || "",
    tool: event.tool || "",
    messageId: event.messageId || "",
    data,
  };
}

export function openRun({ conversationId = "", mode = "", budget = 0 } = {}) {
  const startedAtMs = Date.now();
  const events = [];
  let pending = [];
  let seq = 0;
  let closed = false;

  const ledger = {
    runId: "",
    startedAtMs,
    events,
    roundSeen: -1,
    callId(round, index) {
      return `r${round}c${index}`;
    },
    emit(type, { callId = "", parentCallId = "", tool = "", messageId = "", round, data } = {}) {
      if (closed) return null;
      const event = { seq: ++seq, ts: Date.now(), type, callId, parentCallId, tool, messageId, round, data: data || {} };
      events.push(event);
      pending.push(event);
      if (typeof round === "number") ledger.roundSeen = round;
      // 服务端长时间不可用时只丢最旧的，内存账（events）保持全量
      if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
      return event;
    },
    flush({ final = false, status = "" } = {}) {
      const batch = pending.splice(0, pending.length);
      const run = {
        runId: ledger.runId,
        conversationId,
        mode,
        startedAtMs,
        budgetRounds: budget,
        final,
        status,
      };
      if (final) {
        run.endedAtMs = Date.now();
        run.wallMs = run.endedAtMs - startedAtMs;
      }
      return post(APPEND_PATH, { run, events: batch.map(toWire) }).catch((err) => {
        console.warn("[SLATE] 工具事件落账失败:", err?.message || err);
      });
    },
    finish({ status = "completed", stops = "" } = {}) {
      if (closed) return Promise.resolve();
      const now = Date.now();
      ledger.emit("run.finished", {
        data: { status, stops, rounds: ledger.roundSeen + 1, wallMs: now - startedAtMs },
      });
      closed = true;
      window.removeEventListener("pagehide", onPageHide);
      return ledger.flush({ final: true, status });
    },
  };

  // 一轮一个 id，它同时是「本轮总结 / 撤回」那份清单的键：清单要留 7 天，只靠 4 位
  // 随机数一旦撞车，两轮的文件就会被并进同一条清单，撤销时连不相干那轮的也一起还原。
  // 所以时间戳打头、随机位补足 8 位。
  const rand = String(Math.random().toString(16).slice(2)).padStart(8, "0").slice(0, 8);
  ledger.runId = `run_${Date.now().toString(36)}_${rand}`;

  const onPageHide = () => {
    if (closed) return;
    closed = true;
    // keepalive 请求体上限约 64KB，页面要走了只补发终态，不搬运在飞的整批事件
    const now = Date.now();
    post(APPEND_PATH, {
      run: {
        runId: ledger.runId,
        conversationId,
        mode,
        startedAtMs,
        endedAtMs: now,
        wallMs: now - startedAtMs,
        budgetRounds: budget,
        final: true,
        status: "interrupted",
      },
      events: [{
        seq: ++seq,
        ts: now,
        type: "run.finished",
        callId: "",
        tool: "",
        messageId: "",
        data: { status: "interrupted", stops: "页面已关闭", rounds: ledger.roundSeen + 1, wallMs: now - startedAtMs },
      }],
    }, { keepalive: true }).catch(() => {});
  };
  window.addEventListener("pagehide", onPageHide);

  return ledger;
}

/** 聊天工具卡片投影：与历史 metadata.toolResults 同形状 */
export function projectChat(ledger, round) {
  const out = [];
  if (!ledger) return out;
  for (const e of ledger.events) {
    if (e.type !== "call.finished" || !e.data?.call || !e.data?.result) continue;
    if (round !== undefined && e.round !== round) continue;
    out.push({ call: e.data.call, result: e.data.result });
  }
  return out;
}

/**
 * 白板步骤卡投影：只报到过 call.ready 的调用（被去重拦下的计划不生成卡片），
 * 顺序即 seq 顺序，状态由 call.finished / call.cancelled 覆盖。
 */
export function projectSteps(ledger) {
  const steps = new Map();
  if (!ledger) return [];
  for (const e of ledger.events) {
    if (!e.callId || !e.type.startsWith("call.")) continue;
    let step = steps.get(e.callId);
    if (!step) {
      step = { callId: e.callId, tool: "", args: null, ready: false, status: "running", excerpt: "", durationMs: 0 };
      steps.set(e.callId, step);
    }
    if (e.type === "call.planned") {
      step.tool = e.tool || step.tool;
      if (e.data?.args) step.args = e.data.args;
    } else if (e.type === "call.ready") {
      step.ready = true;
      step.tool = e.tool || step.tool;
    } else if (e.type === "call.finished") {
      step.status = e.data?.status || "done";
      step.durationMs = e.data?.durationMs || 0;
      step.excerpt = String(e.data?.result?.output ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
    } else if (e.type === "call.cancelled") {
      step.status = "cancelled";
    }
  }
  return [...steps.values()].filter(s => s.ready).map(s => ({
    callId: s.callId,
    tool: s.tool,
    label: toolLabel(s.tool, s.args),
    args: s.args,
    argsSummary: toolArgsSummary(s.args, s.tool),
    status: s.status,
    excerpt: s.excerpt,
    durationMs: s.durationMs,
  }));
}
