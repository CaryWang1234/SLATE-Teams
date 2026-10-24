/**
 * 办公室引擎：领活、跑活、递话，外加「像人一样工作」那三件事——
 * 照自己的备忘开工（office_note）、晨会分诊手上的队列（office_triage）、
 * 办不下去时如实结班（office_settle：blocked 等人给条件，dropped 等人点头）。
 *
 * 分工（与 backend/routers/office.py 一一对应）：
 *   名册、值班表、队列、传话、备忘都活在后端库里——到点了页面可能没开，那些不能只留在内存。
 *   执行活在这一个页面里：工具、审批、API Key 全在这一侧（与团队轮次循环同口径）。
 *   需要判断的事一律排成一条活，由这一趟办完再交回结局；后端只做确定性预检（时钟、守卫）。
 *
 * 四条不许回退的口径：
 *
 * 1. 领活走后端 CAS。两个桌面窗口同时读到同一条 queued 就会各跑一遍，
 *    同一句交办动两次工具比不跑严重得多；页面抢不到就当没抢到。
 * 2. 每一趟自己的 AbortController，停止口只有 stopOfficeJob 一个。
 *    租约靠 heartbeat 续；页面崩掉则由后端时钟把活退回队列（第 2 次仍死就判失败）。
 * 3. 结局只经 bg_tasks 那一条唤醒通道发出（upsertLocalTask + pushLocalBgEvent），
 *    不写第二种唤醒链路——两套迟早分叉成"手机问得比桌面多"那种病。
 * 4. 后台路径一律不带 mode（工具白名单）：员工该干什么由名册上的职责管，
 *    不由输入框那一档管——与 agent_loop.js、team.js 里那两条注释同口径。
 *    并行额度先让给用户：run_registry 占满时这一趟不开工。
 */

import { state, getModelKey, getModelDefinition, estimateTokens, setPermissionModeFor } from "../store.js?v=20261024-001";
import { get, post, patch, del, streamChat } from "./api.js?v=20261024-001";
import { detectAllCalls, stripToolCalls, executeToolCalls, getToolsSystemPrompt, buildOpenAITools, effectiveToolMode, openAICallsToCalls } from "./tools.js?v=20261024-001";
import { openRun as openLedgerRun } from "./agent_ledger.js?v=20261024-001";
import { upsertLocalTask, pushLocalBgEvent, registerLocalTaskStopper, startBgPolling } from "./bg_tasks.js?v=20261024-001";
import { runningCount, maxParallelRuns } from "./run_registry.js?v=20261024-001";
import { ensureProjectScope } from "./project_scope.js?v=20261024-001";
import { notifyTaskComplete } from "./notify.js?v=20261024-001";
import { t } from "./i18n.js?v=20261024-001";

/** 有活在跑时的轮询间隔 */
export const OFFICE_ACTIVE_MS = 4000;
/** 面板开着但队列空：还是要偶尔刷一下，同事之间的动静得看得见 */
export const OFFICE_PANEL_MS = 6000;
/** 面板没开、队列也空：慢探，别让空转把日志刷满 */
export const OFFICE_IDLE_MS = 20000;
/** 跑着的活多久续一次租约（后端租约 120 秒，这一头必须明显更短） */
export const OFFICE_HEARTBEAT_MS = 30000;
/** 一次最多同时跑几位员工：与后端 CLAIM_MAX 同一个数 */
export const OFFICE_MAX_CONCURRENT = 2;
/** 结局尾巴带多少字进唤醒载荷：够看清结论，又不把上下文灌爆 */
export const OFFICE_TAIL_BUDGET = 1600;
/** 注入 prompt 的备忘总量上限：不设上限，备忘迟早把自己的窗口撑掉 */
export const OFFICE_MEMORY_CHARS = 1800;
/** 分诊时给员工看的队列条数上限 */
export const OFFICE_TRIAGE_LIST = 20;

// 面板读的是内存里这份快照，引擎自己刷；不在 store 上开第二个状态源。
let board = {
  employees: [], duties: [], jobs: [], messages: [], notes: [], unreadForUser: 0,
  templates: [], maxHops: 6, guardKinds: [], triageActions: [], reviewVerdicts: [],
  standup: [], performance: [],
};
const listeners = new Set();
/** jobId → 这一趟真在跑的东西（controller / 会话 / 工位上那句话） */
const running = new Map();
let claimToken = "";
let pollTimer = null;
let heartbeatTimer = null;

/**
 * 办公室的事件总线：面板订阅它，不再自己发请求。
 * 类型：board（快照刷过了）/ activity（某位员工刚说了一句，工位上要有气泡）/
 *      job（一条活的开始或结局）
 */
export const officeEvents = {
  on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit(type, payload = {}) {
    const event = { type: String(type || ""), ...payload };
    for (const fn of listeners) {
      try { fn(event); } catch { /* 渲染失败绝不能拖住执行 */ }
    }
  },
};

export function officeBoard() {
  return board;
}

export function officeRunning() {
  return [...running.values()].map(r => ({
    jobId: r.jobId,
    employeeId: r.employeeId,
    employeeName: r.employeeName,
    conversationId: r.conversationId,
    line: r.line,
    startedAt: r.startedAt,
  }));
}

/** 某位员工此刻的灯：引擎知道这一趟在跑就先认它，否则读后端算出来的那份 */
export function officeSeatStatus(employeeId) {
  const key = String(employeeId || "");
  // running 是 Map（键是 jobId），没有 .some：一位可能同时挂着两条活，扫到就算在忙
  for (const rec of running.values()) if (rec.employeeId === key) return "busy";
  return board.employees.find(e => e.employeeId === key)?.status || "idle";
}

/**
 * 工位面是否真的在眼前：引擎据此决定刷快照的频率，交付完成时也据此决定喊不喊人。
 * 合并后「办公室」面板在对话面也一直 active，只判 .panel.active 会把聊天时当成看过工位：
 * 消息被误标已读、交付通知被吞、轮询还一直走 6 秒快档。两道都得满足。
 */
function officePanelVisible() {
  return !!document.getElementById("panel-office")?.classList.contains("active")
    && !!document.getElementById("office-view-desk")?.classList.contains("active");
}

// ── 后端往返（面板只调这一层的函数，不自己拼 URL）──────────

async function refreshBoard() {
  try {
    const res = await get("/office/board");
    if (res?.code !== 0 || !res.data) return false;
    board = { ...board, ...res.data };
    officeEvents.emit("board", { board });
    return true;
  } catch {
    return false;
  }
}

export async function hireEmployee(payload) {
  const res = await post("/office/employees", payload);
  if (res?.code === 0) await refreshBoard();
  return res;
}

export async function patchEmployee(employeeId, payload) {
  const res = await patch(`/office/employees/${encodeURIComponent(employeeId)}`, payload);
  if (res?.code === 0) await refreshBoard();
  return res;
}

export async function fireEmployee(employeeId) {
  const res = await del(`/office/employees/${encodeURIComponent(employeeId)}`);
  if (res?.code === 0) await refreshBoard();
  return res;
}

export async function addDuty(payload) {
  const res = await post("/office/duties", payload);
  if (res?.code === 0) await refreshBoard();
  return res;
}

export async function patchDuty(dutyId, payload) {
  const res = await patch(`/office/duties/${encodeURIComponent(dutyId)}`, payload);
  if (res?.code === 0) await refreshBoard();
  return res;
}

export async function removeDuty(dutyId) {
  const res = await del(`/office/duties/${encodeURIComponent(dutyId)}`);
  if (res?.code === 0) await refreshBoard();
  return res;
}

export async function runDutyNow(dutyId) {
  const res = await post(`/office/duties/${encodeURIComponent(dutyId)}/run`, {});
  if (res?.code === 0) {
    await refreshBoard();
    startOfficeEngine();
  }
  return res;
}

/** 人在办公室里说一句话：贴出来（broadcast）、点名交给某位员工（会排成一条活） */
export async function sayAtOffice({ toKind, toId, toName, text }) {
  const res = await post("/office/messages", {
    fromKind: "user", fromId: "", fromName: t("用户"),
    toKind, toId, toName, text, wake: toKind === "employee" ? 1 : 0,
  });
  if (res?.code === 0) {
    await refreshBoard();
    startOfficeEngine();
  }
  return res;
}

export async function markOfficeRead(employeeId = "") {
  const res = await post("/office/messages/read", { employeeId });
  if (res?.code === 0) await refreshBoard();
  return res;
}

/** 人点头把活放回队列：dropped / blocked 回到 queued 只有这一扇门（员工自己推不开） */
export async function reviveJob(jobId) {
  const res = await post(`/office/jobs/${encodeURIComponent(jobId)}/revive`, {});
  if (res?.code === 0) {
    await refreshBoard();
    startOfficeEngine();
  }
  return res;
}

/** 人同意「不该办」：落成结案，不再挂在等你拍板那一栏（只翻状态，那一趟的账不动） */
export async function declineJob(jobId) {
  const res = await post(`/office/jobs/${encodeURIComponent(jobId)}/decline`, {});
  if (res?.code === 0) await refreshBoard();
  return res;
}

/** 人替员工划掉一条备忘：事在别处办完的（手工改的、别的窗口做的），他自己看不见就划不掉 */
export async function closeOfficeNote(employeeId, noteId) {
  const res = await post("/office/notes", { employeeId, kind: "ledger", text: "", closeNoteId: noteId });
  if (res?.code === 0) await refreshBoard();
  return res;
}

// ── 轮询：领活 + 刷快照 ──────────────────────────

function nextDelay() {
  if (running.size) return OFFICE_ACTIVE_MS;
  return officePanelVisible() ? OFFICE_PANEL_MS : OFFICE_IDLE_MS;
}

async function tick() {
  const room = OFFICE_MAX_CONCURRENT - running.size;
  // 用户自己的生成把额度占满时不领活：领了也开不了工，白占一条 running 记录
  const userRoom = maxParallelRuns() - runningCount();
  if (room > 0 && userRoom > 0) {
    try {
      const res = await post("/office/jobs/claim", { claimToken, limit: Math.min(room, userRoom) });
      if (res?.code === 0 && res.data) {
        claimToken = res.data.claimToken || claimToken;
        const jobs = Array.isArray(res.data.jobs) ? res.data.jobs : [];
        for (const job of jobs) runJob(job).catch(err => finishAbandoned(job, String(err?.message || err)));
      }
    } catch { /* 后端没起来：下一轮再试 */ }
  }
  await refreshBoard();
}

function scheduleNext() {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    await tick();
    // tick 期间可能有人调过 startOfficeEngine（已经排好了下一次）：别再叠一层
    if (pollTimer === null) scheduleNext();
  }, nextDelay());
}

export function startOfficeEngine() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  scheduleNext();
}

/** 只停轮询：正在跑的活由 stopOfficeJob 逐条掐，关面板不该把员工的活儿掐死 */
export function stopOfficeEngine() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function ensureHeartbeat() {
  if (heartbeatTimer !== null || !running.size) return;
  heartbeatTimer = setInterval(() => {
    if (!running.size) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      return;
    }
    post("/office/jobs/heartbeat", { claimToken, jobIds: [...running.keys()] }).catch(() => {});
  }, OFFICE_HEARTBEAT_MS);
}

// ── 跑一条活 ────────────────────────────────────

function taskKey(jobId) {
  return `office-${jobId}`;
}

function taskLabel(job, employeeName) {
  return `${employeeName} · ${String(job.brief || "").slice(0, 24)}`;
}

/** 工位上那句话：面板据此冒气泡 */
function setLine(jobId, text) {
  const rec = running.get(String(jobId || ""));
  if (!rec) return;
  rec.line = String(text || "").replace(/\s+/g, " ").trim().slice(0, 90);
  officeEvents.emit("activity", { employeeId: rec.employeeId, jobId, text: rec.line });
}

async function runJob(job) {
  const jobId = String(job.jobId || "");
  if (!jobId || running.has(jobId)) return;
  const employee = board.employees.find(e => e.employeeId === String(job.employeeId || ""));
  if (!employee) {
    await finishJob(job, { status: "stopped", error: t("员工已离职") });
    return;
  }

  // 名册上钉过模型就用那只，没钉就跟随当前主模型
  const pinned = String(employee.modelId || "");
  const definition = pinned ? getModelDefinition(pinned) : null;
  const modelId = definition?.id || state.currentModel?.id || "";
  const apiKey = getModelKey(modelId)
    || (modelId && modelId === state.currentModel?.id ? (state.currentModel?.key || "") : "");
  if (!modelId || (!apiKey && modelId !== "local")) {
    await finishAbandoned(job, t("未配置该模型的 API Key，没法开工"));
    return;
  }

  const project = await ensureProjectScope(String(job.projectId || ""));
  // 归属项目点名了却读不到现场：停下来，不能拿屏幕上那一个去干活
  if (String(job.projectId || "") && !project) {
    await finishAbandoned(job, t("项目现场读不到，已停手"));
    return;
  }

  const conv = await createJobConversation(job, employee, project);
  if (!conv) {
    await finishAbandoned(job, t("交付会话建不出来"));
    return;
  }
  const conversationId = conv.id;
  const jobTitle = conv.title || "";
  // 「托管」就是把这一场钉到夜间档：高危命令不问、缺条件也不反问
  if (employee.unattended) setPermissionModeFor(conversationId, "night");

  const controller = new AbortController();
  // 这一趟的身份对象：既是工位上那条记录，也是工具拿到的 actor。
  // office_settle 要把「卡住 / 不该办」记在这同一份引用上（引擎在这一趟结束时落终态），
  // 让工具自己去 POST finish 会开出第二条收口通路，两处写同一行迟早分叉。
  const record = {
    kind: "office", jobId, employeeId: employee.employeeId, employeeName: employee.name,
    conversationId, line: "", startedAt: Date.now(), controller, settled: null,
    usage: { promptTokens: 0, completionTokens: 0 },
  };
  running.set(jobId, record);
  upsertLocalTask({
    task_id: taskKey(jobId), label: taskLabel(job, employee.name),
    state: "running", exit_code: null, conversation_id: conversationId, family: "office",
  });
  startBgPolling();
  ensureHeartbeat();
  officeEvents.emit("job", { jobId, status: "running", employeeId: employee.employeeId });

  const unread = await takeColleagueMessages(employee.employeeId);
  const messages = [
    { role: "system", content: buildEmployeeSystemPrompt(employee) },
    { role: "user", content: buildJobPrompt(job, employee, unread) },
  ];
  await addConversationMessage(conversationId, {
    role: "user", content: messages[1].content, model: "",
  });

  let rounds = 0;
  let toolCalls = 0;
  let finalText = "";
  let failure = "";
  let stopped = false;
  try {
    const budget = Math.max(1, Math.min(24, Number(employee.roundsBudget) || 8));
    for (let round = 0; round < budget; round++) {
      if (controller.signal.aborted) { stopped = true; break; }
      rounds = round + 1;
      // 一轮一份账本，开在轮首（与 agent_loop 同口径）：没动工具的那一轮也得留一行，
      // 否则星图与「这一轮改了哪些文件」按 run 找，办公那一趟整轮都是隐形的。
      const ledger = openLedgerRun({ conversationId, mode: "office", budget: 1 });
      try {
        setLine(jobId, t("正在想这一步"));
        // 每一轮都把整条线程重发一次，所以 prompt 按整条算才是真数
        record.usage.promptTokens += estimateTokens(messages.map(m => m.content).join("\n"));
        // 两种协议都收：能原生就带 schema（原生调用的可靠度明显高于文本标记），
        // 弱端点与本地模型仍走提示词教的文本标记；DSML 泄漏那一路由 detectAllCalls 一起吃掉。
        const native = effectiveToolMode(modelId, definition?.provider || state.currentModel?.provider || "openai", "agent") === "native";
        let raw = "";
        let nativeCalls = [];
        for await (const chunk of streamChat({
          model: modelId,
          provider: definition?.provider || state.currentModel?.provider || "openai",
          base_url: definition?.base_url || state.currentModel?.base_url,
          messages,
          api_key: apiKey,
          temperature: 0.4,
          stream: true,
          signal: controller.signal,
          ...(native ? { tools: buildOpenAITools(null) } : {}),
        }, { onToolCall: (calls) => { nativeCalls = calls; } })) {
          raw += chunk;
        }
        record.usage.completionTokens += estimateTokens(raw);
        const clean = stripToolCalls(raw);
        if (clean.trim()) finalText = clean.trim();
        const markup = detectAllCalls(raw);
        // 标记优先：同一轮里两种都冒出来时只执行一份，跑两遍就是同一台机器被改两次
        const calls = markup.length ? markup : openAICallsToCalls(nativeCalls);
        messages.push({ role: "assistant", content: raw });
        if (!calls.length) break;
        if (controller.signal.aborted) { stopped = true; break; }

        setLine(jobId, t("正在调用 {tool}", { tool: calls[0].name }));
        const startedAt = new Map();
        const results = await executeToolCalls(calls, {
          signal: controller.signal,
          ledger,
          convId: conversationId,
          project: project || null,
          // 这一趟是谁在跑：office_send 据此把发话人记成这名员工，
          // office_note / office_triage / office_settle 据此认出只能动他自己的记录
          actor: record,
          callIdFor: (i) => ledger.callId(round, i),
          onCallStart: (call, i) => {
            const callId = ledger.callId(round, i);
            startedAt.set(callId, Date.now());
            ledger.emit("call.planned", { callId, tool: call.name, round, data: { args: call.params } });
            ledger.emit("call.ready", { callId, tool: call.name, round });
            ledger.emit("call.started", { callId, tool: call.name, round });
          },
          onCallEnd: (call, i, result) => {
            const callId = ledger.callId(round, i);
            ledger.emit("call.finished", {
              callId, tool: call.name, round,
              data: {
                status: result === undefined ? "failed" : result.success === false ? "error" : "done",
                durationMs: Math.max(0, Date.now() - (startedAt.get(callId) || Date.now())),
              },
            });
          },
        });
        toolCalls += results.length;
        if (controller.signal.aborted) { stopped = true; break; }

        const parts = results.map(r => {
          const text = typeof r.output === "string" ? r.output : JSON.stringify(r.output ?? {});
          return `[工具 ${r.name}] ${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}`;
        });
        messages.push({
          role: "user",
          content: `[工具结果]\n${parts.join("\n\n")}\n\n请继续推进；办完了就输出最终交付（纯文本，不带工具调用块）。`,
        });
      } finally {
        ledger.finish({ status: controller.signal.aborted ? "cancelled" : "completed" });
      }
    }
  } catch (e) {
    if (controller.signal.aborted || e?.name === "AbortError") stopped = true;
    else failure = String(e?.message || e);
  }

  // 员工用 office_settle 结的班优先于「跑完了」：卡住与该不该办都是等人，不是失败，
  // 也不该被洗成 done——那等于把「这事没人管」写成「这事办完了」。
  const settled = record.settled;
  const status = stopped ? "stopped" : failure ? "error" : (settled?.status || "done");
  const awaiting = status === "blocked" || status === "dropped";
  setLine(jobId, status === "done" ? t("已交付")
    : status === "stopped" ? t("已停止")
      : status === "blocked" ? t("已受阻")
        : status === "dropped" ? t("判为不该办") : t("没跑成"));
  const finishRes = await finishJob(job, {
    status,
    resultText: status === "done" ? finalText : "",
    error: failure || (stopped ? t("被停止") : ""),
    rounds,
    toolCalls,
    // 这一趟的用量跟着结局一起交回：预算熔断读的就是这一列（与 daily_usage 同一份估算口径）
    tokens: record.usage.promptTokens + record.usage.completionTokens,
    conversationId,
    stateReason: awaiting ? (settled?.reason || "") : "",
    decidedBy: status === "dropped" ? "employee" : "",
  });
  // 交付被名册上的那道门拦进审校队列时，这一趟的结果就不能再说成「已交付」：
  // 状态灯由后端算，措辞必须由读到判定的人来改，两处都留在页面上猜就会分叉。
  const review = status === "done" && finishRes?.code === 0 && finishRes?.data?.review === "pending"
    ? { pending: true, reviewerName: String(finishRes.data.reviewerName || "") }
    : null;
  if (review) setLine(jobId, t("已交审校"));
  // 交付正文也要落进那场会话：只写进交办那一句的话，「去看这一场」点开的是半截对话
  const lineText = status === "done" ? (finalText || t("这一趟没留下正文"))
    : status === "blocked" ? `${t("缺条件，做不了")}：${settled?.reason || ""}`
      : status === "dropped" ? `${t("这件事不该办")}：${settled?.reason || ""}`
        : (finalText || failure || t("被停止"));
  await addConversationMessage(conversationId, {
    role: "assistant",
    content: lineText,
    model: modelId,
  });
  // 两条消息都落了才把标题改回 [员工] 那一份（后端用首条正文取的是占位标题）
  await restoreJobTitle(conversationId, jobTitle);
  await syncJobUsage(conversationId, record.usage, messages);

  running.delete(jobId);
  upsertLocalTask({
    task_id: taskKey(jobId), label: taskLabel(job, employee.name),
    // 卡住 / 不该办 这一趟本身是跑完的（没崩、没被掐），任务列表里算正常结束；
    // "等人"这件事由 office_jobs 的状态与下面那条 awaiting 事件承担，不在这里发明第二种状态。
    state: status === "done" || awaiting ? "exited" : status === "stopped" ? "stopped" : "failed",
    exit_code: status === "done" || awaiting ? 0 : status === "stopped" ? null : 1,
    conversation_id: conversationId, family: "office",
  });
  pushLocalBgEvent({
    task_id: taskKey(jobId),
    label: taskLabel(job, employee.name),
    kind: awaiting ? "awaiting" : status === "done" ? "exit" : status === "stopped" ? "stopped" : "fail",
    exit_code: status === "done" || awaiting ? 0 : 1,
    tail: (finalText || failure || settled?.reason || "").slice(-OFFICE_TAIL_BUDGET),
    tail_budget: OFFICE_TAIL_BUDGET,
    conversation_id: conversationId,
    origin: "local",
  });
  await reportToOffice(job, employee, status, finalText, failure, settled, review);
  officeEvents.emit("job", { jobId, status, employeeId: employee.employeeId, resultText: finalText });
  if ((status === "done" || awaiting) && !officePanelVisible()) {
    // 等人点头的事要能喊到人：只在 done 时提醒的话，「卡住」就成了一条没人知道的挂账。
    // 进了审校的那一份也是「还没到用户手上」，所以第三种措辞同样要能喊人。
    try {
      notifyTaskComplete(awaiting ? t("员工等你拍板") : review ? t("员工已交审校") : t("员工交付"),
        `${employee.name}：${(settled?.reason || finalText).slice(0, 80)}`);
    } catch { /* 通知不是关键路径 */ }
  }
  await refreshBoard();
}

/** 开不了工 / 中途炸在外层：把队列收尾，并给人递一句为什么 */
async function finishAbandoned(job, reason) {
  const jobId = String(job.jobId || "");
  await finishJob(job, { status: "error", error: String(reason || "").slice(0, 200) });
  const employee = board.employees.find(e => e.employeeId === String(job.employeeId || ""));
  if (employee) {
    await post("/office/messages", {
      fromKind: "system", fromId: "", fromName: t("办公室"),
      toKind: "user", toId: "", toName: "", text: t("{name} 没能开工：{why}", { name: employee.name, why: reason }),
      jobId,
    }).catch(() => {});
  }
  running.delete(jobId);
  await refreshBoard();
  officeEvents.emit("job", { jobId, status: "error", employeeId: job.employeeId });
}

async function finishJob(job, payload) {
  const jobId = String(job.jobId || "");
  if (!jobId) return null;
  // 除了交回结局，这里还要读一句「这份交付进没进审校」：那道门由名册上的审校人决定，
  // 引擎不自己判该不该审——自己判就等于把门禁的实现挪到第二处。
  return await post(`/office/jobs/${encodeURIComponent(jobId)}/finish`, payload).catch(() => null);
}

async function createJobConversation(job, employee, project) {
  const title = `[${t("员工")}] ${employee.name} · ${String(job.brief || "").slice(0, 18)}`.slice(0, 40);
  try {
    const res = await post("/chat/conversations", {
      title,
      project: project?.name || "",
      project_id: project?.project_id || "",
    });
    if (res?.code !== 0 || !res.data?.id) return null;
    // 建场时那份标题先交回去：后端在第一条用户消息落库时会拿正文前 30 字顶掉它，
    // 所以真正改回 [员工] 那一份要等消息落完（与 scheduler 同一手，顺序不能颠倒）
    return { ...res.data, title };
  } catch {
    return null;
  }
}

/** 把会话标题改回员工那一份——必须在两条消息都落库之后，否则又被首条正文顶掉 */
async function restoreJobTitle(conversationId, title) {
  if (!conversationId || !title) return;
  await patch(`/chat/conversations/${encodeURIComponent(conversationId)}`, { title }).catch(() => {});
}

async function addConversationMessage(conversationId, payload) {
  await post(`/chat/conversations/${encodeURIComponent(conversationId)}/messages`, payload).catch(() => {});
}

async function syncJobUsage(conversationId, usage, messages) {
  if (!conversationId) return;
  const threadText = messages.map(m => m.content).join("\n");
  await patch(`/chat/conversations/${encodeURIComponent(conversationId)}/usage`, {
    total_tokens: usage.promptTokens + usage.completionTokens,
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    message_count: messages.length,
    context_tokens: estimateTokens(threadText),
  }).catch(() => {});
}

async function takeColleagueMessages(employeeId) {
  try {
    const res = await post("/office/messages/take", { employeeId, limit: 10 });
    if (res?.code !== 0) return [];
    return Array.isArray(res.data?.items) ? res.data.items : [];
  } catch {
    return [];
  }
}

async function reportToOffice(job, employee, status, finalText, failure, settled, review = null) {
  if (review?.pending) {
    // 交付先进了审校那一队列，还没到用户手上：贴一条到动态流就好。
    // 不发给审校人的收件箱——他要判的那一份已经连正文排在给他的 job 里了，
    // 再递一遍就是把同一份正文喂两次窗口；也不记成用户的未读——那是一句还没交付的话。
    await post("/office/messages", {
      fromKind: "employee", fromId: employee.employeeId, fromName: employee.name,
      toKind: "broadcast", toId: "", toName: "", jobId: job.jobId,
      text: `${t("已交审校")} · ${employee.name} → ${review.reviewerName || t("审校人")}：`
        + `${String(finalText || "").slice(0, 200)}`,
    }).catch(() => {});
    return;
  }
  const text = status === "done" ? (finalText || t("这一趟没留下正文"))
    : status === "stopped" ? t("被停止")
      : status === "blocked" ? `${t("缺条件，做不了")}：${settled?.reason || ""}`
        : status === "dropped" ? `${t("这件事不该办")}：${settled?.reason || ""}`
          : (failure || t("没跑成"));
  await post("/office/messages", {
    fromKind: "employee", fromId: employee.employeeId, fromName: employee.name,
    toKind: "user", toId: "", toName: "", text, jobId: job.jobId,
  }).catch(() => {});
}

// ── 提示词 ──────────────────────────────────────

/** 名册那一段：同事的名字与工号都列出来，递话才知道写给谁 */
function rosterText(excludeId) {
  const others = board.employees.filter(e => e.employeeId !== excludeId);
  if (!others.length) return "";
  return `同事名册：\n${others.map(e => `- ${e.name}（${e.role || t("未填岗位")}，工号 ${e.employeeId}）`).join("\n")}`;
}

/**
 * 工作记忆那一段：只给他自己写的备忘，按「未闭环 / 卡住 / 已定论」三档，最近的几条。
 * 每条都带 note_id——不给 id，上一趟的 open 就永远划不掉，备忘只增不减，
 * 到上限后被裁掉的恰好是最早那几条还没办完的事。
 */
function memoryText(employeeId) {
  const mine = (Array.isArray(board.notes) ? board.notes : []).filter(n => n.employeeId === employeeId);
  if (!mine.length) return "";
  const sections = [
    [t("未闭环"), "open", 8],
    [t("受阻"), "blocked", 4],
    [t("已定论"), "ledger", 4],
  ];
  let used = 0;
  const parts = [];
  for (const [label, kind, limit] of sections) {
    const lines = [];
    for (const note of mine.filter(n => n.kind === kind).slice(-limit)) {
      const line = `- ${note.text}${note.ref ? `（${note.ref}）` : ""}｜id ${note.noteId}`;
      if (used + line.length > OFFICE_MEMORY_CHARS) break;
      used += line.length;
      lines.push(line);
    }
    if (lines.length) parts.push(`${label}：\n${lines.join("\n")}`);
    if (used > OFFICE_MEMORY_CHARS) break;
  }
  if (!parts.length) return "";
  return `你自己的备忘（上一趟留下的，不是别人交代的）：\n${parts.join("\n")}`;
}

function originLabel(origin) {
  return origin === "duty" ? t("值班表到点")
    : origin === "message" ? t("同事转述")
      : origin === "review" ? t("审校") : t("用户交办");
}

function fmtWhen(ms) {
  const n = Number(ms) || 0;
  if (!n) return "";
  const d = new Date(n);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function buildEmployeeSystemPrompt(employee) {
  const roster = rosterText(employee.employeeId);
  const memory = memoryText(employee.employeeId);
  return `你是 SLATE 办公室里的一名员工，名叫 ${employee.name}。
岗位：${employee.role || t("未填")}。
${employee.objective ? `目标：${employee.objective}\n` : ""}职责：
${employee.dutyText || t("按交代做的事负责到底。")}
${memory ? `\n${memory}\n` : ""}
工作纪律：
1. 这是一次独立交付：没有人会追问你，产出必须自包含、结论在前，能直接给人用。
2. 需要信息时主动调用工具，不要臆测；改动过什么就把位置写清楚。
3. 与同事说话只有一个通道：office_send(to, text)。to 填对方名字或工号，也可填 user（只说给用户）或 broadcast（贴到动态流）。
   递过去会排成一条新的活给对方，不必等回话；一次只递一件事，正文写要办什么或结论，不要贴过程。
4. 这件事不该你做、或缺条件做不了时，如实说缺什么，不要编造进度。
5. 上一趟的记忆靠 office_note(kind, text, ref, closeNoteId)：kind 填 open（还没办完）/ ledger（结论）/ blocked（卡在哪）。
   开工先照上面那段备忘走；一件事真办完了就记一条 ledger，并用 closeNoteId 划掉对应那条 open——留着它下一趟会再办一遍。
6. 办不下去用 office_settle(status, reason) 结班：blocked 是缺条件等人给，dropped 是你判定这件事不该办（必须写清为什么）。
   判「不该办」不会让它消失——它停在「等你拍板」，只有人点头才回队列。
${roster ? `\n${roster}\n` : ""}
${getToolsSystemPrompt({ minimal: true, officeRun: true })}`;
}

/**
 * 晨会分诊这一趟的正文：把他自己名下的待办列出来，让他排顺序、必要时判「不该办」。
 * 队列从内存快照里读，不再多打一次请求（面板判据里有「请求数」这一项）。
 */
function buildTriagePrompt(job, employee) {
  const pending = (Array.isArray(board.jobs) ? board.jobs : [])
    .filter(j => j.employeeId === employee.employeeId
      && (j.status === "queued" || j.status === "blocked")
      // 排给他的审校不进分诊名单：那是名册定的职责，不是「今天要不要办」的选项。
      // 判成不该办，被审的那份就永远拿不到结论——后端那一道也照样拒（两处口径对齐）。
      && j.kind !== "review"
      && String(j.jobId) !== String(job.jobId))
    .slice(0, OFFICE_TRIAGE_LIST);
  const head = `〔${t("晨会分诊")}〕${employee.name}，现在把手上的活过一遍，不是马上去做哪一件。`;
  if (!pending.length) {
    return `${head}\n\n此刻你名下一条待办都没有${job.brief ? `。这一班交代的是：\n\n${job.brief}` : ""}\n`
      + `就把这次分诊的结论用一句话说清（有什么、缺什么、接下来打算办什么），可以用 office_note 给自己留一条备忘。`;
  }
  const lines = pending.map(j => `- ${j.jobId}｜${String(j.brief || "").slice(0, 60)}`
    + `（${originLabel(j.origin)}${fmtWhen(j.enqueuedAtMs) ? `，${fmtWhen(j.enqueuedAtMs)}` : ""}`
    + `${Number(j.priority) ? `，优先级 ${j.priority}` : ""}`
    + `${j.stateReason ? `，${j.stateReason}` : ""}）`);
  return `${head}\n\n待办的活：\n${lines.join("\n")}
\n逐条想清楚哪些今天真该办，然后用一次 office_triage(decisions) 把处置交回来：
- keep：该办。priority 给 0-9（越大越先领），dueMs 只在真有期限时填毫秒时间戳。
- defer：先放着（改到明天，不占今天的顺序）。
- drop：判定这件事不该办，why 必填——它不会消失，会停在「等你拍板」等人选。
只处置上面列出的这些 job；正在做的这一条不在名单里，它就是这次判断的载体。`
    + `${job.brief ? `\n\n这一班还交代了：${job.brief}` : ""}`;
}

/**
 * 审校那一趟的正文：原件（交代 + 交付正文 + 怎么判）是后端排活时按名册拼好的，
 * 这里只补一句「你是替他过目，不是替他重做」。
 * 判定落库只有 office_review 一处，引擎不在这里发明第二种收口。
 */
function buildReviewPrompt(job, employee) {
  return `${String(job.brief || "")}\n\n`
    + `你是 ${employee.name}（${employee.role || t("未填")}）。这一趟只判合格与否：`
    + `不要重写他的交付，也不要替他补做——不合格就 office_review(verdict="return", note=要他改哪里)，`
    + `合格就 office_review(verdict="approve", note=写清你核过什么)。`;
}

function buildJobPrompt(job, employee, unread) {
  const inbox = (Array.isArray(unread) && unread.length)
    ? `\n\n未读同事消息（这些是同事说的，不是用户说的）：\n${unread.map(m => `- ${m.fromName}：${m.text}`).join("\n")}`
    : "";
  if (job.kind === "triage") return buildTriagePrompt(job, employee) + inbox;
  if (job.kind === "review") return buildReviewPrompt(job, employee) + inbox;
  return `〔${originLabel(job.origin)}〕这一条活交给 ${employee.name}：\n\n${job.brief}${inbox}\n\n现在就开始办。`
    + `\n\n（对照你自己的备忘：上一趟留了「未闭环」的，先看它这次能不能一起收掉；真收掉就划掉那条。）`;
}

// ── 停止口（唯一入口）──────────────────────────

export function stopOfficeJob(jobId) {
  const rec = running.get(String(jobId || ""));
  if (!rec) return false;
  rec.controller.abort();
  setLine(rec.jobId, t("已停止"));
  return true;
}

// 后台任务面板那颗「停止」按 origin 分流到这里：本地任务没有进程可杀
registerLocalTaskStopper(async (taskId) => {
  const id = String(taskId || "");
  if (!id.startsWith("office-")) return false;
  return stopOfficeJob(id.slice("office-".length));
});

export async function initOfficeEngine() {
  await refreshBoard();
  startOfficeEngine();
}
