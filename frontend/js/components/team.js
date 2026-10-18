/**
 * SLATE AI 团队组件：多模型协作讨论
 * 轻量模型初步讨论，重型模型最终决策。
 *
 * 除本机 localStorage 历史外，一次讨论还按"每次发言 = 一行 team_turns + 一个事件账本 run"
 * 落到后端（/events/team/append），黑板工作流视图的团队星图读的就是这份。
 * 落库全程 fire-and-forget：讨论本身不依赖后端，写失败只 warn，
 * 历史仍在，只是这场讨论画不进星图（列表里标"仅本机记录"）。
 */

import { state, subscribe, getModelKey, hasModelKey, estimateTokens, addBoardCard, getModelDefinition, permissionModeFor } from "../store.js?v=20261017-001";
import { notifyTaskComplete } from "../services/notify.js?v=20261017-001";
import { dlgChoice } from "../services/dialog.js?v=20261017-001";
import { upsertLocalTask, pushLocalBgEvent, registerLocalTaskStopper } from "../services/bg_tasks.js?v=20261017-001";
import { streamChat, post, get } from "../services/api.js?v=20261017-001";
import { detectToolCalls, stripToolCalls, executeToolCalls, getToolsSystemPrompt } from "../services/tools.js?v=20261017-001";
import { openRun as openLedgerRun } from "../services/agent_ledger.js?v=20261017-001";
import { memberHue } from "../services/star_map.js?v=20261017-001";
import { renderMarkdown } from "../services/markdown.js?v=20261017-001";
import { loadWorkflows, getWorkflow, runWorkflow, stopWorkflow, saveRunToKnowledge } from "../services/workflow.js?v=20261017-001";
import { getExpert, buildExpertPrompt } from "../services/experts.js?v=20261017-001";
import { getExpertsCached } from "./experts.js?v=20261017-001";
import { t } from "../services/i18n.js?v=20261017-001";
import { makeId } from "../services/utils.js?v=20261017-001";

// 当模型列表加载完成后，重新渲染团队成员（填充下拉选项）
subscribe("modelRegistry", () => renderTeamMembers());

let teamMembersArea, teamTopicInput, btnStartDiscuss, teamOutput, btnAddMember;
let teamHistoryList, teamUsageBar, btnNewTeamDiscussion, btnStopDiscuss;

// 团队升为顶层页签后，"这一场是不是用户眼前跑着的"由 .panel.active 判，
// 不再是过去的 .hidden。两处背后跑完才补通知/响铃的判断都走这里。
function teamPanelVisible() {
  return !!document.getElementById("panel-team")?.classList.contains("active");
}
let teamMembers = [];
let teamHistory = [];
// seatId → { name, online, state }：主持人这边的在线提示，只在面板可见时刷新
let teamPresence = new Map();
let currentTeamUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, messageCount: 0 };
let isDiscussing = false;
let maxRounds = 5;
let teamSignoffOn = true;
let discussAbortController = null;
const TEAM_HISTORY_KEY = "slate_team_history";
// 人不签字就重开的次数上限：每重开一轮是全员一次真实开销，没有闸就变成无限辩论
const TEAM_REOPEN_CAP = 2;
// 事件尾巴带多少字给模型看：够读回那句决策，又不占满唤醒载荷
const TEAM_TAIL_BUDGET = 300;

// ── 席位（Teams 期把"成员"升级成席位）────────────────────
//
// 席位有两种来源，其余字段完全同构——星图、@ 定位、动作语法、账本都不区分它们：
//   ai    : 发言来自一个模型（原来的行为）
//   human : 发言由真人写，经后端收件箱递进来（见 awaitHumanTurn）
const SEAT_KINDS = ["ai", "human"];
// 人类席位超时怎么办：delegate = 让 AI 替这个席位代笔（留痕标"代笔"）、skip = 跳过并留痕、wait = 一直等
const SEAT_FALLBACKS = ["delegate", "skip", "wait"];
const SEAT_DEFAULT_TIMEOUT_SEC = 120;
const SEAT_MIN_TIMEOUT_SEC = 10;
const SEAT_MAX_TIMEOUT_SEC = 1800;
// 等真人发言时的收件箱轮询间隔：一秒一次足够（局域网），也不用 SSE 那一套常驻连接
const INBOX_POLL_MS = 1000;
const TEAM_DEVICE_KEY = "slate_teams_device_id";

/** 这台设备的标识：邀请与归属要记"是哪台机器"，但不必是账号 */
function hostDeviceId() {
  try {
    let id = localStorage.getItem(TEAM_DEVICE_KEY);
    if (!id) {
      id = "dev_" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(TEAM_DEVICE_KEY, id);
    }
    return id;
  } catch (e) {
    return "";
  }
}

function clampTimeoutSec(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return SEAT_DEFAULT_TIMEOUT_SEC;
  return Math.min(SEAT_MAX_TIMEOUT_SEC, Math.max(SEAT_MIN_TIMEOUT_SEC, Math.round(n)));
}

/**
 * 席位补默认值。老名册（localStorage 里的历史场次、内置预设）没有 kind 这些字段，
 * 读回来一律按 ai 认——那之前的成员本来就都是模型。
 */
function normalizeSeat(raw) {
  const seat = { ...(raw || {}) };
  seat.id = String(seat.id || "");
  seat.name = String(seat.name || "");
  seat.role = seat.role || "member";
  seat.kind = SEAT_KINDS.includes(seat.kind) ? seat.kind : "ai";
  seat.fallback = SEAT_FALLBACKS.includes(seat.fallback) ? seat.fallback : "delegate";
  seat.timeoutSec = clampTimeoutSec(seat.timeoutSec);
  seat.caps = Array.isArray(seat.caps) ? seat.caps.filter(c => typeof c === "string") : [];
  if (seat.kind === "human") {
    // 人类席位没有模型，也没有人格设定；caps 至少要有发言
    seat.modelId = "";
    seat.persona = "";
    seat.caps = seat.caps.length ? seat.caps : ["speak"];
  } else {
    seat.caps = [];
  }
  seat.proxyModelId = String(seat.proxyModelId || "");
  return seat;
}

// ── 默认团队成员 ────────────────────────────

const DEFAULT_MEMBERS = [
  { id: "member-1", name: "分析师", modelId: "deepseek-flash", persona: "你是务实派分析师。关注可行性和成本，回答简洁（1-3句）。", role: "analyst" },
  { id: "member-2", name: "创意官", modelId: "gemini-3.6-flash", persona: "你是创意导向的思考者。关注创新可能性和用户体验，回答简洁（1-3句）。", role: "creative" },
  { id: "member-3", name: "决策者", modelId: "gpt-5.6-sol", persona: "你是最终决策者。综合各方观点给出明确建议和理由，回答简洁（1-3句）。", role: "decider" },
];

// ── 团队预设 ────────────────────────────

const TEAM_PRESETS = [
  {
    "id": "classic",
    "name": "经典三人组",
    "desc": "分析师 + 创意者 + 决策者",
    "members": [
      {
        "name": "分析师",
        "modelId": "deepseek-flash",
        "persona": "你是务实派分析师。关注可行性和成本，回答简洁（1-3句）。",
        "role": "analyst"
      },
      {
        "name": "创意者",
        "modelId": "gemini-3.6-flash",
        "persona": "你是创意导向的思考者。关注创新可能性和用户体验，回答简洁（1-3句）。",
        "role": "creative"
      },
      {
        "name": "决策者",
        "modelId": "gpt-5.6-sol",
        "persona": "你是最终决策者。综合各方观点给出明确建议和理由，回答简洁（1-3句）。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "code-review",
    "name": "代码审查组",
    "desc": "安全专家 + 性能专家 + 架构师",
    "members": [
      {
        "name": "安全专家",
        "modelId": "deepseek-flash",
        "persona": "你是安全审计专家。专注代码安全漏洞、注入风险、敏感信息泄露，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "性能专家",
        "modelId": "gemini-3.6-flash",
        "persona": "你是性能优化专家。关注算法复杂度、内存泄漏、并发问题，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "架构师",
        "modelId": "gpt-5.6-sol",
        "persona": "你是资深架构师。关注代码结构、设计模式、可维护性，综合给出改进方案。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "product-brainstorm",
    "name": "产品头脑风暴",
    "desc": "产品经理 + 设计师 + 用户代言 + 技术负责人",
    "members": [
      {
        "name": "产品经理",
        "modelId": "gemini-3.6-flash",
        "persona": "你是资深产品经理。关注用户价值、市场定位和商业可行性，回答简洁。",
        "role": "creative"
      },
      {
        "name": "设计师",
        "modelId": "deepseek-flash",
        "persona": "你是交互设计师。关注用户体验、信息架构和视觉层次，回答简洁。",
        "role": "creative"
      },
      {
        "name": "用户代言",
        "modelId": "kimi-k2.7-code",
        "persona": "你代表终端用户发声。关注易用性、学习成本和真实使用场景，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "技术负责人",
        "modelId": "gpt-5.6-sol",
        "persona": "你是技术负责人。综合产品、设计、用户视角给出技术可行方案和优先级。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "tech-selection",
    "name": "技术选型",
    "desc": "前端专家 + 后端专家 + 基础设施专家",
    "members": [
      {
        "name": "前端专家",
        "modelId": "deepseek-flash",
        "persona": "你是前端技术专家。从框架生态、开发体验、性能角度评估技术方案，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "后端专家",
        "modelId": "gemini-3.6-flash",
        "persona": "你是后端技术专家。从可扩展性、维护成本、社区成熟度角度评估技术方案，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "基础设施专家",
        "modelId": "kimi-k2.7-code",
        "persona": "你是基础设施专家。从部署运维、监控告警、成本角度评估技术方案，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "技术总监",
        "modelId": "gpt-5.6-sol",
        "persona": "你是技术总监。综合前端、后端、基础设施的意见，给出最终技术选型建议和理由。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "red-blue",
    "name": "红蓝对抗",
    "desc": "正方辩手 + 反方辩手 + 裁判",
    "members": [
      {
        "name": "正方辩手",
        "modelId": "gemini-3.6-flash",
        "persona": "你是正方辩手。积极论证方案的可行性、优势和价值，用事实和逻辑支撑，回答简洁。",
        "role": "creative"
      },
      {
        "name": "反方辩手",
        "modelId": "deepseek-flash",
        "persona": "你是反方辩手。尖锐质疑方案的漏洞、风险和盲点，用反例和数据反驳，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "裁判",
        "modelId": "gpt-5.6-sol",
        "persona": "你是公正的裁判。听取正反双方论点，裁定谁的论证更有说服力，给出平衡的结论。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "fullstack-review",
    "name": "全栈评审",
    "desc": "前端 + 后端 + 数据库 + 运维",
    "members": [
      {
        "name": "前端评审",
        "modelId": "deepseek-flash",
        "persona": "你负责前端评审。关注组件设计、状态管理、渲染性能和可访问性，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "后端评审",
        "modelId": "gemini-3.6-flash",
        "persona": "你负责后端评审。关注 API 设计、业务逻辑、错误处理和安全性，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "数据库评审",
        "modelId": "kimi-k2.7-code",
        "persona": "你负责数据层评审。关注数据模型、查询效率、索引策略和数据一致性，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "运维评审",
        "modelId": "deepseek-flash",
        "persona": "你负责运维评审。关注部署流程、日志监控、容灾恢复和成本，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "技术总监",
        "modelId": "gpt-5.6-sol",
        "persona": "你是技术总监。综合各层评审意见，给出最终改进方案和优先级排序。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "writing-workshop",
    "name": "写作工坊",
    "desc": "内容策划 + 文案写手 + 编辑",
    "members": [
      {
        "name": "内容策划",
        "modelId": "gemini-3.6-flash",
        "persona": "你是内容策划。负责确定主题、受众、核心论点和内容结构，回答简洁。",
        "role": "creative"
      },
      {
        "name": "文案写手",
        "modelId": "deepseek-flash",
        "persona": "你是文案写手。负责文字表达、修辞润色和节奏把控，回答简洁。",
        "role": "creative"
      },
      {
        "name": "编辑",
        "modelId": "gpt-5.6-sol",
        "persona": "你是资深编辑。负责质量把关、逻辑校对和整体改进建议，综合给出最终版本。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "startup-advisory",
    "name": "创业顾问团",
    "desc": "市场顾问 + 技术顾问 + 财务顾问 + 运营顾问",
    "members": [
      {
        "name": "市场顾问",
        "modelId": "gemini-3.6-flash",
        "persona": "你是市场营销顾问。关注目标市场、获客策略、品牌定位和竞争分析，回答简洁。",
        "role": "creative"
      },
      {
        "name": "技术顾问",
        "modelId": "deepseek-flash",
        "persona": "你是技术顾问。关注技术可行性、MVP 范围、开发周期和技术债，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "财务顾问",
        "modelId": "kimi-k2.7-code",
        "persona": "你是财务顾问。关注成本结构、盈利模式、现金流和融资策略，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "运营顾问",
        "modelId": "gemini-3.6-flash",
        "persona": "你是运营顾问。关注用户增长、留存策略、团队搭建和运营效率，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "CEO",
        "modelId": "gpt-5.6-sol",
        "persona": "你是 CEO。综合市场、技术、财务、运营意见，做出战略决策和优先级排序。",
        "role": "decider"
      }
    ]
  },
  {
    "id": "academic-seminar",
    "name": "学术研讨",
    "desc": "方法论专家 + 实证研究者 + 批判者",
    "members": [
      {
        "name": "方法论专家",
        "modelId": "gemini-3.6-flash",
        "persona": "你是方法论专家。关注研究设计、理论框架和方法论严谨性，回答简洁。",
        "role": "creative"
      },
      {
        "name": "实证研究者",
        "modelId": "deepseek-flash",
        "persona": "你是实证研究者。关注数据证据、实验设计和统计分析，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "批判者",
        "modelId": "kimi-k2.7-code",
        "persona": "你是学术批判者。质疑假设、指出逻辑漏洞和替代解释，回答简洁。",
        "role": "analyst"
      },
      {
        "name": "主持人",
        "modelId": "gpt-5.6-sol",
        "persona": "你是研讨会主持人。综合各方观点，总结共识与分歧，指出未来研究方向。",
        "role": "decider"
      }
    ]
  }
];

function applyTeamPreset(presetId) {
  if (presetId === "custom") return; // 自定义模式：保留当前成员
  const preset = TEAM_PRESETS.find(p => p.id === presetId);
  if (!preset) return;
  teamMembers = preset.members.map((m, i) => normalizeSeat({
    id: `preset-${presetId}-${i}`,
    name: m.name,
    kind: m.kind,
    modelId: m.modelId,
    persona: m.persona,
    role: m.role,
    expertId: "",
  }));
  renderTeamMembers();
}


function fmtTok(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n || 0);
}

function makeSessionId() {
  return makeId();
}

// ── 团队会话落库（星图的数据源）────────────────────────

/**
 * 名册快照：只留星图要用的字段，hue 由 id 算出（纯函数 ⇒ 同一成员任何一场讨论同色）。
 *
 * kind / caps / fallback / timeoutSec 必须一起带上：后端的名册白名单只认它认识的字段，
 * 少发一个就等于这位席位的"是人是机"在落库那一刻丢了（读回来会当成 AI）。
 */
function teamRosterSnapshot(members) {
  return (members || [])
    .map(m => ({
      id: String(m?.id || ""),
      kind: m?.kind === "human" ? "human" : "ai",
      name: String(m?.name || "").slice(0, 40),
      role: m?.role || "member",
      modelId: m?.modelId || "",
      expertId: m?.expertId || "",
      caps: Array.isArray(m?.caps) ? m.caps : [],
      fallback: m?.fallback || "",
      timeoutSec: Number(m?.timeoutSec) || 0,
      hue: memberHue(m?.id),
    }))
    .filter(m => m.id);
}

function createTeamRemote({ topic, members }) {
  return {
    id: makeSessionId(),
    conversationId: state.currentConversationId || "",
    topic,
    createdAtMs: Date.now(),
    roster: teamRosterSnapshot(members),
    hostDeviceId: hostDeviceId(),
    scopeProjectId: String(state.currentProjectId || ""),
    seq: 0,
    speakers: [],
    // ok=至少写成功过一次；failed=尝试过且全失败；null=还没试
    syncState: null,
    inflight: new Set(),
  };
}

function teamSessionRow(ctx, extra = {}) {
  const row = {
    id: ctx.id,
    conversationId: ctx.conversationId,
    topic: ctx.topic,
    createdAtMs: ctx.createdAtMs,
    status: extra.status || "running",
    members: ctx.roster,
    hostDeviceId: ctx.hostDeviceId || "",
    scopeProjectId: ctx.scopeProjectId || "",
    phase: extra.phase || "",
    ...(extra.final ? {
      endedAtMs: Date.now(),
      rounds: extra.rounds || 0,
      verdictText: extra.verdictText || "",
      summaryMarkdown: extra.summaryMarkdown || "",
    } : {}),
  };
  // awaiting 只在调用方**明确给了**这个键时才带：普通发言的批次里带上它，
  // 会把正在进行的等待清成空，主持人页面就再也等不到人来。
  if (typeof extra.awaitingSeatId === "string") {
    row.awaitingSeatId = extra.awaitingSeatId;
    row.awaitingSinceMs = extra.awaitingSeatId ? (extra.awaitingSinceMs || Date.now()) : 0;
  }
  return row;
}

function postTeam(ctx, payload) {
  const req = post("/events/team/append", payload)
    .then(() => { ctx.syncState = "ok"; })
    .catch((err) => {
      console.warn("[SLATE] 团队会话落库失败:", err?.message || err);
      if (ctx.syncState !== "ok") ctx.syncState = "failed";
    })
    .finally(() => { ctx.inflight.delete(req); });
  ctx.inflight.add(req);
  return req;
}

/** @ 到的名字解析成成员 id：先认本场已发言的人（回的是那段话的作者），再退到名册同名 */
function resolveTargetMemberId(ctx, targetName, selfId) {
  const name = String(targetName || "").trim();
  if (!name) return "";
  for (let i = ctx.speakers.length - 1; i >= 0; i--) {
    if (ctx.speakers[i].name === name && ctx.speakers[i].id !== selfId) return ctx.speakers[i].id;
  }
  const inRoster = ctx.roster.find(m => m.name === name && m.id !== selfId);
  return inRoster?.id || "";
}

/** 一次发言落库：名册随行 upsert（只补不覆盖），发言按 (session_id, seq) 幂等 */
function recordTeamTurn(ctx, rec, runId = "") {
  if (!ctx) return;
  const memberId = String(rec.member?.id || "");
  const turn = {
    seq: ++ctx.seq,
    round: typeof rec.round === "number" ? rec.round : 0,
    memberId,
    memberName: rec.member?.name || "",
    role: rec.member?.role || "member",
    modelId: rec.member?.modelId || "",
    expertId: rec.member?.expertId || "",
    action: rec.action || "propose",
    targetMemberId: resolveTargetMemberId(ctx, rec.target, memberId),
    runId,
    text: String(rec.text || ""),
    // 摘要给星图与看板用，全文才是"这一场说过什么"的可追溯正文（本地历史被 50 场上限
    // 挤掉、或这场是手动停止的那场时，只能靠它重建）
    fullText: String(rec.full || rec.text || ""),
    ts: Date.now(),
    // 归属：这句话是谁说的、谁替谁说的。少带一个，"人的发言"就会被记成机器的。
    seatKind: rec.member?.kind === "human" ? "human" : "ai",
    onBehalfOf: String(rec.onBehalfOf || ""),
    authorDeviceId: String(rec.authorDeviceId || ""),
  };
  ctx.speakers.push({ id: memberId, name: rec.member?.name || "" });
  postTeam(ctx, { session: teamSessionRow(ctx, rec.sessionExtra || {}), turns: [turn] });
}

/** 收尾：补终态与总结。返回 Promise，供本地历史落库前把在飞的写入等干。 */
function finishTeamRemote(ctx, { status, rounds, verdictText, summaryMarkdown }) {
  if (!ctx) return Promise.resolve();
  postTeam(ctx, {
    session: teamSessionRow(ctx, { status, final: true, rounds, verdictText, summaryMarkdown }),
    turns: [],
  });
  return Promise.allSettled([...ctx.inflight]);
}


function resetTeamUsage() {
  currentTeamUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, messageCount: 0 };
  renderTeamUsage();
}

function addTeamUsage(promptText, completionText = "") {
  const promptTokens = estimateTokens(promptText || "");
  const completionTokens = estimateTokens(completionText || "");
  currentTeamUsage.promptTokens += promptTokens;
  currentTeamUsage.completionTokens += completionTokens;
  currentTeamUsage.totalTokens = currentTeamUsage.promptTokens + currentTeamUsage.completionTokens;
  currentTeamUsage.messageCount += 1;
  renderTeamUsage();
}

function renderTeamUsage(usage = currentTeamUsage) {
  if (!teamUsageBar) return;
  teamUsageBar.innerHTML = `
    <span class="usage-model">团队讨论</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("发言 {n} 条", { n: usage.messageCount || 0 })}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("输入 {n}", { n: fmtTok(usage.promptTokens || 0) })}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("输出 {n}", { n: fmtTok(usage.completionTokens || 0) })}</span>
    <span class="usage-sep">|</span>
    <span class="usage-stat">${t("总计 {n}", { n: fmtTok(usage.totalTokens || 0) })}</span>
  `;
}

function loadTeamHistory() {
  try {
    const raw = localStorage.getItem(TEAM_HISTORY_KEY);
    teamHistory = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(teamHistory)) teamHistory = [];
  } catch {
    teamHistory = [];
  }
}

function saveTeamHistory() {
  try {
    localStorage.setItem(TEAM_HISTORY_KEY, JSON.stringify(teamHistory.slice(0, 50)));
  } catch {}
}

function renderTeamHistory() {
  if (!teamHistoryList) return;
  teamHistoryList.innerHTML = "";
  if (teamHistory.length === 0) {
    const empty = document.createElement("div");
    empty.className = "team-history-empty";
    empty.textContent = t("暂无团队历史");
    teamHistoryList.appendChild(empty);
    return;
  }
  for (const session of teamHistory) {
    const item = document.createElement("div");
    item.className = "team-history-item";
    item.dataset.sessionId = session.id;
    // 这个 div 就是"打开那一场"的按钮：补上角色与键盘激活，读屏和纯键盘都够得着
    item.setAttribute("role", "button");
    item.tabIndex = 0;

    const title = document.createElement("div");
    title.className = "team-history-title";
    title.textContent = session.topic || t("未命名讨论");
    item.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "team-history-meta";
    const time = session.createdAt ? new Date(session.createdAt).toLocaleString() : "";
    const turnCount = session.entries?.length ?? session.responses?.length ?? 0;
    meta.textContent = time + t(" · {n} 条发言 · ~{tok} tok", { n: turnCount, tok: fmtTok(session.usage?.totalTokens || 0) });
    // 落库失败的历史只在明确失败时标注：老记录没这个字段，不该被说成"没同步"
    if (session.remote === false) {
      const badge = document.createElement("span");
      badge.className = "team-history-badge";
      badge.textContent = t("仅本机记录");
      badge.title = t("这场讨论未能写入后端，星图里看不到");
      meta.appendChild(badge);
    }
    if (session.stopped) {
      const badge = document.createElement("span");
      badge.className = "team-history-badge";
      badge.textContent = t("已中断");
      badge.title = t("这场讨论被手动停止，没有走完轮次");
      meta.appendChild(badge);
    }
    item.appendChild(meta);

    item.addEventListener("click", () => loadTeamSession(session.id));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        loadTeamSession(session.id);
      }
    });
    teamHistoryList.appendChild(item);
  }
}

function persistTeamSession(session) {
  teamHistory = [session, ...teamHistory.filter(item => item.id !== session.id)].slice(0, 50);
  saveTeamHistory();
  renderTeamHistory();
}

// ── 渲染 ────────────────────────────────────

function renderTeamMembers() {
  if (!teamMembersArea) return;
  teamMembersArea.innerHTML = "";

  if (teamMembers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "team-empty";
    empty.textContent = "暂无团队成员，点击 + 添加";
    teamMembersArea.appendChild(empty);
    return;
  }

  teamMembers.forEach((m, i) => {
    const card = document.createElement("div");
    card.className = "team-member-card" + (m.kind === "human" ? " is-human" : "");

    const header = document.createElement("div");
    header.className = "team-member-header";

    const avatar = document.createElement("span");
    avatar.className = "team-member-avatar";
    // 真人席位用名字首字：一眼能和模型席位的 A/C/D 分开，也不用再造一套图标
    avatar.textContent = m.kind === "human"
      ? (m.name || "?").charAt(0)
      : (m.role === "analyst" ? "A" : m.role === "creative" ? "C" : m.role === "decider" ? "D" : "M");
    header.appendChild(avatar);

    const info = document.createElement("div");
    info.className = "team-member-info";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "team-member-name";
    nameInput.value = m.name;
    nameInput.placeholder = "成员名称";
    nameInput.addEventListener("change", () => { m.name = nameInput.value; });
    info.appendChild(nameInput);

    if (m.kind === "human") {
      const kindBadge = document.createElement("span");
      kindBadge.className = "team-member-kind";
      kindBadge.textContent = t("真人");
      const dot = document.createElement("span");
      dot.className = "team-member-presence";
      dot.dataset.seat = m.id;
      dot.title = t("未加入");
      info.appendChild(kindBadge);
      info.appendChild(dot);
    } else {
      const modelSelect = document.createElement("select");
      modelSelect.className = "team-member-model";
      populateModelOptions(modelSelect, m.modelId);
      modelSelect.addEventListener("change", () => { m.modelId = modelSelect.value; });
      info.appendChild(modelSelect);
    }

    header.appendChild(info);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "team-member-remove";
    removeBtn.textContent = "×";
    removeBtn.title = t("移除");
    // 只有 × 一个字形：读屏要有个名字，不然只会念出"乘号"
    removeBtn.setAttribute("aria-label", t("移除"));
    removeBtn.addEventListener("click", () => {
      teamMembers.splice(i, 1);
      renderTeamMembers();
    });
    header.appendChild(removeBtn);

    card.appendChild(header);

    if (m.kind === "human") {
      // 真人席位没有模型与人格设定：它有的是"能做什么""等不到人怎么办"
      card.appendChild(buildHumanSeatControls(m));
    } else {
      const personaInput = document.createElement("textarea");
      personaInput.className = "team-member-persona";
      personaInput.value = m.persona;
      personaInput.placeholder = "角色设定…";
      personaInput.rows = 2;
      personaInput.addEventListener("change", () => { m.persona = personaInput.value; });
      card.appendChild(personaInput);

      // 专家包绑定：辩论时注入专属 persona + rules
      const expertRow = document.createElement("div");
      expertRow.className = "team-member-expert-row";
      const expertLabel = document.createElement("span");
      expertLabel.className = "team-member-expert-label";
      expertLabel.textContent = "专家包";
      expertRow.appendChild(expertLabel);
      const expertSelect = document.createElement("select");
      expertSelect.className = "team-member-model member-expert-select";
      expertSelect.dataset.current = m.expertId || "";
      const noneOpt = document.createElement("option");
      noneOpt.value = "";
      noneOpt.textContent = "无专家";
      expertSelect.appendChild(noneOpt);
      for (const item of getExpertsCached()) {
        const opt = document.createElement("option");
        opt.value = item.id;
        opt.textContent = item.name || item.id;
        if (item.id === m.expertId) opt.selected = true;
        expertSelect.appendChild(opt);
      }
      expertSelect.addEventListener("change", () => {
        m.expertId = expertSelect.value;
        expertSelect.dataset.current = expertSelect.value;
      });
      expertRow.appendChild(expertSelect);
      card.appendChild(expertRow);
    }

    teamMembersArea.appendChild(card);
  });
  paintTeamPresence();
}

/**
 * 真人席位的控件：能做什么、等不到人怎么办、等多久，以及那条邀请链接。
 *
 * 邀请链接是**一次性展示**：票据原文只在签发那一次响应里回来，之后库里只有它的 sha256，
 * 主持人这边也不留副本——刷新页面就该再签一张，而不是把一张票长期挂在界面上。
 */
function buildHumanSeatControls(m) {
  const box = document.createElement("div");
  box.className = "team-human-seat";

  const capRow = document.createElement("div");
  capRow.className = "team-human-row";
  const capLabel = document.createElement("span");
  capLabel.className = "team-human-label";
  capLabel.textContent = t("权限");
  capRow.appendChild(capLabel);
  const mkCap = (cap, label) => {
    const wrap = document.createElement("label");
    wrap.className = "team-human-cap";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = (m.caps || []).includes(cap);
    cb.addEventListener("change", () => {
      const set = new Set(m.caps || []);
      if (cb.checked) set.add(cap); else set.delete(cap);
      m.caps = [...set];
    });
    wrap.appendChild(cb);
    const span = document.createElement("span");
    span.textContent = label;
    wrap.appendChild(span);
    return wrap;
  };
  capRow.appendChild(mkCap("speak", t("发言")));
  capRow.appendChild(mkCap("signoff", t("拍板")));
  box.appendChild(capRow);

  const fbRow = document.createElement("div");
  fbRow.className = "team-human-row";
  const fbLabel = document.createElement("span");
  fbLabel.className = "team-human-label";
  fbLabel.textContent = t("等不到人");
  fbRow.appendChild(fbLabel);
  const fbSelect = document.createElement("select");
  fbSelect.className = "team-member-model";
  for (const [value, label] of [
    ["delegate", t("让 AI 代笔")],
    ["skip", t("跳过并留痕")],
    ["wait", t("一直等")],
  ]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (m.fallback === value) opt.selected = true;
    fbSelect.appendChild(opt);
  }
  fbSelect.addEventListener("change", () => { m.fallback = fbSelect.value; });
  fbRow.appendChild(fbSelect);
  const secInput = document.createElement("input");
  secInput.type = "number";
  secInput.className = "team-human-timeout";
  secInput.min = String(SEAT_MIN_TIMEOUT_SEC);
  secInput.max = String(SEAT_MAX_TIMEOUT_SEC);
  secInput.step = "10";
  secInput.value = String(m.timeoutSec);
  secInput.title = t("等多久（秒）");
  secInput.setAttribute("aria-label", t("等多久（秒）"));
  secInput.addEventListener("change", () => {
    m.timeoutSec = clampTimeoutSec(secInput.value);
    secInput.value = String(m.timeoutSec);
  });
  fbRow.appendChild(secInput);
  box.appendChild(fbRow);

  const inviteRow = document.createElement("div");
  inviteRow.className = "team-human-row";
  const inviteBtn = document.createElement("button");
  inviteBtn.type = "button";
  inviteBtn.className = "team-invite-btn";
  inviteBtn.textContent = t("生成邀请链接");
  const inviteOut = document.createElement("span");
  inviteOut.className = "team-invite-url";
  inviteBtn.addEventListener("click", async () => {
    inviteBtn.disabled = true;
    try {
      const data = await inviteSeat(m);
      const url = String(data?.inviteUrl || "");
      inviteOut.textContent = url || t("遥控未开启，先到设置里打开局域网遥控");
      inviteOut.classList.toggle("ready", !!url);
      if (url) refreshTeamPresence();
    } catch (e) {
      inviteOut.textContent = String(e?.message || e);
      inviteOut.classList.remove("ready");
    } finally {
      inviteBtn.disabled = false;
    }
  });
  inviteRow.appendChild(inviteBtn);
  box.appendChild(inviteRow);
  box.appendChild(inviteOut);
  return box;
}

/**
 * 只刷新在线点，不重建名册——重建会把正在输入的那个名字框顶掉焦点。
 * 在线是内存态：主持人这边也只是一条提示，不参与任何判定。
 */
function paintTeamPresence() {
  if (!teamMembersArea) return;
  for (const dot of teamMembersArea.querySelectorAll(".team-member-presence")) {
    const seatId = dot.dataset.seat || "";
    const rec = teamPresence.get(seatId);
    const online = !!rec?.online;
    dot.classList.toggle("online", online);
    dot.classList.toggle("away", !!rec && !online);
    dot.title = rec ? (online ? t("在线") : t("暂离")) : t("未加入");
  }
  // 在线点是改 class（属性变更），发言流那个 MutationObserver 看不见，这里补一次
  scheduleTeamAgenda();
}

async function refreshTeamPresence() {
  let rows = [];
  try {
    rows = await listAttendees();
  } catch (e) {
    // 议事厅接口不可用（遥控关着之类）：把在线标记清掉就好，别在控制台刷屏
    if (teamPresence.size) { teamPresence = new Map(); paintTeamPresence(); }
    return;
  }
  const next = new Map();
  for (const row of rows) {
    if (!row?.seatId) continue;
    next.set(row.seatId, { name: row.name || "", online: !!row.online, state: row.state || "" });
  }
  teamPresence = next;
  paintTeamPresence();
}

function populateModelOptions(select, selectedId) {
  select.innerHTML = "";
  const groups = { international: "国外", domestic: "国内", local: "本地" };
  for (const [cat, label] of Object.entries(groups)) {
    const models = state.modelRegistry[cat];
    if (!models) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = t(label);
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name + (hasModelKey(m.id) ? "" : t("（未配置 Key）"));
      if (m.id === selectedId) opt.selected = true;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }

  // 自定义模型
  if (state.customModels.length > 0) {

    const optgroup = document.createElement("optgroup");
    optgroup.label = t("自定义");
    for (const m of state.customModels) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name + (hasModelKey(m.id) ? "" : t("（未配置 Key）"));
      if (m.id === selectedId) opt.selected = true;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }
}

// ── 辩论逻辑：提案 / 支持 / 反对 / 反驳 / 补充 / 决策 ────

const DEBATE_ACTIONS = {
  propose: "提案",
  support: "支持",
  oppose: "反对",
  rebut: "反驳",
  supplement: "补充",
  verdict: "决策",
  // 这两种是"这一格没人说话"的记录，不是发言：只有界面与落库读得到，模型读不到
  // （parseDebateAction 的正则不认它们，成员提示词里也只给前六种，所以不会被"演"出来）
  error: "失败",
  skipped: "未参与",
  // 人类席位的两种非发言收场：超时没开口是**留痕**（与失败/缺席同一类，不算发言），
  // 「等待发言」只是界面上那一格临时态，不落库（落库的是它最终的收场）
  silent: "超时未发言",
  waiting: "等待发言",
  // 下面三种是"人有没有签字"的记录：同样只有界面与落库写得出，成员演不出来
  // （拍板行挂的是合成成员 id:"signoff"，星图按名册取发言时天然把它排除在外）
  awaiting: "待拍板",
  decided: "已拍板",
  reopened: "未拍板",
};

// 摘要与统计只数这些：拍板行不算一次发言（与星图、失败/缺席同一口径）
const SPEECH_ACTIONS = ["propose", "support", "oppose", "rebut", "supplement", "verdict"];

/** 解析发言的动作前缀与回应对象：【动作】@成员{n}*/
function parseDebateAction(text) {
  const m = String(text || "").match(/^\s*【(提案|支持|反对|反驳|补充|决策)】\s*(?:@([^\s【】@]+))?/);
  if (!m) return { action: "propose", target: "", content: String(text || "").trim() };
  const action = Object.keys(DEBATE_ACTIONS).find(k => DEBATE_ACTIONS[k] === m[1]) || "propose";
  return { action, target: m[2] || "", content: String(text || "").slice(m[0].length).trim() };
}

function buildTranscript(entries) {
  return entries.map(e =>
    `[${e.round}轮] ${e.member.name} ${DEBATE_ACTIONS[e.action] || "发言"}${e.target ? `（回${e.target}）` : ""}: ${e.text}`
  ).join("\n");
}

// 空态渲染成真实节点，而不是留在 CSS 的 :empty::before 里——伪元素里的中文过不了
// i18n 的文本观察器，英文界面会一直显示中文。
function showTeamEmptyState() {
  if (!teamOutput) return;
  const el = document.createElement("div");
  el.className = "team-empty-state";
  el.textContent = t("输入议题后开始团队讨论。");
  teamOutput.appendChild(el);
}

function addRoundHeader(round, final = false) {
  const el = document.createElement("div");
  el.className = "debate-round-header";
  // 终局那格不是"第 N 轮"：套进轮次模板会渲染成「第 最终决策 轮」，而且整串没有词典键、英文界面照样是中文
  el.textContent = final ? t("最终决策") : t("—— 第 {n} 轮 ——", { n: round });
  teamOutput.appendChild(el);
}

function addDebateEntry(member, action = "propose") {
  const el = document.createElement("div");
  el.className = `debate-entry action-${action} streaming`;

  const header = document.createElement("div");
  header.className = "debate-header";

  const avatar = document.createElement("span");
  avatar.className = "debate-avatar";
  avatar.textContent = (member.name || "?").charAt(0);
  header.appendChild(avatar);

  const name = document.createElement("span");
  name.className = "debate-name";
  name.textContent = member.name;
  header.appendChild(name);

  const badge = document.createElement("span");
  badge.className = `debate-action-badge action-${action}`;
  badge.textContent = DEBATE_ACTIONS[action] || "发言";
  header.appendChild(badge);

  const model = document.createElement("span");
  model.className = "debate-model";
  model.textContent = findModel(member.modelId)?.name || member.modelId;
  header.appendChild(model);

  el.appendChild(header);

  const replyRef = document.createElement("div");
  replyRef.className = "debate-reply-ref hidden";
  el.appendChild(replyRef);

  const content = document.createElement("div");
  content.className = "debate-content";
  el.appendChild(content);

  teamOutput.appendChild(el);
  teamOutput.scrollTop = teamOutput.scrollHeight;
  return { el, badge, replyRef, content };
}

function finalizeEntry(entry, action, target, text) {
  entry.el.classList.remove("streaming");
  if (!DEBATE_ACTIONS[action]) action = "propose";
  entry.el.className = `debate-entry action-${action}`;
  entry.badge.className = `debate-action-badge action-${action}`;
  entry.badge.textContent = DEBATE_ACTIONS[action];
  if (target) {
    entry.replyRef.textContent = t("回应 {name}", { name: target });
    entry.replyRef.classList.remove("hidden");
  }
  entry.content.textContent = text;
  teamOutput.scrollTop = teamOutput.scrollHeight;
}

// ── 拍板：决策要人签字才算数 ──────────────────────────────

const SIGNOFF_MEMBER = { id: "signoff", name: "我", role: "member", modelId: "" };

function signoffRec(action, text, round) {
  return {
    round, member: { ...SIGNOFF_MEMBER, name: t("我") },
    action, target: "", text, full: text,
  };
}

/** 任务中心里的那一行：与后台进程任务同一族（面板不需要认识第二种行），
 *  family 只是把"这是团队讨论"说清，提醒话术由团队这一侧自己出。 */
function syncTeamTask(ctx, patch) {
  upsertLocalTask({
    task_id: `team:${ctx.id}`,
    label: `${t("团队讨论")} · ${(ctx.topic || "").slice(0, 24)}`,
    conversation_id: ctx.conversationId,
    family: "team",
    state: "running",
    exit_code: null,
    output: "",
    started_at: ctx.createdAtMs,
    log_path: "",
    ...patch,
  });
}

/** 决策出来后的"人签字"这一道。返回写进 entries 的那一行（decided/reopened），
 *  调用方据此决定要不要结束讨论；返回 null 表示这一场已经不需要再问（已停止/夜间模式之外）。 */
async function requestTeamSignoff(rec, ctx, round) {
  if (discussAbortController?.signal.aborted) return null;
  // 夜间模式（全托管）＝不向人提问：直接采纳，与 tools.js 里 user_ask 那条同一口径。
  // 但这一行照画：没人签字这件事要看得见，不能悄悄读成"用户点过头"
  if (permissionModeFor(ctx.conversationId) === "night") {
    const text = t("夜间模式：决策已自动采纳");
    finalizeEntry(addDebateEntry(SIGNOFF_MEMBER, "decided"), "decided", "", text);
    return signoffRec("decided", text, round);
  }

  const row = addDebateEntry(SIGNOFF_MEMBER, "awaiting");
  row.content.textContent = t("等待你拍板");
  // 用户可能正在别的会话里干活：这条要进与后台任务同一个池子，等主人回来领
  pushLocalBgEvent({
    task_id: `team:${ctx.id}`,
    label: `${t("团队讨论")} · ${(ctx.topic || "").slice(0, 24)}`,
    kind: "awaiting",
    exit_code: null,
    tail: String(rec.text || ""),
    tail_budget: TEAM_TAIL_BUDGET,
    conversation_id: ctx.conversationId,
    origin: "local",
  });
  // 面板就摆在眼前时弹窗本身已经够显眼，只有这场在背后跑才补一条系统通知
  if (!teamPanelVisible()) {
    try {
      notifyTaskComplete(t("团队讨论等你拍板"), (ctx.topic || "").slice(0, 24), "slate-team-signoff");
    } catch (e) { /* 通知不是关键路径 */ }
  }

  const answer = await dlgChoice(
    t("团队讨论待拍板"),
    `${t("决策待拍板")}：${String(rec.text || "").slice(0, 120)}`,
    [{ value: "approve", label: t("采纳拍板") }, { value: "reopen", label: t("继续讨论") }],
  );
  // 取消/Esc 算"没签"：用户不点头就不能替他结束这场讨论
  const approved = answer === "approve";
  const outcome = approved ? "decided" : "reopened";
  const text = approved ? t("已采纳这个决策") : t("未拍板：继续讨论");
  finalizeEntry(row, outcome, "", text);
  return signoffRec(outcome, text, round);
}

function buildMemberPrompt(member, topic, boardContext, entries, round, isLastRound, expertDetail = null) {
  let prompt = `${member.persona}\n`;
  // 绑定的专家包：注入专家人格与规则
  const expertPrompt = buildExpertPrompt(expertDetail);
  if (expertPrompt) prompt += `${expertPrompt}\n`;
  prompt += `\n议题: ${topic}${boardContext}\n\n`;
  if (entries.length === 0) {
    prompt += "这是第一轮，请提出你的想法或方案。";
  } else {
    prompt += `已有发言记录:\n${buildTranscript(entries)}\n\n请继续参与讨论：可以提出新想法，也可以支持、反对、反驳或补充他人的想法。`;
  }
  prompt += `\n\n发言格式：第一行以【提案】【支持】【反对】【反驳】【补充】之一开头，回应他人时在动作后写 @对方成员名，第二行起写正文（1-3句）。`;
  if (member.role === "decider") {
    prompt += isLastRound
      ? "\n这是最后一轮：请综合各方观点，以【决策】开头给出最终方案、理由与取舍。"
      : `\n若各方已达成共识或分歧无法调和，你可以【决策】开头直接给出最终方案（${teamSignoffOn ? "之后讨论不会立刻结束：会停下来等用户签字" : "讨论将立即结束"}）；否则继续正常参与讨论。`;
  }
  return prompt;
}

// ── 议事厅：把真人的话递进来 ─────────────────────────────
//
// 后端只负责收件箱、在线态与票据，轮次推进仍在这里。所以"等人的这段等待"也在主持人页面：
// 把「轮到谁」写到会话上 → 轮询收件箱 → 超时按席位预设回退。

const sleepMs = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
});

/** 主持人（本机）对议事厅接口的调用；code 非 0 一律当失败抛出去 */
async function teamApi(path, body) {
  const res = body === undefined ? await get(`/teams/${path}`) : await post(`/teams/${path}`, body);
  if (!res || res.code !== 0) throw new Error(res?.message || t("议事厅请求失败"));
  return res.data;
}

/** 把「正等着谁开口」写到会话上：与会者页面靠它显示「轮到你」 */
async function setAwaitingSeat(ctx, seatId) {
  if (!ctx) return;
  try {
    await teamApi("awaiting", { sessionId: ctx.id, seatId: seatId || "" });
  } catch (e) {
    // 等待态只是给与会者那一侧的提示；写不进去不值得打断整场讨论
    console.warn("[SLATE] 写入等待席位失败:", e?.message || e);
  }
}

/** 签发一张与会者票据。token 只在这一次响应里出现，之后库里只有它的 sha256 */
async function inviteSeat(seat) {
  return teamApi("invite", {
    seatId: seat.id,
    name: seat.name,
    caps: Array.isArray(seat.caps) && seat.caps.length ? seat.caps : ["speak"],
    deviceId: hostDeviceId(),
  });
}

async function listAttendees() {
  const data = await teamApi("attendees");
  return Array.isArray(data?.attendees) ? data.attendees : [];
}

/** 只取"某一位席位"的话：取整队会把别人的话一起消费掉，那一句谁也看不到了 */
async function takeSeatInbox(sessionId, seatId) {
  const data = await teamApi("inbox/take", { sessionId, seatId });
  return Array.isArray(data?.items) ? data.items : [];
}

/** 一行系统提示（超时、代笔之类）：与发言分开画，也不参与落账 */
function showTeamNotice(text) {
  if (!teamOutput) return;
  const el = document.createElement("div");
  el.className = "team-notice";
  el.textContent = text;
  teamOutput.appendChild(el);
  teamOutput.scrollTop = teamOutput.scrollHeight;
}

function seatLabel(seat) {
  return seat?.name || seat?.id || "";
}

/**
 * 等一位真人发言。
 *
 * 三种收场都要留痕——"超时没开口"和"从来没轮到过"在账上必须是两回事。
 * 返回 { status: "spoken" | "delegate" | "skip" | "aborted", ... }
 */
async function awaitHumanTurn(seat, { ctx, signal }) {
  const entry = addDebateEntry(seat, "waiting");
  entry.content.textContent = t("等 {name} 发言…", { name: seatLabel(seat) });

  // 就地给主持人两个手动出口：等不及了能立刻跳过，或者让 AI 替这位说完
  let resolveManual = null;
  const manual = new Promise((resolve) => { resolveManual = resolve; });
  const controls = document.createElement("div");
  controls.className = "team-await-controls";
  const mkBtn = (label, value, primary) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "team-await-btn" + (primary ? " primary" : "");
    b.textContent = label;
    b.addEventListener("click", () => resolveManual(value));
    return b;
  };
  controls.appendChild(mkBtn(t("跳过"), "skip"));
  controls.appendChild(mkBtn(t("让 AI 代笔"), "delegate", true));
  entry.el.appendChild(controls);

  // fallback="wait" 是"一直等"：没有上限，也就没有超时收场
  const unlimited = seat.fallback === "wait";
  const deadline = unlimited ? Infinity : Date.now() + seat.timeoutSec * 1000;
  const timeoutOutcome = () => (seat.fallback === "skip" ? { status: "skip" } : { status: "delegate" });

  // 等待那一格是"占位"，不是发言：说出口就把它就地改成这一席真正的发言行（同一条 DOM，
  // 位置不动）；没等到人（跳过/代笔/中止）就整条撤掉——留着的话画面上会永远挂一条
  // "等 X 发言…"的死行，而那句真话只在库里，直播里根本看不到。
  const settle = (o) => {
    if (o.status === "spoken") { controls.remove(); return { ...o, entry }; }
    entry.el.remove();
    return o;
  };

  await setAwaitingSeat(ctx, seat.id);
  try {
    while (true) {
      if (signal?.aborted) return settle({ status: "aborted" });
      let raced;
      try {
        raced = await Promise.race([manual, sleepMs(INBOX_POLL_MS, signal).then(() => "tick")]);
      } catch (e) {
        return settle({ status: "aborted" });
      }
      if (raced === "skip" || raced === "delegate") return settle({ status: raced });
      let items = [];
      try {
        items = await takeSeatInbox(ctx.id, seat.id);
      } catch (e) {
        // 这一轮读失败当作"还没说话"；真要一直读不通，会在超时后按席位预设收场，不把整场拖死
        console.warn("[SLATE] 读收件箱失败:", e?.message || e);
      }
      // 等的这一跳顺手刷一次在线：这正好是主持人最想知道"他到底在不在"的时刻
      refreshTeamPresence();
      const mine = items[0];
      if (mine) {
        return settle({
          status: "spoken",
          action: mine.action || "propose",
          text: String(mine.text || ""),
          targetSeatId: String(mine.target_seat_id || ""),
          authorDeviceId: String(mine.device_id || ""),
        });
      }
      if (!unlimited && Date.now() >= deadline) return settle(timeoutOutcome());
    }
  } finally {
    // 收口：没人在等了。不清掉的话，与会者那一侧会一直显示"轮到你"
    await setAwaitingSeat(ctx, "");
  }
}

/**
 * 一位席位说一句话。
 *
 * AI 席位与"AI 代笔"走的是同一条路：同一次工具调用、同一份事件账本、同一套动作解析——
 * 拆成两份实现的话，代笔那条迟早会漏掉审批或漏记工具，而它动的是同一台机器。
 *
 * 返回 { status: "done" | "skipped" | "error" | "aborted", action, target, text, full, runId }
 */
async function speakForSeat(seat, opts) {
  const { topic, boardContext, entries, round, isLastRound, expertDetail, signal, modelId, onBehalfOf, conversationId } = opts;
  const apiKey = getModelKey(modelId);
  if (!apiKey) {
    const why = t("未配置 API Key，已跳过");
    const skipEntry = addDebateEntry(seat, "skipped");
    finalizeEntry(skipEntry, "skipped", "", why);
    return { status: "skipped", text: why, full: why, onBehalfOf };
  }

  const entry = addDebateEntry(seat, "propose");
  if (onBehalfOf) {
    const note = document.createElement("span");
    note.className = "debate-proxy-note";
    note.textContent = t("AI 代笔");
    entry.el.querySelector(".debate-header")?.appendChild(note);
  }
  const systemPrompt = `你是 SLATE 团队协作成员：始终从自己的角色立场出发发表独立观点，直接给观点，不寒暄、不复述他人。${getToolsSystemPrompt({ minimal: true })}`;
  const userPrompt = buildMemberPrompt(seat, topic, boardContext, entries, round, isLastRound, expertDetail);

  let fullText = "";
  let failure = "";
  try {
    for await (const chunk of streamChat({
      model: modelId,
      provider: findModel(modelId)?.provider,
      // 自定义/本地模型的端点只在前端注册表里，代理要靠这一个字段认路；
      // 少发它就会回「未知模型」，这位席位的每一次发言都变成失败
      base_url: findModel(modelId)?.base_url,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      api_key: apiKey,
      temperature: seat.role === "decider" ? 0.3 : 0.7,
      max_tokens: 500,
      stream: true,
      signal,
    })) {
      fullText += chunk;
      entry.content.textContent = fullText;
      teamOutput.scrollTop = teamOutput.scrollHeight;
    }
  } catch (e) {
    if (signal?.aborted) return { status: "aborted", onBehalfOf };
    failure = String(e?.message || e);
  }

  if (failure) {
    // 失败不进 entries：这句一旦被下一位读到，模型会把报错当成"某某的主张"接着反驳。
    // 它只落两处——黑板上标成「失败」的一行，和账本里 action="error" 的一条。
    finalizeEntry(entry, "error", "", t("请求失败: {msg}", { msg: failure }));
    return { status: "error", text: failure, full: failure, onBehalfOf };
  }

  let runId = "";
  const toolCalls = detectToolCalls(fullText);
  if (toolCalls.length > 0) {
    fullText = stripToolCalls(fullText);
    // 这次发言动过的工具记进一个 mode:"team" 的账本 run（发言行带 run_id）：
    // 星图的叶子就是从这份账里数出来的，没有这份账这位席位的手就不可见
    const ledger = openLedgerRun({ conversationId, mode: "team", budget: 1 });
    runId = ledger.runId;
    const results = await executeToolCalls(toolCalls, {
      signal,
      ledger,
      callIdFor: (i) => ledger.callId(0, i),
      onCallStart: (call, i) => {
        const callId = ledger.callId(0, i);
        ledger.emit("call.planned", { callId, tool: call.name, round: 0, data: { args: call.params } });
        ledger.emit("call.ready", { callId, tool: call.name, round: 0 });
        ledger.emit("call.started", { callId, tool: call.name, round: 0 });
      },
      onCallEnd: (call, i, result) => {
        ledger.emit("call.finished", {
          callId: ledger.callId(0, i),
          tool: call.name,
          round: 0,
          data: { status: result === undefined ? "failed" : result.success === false ? "error" : "done" },
        });
      },
    });
    ledger.finish({ status: signal?.aborted ? "cancelled" : "completed" });
    for (const r of results) {
      const toolEl = document.createElement("div");
      toolEl.className = "team-tool-result";
      toolEl.textContent = `${r.output}`;
      teamOutput.appendChild(toolEl);
    }
  }

  const parsed = parseDebateAction(fullText);
  // 非决策者不允许越权拍板
  const action = parsed.action === "verdict" && seat.role !== "decider" ? "propose" : parsed.action;
  finalizeEntry(entry, action, parsed.target, parsed.content || "（无内容）");
  addTeamUsage(`${systemPrompt}\n\n${userPrompt}`, fullText);
  return {
    status: "done", action, target: parsed.target,
    text: parsed.content || fullText, full: fullText, runId, onBehalfOf,
  };
}

async function startDiscussion() {
  const topic = teamTopicInput.value.trim();
  if (!topic) return;
  if (teamMembers.length === 0) return;
  if (isDiscussing) return;

  isDiscussing = true;
  discussAbortController = new AbortController();
  btnStartDiscuss.disabled = true;
  btnStartDiscuss.textContent = "辩论中…";
  if (btnStopDiscuss) {
    btnStopDiscuss.classList.remove("hidden");
    btnStopDiscuss.disabled = false;
  }
  teamOutput.innerHTML = "";
  resetTeamUsage();

  const topicEl = document.createElement("div");
  topicEl.className = "team-topic";
  topicEl.textContent = t("议题: {topic}", { topic });
  teamOutput.appendChild(topicEl);

  // 注入黑板上下文
  let boardContext = "";

  if (state.boardCards.length > 0) {
    boardContext = "\n\n当前黑板卡片:\n" + state.boardCards.map(c =>
      `[${c.id}] ${c.title}${c.body ? " " + c.body : ""}`
    ).join("\n");
  }

  const entries = [];
  let verdict = null;
  let reopenUsed = 0;
  // 本场讨论的后端落库上下文（星图数据源）；与 localStorage 历史各走各的
  const teamRemote = createTeamRemote({ topic, members: teamMembers });
  // 任务中心里给这场讨论占一行：跑在背后时，人回来看得见它还在跑
  syncTeamTask(teamRemote);
  // 先把会话行落下来：与会者可能在第一位发言之前就打开页面，而「等待席位」是对会话行的
  // UPDATE——行不存在就写不进去，那一侧会一直显示"还没开始"
  postTeam(teamRemote, { session: teamSessionRow(teamRemote, { phase: "starting" }), turns: [] });

  // 一次"有效发言"的统一收口：进上下文 + 落账 + 拍板停点。
  // AI 发言、真人发言、AI 代笔都必须走这里——拍板逻辑只此一份，漏一处就有人能绕开签字。
  const finishSeatTurn = async (rec, runId = "") => {
    entries.push(rec);
    recordTeamTurn(teamRemote, rec, runId);
    if (rec.action !== "verdict") return;
    // 要求拍板时【决策】只是一份待签的草案：人不签字就不结束这场讨论
    const outcome = teamSignoffOn && reopenUsed < TEAM_REOPEN_CAP
      ? await requestTeamSignoff(rec, teamRemote, rec.round)
      : null;
    if (outcome) {
      entries.push(outcome);
      recordTeamTurn(teamRemote, outcome);
      if (outcome.action === "reopened") reopenUsed += 1;
    }
    if (!outcome || outcome.action === "decided") verdict = rec;
  };

  // 预加载成员绑定的专家包
  const expertDetails = new Map();

  for (const member of teamMembers) {
    if (member.expertId && !expertDetails.has(member.expertId)) {
      try {
        expertDetails.set(member.expertId, await getExpert(member.expertId));
      } catch (e) {
        console.warn(`专家包加载失败（${member.expertId}）`, e);
      }
    }
  }

  // 多轮辩论：每轮每位成员可提案或回应他人，直到决策产生或轮次用尽
  for (let round = 1; round <= maxRounds && !verdict; round++) {
    if (discussAbortController?.signal.aborted) break;
    addRoundHeader(round);
    const isLastRound = round === maxRounds;

    for (const member of teamMembers) {
      if (verdict || discussAbortController?.signal.aborted) break;
      const signal = discussAbortController?.signal;

      // 真人席位：轮到他就等人写。等的这段不落 entries——还没说出口的话不该被下一位读到
      if (member.kind === "human") {
        const outcome = await awaitHumanTurn(member, { ctx: teamRemote, signal });
        if (outcome.status === "aborted") break;

        if (outcome.status === "spoken") {
          // 与会者自己选的动作也要过"非决策者不得拍板"那道闸，与模型发言同一口径
          const action = outcome.action === "verdict" && member.role !== "decider" ? "propose" : outcome.action;
          const targetName = teamMembers.find(s => s.id === outcome.targetSeatId)?.name || "";
          // 等待那一格就地变成他这句真话（同一格，不另起一行）：直播里主持人要看得见人说了什么
          finalizeEntry(outcome.entry, action, targetName, outcome.text);
          await finishSeatTurn({
            round, member: { ...member }, action, target: targetName,
            text: outcome.text, full: outcome.text,
            authorDeviceId: outcome.authorDeviceId,
          });
          continue;
        }

        if (outcome.status === "delegate") {
          const proxyModel = member.proxyModelId || state.currentModel?.id;
          showTeamNotice(t("{name} 超时未发言，已由 AI 代笔", { name: seatLabel(member) }));
          const r = await speakForSeat(
            {
              ...member,
              persona: t("你正在替 {name} 代笔：他没能及时发言。请从他的立场给出简短发言（1-3 句）。", { name: seatLabel(member) }),
            },
            {
              topic, boardContext, entries, round, isLastRound, expertDetail: null,
              signal, modelId: proxyModel, onBehalfOf: member.id,
              conversationId: teamRemote.conversationId,
            },
          );
          if (r.status === "aborted") break;
          if (r.status === "skipped" || r.status === "error") {
            // 代笔失败也留痕：这位席位在这一轮确实没有话，而且是"代笔没成功"这个原因
            recordTeamTurn(teamRemote, {
              round, member: { ...member },
              action: r.status === "skipped" ? "skipped" : "error",
              target: "", text: r.text, full: r.full,
            });
            continue;
          }
          await finishSeatTurn({
            round, member: { ...member }, action: r.action, target: r.target,
            text: r.text, full: r.full, onBehalfOf: member.id,
          }, r.runId);
          continue;
        }

        // skip：超时没开口。留痕，但不算发言（与失败、缺席同一类）
        const why = t("{name} 超时未发言", { name: seatLabel(member) });
        const silentEntry = addDebateEntry(member, "silent");
        finalizeEntry(silentEntry, "silent", "", why);
        showTeamNotice(why);
        recordTeamTurn(teamRemote, {
          round, member: { ...member }, action: "silent", target: "", text: why, full: why,
        });
        continue;
      }

      const r = await speakForSeat(member, {
        topic, boardContext, entries, round, isLastRound, signal,
        expertDetail: member.expertId ? expertDetails.get(member.expertId) : null,
        modelId: member.modelId,
        conversationId: teamRemote.conversationId,
      });
      if (r.status === "aborted") break;
      if (r.status === "skipped" || r.status === "error") {
        // 缺席也留一行账：星图上一位"从没开口"的成员和一位"没配 Key"的成员是两回事
        recordTeamTurn(teamRemote, {
          round, member: { ...member },
          action: r.status === "skipped" ? "skipped" : "error",
          target: "", text: r.text, full: r.full,
        });
        continue;
      }
      await finishSeatTurn({
        round, member: { ...member }, action: r.action, target: r.target,
        text: r.text, full: r.full,
      }, r.runId);
    }

    // 轮次用尽仍无决策：决策者强制拍板
    if (!verdict && isLastRound) {
      if (discussAbortController?.signal.aborted) break;
      verdict = await forceVerdict(topic, boardContext, entries, teamRemote);
      // 强制拍板的那份结论同样要人签字；不签就是"轮次用尽、未拍板"，不替用户结束这场
      if (verdict && teamSignoffOn) {
        const outcome = await requestTeamSignoff(verdict, teamRemote, verdict.round);
        if (outcome) {
          entries.push(outcome);
          recordTeamTurn(teamRemote, outcome);
          if (outcome.action !== "decided") verdict = null;
        }
      }
    }
  }

  if (btnStopDiscuss) {
    btnStopDiscuss.classList.add("hidden");
    btnStopDiscuss.disabled = true;
  }
  const stoppedManually = !!discussAbortController?.signal.aborted;
  const roundsPlayed = entries.reduce((acc, e) => (
    typeof e.round === "number" && e.round > acc ? e.round : acc
  ), 0);
  const summaryMarkdown = stoppedManually ? "" : renderDebateSummary(topic, entries, verdict);
  // 任务中心那一行跟着收掉：面板按 origin:"local" 认它，不再多一种行
  syncTeamTask(teamRemote, {
    state: stoppedManually ? "stopped" : "exited",
    exit_code: 0,
    output: String(verdict?.text || entries.at(-1)?.text || "").slice(-TEAM_TAIL_BUDGET),
    finished_at: Date.now(),
  });
  // 收尾先把在飞的落库等干，本地历史才知道这场讨论该不该标"仅本机记录"
  await finishTeamRemote(teamRemote, {
    status: stoppedManually ? "stopped" : verdict ? "decided" : "exhausted",
    rounds: roundsPlayed,
    verdictText: verdict?.text || "",
    summaryMarkdown,
  });
  // 手动停止的那场也要留历史：停在第 2 轮的辩论不是"没发生过"，用户回来要能接着看
  // （summaryMarkdown 对这种场次刻意留空——没有结论就不编一个结论）
  persistTeamSession({
    id: teamRemote.id,
    topic,
    createdAt: Date.now(),
    members: teamMembers.map(m => ({ ...m })),
    entries,
    verdictText: verdict?.text || "",
    summaryMarkdown,
    usage: { ...currentTeamUsage },
    remote: teamRemote.syncState === "ok",
    stopped: stoppedManually,
  });

  isDiscussing = false;
  discussAbortController = null;
  btnStartDiscuss.disabled = false;
  btnStartDiscuss.textContent = "开始讨论";
  // 面板就摆在眼前时不响第二声：这一场是用户看着跑完的，只有背后跑完的才需要人回来
  if (!teamPanelVisible()) {
    try {
      notifyTaskComplete(
        stoppedManually ? t("团队讨论已停止") : t("团队讨论已完成"),
        topic.slice(0, 24),
        "slate-team-discussion",
      );
    } catch (e) { /* 通知不是关键路径 */ }
  }
}

/** 轮次用尽仍无共识时，由决策者（或首位有 Key 的成员）给出最终方案 */

/** 停止正在进行的讨论 */
function stopDiscussion() {
  if (!isDiscussing || !discussAbortController) return;
  if (discussAbortController.signal.aborted) return; // 已停止过，等待循环收尾
  discussAbortController.abort();
  // 不在此重置状态：保持 controller 非空，后续成员请求拿到已中止的 signal 立即失败，
  // 不会发出不受控请求；isDiscussing/按钮由循环结束后统一收尾，避免并发第二场辩论
  // 提醒也只有一处：循环收尾按"这一场是否在背后结束"统一发，这里再发一次就是响两声
  const stopEl = document.createElement("div");
  stopEl.className = "team-stopped-notice";
  stopEl.textContent = t("讨论已手动停止");
  teamOutput.appendChild(stopEl);
}

async function forceVerdict(topic, boardContext, entries, teamRemote = null) {
  const decider = teamMembers.find(m => m.role === "decider") || teamMembers[0];
  const apiKey = decider ? getModelKey(decider.modelId) : "";
  if (!decider || !apiKey) return null;

  addRoundHeader(null, true);
  const entry = addDebateEntry(decider, "verdict");
  const systemPrompt = `你是 SLATE 团队协作成员：始终从自己的角色立场出发发表独立观点，直接给观点，不寒暄、不复述他人。${getToolsSystemPrompt({ minimal: true })}`;
  const userPrompt = `${decider.persona}\n\n议题: ${topic}${boardContext}\n\n辩论记录:\n${buildTranscript(entries)}\n\n讨论轮次已用尽。请综合各方观点，以【决策】开头给出最终方案、理由与取舍。`;

  let fullText = "";
  let failure = "";
  try {
    for await (const chunk of streamChat({
      model: decider.modelId,
      provider: findModel(decider.modelId)?.provider,
      base_url: findModel(decider.modelId)?.base_url,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      api_key: apiKey,
      temperature: 0.3,
      max_tokens: 800,
      stream: true,
      signal: discussAbortController?.signal,
    })) {
      fullText += chunk;
      entry.content.textContent = fullText;
      teamOutput.scrollTop = teamOutput.scrollHeight;
    }
  } catch (e) {
    if (discussAbortController?.signal.aborted) return null;
    failure = String(e?.message || e);
  }

  if (failure) {
    // 拍板失败不等于拍板：这句要是当成结论存下来，总结里就多出一个谁也没同意过的"最终方案"
    finalizeEntry(entry, "error", "", t("请求失败: {msg}", { msg: failure }));
    recordTeamTurn(teamRemote, {
      round: 0, member: { ...decider }, action: "error", target: "", text: failure, full: failure,
    });
    return null;
  }

  fullText = stripToolCalls(fullText);
  const parsed = parseDebateAction(fullText);
  finalizeEntry(entry, "verdict", parsed.target, parsed.content || fullText);
  addTeamUsage(`${systemPrompt}\n\n${userPrompt}`, fullText);

  const rec = {
    round: "最终决策", member: { ...decider }, action: "verdict", target: parsed.target,
    text: parsed.content || fullText, full: fullText,
  };
  entries.push(rec);
  // 强制拍板这一行不跑工具（上面只 strip 不 exec），所以没有 run_id，只有发言与边
  recordTeamTurn(teamRemote, rec, "");
  return rec;
}

function renderDebateSummary(topic, entries, verdict) {
  if (entries.length === 0) return "";

  const summaryEl = document.createElement("div");
  summaryEl.className = "team-summary";
  summaryEl.innerHTML = '<div class="team-summary-title">辩论摘要</div><div class="team-summary-content"></div>';
  teamOutput.appendChild(summaryEl);

  // 摘要只数真正发言的那几行：拍板行是"人签了字"的记录，不算一次发言（与星图、失败/缺席同一口径）
  const speech = entries.filter(e => SPEECH_ACTIONS.includes(e.action));
  const names = [...new Set(speech.map(e => e.member.name))];
  const actionCount = {};
  for (const e of speech) actionCount[e.action] = (actionCount[e.action] || 0) + 1;
  const countText = Object.entries(actionCount)
    .map(([k, n]) => `${t(DEBATE_ACTIONS[k] || k)} ${n}`).join(" · ");

  let summary = t("**议题**: {topic}", { topic }) + "\n\n";
  summary += t("**参与成员**: {names}", { names: names.join("、") }) + "\n\n";
  summary += t("**发言统计**: 共 {n} 条（{counts}）", { n: speech.length, counts: countText }) + "\n\n";
  if (verdict) {
    summary += t("**最终方案**（{name}）:", { name: verdict.member.name }) + "\n" + verdict.text;
  } else {
    summary += t("**结果**: 未达成明确决策");
  }

  summaryEl.querySelector(".team-summary-content").innerHTML = renderSimpleMarkdown(summary);
  teamOutput.scrollTop = teamOutput.scrollHeight;
  return summary;
}

function renderLoadedSession(session) {
  if (!session || !teamOutput) return;
  teamOutput.innerHTML = "";
  teamTopicInput.value = session.topic || "";

  const topicEl = document.createElement("div");
  topicEl.className = "team-topic";
  topicEl.textContent = t("议题: {topic}", { topic: session.topic || t("未命名讨论") });
  teamOutput.appendChild(topicEl);

  if (Array.isArray(session.entries)) {
    // 新版辩论记录：按轮次分组渲染
    let lastRound = null;
    for (const e of session.entries) {
      if (e.round !== lastRound) {
        addRoundHeader(e.round);
        lastRound = e.round;
      }
      const entry = addDebateEntry(e.member, e.action || "propose");
      finalizeEntry(entry, e.action || "propose", e.target || "", e.text || "");
    }
  } else {
    // 旧版单轮记录兼容
    for (const response of session.responses || []) {
      addTeamResponse(response.member, response.text || "");
    }
  }

  if (session.summaryMarkdown) {
    const summaryEl = document.createElement("div");
    summaryEl.className = "team-summary";
    summaryEl.innerHTML = '<div class="team-summary-title">讨论摘要</div><div class="team-summary-content"></div>';
    summaryEl.querySelector(".team-summary-content").innerHTML = renderSimpleMarkdown(session.summaryMarkdown);
    teamOutput.appendChild(summaryEl);
  }

  currentTeamUsage = {
    promptTokens: session.usage?.promptTokens || 0,
    completionTokens: session.usage?.completionTokens || 0,
    totalTokens: session.usage?.totalTokens || 0,
    messageCount: session.usage?.messageCount || 0,
  };
  renderTeamUsage();
}

/** 库里的 team_turns 反推成这一场的样子：本地历史只是缓存（50 场上限、换机器、清过
 *  localStorage 都会没有），全文落在库里，所以正文以库为准。 */
function sessionFromRemote(data, local = null) {
  const s = data?.session || {};
  const roster = Array.isArray(data?.members) ? data.members : [];
  const byId = new Map(roster.map(m => [m.id, m]));
  const entries = (Array.isArray(data?.turns) ? data.turns : [])
    .filter(turn => turn.fullText || turn.digest)
    .map(turn => ({
      round: turn.round,
      member: byId.get(turn.memberId) || { id: turn.memberId, name: turn.memberName },
      action: turn.action,
      target: (byId.get(turn.targetMemberId) || {}).name || "",
      text: turn.fullText || turn.digest,
    }));
  return {
    id: s.id,
    topic: s.topic,
    createdAt: s.createdAtMs,
    members: roster,
    entries,
    verdictText: s.verdict || "",
    summaryMarkdown: s.summaryMarkdown || "",
    usage: local?.usage || null,
    remote: true,
    stopped: s.status === "stopped",
  };
}

async function loadTeamSession(sessionId) {
  if (isDiscussing) return;
  const local = teamHistory.find(item => item.id === sessionId);
  if (local) renderLoadedSession(local);
  teamHistoryList?.querySelectorAll(".team-history-item").forEach(item => {
    item.classList.toggle("active", item.dataset.sessionId === sessionId);
  });
  // 本地已经有正文就不动画面；只有本地缺（被上限挤掉、老格式、清了缓存）才回库里取
  if (local && Array.isArray(local.entries) && local.entries.length > 0) return;
  let res;
  try {
    res = await get(`/events/team/${encodeURIComponent(sessionId)}`);
  } catch (e) {
    console.warn("[SLATE] 团队会话读取失败:", e?.message || e);
    return;
  }
  if (res?.code !== 0 || !res.data || !local && !res.data.session) return;
  renderLoadedSession(sessionFromRemote(res.data, local));
}

function addTeamResponse(member, text) {
  const el = document.createElement("div");
  el.className = "team-response";

  const header = document.createElement("div");
  header.className = "team-response-header";

  const avatar = document.createElement("span");
  avatar.className = "team-response-avatar";
  avatar.textContent = member.name.charAt(0);
  header.appendChild(avatar);

  const name = document.createElement("span");
  name.className = "team-response-name";
  name.textContent = member.name;
  header.appendChild(name);

  const model = document.createElement("span");
  model.className = "team-response-model";
  const modelCfg = findModel(member.modelId);
  model.textContent = modelCfg?.name || member.modelId;
  header.appendChild(model);

  el.appendChild(header);

  const content = document.createElement("div");
  content.className = "team-response-content";
  content.textContent = text;
  el.appendChild(content);

  teamOutput.appendChild(el);
  teamOutput.scrollTop = teamOutput.scrollHeight;
  return el;
}

function findModel(modelId) {
  // 用 store 的统一查法：它先翻注册表分组，再回落到用户自己添加的模型。
  // 团队面板原来只翻 state.modelRegistry 的分组，自定义/本地模型查不到 →
  // base_url 发不出去，后端 _find_model 认不出这个 id，只回「未知模型」，
  // 于是这位成员整场每一句都变成一格失败（界面看不出是配置问题）。
  return getModelDefinition(modelId);
}

function renderSimpleMarkdown(text) {
  return renderMarkdown(text);
}

// ── 工作流视图 ────────────────────────────

let wfSelect, wfDesc, wfInput, btnWfRun, wfRunStatus, wfNodeList, wfResultBar;
let wfList = [];
let wfRunning = false;
let wfAbortBtn = null;

const WF_STATUS_TEXT = {
  waiting: "等待",
  running: "运行中",
  success: "成功",
  failed: "失败",
  skipped: "跳过",
};

async function initWorkflowView() {
  wfSelect = document.getElementById("wf-select");
  wfDesc = document.getElementById("wf-desc");
  wfInput = document.getElementById("wf-input");
  btnWfRun = document.getElementById("btn-wf-run");
  wfRunStatus = document.getElementById("wf-run-status");
  wfNodeList = document.getElementById("wf-node-list");
  wfResultBar = document.getElementById("wf-result-bar");
  if (!wfSelect) return;

  // 讨论 / 工作流视图切换（不影响原有团队讨论功能）
  const discussView = document.getElementById("team-discuss-view");
  const workflowView = document.getElementById("team-workflow-view");
  const tabDiscuss = document.getElementById("btn-team-view-discuss");
  const tabWorkflow = document.getElementById("btn-team-view-workflow");
  const switchView = (isWorkflow) => {
    discussView?.classList.toggle("hidden", isWorkflow);
    workflowView?.classList.toggle("hidden", !isWorkflow);
    tabDiscuss?.classList.toggle("active", !isWorkflow);
    tabWorkflow?.classList.toggle("active", isWorkflow);
  };
  tabDiscuss?.addEventListener("click", () => switchView(false));
  tabWorkflow?.addEventListener("click", () => switchView(true));

  wfSelect.addEventListener("change", renderWfDesc);
  btnWfRun.addEventListener("click", runSelectedWorkflow);

  // 工作流停止按钮
  wfAbortBtn = document.getElementById("btn-wf-stop");
  if (wfAbortBtn) {
    wfAbortBtn.addEventListener("click", () => {
      stopWorkflow();
      wfAbortBtn.classList.add("hidden");
      wfRunStatus.textContent = t("工作流正在停止...");
    });
    wfAbortBtn.classList.add("hidden");
  }

  await refreshWorkflowList();
}

async function refreshWorkflowList() {
  try {
    wfList = await loadWorkflows();
    wfSelect.innerHTML = "";
    if (wfList.length === 0) {
      wfDesc.textContent = "暂无工作流，请在 backend/workflows/ 目录放置 JSON 定义文件";
      return;
    }
    for (const wf of wfList) {
      const opt = document.createElement("option");
      opt.value = wf.id;
      opt.textContent = wf.valid ? wf.name + t("（{n} 节点）", { n: wf.node_count }) : wf.name + t("（定义非法）");
      wfSelect.appendChild(opt);
    }
    renderWfDesc();
  } catch (e) {
    wfDesc.textContent = t("工作流列表加载失败: {msg}", { msg: e.message });
  }
}

function renderWfDesc() {
  const wf = wfList.find(w => w.id === wfSelect.value);
  if (!wf) { wfDesc.textContent = ""; return; }
  wfDesc.textContent = wf.valid
    ? (wf.description || "") + t("（节点 {n} · 依赖边 {m}）", { n: wf.node_count, m: wf.edge_count })
    : t("该工作流定义非法：{msg}", { msg: wf.error });
}

function makeWfIo(label, text) {
  const box = document.createElement("div");
  box.className = "wf-node-io";
  const labelEl = document.createElement("div");
  labelEl.className = "wf-node-io-label";
  labelEl.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = text;
  box.appendChild(labelEl);
  box.appendChild(pre);
  return box;
}

function renderWfNodeRows(wf) {
  wfNodeList.innerHTML = "";
  // 按拓扑顺序展示（后端已返回 order）
  const orderIndex = new Map((wf.order || []).map((id, i) => [id, i]));

  const nodes = [...(wf.nodes || [])].sort((a, b) =>
    (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0)
  );
  for (const node of nodes) {
    const row = document.createElement("div");
    row.className = "wf-node";
    row.dataset.nodeId = node.id;
    row.dataset.status = "waiting";

    const head = document.createElement("div");
    head.className = "wf-node-head";

    const statusEl = document.createElement("span");
    statusEl.className = "wf-node-status";
    statusEl.textContent = WF_STATUS_TEXT.waiting;
    head.appendChild(statusEl);

    const nameEl = document.createElement("span");
    nameEl.className = "wf-node-name";
    nameEl.textContent = node.name;
    head.appendChild(nameEl);

    const bindEl = document.createElement("span");
    bindEl.className = "wf-node-bind";
    bindEl.textContent = node.skill ? `${node.skill}` : "";
    head.appendChild(bindEl);

    const caret = document.createElement("span");
    caret.className = "wf-node-caret";
    caret.textContent = "▸";
    head.appendChild(caret);

    const detail = document.createElement("div");
    detail.className = "wf-node-detail hidden";

    // 这一行本身就是"展开/收起"的按钮：补角色、键盘与 aria-expanded（▸ 只是装饰）
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.setAttribute("aria-expanded", "false");
    const toggleDetail = () => {
      head.setAttribute("aria-expanded", String(detail.classList.toggle("hidden") === false));
    };
    head.addEventListener("click", toggleDetail);
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleDetail();
      }
    });
    row.appendChild(head);
    row.appendChild(detail);
    wfNodeList.appendChild(row);
  }
}

function updateWfNodeRow(rec) {
  const row = wfNodeList?.querySelector(`.wf-node[data-node-id="${rec.id}"]`);
  if (!row) return;
  row.dataset.status = rec.status;
  row.querySelector(".wf-node-status").textContent = WF_STATUS_TEXT[rec.status] || rec.status;
  if (rec.modelLabel) row.querySelector(".wf-node-bind").textContent = rec.modelLabel;

  const detail = row.querySelector(".wf-node-detail");
  detail.innerHTML = "";
  if (rec.error) {
    const errEl = document.createElement("div");
    errEl.className = "wf-node-error";
    errEl.textContent = `${rec.error}`;
    detail.appendChild(errEl);
  }
  if (rec.inputPreview) detail.appendChild(makeWfIo("输入", rec.inputPreview));
  if (rec.output) detail.appendChild(makeWfIo("输出", rec.output));
}

async function runSelectedWorkflow() {
  if (wfRunning) return;
  const userInput = wfInput.value.trim();
  if (!userInput) {
    wfRunStatus.textContent = "请先输入任务需求";
    return;
  }
  const selected = wfList.find(w => w.id === wfSelect.value);
  if (!selected) return;
  if (!selected.valid) {
    wfRunStatus.textContent = t("该工作流定义非法，无法执行：{msg}", { msg: selected.error });
    return;
  }

  wfRunning = true;
  btnWfRun.disabled = true;
  wfAbortBtn?.classList.remove("hidden");
  wfResultBar.innerHTML = "";
  wfRunStatus.textContent = "加载工作流定义…";

  try {
    const wf = await getWorkflow(selected.id);
    renderWfNodeRows(wf);

    const total = (wf.nodes || []).length;
    let doneCount = 0;
    wfRunStatus.textContent = t("运行中（0/{n}）…", { n: total });

    const result = await runWorkflow(wf, userInput, teamMembers, {
      onNode: (rec) => {
        updateWfNodeRow(rec);
        if (["success", "failed", "skipped"].includes(rec.status)) {
          doneCount += 1;
          wfRunStatus.textContent = doneCount < total
            ? t("运行中（{done}/{n}）…", { done: doneCount, n: total })
            : "工作流已结束，正在将产物写入知识库…";
        }
      },
    });

    const okCount = result.order.filter(id => result.records[id].status === "success").length;
    try {
      const docId = await saveRunToKnowledge(wf, result);
      wfResultBar.textContent = "";
      const ok = document.createElement("span");
      ok.className = "wf-result-ok";
      ok.textContent = t("{ok}/{n} 节点成功 · 产物已写入知识库（{title}），可在记忆面板查看", { ok: okCount, n: total, title: docId });
      wfResultBar.appendChild(ok);
    } catch (e) {
      wfResultBar.textContent = "";
      const err = document.createElement("span");
      err.className = "wf-result-error";
      err.textContent = t("节点成功 {ok}/{n}，但写入知识库失败: {msg}", { ok: okCount, n: total, msg: e.message });
      wfResultBar.appendChild(err);
    }
    wfRunStatus.textContent = "";
    wfAbortBtn?.classList.add("hidden");
    notifyTaskComplete(t("工作流完成"), t("{ok}/{n} 节点成功", { ok: okCount, n: total }));
  } catch (e) {
    wfRunStatus.textContent = "";
    wfResultBar.textContent = "";
    wfAbortBtn?.classList.add("hidden");
    const err = document.createElement("span");
    err.className = "wf-result-error";
    err.textContent = t("工作流执行失败: {msg}", { msg: e.message });
    wfResultBar.appendChild(err);
  } finally {
    wfRunning = false;
    btnWfRun.disabled = false;
  }
}

// ── 右栏「待你签字」──────────────────────────────────────────
// 把散在发言流与名册里的"停点"聚合成一份清单：等你签字、等谁开口、谁不在场。
// 条目只做定位（点一下滚到那一行），不复制按钮——同一个动作有两处可点，
// 迟早有一处是死的。发言流的写入点有七八处，所以用 MutationObserver 兜住，
// 不在每个渲染函数里补一句调用（漏一处就是右栏长期停在旧现场）。
let agendaRaf = 0;
let agendaObserver = null;

function scheduleTeamAgenda() {
  if (agendaRaf) return;
  agendaRaf = requestAnimationFrame(() => { agendaRaf = 0; renderTeamAgenda(); });
}

function teamAgendaItem(text, tone, target) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "team-agenda-item" + (tone ? " " + tone : "");
  btn.textContent = text;
  if (!target) {
    btn.disabled = true;
    return btn;
  }
  btn.addEventListener("click", () => {
    target.scrollIntoView({ block: "center" });
    target.classList.add("team-agenda-focus");
    setTimeout(() => target.classList.remove("team-agenda-focus"), 1200);
  });
  return btn;
}

function renderTeamAgenda() {
  const host = document.getElementById("team-agenda-list");
  if (!host) return;
  host.innerHTML = "";
  const signoff = teamOutput?.querySelector(".debate-entry.action-awaiting");
  if (signoff) host.appendChild(teamAgendaItem(t("等你签字"), "is-signoff", signoff));
  for (const row of teamOutput?.querySelectorAll(".debate-entry.action-waiting") || []) {
    const name = row.querySelector(".debate-name")?.textContent || "";
    host.appendChild(teamAgendaItem(t("等 {name} 发言", { name }), "is-waiting", row));
  }
  const absent = [];
  for (const card of teamMembersArea?.querySelectorAll(".team-member-card.is-human") || []) {
    const dot = card.querySelector(".team-member-presence");
    if (!dot || dot.classList.contains("online")) continue;
    const name = card.querySelector(".team-member-name")?.textContent || "";
    absent.push(teamAgendaItem(
      dot.classList.contains("away") ? t("{name} 暂离", { name }) : t("{name} 未加入", { name }),
      "is-absent", card));
  }
  for (const item of absent) host.appendChild(item);
  const count = host.querySelectorAll(".team-agenda-item").length;
  if (!count) {
    const span = document.createElement("span");
    span.className = "team-agenda-empty";
    span.textContent = t("没有待办");
    host.appendChild(span);
  }
  const head = document.querySelector(".team-agenda-header");
  if (head) {
    head.dataset.count = String(count);
    head.classList.toggle("has-items", count > 0);
  }
}

function initTeamAgenda() {
  renderTeamAgenda();
  if (agendaObserver || typeof MutationObserver !== "function") return;
  agendaObserver = new MutationObserver(scheduleTeamAgenda);
  for (const el of [teamOutput, teamMembersArea]) {
    if (el) agendaObserver.observe(el, { childList: true, subtree: true, characterData: true });
  }
}

// ── 初始化 ─────────────────────────────────

function initTeamPanel() {
  teamMembersArea = document.getElementById("team-members-area");
  teamTopicInput = document.getElementById("team-topic-input");
  btnStartDiscuss = document.getElementById("btn-start-discuss");
  teamOutput = document.getElementById("team-output");
  showTeamEmptyState();
  btnAddMember = document.getElementById("btn-add-member");
  teamHistoryList = document.getElementById("team-history-list");
  teamUsageBar = document.getElementById("team-usage-bar");
  btnNewTeamDiscussion = document.getElementById("btn-new-team-discussion");

  // 默认成员
  teamMembers = DEFAULT_MEMBERS.map(m => normalizeSeat({ ...m }));

  // 预设选择器
  const presetSelect = document.getElementById("team-preset-select");
  if (presetSelect) {
    presetSelect.innerHTML = "";
    // 自定义选项
    const customOpt = document.createElement("option");
    customOpt.value = "custom";
    customOpt.textContent = t("自定义");
    presetSelect.appendChild(customOpt);
    // 预设选项
    for (const preset of TEAM_PRESETS) {
      const opt = document.createElement("option");
      opt.value = preset.id;
      opt.textContent = t(preset.name);
      presetSelect.appendChild(opt);
    }
    // 默认选中第一个预设
    presetSelect.value = "classic";
    presetSelect.addEventListener("change", () => {
      applyTeamPreset(presetSelect.value);
    });
  }
  loadTeamHistory();
  renderTeamHistory();
  renderTeamUsage();
  renderTeamMembers();

  btnAddMember.addEventListener("click", () => {
    teamMembers.push(normalizeSeat({
      id: makeId("m"),
      name: t("成员{n}", { n: teamMembers.length + 1 }),
      modelId: "gpt-5.6-terra",
      persona: "你是团队成员。简洁发表观点（1-3句）。",
      role: "member",
    }));
    renderTeamMembers();
  });

  // 真人席位：发一条邀请链接，他的话由议事厅收件箱递回来（见 awaitHumanTurn）
  const btnAddHumanSeat = document.getElementById("btn-add-human-seat");
  btnAddHumanSeat?.addEventListener("click", () => {
    teamMembers.push(normalizeSeat({
      id: makeId("h"),
      kind: "human",
      name: t("成员{n}", { n: teamMembers.length + 1 }),
      role: "member",
      caps: ["speak"],
      fallback: "delegate",
      timeoutSec: SEAT_DEFAULT_TIMEOUT_SEC,
    }));
    renderTeamMembers();
  });

  // 在线态刻意**不挂定时器**：团队这边只有一条唤醒链路（bg_tasks），再多一个 setInterval
  // 就是第二条定时源。在线只是一条提示，所以在"人真的会看"的时刻刷——进面板、发邀请、
  // 等某人发言的每一跳（见 awaitHumanTurn）。
  refreshTeamPresence();

  btnStartDiscuss.addEventListener("click", startDiscussion);

  // 停止按钮
  btnStopDiscuss = document.getElementById("btn-stop-discuss");
  if (btnStopDiscuss) {
    btnStopDiscuss.addEventListener("click", stopDiscussion);
    btnStopDiscuss.classList.add("hidden");
  }

  // 最大辩论轮数
  const maxRoundsSelect = document.getElementById("team-max-rounds");

  if (maxRoundsSelect) {
    maxRounds = parseInt(maxRoundsSelect.value, 10) || 5;
    maxRoundsSelect.addEventListener("change", () => {
      maxRounds = parseInt(maxRoundsSelect.value, 10) || 5;
    });
  }

  // 决策要不要人签字：与轮数一样是这一场的开关，不落盘
  const signoffToggle = document.getElementById("team-signoff-toggle");
  if (signoffToggle) {
    signoffToggle.checked = teamSignoffOn;
    signoffToggle.addEventListener("change", () => {
      teamSignoffOn = !!signoffToggle.checked;
    });
  }

  btnNewTeamDiscussion?.addEventListener("click", () => {
    if (isDiscussing) return;
    teamOutput.innerHTML = "";
    showTeamEmptyState();
    teamTopicInput.value = "";
    resetTeamUsage();
    teamHistoryList?.querySelectorAll(".team-history-item.active").forEach(item => item.classList.remove("active"));
    teamTopicInput.focus();
  });

  // 工作流视图初始化（讨论视图之外的新能力）
  initWorkflowView();
  initTeamAgenda();
}

// 右栏任务中心点「停止」时，团队这一族由这里收尾（不认识 team: 前缀的一律交回别的登记方）。
// 与后台子代理共用同一个停止器登记表，就是不再写第二条唤醒链路的代价与好处。
registerLocalTaskStopper(async (taskId) => {
  if (!String(taskId || "").startsWith("team:")) return false;
  stopDiscussion();
  return true;
});

export { initTeamPanel, stopDiscussion };
