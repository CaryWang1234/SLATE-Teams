/**
 * SLATE Teams 议事厅（与会者页）。
 *
 * 这一页只做三件事：看这一场说到哪了、轮到我时说话、告诉主持人我还在。
 * 它**不是**工作台的缩小版：会话由票据决定（后端按票据反查），请求里的 sessionId
 * 一概不作数；设置、文件、技能、别的会话都不在这张票的范围内（后端默认拒绝）。
 *
 * 说话是"递进收件箱"而不是直接插进发言流：轮次循环在主持人页面里跑，
 * team_turns 的写者唯一。所以这里发出去的话，会在轮到我那一席时被采纳。
 */

import { t, initI18n } from "../services/i18n.js?v=20261024-001";

const POLL_MS = 1500;
const HEARTBEAT_MS = 10000;
const ACTION_LABELS = [
  ["propose", "提案"], ["support", "支持"], ["oppose", "反对"],
  ["rebut", "反驳"], ["supplement", "补充"], ["verdict", "决策"],
];
const ACTION_TEXT = {
  propose: "提案", support: "支持", oppose: "反对", rebut: "反驳",
  supplement: "补充", verdict: "决策", error: "失败", skipped: "未参与",
  silent: "超时未发言", late: "补充",
};

const TOKEN = new URLSearchParams(window.location.search).get("slate_lan_token") || "";

let state = {
  me: null,            // { seatId, name, caps }
  session: null,       // 会话元信息（议题/状态/等待席位）
  members: [],         // 名册
  lastSeq: -1,         // 已经画出来的最大 seq（增量渲染）
  lastRound: 0,
  myPresence: "in",
  dead: false,         // 票据失效：停止一切轮询，只留一句提示
};

const el = (id) => document.getElementById(id);
const topbarMe = el("mh-me");
const banner = el("mh-banner");
const stream = el("mh-stream");
const composer = el("mh-composer");
const actionSelect = el("mh-action");
const targetSelect = el("mh-target");
const textArea = el("mh-text");
const sendBtn = el("mh-send");
const hint = el("mh-hint");
const presenceBtn = el("mh-presence");

function setBanner(text, mine = false) {
  if (!text) {
    banner.classList.add("hidden");
    banner.textContent = "";
    return;
  }
  banner.textContent = text;
  banner.classList.toggle("mine", !!mine);
  banner.classList.remove("hidden");
}

async function api(path, body) {
  const headers = { "Content-Type": "application/json" };
  if (TOKEN) headers["x-slate-lan-token"] = TOKEN;
  const opts = { headers, credentials: "same-origin" };
  if (body !== undefined) {
    opts.method = "POST";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`/api/teams/${path}`, opts);
  if (resp.status === 401 || resp.status === 403) {
    state.dead = true;
    throw new Error(t("票据已失效，请让主持人重新发一张"));
  }
  const data = await resp.json().catch(() => null);
  if (!data || data.code !== 0) throw new Error((data && data.message) || t("议事厅请求失败"));
  return data.data;
}

// ── 渲染 ────────────────────────────────────────────────

function actionLabel(action) {
  const key = ACTION_TEXT[action] || "";
  return key ? t(key) : t("提案");
}

function memberName(seatId) {
  const found = state.members.find(m => m.id === seatId);
  return found ? found.name : "";
}

function renderTurn(turn) {
  const wrap = document.createElement("div");
  wrap.className = "mh-turn" + (state.me && turn.memberId === state.me.seatId ? " mine" : "");

  const head = document.createElement("div");
  head.className = "mh-turn-head";
  const name = document.createElement("span");
  name.className = "mh-turn-name";
  name.textContent = turn.memberName || memberName(turn.memberId) || "?";
  head.appendChild(name);

  const badge = document.createElement("span");
  badge.className = "mh-turn-badge";
  badge.textContent = actionLabel(turn.action);
  head.appendChild(badge);

  if (turn.targetMemberId) {
    const target = document.createElement("span");
    target.className = "mh-turn-target";
    target.textContent = t("回应 {name}", { name: memberName(turn.targetMemberId) || turn.targetMemberId });
    head.appendChild(target);
  }
  wrap.appendChild(head);

  const body = document.createElement("div");
  body.className = "mh-turn-body";
  // 失败/缺席/超时是留痕不是发言：也说清楚，但别读成"某某的主张"
  if (turn.action === "error" || turn.action === "skipped" || turn.action === "silent") {
    body.className = "mh-notice";
  }
  body.textContent = turn.fullText || turn.digest || "";
  wrap.appendChild(body);
  stream.appendChild(wrap);
}

function renderStreamTurns(turns) {
  for (const turn of turns) {
    if (typeof turn.seq !== "number" || turn.seq <= state.lastSeq) continue;
    if (typeof turn.round === "number" && turn.round > state.lastRound) {
      state.lastRound = turn.round;
      const roundEl = document.createElement("div");
      // 终局那一格不是"第 N 轮"：它挂的 round 值是"最终决策"这个字符串
      roundEl.className = "mh-round";
      roundEl.textContent = typeof turn.round === "number"
        ? t("第 {n} 轮", { n: turn.round })
        : t("最终决策");
      stream.appendChild(roundEl);
    }
    renderTurn(turn);
    state.lastSeq = turn.seq;
  }
}

function renderTargets() {
  const others = state.members.filter(m => !state.me || m.id !== state.me.seatId);
  targetSelect.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = t("不指定");
  targetSelect.appendChild(none);
  for (const m of others) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    targetSelect.appendChild(opt);
  }
  targetSelect.classList.toggle("hidden", others.length === 0);
}

function renderHeader() {
  if (!state.me) return;
  topbarMe.textContent = `${state.me.name}`;
  presenceBtn.textContent = state.myPresence === "away" ? t("归位") : t("暂离");
  presenceBtn.setAttribute("aria-pressed", state.myPresence === "away" ? "true" : "false");
}

function render() {
  renderHeader();
  if (!state.session) {
    setBanner(t("等主持人开始"));
    composer.classList.add("hidden");
    stream.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "mh-notice";
    empty.textContent = t("暂无发言");
    stream.appendChild(empty);
    return;
  }
  composer.classList.remove("hidden");
  setBanner("");

  // 轮到我：这一条就是与会者唯一的"该我说话了"信号，其他都是提示
  const awaiting = state.session.awaitingSeatId || "";
  if (state.me && awaiting && awaiting === state.me.seatId) {
    setBanner(t("现在轮到你发言"), true);
  } else if (state.me && awaiting) {
    setBanner(t("等 {name} 发言…", { name: memberName(awaiting) || awaiting }));
  }

  const turns = state.session && Array.isArray(state.session.turns) ? state.session.turns : [];
  renderStreamTurns(turns);

  const last = turns.length ? turns[turns.length - 1] : null;
  if (last && last.action === "verdict" && state.session.status !== "decided") {
    hint.textContent = t("这一场的决策由主持人在他那台机器上签字");
  }
}

// ── 轮询与会话 ───────────────────────────────────────────

async function tick() {
  if (state.dead) return;
  try {
    const data = await api("session");
    state.me = data.me || state.me;
    state.members = Array.isArray(data.members) ? data.members : [];
    state.session = data.phase === "idle"
      ? null
      : Object.assign({}, data.session, {
          turns: Array.isArray(data.turns) ? data.turns : [],
          awaitingSeatId: (data.session && data.session.awaitingSeatId) || "",
        });
    if (!actionSelect.options.length) buildActionOptions();
    if (!targetSelect.options.length) renderTargets();
    render();
  } catch (e) {
    if (state.dead) {
      setBanner(String(e.message || e), true);
      composer.classList.add("hidden");
      return;
    }
    setBanner(t("连接中断，正在重试…"));
  } finally {
    if (!state.dead) setTimeout(tick, POLL_MS);
  }
}

function buildActionOptions() {
  actionSelect.innerHTML = "";
  for (const [value, label] of ACTION_LABELS) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = t(label);
    actionSelect.appendChild(opt);
  }
}

async function heartbeat() {
  if (state.dead) return;
  try {
    await api("presence", { state: state.myPresence });
  } catch (e) {
    if (state.dead) return;
  }
  setTimeout(heartbeat, HEARTBEAT_MS);
}

// ── 交互 ────────────────────────────────────────────────

async function send() {
  const text = textArea.value.trim();
  if (!text || state.dead) return;
  sendBtn.disabled = true;
  try {
    await api("say", {
      action: actionSelect.value || "propose",
      targetSeatId: targetSelect.value || "",
      text,
    });
    textArea.value = "";
    hint.textContent = t("发言会在轮到你时被采纳");
  } catch (e) {
    hint.textContent = String(e.message || e);
  } finally {
    sendBtn.disabled = false;
  }
}

function init() {
  buildActionOptions();
  renderTargets();
  sendBtn.addEventListener("click", send);
  textArea.addEventListener("keydown", (ev) => {
    // Ctrl/Cmd + Enter 发送；单独回车留给换行（手机上更长的话是常态）
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
      ev.preventDefault();
      send();
    }
  });
  presenceBtn.addEventListener("click", () => {
    state.myPresence = state.myPresence === "away" ? "in" : "away";
    renderHeader();
    heartbeat();
  });
  document.addEventListener("visibilitychange", () => {
    // 回到前台立刻说一声"我还在"：后台时定时器会被节流，不能让主持人误判成暂离
    if (!document.hidden) heartbeat();
  });
  if (!TOKEN) {
    setBanner(t("票据已失效，请让主持人重新发一张"), true);
    state.dead = true;
    return;
  }
  tick();
  heartbeat();
}

initI18n().catch(() => {}).finally(init);
