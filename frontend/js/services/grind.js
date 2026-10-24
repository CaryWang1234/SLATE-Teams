/**
 * SLATE 磨墨模式服务：把粗糙想法研磨为结构化墨稿（任务书）。
 * 提示词注入、墨迹解析、墨稿检测与三个动作（送入目标 / 投到白板 / 存为模板）。
 */

import { get, post, del, patch } from "./api.js?v=20261024-001";

const MAX_ROUNDS = 10;

// 收墨触发词（用户输入命中即终止追问）
const COLLECT_RE = /^(收墨|够了|就这样|可以了|出墨稿|结束磨墨)\s*[。！!.]*\s*$/;

// ── 提示词 ─────────────────────────────────

// 磨墨全程（含每一轮追问与收墨）都是"只研磨不施工"：这条不能只挂在接墨那一条上，
// 否则第 2 轮起就只剩「继续研磨」，加上可用的工具与 Autopilot 章程，模型会自己开工。
const NO_EXEC = "只研磨不施工：这一阶段不调用任何工具、不要改文件、不要跑命令、不开始实现；产出只有追问、墨迹状态与（收墨时）墨稿";

const RULES = [
  "追问纪律：每条回复只问一个缺口；能给 A/B 选项就给选项（选项简短、互斥），尽量少问开放式问题",
  "不要寒暄、不要重复已确认内容、不要一次问多个问题",
  NO_EXEC,
  "用户回复「收墨 / 够了 / 就这样」或信息已足够时，立即进入收墨输出墨稿",
].join("\n");

const STATUS_FORMAT = `回复末尾必须附墨迹状态块（严格按此格式，每行一条，简短）：
【墨迹】
✔ 已定项内容
✘ 未知项内容`;

const DRAFT_FIELDS = "title, goal, audience, deliverables, acceptance, boundaries, suggested_path, open_questions";

const DRAFT_FORMAT = `收墨时输出：先用 1-2 句总结共识，再给出完整墨稿，JSON 放在 \`\`\`json 代码块中，字段：${DRAFT_FIELDS}（deliverables/acceptance/boundaries/open_questions 为数组，其余为字符串；未知项写入 open_questions，不要编造）。`;

function firstRoundPrompt(idea) {
  return `[磨墨模式 · 接墨]
你现在是 SLATE 的磨墨助手：通过有节奏的追问，把粗糙想法研磨成可执行的任务书（墨稿）。最多追问 ${MAX_ROUNDS} 轮。
${RULES}
${STATUS_FORMAT}
${DRAFT_FORMAT}

本轮是接墨，请：先用 1-2 句复述想法核心；再列出需厘清的缺口清单（3-5 项，编号）；最后只针对第一个缺口提问。

用户原始想法：${idea}`;
}

function grindRoundPrompt(session) {
  const round = session.round;
  return `[磨墨模式 · 磨墨 · ${round}/${MAX_ROUNDS} 轮]
继续研磨：只问下一个最重要的缺口，选择题优先。${round >= MAX_ROUNDS ? "已达追问上限，本轮直接收墨输出墨稿。" : `还剩 ${MAX_ROUNDS - round} 轮，若信息已足够可提前收墨。`}
${NO_EXEC}
${STATUS_FORMAT}
${DRAFT_FORMAT}`;
}

function collectingPrompt() {
  return `[磨墨模式 · 收墨]
停止追问。基于以上所有对话信息，输出最终墨稿：先用 1-2 句总结共识，再给出完整 JSON。未知项放入 open_questions。
${NO_EXEC}要动工请等用户点「送入目标模式」。
${DRAFT_FORMAT}`;
}

// ── 墨迹解析 ────────────────────────────────

/**
 * 从助手回复中解析【墨迹】状态块。
 * 返回 { resolved: string[], unknown: string[] }；无状态块返回 null。
 */
function parseInkStatus(content) {
  const text = String(content || "");
  const m = text.match(/【墨迹】([\s\S]*?)(?=\n\s*\n[^✔✘\-\*\s]|\n```|$)/);
  const block = m ? m[1] : text;
  if (!m && !/[✔✘]/.test(text)) return null;

  const resolved = [];
  const unknown = [];
  for (const line of block.split("\n")) {
    const t = line.trim();
    if (t.startsWith("✔")) resolved.push(t.replace(/^✔\s*/, "").trim());
    else if (t.startsWith("✘")) unknown.push(t.replace(/^✘\s*/, "").trim());
    else if (/^[-*]\s+/.test(t)) {
      // 容错：无序列表形式按内容归入未知
      unknown.push(t.replace(/^[-*]\s+/, "").trim());
    }
  }
  if (resolved.length === 0 && unknown.length === 0) return null;
  return { resolved: resolved.filter(Boolean), unknown: unknown.filter(Boolean) };
}

/**
 * 检测回复中的墨 JSON（代码块优先，回退 JSON）。
 * 要求 goal、title 字段才认定为墨稿。
 */
function detectDraft(content) {
  const text = String(content || "");
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  if (blocks.length === 0) {
    const bare = text.match(/\{[\s\S]*"goal"[\s\S]*\}/);
    if (bare) blocks.push(bare[0]);
  }
  for (const b of blocks) {
    try {
      const obj = JSON.parse(b.trim());
      if (obj && typeof obj === "object" && !Array.isArray(obj) && (obj.goal || obj.title)) {
        return obj;
      }
    } catch {}
  }
  return null;
}

// ── 会话状态（后端持久化） ──────────────────

async function startSession(convId, idea) {
  const res = await post("/grind/sessions", { conversation_id: convId, idea });
  return res.code === 0 ? res.data : null;
}

async function getSession(convId) {
  if (!convId) return null;
  const res = await get(`/grind/sessions/${convId}`);
  const s = res.code === 0 ? res.data : null;
  return s && s.state !== "idle" ? s : null;
}

async function patchSession(convId, patchData) {
  const res = await patch(`/grind/sessions/${convId}`, patchData);
  return res.code === 0 ? res.data : null;
}

async function collectSession(convId) {
  const res = await post(`/grind/sessions/${convId}/collect`, {});
  return res.code === 0 ? res.data : null;
}

async function endSession(convId) {
  await del(`/grind/sessions/${convId}`);
}

// ── 墨稿动作 ────────────────────────────────

/** 墨稿转目标任务描述 */
function draftToHarnessTask(draft) {
  const lines = [
    `【磨墨墨稿 · ${draft.title || "未命名任务"}】`,
    `目标：${draft.goal || ""}`,
  ];
  if (draft.audience) lines.push(`受众：${draft.audience}`);
  if (Array.isArray(draft.deliverables) && draft.deliverables.length) {
    lines.push(`交付物：\n${draft.deliverables.map(d => `  - ${d}`).join("\n")}`);
  }
  if (Array.isArray(draft.acceptance) && draft.acceptance.length) {
    lines.push(`验收标准：\n${draft.acceptance.map(d => `  - ${d}`).join("\n")}`);
  }
  if (Array.isArray(draft.boundaries) && draft.boundaries.length) {
    lines.push(`边界与限制：\n${draft.boundaries.map(d => `  - ${d}`).join("\n")}`);
  }
  if (draft.suggested_path) lines.push(`建议路径：${draft.suggested_path}`);
  if (Array.isArray(draft.open_questions) && draft.open_questions.length) {
    lines.push(`开放问题（自行合理假设并注明）：\n${draft.open_questions.map(d => `  - ${d}`).join("\n")}`);
  }
  return lines.join("\n");
}

/** 墨稿转白板卡片（结构与 whiteboard.js saveCard 一致） */
function draftToBoardCard(draft) {
  return {
    id: `c${Date.now().toString(36)}`,
    title: `墨稿 · ${draft.title || "未命名"}`,
    body: draft.goal || JSON.stringify(draft, null, 2).slice(0, 200),
    arrows: [],
    color: "default",
  };
}

/** 墨稿转知识库模板文字 */
async function saveDraftAsTemplate(draft) {
  const res = await post("/knowledge/docs", {
    title: `磨墨模板 · ${draft.title || "未命名"}`,
    source: "grind-mode",
    kind: "grind-template",
    content: JSON.stringify(draft, null, 2),
    metadata: { created_from: "grind" },
  });
  return res.code === 0;
}

export {
  MAX_ROUNDS, COLLECT_RE,
  firstRoundPrompt, grindRoundPrompt, collectingPrompt,
  parseInkStatus, detectDraft,
  startSession, getSession, patchSession, collectSession, endSession,
  draftToHarnessTask, draftToBoardCard, saveDraftAsTemplate,
};
