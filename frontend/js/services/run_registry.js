/**
 * 运行现场登记表（多任务并行的唯一真源）
 *
 * 一句要点：今天"有没有在生成"是一个布尔值，布尔值答不了"哪几场在跑、各归哪个项目"，
 * 而多项目并行要的正是这个。这里把生成权做成一张表：一场会话 = 一个 run = 一个
 * AbortController，停止只有 abortRun 这一个口，切会话不再等于停止。
 *
 * 四条不变量（守卫逐条钉）：
 *   ① 一个会话至多一个 run：并行是"跨会话/跨项目"的并行，同一场对话里开两个 run
 *      会让两条流抢同一个 assistant 气泡，落库顺序直接乱掉。
 *   ② 上限只在 canStart 一处判：跨项目 maxParallelRuns、同项目 maxConcurrentRunsPerProject。
 *      超限**不拒绝**，由调用方进等待队列——静默吞掉用户按下的发送是最坏的一种"贴心"。
 *   ③ run 不落盘：页面刷新后内存里的流、控制器、气泡全没了，落库只会复活成
 *      "看着在跑其实早死了"的假象（照 bgTasks 快照同样的口径处理）。
 *   ④ 释放槽位必须走 endRun（无论正常跑完、被停、抛异常），并且结束时要泵一次队列，
 *      否则等在前面的任务就永久卡在"排队中"。
 */

import { state, notify, subscribe } from "../store.js?v=20261017-001";

// 与设置页的三个控件一一对应；取值越界一律回落默认，脏值不该让并行整体失灵。
const PARALLEL_MIN = 1, PARALLEL_MAX = 4;
const PROJECT_MIN = 1, PROJECT_MAX = 3;

let seq = 0;
const runs = new Map();        // run_id -> run（本模块唯一真源）
const pending = [];            // 等槽位的任务：{ conv_id, project_id, payload, at }
let starter = null;            // chat.js 注册的"把一条等待项跑起来"的入口

function normalizeCount(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function maxParallelRuns() {
  return normalizeCount(state.maxParallelRuns, PARALLEL_MIN, PARALLEL_MAX, 2);
}

export function maxRunsPerProject() {
  return normalizeCount(state.maxConcurrentRunsPerProject, PROJECT_MIN, PROJECT_MAX, 1);
}

// backgroundRuns=false 是用户给自己留的退路：切会话仍中断当前生成（P2 之前的语义）。
export function backgroundRunsOn() {
  return state.backgroundRuns !== false;
}

export function runOf(convId) {
  const id = String(convId || "");
  if (!id) return null;
  for (const r of runs.values()) if (r.conv_id === id) return r;
  return null;
}

export function allRuns() {
  return [...runs.values()];
}

export function activeRuns() {
  return [...runs.values()];
}

export function waitingRuns() {
  return [...runs.values()].filter(r => r.phase === "waiting_approval");
}

export function pendingRuns() {
  return pending.slice();
}

export function pendingCountFor(convId) {
  const id = String(convId || "");
  return pending.filter(p => p.conv_id === id).length;
}

function runsOfProject(projectId) {
  const id = String(projectId || "");
  return [...runs.values()].filter(r => (r.project_id || "") === id);
}

/**
 * 能不能开一场。reason 是给人看的短句（守卫钉住"超限不拒绝"这条，所以调用方拿到
 * not-ok 时要进队列，而不是弹个错误了事）。
 * reserved / reservedProject 是给 pump() 用的"这一趟已经预定了几个坑"：starter 走的是
 * sendMessage，它要先 await 完作用域与确认才 startRun，同步扫一遍队列时 runs 还没长出来，
 * 不记账就会把整条队列一次性放行（同项目串行被绕过，两场同时改同一批文件）。
 */
export function canStart({ convId = "", projectId = "", reserved = 0, reservedProject = 0 } = {}) {
  if (convId && runOf(convId)) return { ok: false, reason: "same_conversation" };
  if (runs.size + reserved >= maxParallelRuns()) return { ok: false, reason: "global_cap" };
  if (projectId && runsOfProject(projectId).length + reservedProject >= maxRunsPerProject()) {
    return { ok: false, reason: "project_cap" };
  }
  return { ok: true, reason: "" };
}

/** 登记一场生成并返回 run；同会话已有 run 时返回 null（调用方据此走队列，不重复开）。 */
export function startRun({ convId = "", projectId = "", payload = null } = {}) {
  const id = String(convId || "");
  if (id && runOf(id)) return null;
  seq += 1;
  const run = {
    run_id: `run-${Date.now().toString(36)}-${seq}`,
    conv_id: id,
    project_id: String(projectId || ""),
    controller: new AbortController(),
    // 队列项的载荷对登记表是黑话：只有 chat.js 读得懂（text/files/kind）
    payload,
    phase: "running",
    started_at: Date.now(),
    last_event_at: Date.now(),
    // 这一场是否正在被看着：决定它能不能动聊天区 DOM。开跑时按当前会话算，
    // 之后由 setRunVisible 跟着切换会话更新。
    visible: Boolean(id) && id === String(state.currentConversationId || ""),
    // 用户在这场的生成期间又发的消息（等这一轮跑完按序发出去）
    queue: [],
    rounds: 0,
  };
  runs.set(run.run_id, run);
  publish();
  return run;
}

export function touchRun(target) {
  const r = typeof target === "object" && target ? target : runs.get(String(target || ""));
  if (!r) return;
  r.last_event_at = Date.now();
}

/** 阶段只影响任务中心怎么说，不影响循环本身：running / waiting_approval / finishing */
export function setRunPhase(runId, phase) {
  const r = runs.get(String(runId || ""));
  if (!r || r.phase === phase) return;
  r.phase = String(phase || "running");
  r.last_event_at = Date.now();
  publish();
}

export function setRunVisible(runId, visible) {
  const r = runs.get(String(runId || ""));
  if (!r) return;
  const next = Boolean(visible);
  if (r.visible === next) return;
  r.visible = next;
  publish();
}

/** 由 run_id 或会话 id 停掉一场（停止按钮只认这场，绝不牵连别的项目）。 */
export function abortRun(target) {
  const key = String(target || "");
  let r = runs.get(key) || null;
  if (!r) r = runOf(key);
  if (!r) return false;
  r.aborted_by_user = true;
  try { r.controller.abort(); } catch (e) {}
  setRunPhase(r.run_id, "finishing");
  return true;
}

export function abortRunFor(convId) {
  return abortRun(convId);
}

export function userAborted(runId) {
  const r = runs.get(String(runId || ""));
  return Boolean(r?.aborted_by_user);
}

/** 收尾：释放槽位 + 泵队列。run 不在表里时静默返回（重复调用要安全）。 */
export function endRun(runId) {
  const key = String(runId || "");
  if (!runs.has(key)) return;
  runs.delete(key);
  publish();
  pump();
}

// ── 等待队列 ────────────────────────────────
// 队列项按"哪一场会话"分组存放：同一会话里连按两次发送是排队（跑完这一场接着发），
// 不同会话的等待项是在等槽位（槽位一空就开新场）。两种都记在这里，界面都写"排队中"。

export function enqueue({ convId = "", projectId = "", payload = null } = {}) {
  const item = { conv_id: String(convId || ""), project_id: String(projectId || ""), payload, at: Date.now() };
  pending.push(item);
  publish();
  return item;
}

export function dropPendingFor(convId) {
  const id = String(convId || "");
  const before = pending.length;
  for (let i = pending.length - 1; i >= 0; i--) if (pending[i].conv_id === id) pending.splice(i, 1);
  if (pending.length !== before) publish();
}

export function registerRunStarter(fn) { starter = fn; }

// 设置页放宽上限 / 重新打开后台运行：坑一腾出来就该把等待队列放进来。
// 没有这条订阅，改完设置要等某一场恰好跑完才动，队列一直写着「排队中」。
for (const key of ["maxParallelRuns", "maxConcurrentRunsPerProject", "backgroundRuns"]) {
  subscribe(key, () => pump());
}

/**
 * 有空位就把队首放进run。三条规则：
 *   ① 同项目的等待项要等同项目的槽位（默认同项目串行），所以逐个试而不是只看队首；
 *   ② 会话已经不存在（被删）的等待项直接丢弃，别拿一条没有归属的消息去开新场；
 *   ③ starter 返回 false 说明这条开不起来（比如模型没配 Key），留在队里等下一次泵。
 */
export function pump() {
  if (!starter) { publish(); return; }
  // 这一趟同步放行、但坑要立刻占住：见 canStart 的 reserved 注释
  const reservedProject = new Map();
  let reserved = 0;
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const pk = String(item.project_id || "");
    const room = canStart({
      convId: item.conv_id, projectId: item.project_id,
      reserved, reservedProject: reservedProject.get(pk) || 0,
    });
    if (item.conv_id && !runOf(item.conv_id) && room.ok) {
      const taken = pending.splice(i, 1)[0];
      publish();
      reserved += 1;
      reservedProject.set(pk, (reservedProject.get(pk) || 0) + 1);
      let started = false;
      try {
        started = starter(taken) !== false;
      } catch (e) {
        started = false;
      }
      if (!started) {
        pending.splice(i, 0, taken);
        publish();
        return;
      }
      i--;
      continue;
    }
    if (item.conv_id && runOf(item.conv_id)) continue;   // 那场还在跑：它自己收尾时会取用
  }
}

// ── 对外快照 ────────────────────────────────
// state.runs 是"能画"的那份，phase/文案在面板里算；不放 DOM 引用，通知链上谁拿到都安全。

function snapshot() {
  return [
    ...[...runs.values()].map(r => ({
      run_id: r.run_id,
      conv_id: r.conv_id,
      project_id: r.project_id,
      phase: r.phase,
      visible: r.visible,
      started_at: r.started_at,
      last_event_at: r.last_event_at,
      queued: r.queue.length,
    })),
    ...pending.map((p, i) => ({
      run_id: `pending-${p.at}-${i}`,
      conv_id: p.conv_id,
      project_id: p.project_id,
      phase: "queued",
      visible: false,
      started_at: p.at,
      last_event_at: p.at,
      queued: 0,
    })),
  ];
}

function publish() {
  state.runs = snapshot();
  notify("runs", state.runs);
}

// 兼容旧调用点：不传 convId = "有没有任何一场在跑"；传了 = "这场在不在跑"。
export function isGenerating(convId = undefined) {
  if (convId === undefined || convId === null) return runs.size > 0;
  return Boolean(runOf(convId));
}

export function runningCount() { return runs.size; }

export function runningCountForProject(projectId) {
  return runsOfProject(projectId).length;
}

export function resetRunsForTests() {
  runs.clear();
  pending.length = 0;
  starter = null;
  publish();
}
