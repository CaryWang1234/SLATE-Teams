/**
 * 后台子代理批次：派出后**不占住这一轮**，跑完把结论当成一条后台任务消息送回。
 *
 * 为什么复用 bg_tasks 那套而不是新写一条唤醒链路：
 * 归属分流、跨会话信箱、徽标、"系统自己开口"的配额、右栏面板的行——这些都已经调好了，
 * 第二套实现迟早和第一套分叉（手机问得比桌面多那一类病就是这么来的）。
 *
 * 一条必须说清的边界：子代理跑在**这个页面**里，不是后端进程。
 * 刷新或关窗它就没了，也不落盘（与 run_registry 的「run 不落盘」同口径：
 * 复活成"看着在跑其实早死了"比直接没了更糟）。面板上本地任务的说明按这个写。
 */

import { upsertLocalTask, pushLocalBgEvent, registerLocalTaskStopper, startBgPolling } from "./bg_tasks.js?v=20261024-001";
import { runSubAgents } from "./subagent.js?v=20261024-001";

/** 同时在跑的后台批次数：一批最多 5 个子代理，不设上限等于让模型自己开线程池 */
export const BG_SUBAGENT_MAX_JOBS = 3;

/** 送回给模型的结论预算：比进程任务的 500 字宽，因为这是交付物而不是日志尾巴 */
export const BG_SUBAGENT_TAIL_BUDGET = 2600;

const jobs = new Map();   // job_id -> { controller, convId, startedAt }：只放在跑的
let seq = 0;

function previewHead(text, max = 90) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function runningBgSubAgentJobs() {
  return jobs.size;
}

export function canStartBgSubAgent() {
  return jobs.size < BG_SUBAGENT_MAX_JOBS;
}

/** 停一批：abort 之后 runSubAgents 会各自落到 stopped，收尾仍走 finishJob */
export function stopSubAgentJob(jobId) {
  const job = jobs.get(String(jobId || ""));
  if (!job) return false;
  try { job.controller.abort(); } catch { /* abort 失败也要让调用方看到"我试过了" */ }
  return true;
}

function statusText(status) {
  return status === "done" ? "完成" : status === "failed" ? "失败"
    : status === "stopped" ? "被停止" : status === "max_rounds" ? "轮次用尽" : String(status);
}

function aggregate(results, skipped) {
  const list = Array.isArray(results) ? results : [];
  // 唤醒时整段只按 tail_budget 从尾部截，所以这里先按人头分预算：
  // 5 个子代理挤一份预算，前几个会被整段截没——那恰恰是最该被看见的结论。
  const per = Math.max(300, Math.floor(BG_SUBAGENT_TAIL_BUDGET / Math.max(1, list.length)) - 80);
  const parts = list.map(r => {
    const body = String(r.output || "").trim() || "（无文本输出）";
    const clipped = body.length > per
      ? body.slice(0, per) + "…（超出后台唤醒预算已截断，完整结论在右栏任务面板）"
      : body;
    return `## 子代理「${r.name}」（${statusText(r.status)}，${r.rounds} 轮，${r.toolCalls} 次工具调用）\n${clipped}`;
  });
  if (skipped > 0) parts.push(`（另有 ${skipped} 个子任务超出单次并行上限，未派出）`);
  return parts.join("\n\n");
}

function finishJob(jobId, results, skipped, failure) {
  const job = jobs.get(String(jobId || ""));
  if (!job) return;
  jobs.delete(String(jobId || ""));

  const list = Array.isArray(results) ? results : [];
  const doneCount = list.filter(r => r.status === "done").length;
  const stopped = list.some(r => r.status === "stopped");
  const tail = failure ? `后台子代理批次启动失败：${failure?.message || failure}` : aggregate(list, skipped);
  const state = failure ? "failed" : (stopped && !doneCount ? "stopped" : "exited");
  // 退出码只回答"这一批有没有交付"：全停 = 没有；有任何一个跑完就算交付，
  // 部分失败写在结论正文里，不靠退出码表达（面板上"退出码 1"会被读成"整个批次失败"）
  const exitCode = failure || !doneCount ? 1 : 0;

  upsertLocalTask({ ...job.task, state, exit_code: exitCode, output: tail, finished_at: Date.now() });
  pushLocalBgEvent({
    task_id: jobId,
    label: job.task.label,
    kind: state === "exited" ? "exit" : state === "stopped" ? "stopped" : "fail",
    exit_code: exitCode,
    tail,
    tail_budget: BG_SUBAGENT_TAIL_BUDGET,
    conversation_id: job.convId,
    origin: "local",
  });
}

/**
 * 派出一批后台子代理。deps 与前台 subagent_run 完全同一份（工具执行器带审批门），
 * 差别只有两处：① 用批次自己的 AbortController，不吃主循环的 signal——主循环一收口
 * 那个 signal 就废了，后台任务不能跟着它一起死；② 结果不进本轮工具回执，走唤醒池。
 */
export function startSubAgentJob({ agents, deps, convId = "" }) {
  if (!canStartBgSubAgent()) return { ok: false, reason: "cap" };
  seq += 1;
  const jobId = `sub-${Date.now().toString(36)}-${seq}`;
  const names = (Array.isArray(agents) ? agents : [])
    .map(a => String(a?.name || "").trim()).filter(Boolean).slice(0, 5);
  const task = {
    task_id: jobId,
    label: `子代理·${names.join("、") || "后台批次"}`,
    command: previewHead((Array.isArray(agents) ? agents : [])
      .map(a => String(a?.task || "").trim()).filter(Boolean).join(" / ")),
    state: "running",
    exit_code: null,
    conversation_id: String(convId || ""),
    created_at: Date.now(),
    log_path: "",
  };
  jobs.set(jobId, { controller: new AbortController(), convId: String(convId || ""), task, startedAt: Date.now() });
  upsertLocalTask(task);
  startBgPolling();

  runSubAgents(agents, { ...deps, scopeConvId: String(convId || "") }, jobs.get(jobId).controller.signal)
    .then(({ results, skipped }) => finishJob(jobId, results, skipped, null))
    .catch((e) => finishJob(jobId, [], 0, e));

  return { ok: true, jobId, task };
}

// 右栏面板点"停止"时，本地任务由这里 abort（注册一次即可，模块只被 tools.js 拉起）
registerLocalTaskStopper(async (jobId) => stopSubAgentJob(jobId));
