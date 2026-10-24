/**
 * SLATE 黑板 · 工作流视图
 *
 * 一屏三件事：这一场对话的**运行控制**（启停 / 续跑 / 自动推进 / 回复方式 / 思考档位）、
 * **可运行的流程说明书**（data/actions/*.yml，卡片人类可读、就地可操作）、
 * **团队星图**（分角色的真实历史，见 services/star_map.js）。
 *
 * 三条硬约束（都是这个仓库踩过的坑）：
 * 1. 绝不写 boardCards —— setBoardCards 的 notify 会连带 renderMermaid + renderBoardView
 *    整树重绘，运行中每秒一跳会把界面抖散。活数据只 patch 自己缓存的叶子节点。
 * 2. 状态只有 store 的 setter 能写：本模块不直接改 state.reasoningEffort / chatMode，
 *    与聊天框顶部的同款选择器共用同一份状态，两处控件一个真相。
 * 3. 运行现场由 chat.js 注入（wfApi），本模块不 import chat.js —— chat.js 已 import
 *    whiteboard.js，反向 import 会成环。
 */

import {
  state, subscribe, setModeFor, activeModeIdFor, modeRegistry, setReasoningEffort,
  reasoningCapabilityOf, reasoningLevelsOf, REASONING_COLLAPSED_CAPS,
} from "../store.js?v=20261024-001";
import { get } from "../services/api.js?v=20261024-001";
import { t } from "../services/i18n.js?v=20261024-001";
import { iconSvgEl } from "../services/icons.js?v=20261024-001";
import { renderStarMap, highlightStar, memberHue } from "../services/star_map.js?v=20261024-001";

const PREF_KEY = "slate_board_wf_prefs";
const TICK_MS = 1000;
const MAX_CARDS = 60;           // 视图只呈现有界的卡片墙，超出的走"显示更多"
const MAX_STEP_TEXT = 90;

/** 运行现场由 chat.js 注入：读它，不复制它 */
let wfApi = null;
let wfPrefs = loadPrefs();
let wfActions = [];
let wfActionsBroken = [];
let wfActionsLoaded = false;
let wfActionsProject = "";      // 这份缓存属于哪个项目视野（换项目要重取）
let wfStepsCache = new Map();   // actionId → steps[]（详情按需取，列表摘要里没有正文）
let wfTeam = { key: "", loading: false, data: null, error: "" };
let wfSelectedMember = null;
let wfTimer = 0;
let wfRafPending = false;

// 缓存的活节点：patch 只认这几个引用，视图重建时整体作废
let wfRefs = null;

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    return {
      pinned: Array.isArray(raw.pinned) ? raw.pinned.filter(x => typeof x === "string") : [],
      onlyPinned: raw.onlyPinned === true,
      expanded: Array.isArray(raw.expanded) ? raw.expanded : [],
    };
  } catch {
    return { pinned: [], onlyPinned: false, expanded: [] };
  }
}

function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(wfPrefs)); } catch { /* 隐私模式下静默 */ }
}

export function setWorkflowRunApi(api) {
  wfApi = api && typeof api.snapshot === "function" ? api : null;
}

function btn(label, title, onClick, extraClass = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `bw-btn ${extraClass}`.trim();
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener("click", (e) => { e.preventDefault(); onClick?.(b); });
  return b;
}

function chip(text, cls = "") {
  const s = document.createElement("span");
  s.className = `bw-chip ${cls}`.trim();
  s.textContent = text;
  return s;
}

// ── Action 目录与详情 ────────────────────────────────────

async function ensureActions(force = false) {
  // 目录是"全局 + 项目覆盖"合并后的那一份：换项目必须重取，缓存只属于取它时那个视野
  const pid = String(state.project?.project_id || "");
  if (wfActionsLoaded && !force && pid === wfActionsProject) return;
  try {
    const res = await get(`/actions${pid ? `?project=${encodeURIComponent(pid)}` : ""}`);
    if (res?.code === 0 && res.data) {
      wfActions = Array.isArray(res.data.actions) ? res.data.actions : [];
      wfActionsBroken = Array.isArray(res.data.broken) ? res.data.broken : [];
      wfActionsLoaded = true;
      wfActionsProject = pid;
      wfStepsCache.clear();   // 步骤正文也按视野缓存：同 id 在另一个项目里是另一份流程
      return;
    }
    // 后端给了非 0：退到内存快照，至少不空着一面墙
    wfActions = Array.isArray(state.actions) ? state.actions : [];
    wfActionsBroken = [];
    wfActionsLoaded = true;
    wfActionsProject = pid;
  } catch {
    wfActions = Array.isArray(state.actions) ? state.actions : [];
    wfActionsLoaded = false;
  }
}

async function loadSteps(actionId) {
  const cacheKey = `${String(state.project?.project_id || "")}|${actionId}`;
  if (wfStepsCache.has(cacheKey)) return wfStepsCache.get(cacheKey);
  try {
    const pid = String(state.project?.project_id || "");
    const res = await get(`/actions/${encodeURIComponent(actionId)}${pid ? `?project=${encodeURIComponent(pid)}` : ""}`);
    // 详情路由的返回是 {data:{action:完整 spec, raw, warnings}}
    const steps = res?.code === 0 ? (res.data?.action?.steps || []) : [];
    wfStepsCache.set(cacheKey, Array.isArray(steps) ? steps : []);
    return wfStepsCache.get(cacheKey);
  } catch {
    wfStepsCache.set(cacheKey, []);
    return [];
  }
}

// ── 团队数据（星图的真出处）────────────────────────────

async function ensureTeamData(conversationId) {
  const key = conversationId || "__none__";
  if (wfTeam.key === key && (wfTeam.data || wfTeam.error || wfTeam.loading)) return;
  wfTeam = { key, loading: true, data: wfTeam.key === key ? wfTeam.data : null, error: "" };
  try {
    const res = await get(`/events/team/latest?conversationId=${encodeURIComponent(conversationId || "")}`);
    if (res?.code === 0 && res.data?.session) {
      wfTeam = { key, loading: false, data: res.data, error: "" };
    } else {
      wfTeam = { key, loading: false, data: null, error: res?.message || "" };
    }
  } catch (e) {
    wfTeam = { key, loading: false, data: null, error: e?.message || "unreachable" };
  }
  if (wfRefs?.starBody?.isConnected && wfRefs.starBody.dataset.teamKey === key) {
    paintStarSection(wfRefs.starBody, key);
  }
}

// ── 卡片墙 ──────────────────────────────────────────────

function authorLabel(action) {
  return action.author === "model" ? t("模型编写") : t("用户编写");
}

function stepItem(s) {
  const li = document.createElement("li");
  const title = document.createElement("span");
  title.className = "bw-step-title";
  title.textContent = String(s?.title || "").slice(0, MAX_STEP_TEXT);
  li.appendChild(title);
  if (s?.tool) {
    const tool = document.createElement("em");
    tool.className = "bw-step-tool";
    tool.textContent = s.tool;
    li.appendChild(tool);
  }
  const detail = String(s?.detail || "").replace(/\s+/g, " ").trim();
  if (detail) {
    const p = document.createElement("span");
    p.className = "bw-step-detail";
    p.textContent = detail.slice(0, MAX_STEP_TEXT) + (detail.length > MAX_STEP_TEXT ? "…" : "");
    li.appendChild(p);
  }
  return li;
}

function actionCard(action) {
  const card = document.createElement("article");
  card.className = "bw-card";
  card.dataset.actionId = action.id;
  const pinned = wfPrefs.pinned.includes(action.id);
  if (pinned) card.classList.add("is-pinned");

  const head = document.createElement("header");
  head.className = "bw-card-head";
  const badge = document.createElement("span");
  badge.className = "bw-card-badge";
  badge.appendChild(iconSvgEl(pinned ? "star" : "zap"));
  const name = document.createElement("strong");
  name.textContent = action.name || action.id;
  name.title = `id: ${action.id}`;
  head.append(badge, name);
  card.appendChild(head);

  const desc = document.createElement("p");
  desc.className = "bw-card-desc";
  desc.textContent = action.description || t("（没写说明）");
  card.appendChild(desc);

  const chips = document.createElement("div");
  chips.className = "bw-card-chips";
  chips.append(chip(t("共 {n} 步", { n: Number(action.stepCount) || 0 })));
  if (Number(action.inputCount) > 0) chips.append(chip(t("{n} 项输入", { n: Number(action.inputCount) })));
  chips.append(chip(authorLabel(action), action.author === "model" ? "is-model" : "is-user"));
  const dest = String(action.outputDestination || "");
  if (dest) chips.append(chip(t("产出落到 {d}", { d: t(DEST_LABEL[dest] || dest) }), "is-dest"));
  for (const tag of (Array.isArray(action.tags) ? action.tags : []).slice(0, 3)) {
    chips.append(chip(`#${tag}`, "is-tag"));
  }
  card.appendChild(chips);

  const steps = document.createElement("ol");
  steps.className = "bw-card-steps hidden";
  card.appendChild(steps);

  // 展开即懒加载，收起不清空：反复点开同一张卡不该反复打后端
  let stepsLoaded = false;
  const openSteps = async (wantOpen) => {
    steps.classList.toggle("hidden", !wantOpen);
    if (!wantOpen || stepsLoaded) return;
    stepsLoaded = true;
    steps.innerHTML = "";
    const list = await loadSteps(action.id);
    if (!list.length) {
      const li = document.createElement("li");
      li.textContent = t("（这份说明书没有列出步骤）");
      steps.appendChild(li);
      return;
    }
    for (const s of list) steps.appendChild(stepItem(s));
  };

  const stepsBtn = btn(t("看步骤"), t("就地展开步骤清单"), async (b) => {
    const wantOpen = steps.classList.contains("hidden");
    await openSteps(wantOpen);
    b.textContent = wantOpen ? t("收起步骤") : t("看步骤");
    wfPrefs.expanded = wantOpen
      ? [...new Set([...wfPrefs.expanded, action.id])]
      : wfPrefs.expanded.filter(id => id !== action.id);
    savePrefs();
  });

  const actionsRow = document.createElement("div");
  actionsRow.className = "bw-card-actions";
  actionsRow.append(
    btn(t("运行此流程"), t("以 @提及 方式发进当前对话"), () => runAction(action), "bw-btn-primary"),
    btn(pinned ? t("取消置顶") : t("置顶"), t("置顶的卡片排在前面"), () => {
      wfPrefs.pinned = pinned
        ? wfPrefs.pinned.filter(id => id !== action.id)
        : [...wfPrefs.pinned, action.id];
      savePrefs();
      renderGrid(wfRefs?.grid);
    }),
    stepsBtn,
  );
  card.appendChild(actionsRow);

  // 上次展开着的卡片重建后仍是展开态（懒加载照跑，否则空列表会被读成"没有步骤"）
  if (wfPrefs.expanded.includes(action.id)) {
    stepsBtn.textContent = t("收起步骤");
    openSteps(true);
  }
  return card;
}

const DEST_LABEL = { message: "对话", file: "文件", board: "黑板" };

// 团队讨论的收尾方式（后端 team_sessions.status）
const TEAM_STATUS_LABEL = {
  running: "进行中", decided: "已拍板", stopped: "已中止", exhausted: "轮次用尽",
};

// 发言动作（team_turns.action 存的是英文键，图上要说人话）
const ACTION_LABEL = {
  propose: "提案", support: "支持", oppose: "反对", rebut: "反驳", supplement: "补充", verdict: "决策",
};

function runAction(action) {
  const api = wfApi;
  if (!api?.runAction) return;
  api.runAction(action.id, action.name || action.id);
}

function sortedActions() {
  const pinnedSet = new Set(wfPrefs.pinned);
  const list = wfPrefs.onlyPinned
    ? wfActions.filter(a => pinnedSet.has(a.id))
    : [...wfActions];
  list.sort((a, b) => {
    const d = (pinnedSet.has(b.id) ? 1 : 0) - (pinnedSet.has(a.id) ? 1 : 0);
    if (d !== 0) return d;
    return String(a.name || "").localeCompare(String(b.name || ""), "zh");
  });
  return list;
}

// ── 控制条 ──────────────────────────────────────────────

function buildRunBar() {
  const bar = document.createElement("div");
  bar.className = "bw-runbar";

  const phase = document.createElement("span");
  phase.className = "bw-phase";
  phase.textContent = t("空闲");
  const timer = document.createElement("span");
  timer.className = "bw-timer";
  bar.append(phase, timer);

  const spacer = document.createElement("span");
  spacer.className = "bw-runbar-spacer";
  bar.appendChild(spacer);

  const stop = btn(t("停止"), t("中断当前运行"), () => wfApi?.stop?.(), "bw-btn-stop");
  const resume = btn(t("继续跑完"), t("把剩下的活交回模型"), () => wfApi?.resume?.());
  const autopilot = btn(t("自动推进"), t("目标模式：自主推进直到收口"), () => wfApi?.toggleAutopilot?.());
  autopilot.classList.add("bw-btn-toggle");

  const modeSel = document.createElement("select");
  modeSel.className = "bw-select";
  modeSel.title = t("回复模式");
  // 只走 setter：输入框那颗胶囊与本控件共享同一份 state，改的是"这一场"的模式
  modeSel.addEventListener("change", () => setModeFor(state.currentConversationId, modeSel.value));

  const effortSel = document.createElement("select");
  effortSel.className = "bw-select";
  effortSel.title = t("思考强度");
  effortSel.addEventListener("change", () => {
    setReasoningEffort(effortSel.value);
    syncEffortOptions();
  });

  bar.append(stop, resume, autopilot, modeSel, effortSel);
  bar.append(
    btn(t("去团队"), t("到对话面板的团队模式"), async () => {
      const { openTeamConversation } = await import("../app.js?v=20261024-001");
      openTeamConversation?.();
    }),
  );

  wfRefs.phase = phase;
  wfRefs.timer = timer;
  wfRefs.stop = stop;
  wfRefs.resume = resume;
  wfRefs.autopilot = autopilot;
  wfRefs.modeSel = modeSel;
  wfRefs.effortSel = effortSel;
  syncModeOptions();
  return bar;
}

// 模式下拉的选项来自注册表（内置四个 + 自定义），增删模式后要重画：
// 用 id 串当签名，变了才重建，避免每次 tick 都动 DOM。
function syncModeOptions() {
  const sel = wfRefs?.modeSel;
  if (!sel) return;
  const all = modeRegistry();
  const sig = all.map(m => m.id).join("|");
  if (sel.dataset.sig === sig) return;
  sel.textContent = "";
  for (const m of all) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = t(m.label);
    sel.appendChild(o);
  }
  sel.dataset.sig = sig;
}

function syncEffortOptions() {
  const sel = wfRefs?.effortSel;
  if (!sel) return;
  const allowed = reasoningLevelsOf(state.currentModel) || ["auto"];
  const cap = reasoningCapabilityOf(state.currentModel);
  const want = allowed.includes(state.reasoningEffort) ? state.reasoningEffort : "auto";
  sel.innerHTML = "";
  for (const level of allowed) {
    const o = document.createElement("option");
    o.value = level;
    o.textContent = t(EFFORT_LABEL[level] || level);
    sel.appendChild(o);
  }
  sel.value = want;
  sel.disabled = allowed.length <= 1;
  sel.title = allowed.length <= 1
    ? t("当前端点不支持下发思考档位")
    : REASONING_COLLAPSED_CAPS.has(cap)
      ? t("该端点只区分开关：低/中/高都按「开」下发")
      : t("思考强度");
}

const EFFORT_LABEL = {
  auto: "自动（不下发）", off: "关", low: "低", medium: "中", high: "高",
};

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60), s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

// ── 活层：patch，不重绘 ─────────────────────────────────

function buildLiveSection() {
  const wrap = document.createElement("section");
  wrap.className = "bw-live";
  const head = document.createElement("h4");
  head.textContent = t("当前运行");
  const list = document.createElement("ol");
  list.className = "bw-live-list";
  wrap.append(head, list);
  wfRefs.liveHead = head;
  wfRefs.liveList = list;
  wfRefs.liveStepEls = new Map();
  return wrap;
}

function liveSig(steps) {
  return steps.map(s => s.callId).join("|");
}

/** 只改文本与 class：整棵活层不重建，卡上的 dataset 身份保持不变 */
function patchWorkflowLive() {
  const refs = wfRefs;
  if (!refs?.phase?.isConnected) return;
  const snap = (wfApi?.snapshot ? wfApi.snapshot() : null) || {};
  const busy = Boolean(snap.busy);

  const done = snap.finished?.exitKind === "done";
  let phase = t("空闲");
  let cls = "is-idle";
  if (busy) {
    phase = t("运行中 · 第 {n} 轮", { n: Number(snap.round) || 1 });
    cls = "is-running";
  } else if (snap.finished) {
    phase = done ? t("已完成") : t("已中断");
    cls = done ? "is-done" : "is-stopped";
  }
  if (refs.phase.textContent !== phase) refs.phase.textContent = phase;
  refs.phase.className = `bw-phase ${cls}`;
  refs.phase.title = snap.finished?.exitReason || "";
  const elapsedMs = snap.startedAtMs ? Date.now() - snap.startedAtMs : 0;
  refs.timer.textContent = elapsedMs && (busy || !snap.finished)
    ? `${t("用时")} ${fmtElapsed(elapsedMs)}`
    : snap.finished?.wallMs ? `${t("用时")} ${fmtElapsed(snap.finished.wallMs)}` : "";

  refs.stop.disabled = !busy;
  refs.resume.disabled = !wfApi?.canResume?.();
  refs.autopilot.classList.toggle("is-on", state.harness?.enabled === true);
  refs.autopilot.textContent = state.harness?.enabled === true ? t("自动推进 · 开") : t("自动推进 · 关");
  const activeMode = activeModeIdFor(state.currentConversationId);
  syncModeOptions();
  if (refs.modeSel && refs.modeSel.value !== activeMode) refs.modeSel.value = activeMode;
  syncEffortOptions();

  const steps = Array.isArray(snap.steps) ? snap.steps : [];
  if (!steps.length) {
    // 空态也要有一句话：留着上一步的列表不删，会把"这一场没跑过"读成"还在跑上一场"
    const wantHint = busy ? t("本轮还在思考，尚未调用工具")
      : snap.finished ? t("上一场运行没有调用工具") : t("本场还没有运行记录");
    refs.liveSig = "";
    let hint = refs.liveList.querySelector(".bw-live-empty");
    if (!hint || refs.liveList.childElementCount > 1 || refs.liveStepEls.size) {
      refs.liveList.innerHTML = "";
      refs.liveStepEls.clear();
      hint = null;
    }
    if (!hint) {
      hint = document.createElement("li");
      hint.className = "bw-live-empty";
      refs.liveList.appendChild(hint);
    }
    if (hint.textContent !== wantHint) hint.textContent = wantHint;
    refs.liveHead.textContent = t("当前运行");
    return;
  }
  const running = steps.filter(s => s.status === "running").length;
  refs.liveHead.textContent = `${t("当前运行")} · ${steps.length - running}/${steps.length}`;

  if (liveSig(steps) !== refs.liveSig) {
    refs.liveSig = liveSig(steps);
    refs.liveList.innerHTML = "";
    refs.liveStepEls.clear();
    for (const s of steps) {
      const li = document.createElement("li");
      li.className = "bw-live-step";
      li.dataset.callId = s.callId;
      const dot = document.createElement("span");
      dot.className = "bw-live-dot";
      const label = document.createElement("strong");
      label.textContent = s.label || s.tool || s.callId;
      const tool = document.createElement("em");
      tool.textContent = s.tool || "";
      const status = document.createElement("span");
      status.className = "wf-live-status";
      const elapsed = document.createElement("span");
      elapsed.className = "wf-live-elapsed";
      li.append(dot, label, tool, status, elapsed);
      refs.liveList.appendChild(li);
      refs.liveStepEls.set(s.callId, { li, status, elapsed });
    }
  }
  const now = Date.now();
  for (const s of steps) {
    const rec = refs.liveStepEls.get(s.callId);
    if (!rec) continue;
    const wantClass = `bw-live-step is-${s.status || "running"}`;
    if (rec.li.className !== wantClass) rec.li.className = wantClass;
    const wantStatus = s.status === "running" ? t("进行中")
      : s.status === "error" || s.status === "failed" ? t("失败")
        : s.status === "cancelled" ? t("已取消") : t("完成");
    if (rec.status.textContent !== wantStatus) rec.status.textContent = wantStatus;
    const wantElapsed = s.status === "running"
      ? fmtElapsed(Math.max(0, now - (refs.liveStartedAt?.[s.callId] || now)))
      : s.durationMs ? fmtElapsed(s.durationMs) : "";
    if (rec.elapsed.textContent !== wantElapsed) rec.elapsed.textContent = wantElapsed;
  }
}

// 步骤首次出现时记下起点，之后每秒只算差值（账本里 running 步没有 durationMs）
function noteLiveStarts(steps) {
  const refs = wfRefs;
  if (!refs) return;
  refs.liveStartedAt = refs.liveStartedAt || {};
  const seen = new Set(steps.map(s => s.callId));
  for (const s of steps) {
    if (s.status === "running" && !refs.liveStartedAt[s.callId]) refs.liveStartedAt[s.callId] = Date.now();
  }
  for (const callId of Object.keys(refs.liveStartedAt)) {
    if (!seen.has(callId)) delete refs.liveStartedAt[callId];
  }
}

function schedulePatch() {
  if (wfRafPending) return;
  wfRafPending = true;
  requestAnimationFrame(() => {
    wfRafPending = false;
    const snap = wfApi?.snapshot ? wfApi.snapshot() : null;
    noteLiveStarts(Array.isArray(snap?.steps) ? snap.steps : []);
    patchWorkflowLive();
  });
}

export function startWorkflowTick() {
  stopWorkflowTick();
  wfTimer = setInterval(schedulePatch, TICK_MS);
  schedulePatch();
}

export function stopWorkflowTick() {
  if (wfTimer) clearInterval(wfTimer);
  wfTimer = 0;
}

// ── 星图区 ──────────────────────────────────────────────

function buildStarSection() {
  const wrap = document.createElement("section");
  wrap.className = "bw-star";
  const body = document.createElement("div");
  body.className = "bw-star-body";
  wrap.appendChild(body);
  wfRefs.starBody = body;
  return wrap;
}

function paintStarSection(body, key) {
  body.innerHTML = "";
  body.dataset.teamKey = key;
  if (wfTeam.loading) {
    const p = document.createElement("p");
    p.className = "bw-hint";
    p.textContent = t("正在读取团队记录…");
    body.appendChild(p);
    return;
  }
  const data = wfTeam.data;
  if (!data?.members?.length) {
    const p = document.createElement("p");
    p.className = "bw-hint";
    p.textContent = t("本场对话还没有团队记录");
    body.appendChild(p);
    const tip = document.createElement("p");
    tip.className = "bw-hint bw-hint-sub";
    tip.textContent = t("在对话面板点「团队」即可发起多角色讨论，讨论过程会记录在此");
    body.appendChild(tip);
    return;
  }
  const head = document.createElement("h4");
  head.className = "bw-star-head";
  const members = data.members.map(m => ({ ...m, hue: Number.isFinite(Number(m.hue)) ? Number(m.hue) : memberHue(m.id) }));
  head.textContent = `${t("团队星图")} · ${t("{n} 位成员", { n: members.length })} · ${t("共 {n} 轮", { n: Number(data.session?.rounds) || 0 })}`;
  // 这场讨论怎么收的尾也标出来：星图只讲结构，结没结束看这一格
  const statusText = TEAM_STATUS_LABEL[String(data.session?.status || "")];
  if (statusText) head.appendChild(chip(t(statusText), "is-status"));
  body.appendChild(head);

  const stage = document.createElement("div");
  stage.className = "bw-star-stage";
  const svg = renderStarMap(stage, { ...data, members }, {
    onSelect: (id) => {
      wfSelectedMember = id;
      highlightStar(stage.querySelector("svg"), id);
      paintMemberTurns(detail, id, data);
    },
  });
  body.appendChild(stage);

  const detail = document.createElement("div");
  detail.className = "bw-star-detail";
  body.appendChild(detail);
  paintMemberTurns(detail, wfSelectedMember, data);
}

function paintMemberTurns(detail, memberId, data) {
  detail.innerHTML = "";
  const turns = (Array.isArray(data.turns) ? data.turns : [])
    .filter(x => !memberId || x.memberId === memberId)
    .slice(-12);
  const title = document.createElement("h5");
  const who = memberId ? (data.members.find(m => m.id === memberId)?.name || memberId) : t("全部成员");
  title.textContent = memberId ? `${t("发言序列")} · ${who}` : t("最近发言");
  detail.appendChild(title);
  if (!turns.length) {
    const p = document.createElement("p");
    p.className = "bw-hint";
    p.textContent = t("这一位还没有发言记录");
    detail.appendChild(p);
    return;
  }
  const list = document.createElement("ul");
  list.className = "bw-turns";
  for (const turn of turns) {
    const li = document.createElement("li");
    const round = document.createElement("span");
    round.className = "bw-turn-round";
    round.textContent = Number(turn.round) > 0 ? t("第 {n} 轮", { n: Number(turn.round) }) : t("收尾");
    const name = document.createElement("strong");
    name.textContent = turn.memberName || "";
    const text = document.createElement("span");
    text.className = "bw-turn-text";
    text.textContent = String(turn.digest || "").replace(/\s+/g, " ").slice(0, MAX_STEP_TEXT);
    li.append(round, name, text);
    if (turn.action) li.appendChild(chip(t(ACTION_LABEL[turn.action] || turn.action), "is-tag"));
    list.appendChild(li);
  }
  detail.appendChild(list);
}

// ── 主渲染 ──────────────────────────────────────────────

function appendBroken(grid) {
  if (!wfActionsBroken.length) return;
  const warn = document.createElement("p");
  warn.className = "bw-hint bw-hint-warn";
  warn.textContent = t("有 {n} 份说明书解析失败，请在工厂查看行号报错", { n: wfActionsBroken.length });
  grid.appendChild(warn);
}

function renderGrid(grid) {
  if (!grid) return;
  grid.innerHTML = "";
  const list = sortedActions();
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "bw-hint";
    p.textContent = wfActionsLoaded
      ? t("还没有流程说明书：在工厂的 Actions 中新建，或让模型用 actions_write 生成")
      : t("读不到 Action 目录（后端未就绪？）");
    grid.appendChild(p);
    appendBroken(grid);
    return;
  }
  for (const action of list.slice(0, MAX_CARDS)) grid.appendChild(actionCard(action));
  if (list.length > MAX_CARDS) {
    const more = document.createElement("p");
    more.className = "bw-hint";
    more.textContent = t("另有 {n} 条未显示，用「只看置顶」收窄", { n: list.length - MAX_CARDS });
    grid.appendChild(more);
  }
  // 坏文件跟着卡片墙走：任何一次重绘（置顶、只看置顶、刷新）都不该让它那句提示消失
  appendBroken(grid);
}

/**
 * 渲染工作流视图。container 是 #board-view-panel（头部由 whiteboard.js 建好并保留），
 * metaEl 是头部那格计数文案。
 * 只接管自己那棵 .bw-root：clear container 会把视图切换条与全屏按钮的宿主一起抹掉。
 */
export async function renderWorkflowView(container, metaEl) {
  if (!container) return;
  container.querySelector(":scope > .bw-root")?.remove();
  const root = document.createElement("div");
  root.className = "bw-root";
  container.appendChild(root);
  wfRefs = { root, liveStepEls: new Map(), liveSig: "", liveStartedAt: {} };

  root.appendChild(buildRunBar());

  const toolbar = document.createElement("div");
  toolbar.className = "bw-toolbar";
  const title = document.createElement("strong");
  title.textContent = t("可运行的流程");
  const onlyPinned = btn(
    wfPrefs.onlyPinned ? t("只看置顶") : t("全部流程"),
    t("把卡片墙收窄到置顶的几条"),
    (b) => {
      wfPrefs.onlyPinned = !wfPrefs.onlyPinned;
      savePrefs();
      b.textContent = wfPrefs.onlyPinned ? t("只看置顶") : t("全部流程");
      b.classList.toggle("is-on", wfPrefs.onlyPinned);
      renderGrid(wfRefs.grid);
    },
  );
  onlyPinned.classList.toggle("is-on", wfPrefs.onlyPinned);
  const reload = btn(t("刷新"), t("重新读取 Action 目录与团队记录"), async () => {
    await ensureActions(true);
    wfTeam = { key: "", loading: false, data: null, error: "" };
    renderGrid(wfRefs.grid);
    await ensureTeamData(wfApi?.conversationId?.() || "");
  });
  toolbar.append(title, onlyPinned, reload);
  root.appendChild(toolbar);

  const grid = document.createElement("div");
  grid.className = "bw-grid";
  root.appendChild(grid);
  wfRefs.grid = grid;
  renderGrid(grid);

  root.appendChild(buildLiveSection());
  root.appendChild(buildStarSection());

  if (metaEl) metaEl.textContent = t("{n} 条流程", { n: wfActions.length });

  await ensureActions();
  renderGrid(grid);
  if (metaEl) metaEl.textContent = t("{n} 条流程", { n: wfActions.length });
  paintStarSection(wfRefs.starBody, wfApi?.conversationId?.() || "__none__");
  await ensureTeamData(wfApi?.conversationId?.() || "");
  patchWorkflowLive();
}

let wfWired = false;
export function initBoardWorkflow() {
  if (wfWired) return;
  wfWired = true;
  // 模型换了，可选档位集合也换了：控制条上的档位要跟着重算（写状态的仍是 store）
  subscribe("model", () => { if (wfRefs?.root?.isConnected) syncEffortOptions(); });
  // 聊天框那侧改了档位（或回落）也要重画本视图的下拉：两边共用同一个 state
  subscribe("reasoningEffort", () => { if (wfRefs?.root?.isConnected) syncEffortOptions(); });
  subscribe("chatMode", () => { if (wfRefs?.root?.isConnected) patchWorkflowLive(); });
}
