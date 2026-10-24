/**
 * 自动会话标题
 *
 * 会话标题原本就是「首条消息前 30 字」，任务一长列表里全是同一句开头，认不出哪场是哪场。
 * 这里在首轮跑完后请模型补一个短标题换上，并且只在这一场还挂着那种占位标题时动手：
 * 你手动改过的名字、后台任务与团队对话自己命好的名字一概不碰。全程静默——列表上那行字
 * 变了就是回执，不额外弹提示（每轮末尾自己发请求的功能都不该打扰人）。
 *
 * 两处判据是同一件事的两半，缺一半都会闯祸：
 * ① 发请求之前查占位——不然每轮末尾都多付一趟；
 * ② 写库之前再查一遍——从请求发出到 PATCH 之间用户可能已经手动改过名，
 *    那时无脑覆盖就是「我改了名字，它自己又变回去了」。
 */

import { state, notify, messagesOf } from "../store.js?v=20261024-001";
import { aiModelFor, isAiFeatureOn } from "./ai_features.js?v=20261024-001";
import { patch, streamChat, REASONING_PREFIX, REASONING_INLINE_PREFIX } from "./api.js?v=20261024-001";

// 24 字是侧栏一行放得下的长度；后端 PATCH 还会再截到 60，这里先按界面截。
const MAX_TITLE_CHARS = 24;
const QUESTION_CHARS = 600;
const ANSWER_CHARS = 400;
// 建会话时的兜底名（chat.js 与后端各有一份），空标题也按占位看待。
const FALLBACK_TITLE = "新对话";

function textOf(msg) {
  return String(msg?.display || msg?.content || "").trim();
}

/**
 * 这一场的标题还是占位吗。占位 = 后端/前端建场时那种「首条消息截一段」，
 * 或者干脆是空的（只发文件的首条消息曾被后端写成空标题）。
 */
export function isPlaceholderTitle(title, seeds) {
  const cur = String(title || "").trim();
  if (!cur) return true;
  for (const raw of seeds) {
    const seed = String(raw || "").trim();
    if (!seed) continue;
    const head = seed.slice(0, 30);
    if (cur === head || cur === `${head}...`) return true;
  }
  return false;
}

/** 标题的来历线索：首条消息原文、随消息进来的第一个文件名、建场兜底名。 */
function seedsOf(firstUser) {
  const seeds = [textOf(firstUser), FALLBACK_TITLE];
  const firstName = firstUser?.files?.[0]?.name;
  if (firstName) seeds.push(firstName);
  return seeds;
}

/** 话术只给模型看，不进 i18n（与压缩摘要、记忆蒸馏同一口径）。 */
function buildTitlePrompt(question, answer) {
  return `给这轮对话起一个会话标题。

要求：
- 用与「用户消息」相同的语言
- 不超过 12 个汉字（用英文就不超过 6 个单词）
- 只输出标题本身：不要引号、不要句末标点、不要前缀说明、不要换行
- 概括用户要做的事，不要写成「用户询问…」「助手回答…」这类叙述

用户消息：
${question.slice(0, QUESTION_CHARS)}

助手回复（节选，只用来判断这件事的性质）：
${answer.slice(0, ANSWER_CHARS)}`;
}

// 只有首尾正好配成一对时才剥掉：模型给整条标题加引号很常见，但「【任务】整理导出流程」
// 这种开头带方括号、结尾不带的，括号是标题的一部分，按字符类硬剥会留下一个孤立的】。
const TITLE_PAIRS = [["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"],
  ["「", "」"], ["『", "』"], ["《", "》"], ["【", "】"], ["[", "]"], ["(", ")"], ["（", "）"]];

function unwrapTitle(s) {
  let out = s;
  for (let guard = 0; guard < 6; guard++) {
    const pair = TITLE_PAIRS.find(([a, b]) =>
      out.startsWith(a) && out.endsWith(b) && out.length > a.length + b.length);
    if (!pair) break;
    out = out.slice(pair[0].length, out.length - pair[1].length).trim();
  }
  return out;
}

/**
 * 模型爱把标题裹在引号、破折号或「标题：」里，也可能整段吐回来。
 * 这里只取第一行、剥掉这些包裹，再按界面宽度截断；剩下不足两个字就当作没起出来。
 */
export function sanitizeTitle(raw) {
  let s = String(raw || "").split(/\r?\n/)[0] || "";
  s = s.replace(/^\s*(?:[-*·•]+|#+)\s*/, "");
  s = s.replace(/^\s*(?:会话)?标题\s*[:：]\s*/, "");
  s = s.replace(/^\s*title\s*[:：]\s*/i, "");
  s = unwrapTitle(s.trim());
  s = s.replace(/[。．！!？?；;，,]+$/, "");
  s = unwrapTitle(s.trim());
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > MAX_TITLE_CHARS) s = s.slice(0, MAX_TITLE_CHARS).trim();
  if (s.length < 2 || s === FALLBACK_TITLE) return "";
  return s;
}

/**
 * 首轮结束后试着给这一场起个名。返回是否真的改了标题。
 * 任何一步不成立就静默返回 false：这是锦上添花的后台请求，不值得为它弹错。
 *
 * opts: { convId, model（aiModelFor 的兜底模型）, onApplied（改成功后回调，桌面用来刷列表）}
 */
export async function autoGenerateSessionTitle({ convId, model, onApplied } = {}) {
  try {
    if (!convId) return false;
    if (!isAiFeatureOn("session_title")) return false;

    const thread = messagesOf(convId).filter(m => !m.hidden && (m.role === "user" || m.role === "assistant"));
    const firstUser = thread.find(m => m.role === "user");
    const lastAssistant = [...thread].reverse().find(m => m.role === "assistant");
    // 只管首轮：第二句一说，这场要么已有名字、要么用户已经自己起过名了。
    if (thread.filter(m => m.role === "user").length !== 1) return false;
    if (!firstUser || !lastAssistant) return false;

    const seeds = seedsOf(firstUser);
    const entry = () => (state.conversations || []).find(c => c?.id === convId);
    const conv = entry();
    if (!conv || !isPlaceholderTitle(conv.title, seeds)) return false;

    const question = textOf(firstUser);
    const answer = textOf(lastAssistant);
    if (!question && !answer) return false;

    const target = aiModelFor("session_title", model || state.currentModel);
    if (!target.usable) return false;

    let raw = "";
    for await (const chunk of streamChat({
      model: target.id,
      provider: target.provider,
      messages: [{ role: "user", content: buildTitlePrompt(question, answer) }],
      api_key: target.key,
      base_url: target.base_url,
      temperature: 0.2,
      max_tokens: 64,
      stream: true,
    })) {
      // 带思考的模型把 reasoning 混在同一条流里，前缀是控制标记，不能拼进标题
      const s = String(chunk || "");
      if (s.startsWith(REASONING_PREFIX) || s.startsWith(REASONING_INLINE_PREFIX)) continue;
      raw += s;
    }

    const title = sanitizeTitle(raw);
    if (!title) return false;
    // 请求在途的这几秒里用户可能已经改过名——再认一次，只覆盖还是占位的那一种
    const fresh = entry();
    if (!fresh || !isPlaceholderTitle(fresh.title, seeds)) return false;
    if (String(fresh.title || "").trim() === title) return false;

    const res = await patch(`/chat/conversations/${convId}`, { title });
    if (res?.code !== 0) return false;

    fresh.title = title;
    notify("conversations", state.conversations);
    if (typeof onApplied === "function") {
      try { await onApplied(title); } catch (e) { /* 列表没刷成不算失败：库里已经是新标题 */ }
    }
    return true;
  } catch (e) {
    console.warn("自动会话标题生成失败:", e);
    return false;
  }
}
