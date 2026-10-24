/**
 * 后台任务中心（右栏，与 TODOLIST 并列）。
 *
 * 这一栏存在的理由：模型被明确要求"起了任务就别轮询"——那模型不看的时候，人得看得见。
 * 面板读的是 services/bg_tasks.js 的快照（它按 3 秒轮询，没任务时退到 20 秒慢探），
 * 自己不发起任何请求，除了"展开某条任务的输出"这一下按需拉取。
 *
 * 三件事刻意做对：
 *   ① 没有任务时整栏隐藏（不留空壳占位），工具栏按钮同步置灰；
 *   ② 停止按钮只在 running 时出现——停一个早就结束的任务是空动作，按钮不该在；
 *   ③ 输出是"按需拉、只拉展开的那一条"，不然面板一显示就把所有任务的日志拉一遍。
 *
 * 多项目在册之后它是跨项目的：列表按项目分组，别的项目的任务在这里看得见也停得了
 * （进程本来就是后端全局管的），但要回到那个项目 / 那场会话才念得对——所以每行给的是
 * "切过去看"，不是"在这儿接着演"。
 */

import { state, notify } from "../store.js?v=20261024-001";
import { t } from "../services/i18n.js?v=20261024-001";
import { iconSvgEl } from "../services/icons.js?v=20261024-001";
import { get } from "../services/api.js?v=20261024-001";
import { switchToProject } from "../services/project_scene.js?v=20261024-001";
import { bgTasks, stopBgTask, clearFinishedBgTasks, peekBgEvents, bgInbox, startBgPolling, refreshBgTasks } from "../services/bg_tasks.js?v=20261024-001";
import { abortRun } from "../services/run_registry.js?v=20261024-001";

/** 展开的输出最多往回看多少行：面板是瞄一眼用的，不是完整日志阅读器 */
const TAIL_LINES = 200;

let panelEl = null;
/** 当前展开输出的任务 id（同时只有一个，避免一次拉一堆日志） */
let expandedId = "";
/** 展开的输出缓存：{ taskId: text }，轮询刷新时按展开项重拉 */
let outputCache = {};

function stateIcon(task) {
  if (task.state === "running") return "activity";
  if (task.state === "stopped") return "ban";
  if (task.state === "exited" && task.exit_code === 0) return "check";
  return "alert-triangle";
}

function stateText(task) {
  if (task.state === "running") return t("进行中");
  if (task.state === "stopped") return t("已停止");
  if (task.state === "exited") return task.exit_code === 0 ? t("已完成") : t("退出码 {n}", { n: task.exit_code });
  // 后端把非 0 退出单独记成 failed：跟"异常结束"分开报，否则"退出码 3"和"压根没跑起来"
  // 在面板上长得一模一样，想知道到底怎么了只能去翻日志
  if (task.state === "failed" && task.exit_code !== null && task.exit_code !== undefined) {
    return t("退出码 {n}", { n: task.exit_code });
  }
  return t("异常结束");
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function mountBgTaskPanel(el) {
  panelEl = el;
  if (!panelEl) return;
  startBgPolling();
  refreshBgTasks();
  renderBgTaskPanel();
}

/** 这一栏此刻有几行可看：后台进程与模型生成两类都算"有事"。
 *  判据只写这一处——面板展开、标题计数、按钮置灰过去各读各的：只有生成在跑而进程表
 *  为空时，面板撑开了行、按钮却按"没任务"死了，用户点不开也收不回；标题还会写「任务中心 0」。 */
function panelRows() {
  const tasks = bgTasks();
  const runs = Array.isArray(state.runs) ? state.runs : [];
  return {
    tasks,
    runs,
    count: tasks.length + runs.length,
    running: tasks.filter(x => x.state === "running").length
      + runs.filter(r => r.phase !== "queued").length,
  };
}

export function renderBgTaskPanel() {
  if (!panelEl) return;
  syncBgRailButton();
  const { tasks, runs, count, running } = panelRows();
  // 没有在册任务也没有在跑的生成才收起来：这一栏是"有事才出现"，不是常驻家具。
  if (!count || state.bgPanelOpen === false) {
    panelEl.classList.add("hidden");
    panelEl.innerHTML = "";
    return;
  }
  const unread = bgInbox().length + peekBgEvents().length;
  panelEl.classList.remove("hidden");
  panelEl.innerHTML = "";

  const header = document.createElement("div");
  header.className = "todo-panel-header";
  const title = document.createElement("span");
  title.className = "todo-panel-title";
  title.textContent = t("任务中心 {n}", { n: count })
    + (running ? t(" · 运行中 {n}", { n: running }) : "")
    + (unread ? t(" · 未读 {n}", { n: unread }) : "");
  const spacer = document.createElement("span");
  spacer.className = "bg-panel-spacer";
  const clearBtn = document.createElement("button");
  clearBtn.className = "bg-icon-btn";
  clearBtn.title = t("清掉已结束的记录（日志文件保留）");
  clearBtn.appendChild(iconSvgEl("x"));
  clearBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    expandedId = "";
    outputCache = {};
    await clearFinishedBgTasks();
    renderBgTaskPanel();
  });
  const toggle = document.createElement("span");
  toggle.className = "todo-toggle";
  toggle.textContent = "▾";
  header.append(title, spacer, clearBtn, toggle);
  header.addEventListener("click", () => {
    state.bgPanelOpen = false;
    notify("bgPanelOpen", false);
    renderBgTaskPanel();
  });
  panelEl.appendChild(header);

  const body = document.createElement("div");
  body.className = "todo-panel-body bg-task-body";
  for (const run of runs) body.appendChild(renderRunRow(run));
  for (const group of groupByProject(tasks)) {
    if (group.label) body.appendChild(renderGroupHead(group));
    for (const task of group.tasks) body.appendChild(renderRow(task));
  }
  panelEl.appendChild(body);
}

/**
 * 一场生成（模型正在跑的对话）在面板里占一行。
 * 它与后台进程的区别写在 label 上：生成是自己会结束的，进程要人管，
 * 所以排队中的那几行只有"等位置"的意思，没有停止按钮以外的动作。
 */
function renderRunRow(run) {
  const row = document.createElement("div");
  const queued = run.phase === "queued";
  row.className = "bg-task-item bg-run-item" + (queued ? " bg-run-queued" : " bg-task-running");
  row.dataset.runId = run.run_id;
  row.dataset.projectId = run.project_id || "";

  const head = document.createElement("div");
  head.className = "bg-task-head";
  const icon = document.createElement("span");
  icon.className = "bg-task-icon";
  icon.appendChild(iconSvgEl(queued ? "clock" : "activity"));
  const label = document.createElement("span");
  label.className = "bg-task-label";
  const conv = (Array.isArray(state.conversations) ? state.conversations : []).find(c => c?.id === run.conv_id);
  label.textContent = conv?.title || (run.conv_id ? t("进行中的对话") : t("新对话"));
  label.title = run.conv_id || "";
  const meta = document.createElement("span");
  meta.className = "bg-task-meta";
  meta.textContent = queued
    ? t("排队中")
    : t("生成中") + " · " + fmtDuration((Date.now() - (run.started_at || Date.now())) / 1000);
  head.append(icon, label, meta);

  const proj = document.createElement("div");
  proj.className = "bg-task-cmd";
  proj.textContent = `${projectNameOf(run.project_id)}${run.visible ? "" : t(" · 不在屏幕上")}`;
  head.appendChild(proj);

  const actions = document.createElement("div");
  actions.className = "bg-task-actions";
  if (run.conv_id) {
    const goBtn = document.createElement("button");
    goBtn.className = "bg-icon-btn bg-row-jump";
    goBtn.dataset.conversationId = run.conv_id;
    goBtn.title = t("去看这一场");
    goBtn.appendChild(iconSvgEl("message-circle"));
    goBtn.addEventListener("click", async () => {
      goBtn.disabled = true;
      try {
        const pid = String(run.project_id || "");
        if (pid && pid !== String(state.project?.project_id || "")) await switchToProject(pid);
        const { openConversation } = await import("./chat.js?v=20261024-001");
        await openConversation(run.conv_id);
      } finally {
        goBtn.disabled = false;
      }
    });
    actions.appendChild(goBtn);
  }
  if (!queued) {
    const stopBtn = document.createElement("button");
    stopBtn.className = "bg-icon-btn bg-icon-danger";
    stopBtn.title = t("停止这一场生成");
    stopBtn.appendChild(iconSvgEl("ban"));
    stopBtn.addEventListener("click", async () => {
      stopBtn.disabled = true;
      abortRun(run.run_id);
      renderBgTaskPanel();
    });
    actions.appendChild(stopBtn);
  }
  head.appendChild(actions);
  row.append(head, proj);
  return row;
}

function projectNameOf(projectId) {
  const pid = String(projectId || "");
  if (!pid) return t("未分类");
  const entry = (Array.isArray(state.projects) ? state.projects : []).find(p => p?.id === pid);
  return entry?.name || pid;
}

/** 在册项目里查名字；查不到（已移出册）也照 id 上记的那个路径尾巴显示，不让任务变成无主 */
function projectLabelOf(task) {
  const pid = String(task?.project_id || "");
  if (!pid) return "";
  const entry = (Array.isArray(state.projects) ? state.projects : []).find(p => p?.id === pid);
  return entry?.name || pid;
}

/** 按项目分组：当前视野那一组排最前，其余按名字。没有归属的任务单独一组垫底。 */
function groupByProject(tasks) {
  const activeId = String(state.project?.project_id || "");
  const buckets = new Map();
  for (const task of tasks) {
    const pid = String(task?.project_id || "");
    if (!buckets.has(pid)) buckets.set(pid, []);
    buckets.get(pid).push(task);
  }
  const groups = [...buckets.entries()].map(([pid, list]) => ({
    projectId: pid,
    label: pid || "__none__",
    name: projectLabelOf(list[0]) || (pid ? "" : t("未分类")),
    active: !!pid && pid === activeId,
    tasks: list,
  }));
  groups.sort((a, b) => (b.active - a.active) || String(a.name).localeCompare(String(b.name), "zh"));
  return groups.map(g => ({ ...g, label: g.active ? "" : g.name }));
}

function renderGroupHead(group) {
  const head = document.createElement("div");
  head.className = "bg-group-head";
  head.dataset.projectId = group.projectId || "";
  const name = document.createElement("span");
  name.className = "bg-group-name";
  name.textContent = group.name || t("未分类");
  name.title = group.projectId || "";
  head.appendChild(name);
  const count = document.createElement("span");
  count.className = "bg-group-count";
  count.textContent = String(group.tasks.length);
  head.appendChild(count);
  if (group.projectId) {
    const jump = document.createElement("button");
    jump.className = "bg-icon-btn bg-group-jump";
    jump.dataset.projectId = group.projectId;
    jump.title = t("切到该项目");
    jump.appendChild(iconSvgEl("folder"));
    jump.addEventListener("click", async () => {
      jump.disabled = true;
      const out = await switchToProject(group.projectId);
      if (!out?.ok) notify("bgTasks", bgTasks());
      await refreshBgTasks();
    });
    head.appendChild(jump);
  }
  return head;
}

function renderRow(task) {
  const row = document.createElement("div");
  row.className = "bg-task-item" + (task.state === "running" ? " bg-task-running" : "");
  row.dataset.taskId = task.task_id;

  const head = document.createElement("div");
  head.className = "bg-task-head";
  const icon = document.createElement("span");
  icon.className = "bg-task-icon";
  icon.appendChild(iconSvgEl(stateIcon(task)));
  const label = document.createElement("span");
  label.className = "bg-task-label";
  label.textContent = task.label || task.task_id;
  label.title = `${task.task_id}\n${task.command || ""}\n${task.log_path || ""}`;
  const meta = document.createElement("span");
  meta.className = "bg-task-meta";
  meta.textContent = `${stateText(task)} · ${fmtDuration(task.duration)}`;
  head.append(icon, label, meta);

  const cmd = document.createElement("div");
  cmd.className = "bg-task-cmd";
  cmd.textContent = task.command || "";
  cmd.title = task.command || "";

  const actions = document.createElement("div");
  actions.className = "bg-task-actions";
  const isLocal = task.origin === "local";
  const isTeam = task.family === "team";
  const logBtn = document.createElement("button");
  logBtn.className = "bg-icon-btn";
  // 本地任务（后台子代理批次、团队讨论）没有日志文件可看，展开读的是它自己存的结论
  logBtn.title = t(isTeam ? "看这场讨论的结论" : isLocal ? "看子代理结论" : "看输出（最近 {n} 行）", { n: TAIL_LINES });
  logBtn.appendChild(iconSvgEl("eye"));
  logBtn.addEventListener("click", () => toggleOutput(task.task_id));
  actions.appendChild(logBtn);
  if (isTeam) {
    // 团队讨论不新加一种行：同一张表里读的是同一份合并结果，只多给一个"回面板重看"的入口
    const teamBtn = document.createElement("button");
    teamBtn.className = "bg-icon-btn bg-row-team-jump";
    teamBtn.dataset.sessionId = String(task.task_id).slice("team:".length);
    teamBtn.title = t("在团队面板里重看这场讨论");
    teamBtn.appendChild(iconSvgEl("user"));
    teamBtn.addEventListener("click", async () => {
      teamBtn.disabled = true;
      try {
        const { openTeamConversation } = await import("../app.js?v=20261024-001");
        openTeamConversation?.();
        const sid = teamBtn.dataset.sessionId;
        const item = [...document.querySelectorAll(".team-history-item")].find(el => el.dataset.sessionId === sid);
        item?.click();
      } finally {
        teamBtn.disabled = false;
      }
    });
    actions.appendChild(teamBtn);
  }
  // 归属是别场会话的（多半在别的项目）：给一个"回到那场去看"的入口。
  // 就地"继续演"是不行的——那条对话的上下文不在这儿。
  const owner = String(task.conversation_id || "");
  if (owner && owner !== String(state.currentConversationId || "")) {
    const goBtn = document.createElement("button");
    goBtn.className = "bg-icon-btn bg-row-jump";
    goBtn.dataset.conversationId = owner;
    goBtn.title = t("回到起它的那场会话");
    goBtn.appendChild(iconSvgEl("message-circle"));
    goBtn.addEventListener("click", async () => {
      goBtn.disabled = true;
      try {
        const pid = String(task.project_id || "");
        if (pid && pid !== String(state.project?.project_id || "")) await switchToProject(pid);
        const { openConversation } = await import("./chat.js?v=20261024-001");
        await openConversation(owner);
      } finally {
        goBtn.disabled = false;
      }
    });
    actions.appendChild(goBtn);
  }
  if (task.state === "running") {
    const stopBtn = document.createElement("button");
    stopBtn.className = "bg-icon-btn bg-icon-danger";
    stopBtn.title = t(isTeam ? "停止这场讨论" : isLocal ? "停止这批子代理" : "停止任务（终止整棵进程树）");
    stopBtn.appendChild(iconSvgEl("ban"));
    stopBtn.addEventListener("click", async () => {
      stopBtn.disabled = true;
      await stopBgTask(task.task_id);
      renderBgTaskPanel();
    });
    actions.appendChild(stopBtn);
  }
  head.appendChild(actions);
  row.append(head, cmd);

  if (expandedId === task.task_id) {
    const pre = document.createElement("pre");
    pre.className = "bg-task-output";
    pre.textContent = outputCache[task.task_id] ?? t("读取中…");
    row.appendChild(pre);
  }
  return row;
}

async function toggleOutput(taskId) {
  if (expandedId === taskId) {
    expandedId = "";
    renderBgTaskPanel();
    return;
  }
  expandedId = taskId;
  renderBgTaskPanel();
  await fetchOutput(taskId);
  renderBgTaskPanel();
}

async function fetchOutput(taskId) {
  const local = bgTasks().find(x => x.task_id === taskId && x.origin === "local");
  if (local) {
    // 后台子代理批次活在页面里，没有 /bg-tasks 那条路由：结论就在任务对象上
    outputCache[taskId] = String(local.output || "").trim() || t("（这一批还没有结论）");
    return;
  }
  try {
    const res = await get(`/bg-tasks/${encodeURIComponent(taskId)}?tail_lines=${TAIL_LINES}`);
    const body = res?.code === 0 ? (res.data?.task?.output || "") : (res?.message || "");
    outputCache[taskId] = body.trim() || t("（暂无输出）");
  } catch (e) {
    outputCache[taskId] = t("读取失败：{msg}", { msg: e.message });
  }
}

/** 工具栏按钮与面板状态同步（描金=展开、置灰=没事可看、金点=有别处的消息没看） */
function syncBgRailButton() {
  const btn = document.getElementById("btn-bg-tasks");
  if (!btn) return;
  const { count, running } = panelRows();
  const unread = bgInbox().length;
  btn.disabled = !count;
  btn.classList.toggle("is-na", !count);
  btn.classList.toggle("rail-toggle-on", count > 0 && state.bgPanelOpen !== false);
  // 未读是小金点，不抢任务数那个位置：两个数各自有意义，挤成一个就都读不出来了
  btn.classList.toggle("has-unread", unread > 0);
  btn.setAttribute("aria-pressed", state.bgPanelOpen !== false ? "true" : "false");
  btn.title = (!count ? t("当前没有后台任务")
    : running ? t("后台任务 {n} 个（{m} 个运行中）", { n: count, m: running })
      : t("后台任务 {n} 个（都结束了）", { n: count }))
    + (unread ? t(" · {n} 条消息在别的会话没看", { n: unread }) : "");
  const label = btn.querySelector(".bg-rail-count");
  if (label) label.textContent = count ? String(count) : "";
}

/** 轮询把新快照推进来后重绘；展开中的那条顺手刷一次输出 */
export async function onBgTasksChanged() {
  if (expandedId) {
    const still = bgTasks().some(x => x.task_id === expandedId);
    if (!still) {
      expandedId = "";
      outputCache = {};
    } else {
      await fetchOutput(expandedId);
    }
  }
  renderBgTaskPanel();
}
