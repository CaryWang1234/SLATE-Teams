/**
 * 「优化提示词」：把输入框里的草稿交给模型改写一遍，改完先比对，采用才回填。
 *
 * 这条链路上最贵的错是"没确认就动了用户的稿子"，所以要不要回填只由审阅弹窗的返回值决定：
 * 弹窗的四条退出通道里只有「采用」为 true，其余（保留原文 / ESC / × / 点背景）一律不写回。
 * 另一条同等要紧的：等模型的那几秒输入框还能打字、语音也还在往里头写，所以回填前先确认
 * 草稿没被改过——覆盖掉用户刚写的字，比不优化糟得多。
 */

import { state } from "../store.js?v=20261017-001";
import { aiModelFor, aiFeatureBlocked } from "../services/ai_features.js?v=20261017-001";
import { streamChat, REASONING_PREFIX, REASONING_INLINE_PREFIX } from "../services/api.js?v=20261017-001";
import { dlgReview, dlgToast } from "../services/dialog.js?v=20261017-001";
import { t } from "../services/i18n.js?v=20261017-001";
import { reportError } from "../services/error_sink.js?v=20261017-001";

// 发给模型的话术是载荷，不进 i18n 字典（约定：t() 只包用户可见文本）
function buildPolishPrompt(draft) {
  return `你是提示词改写助手。请把下面这段用户草稿改写得更清楚、更可执行，只输出改写后的正文。

要求：
1. 保持原意，不要新增用户没提到的目标、步骤或细节
2. 保持与草稿相同的语言
3. 草稿里的 @提及（@skill:、@tool:、@mcp:、@file:）、代码、路径、数字必须原样保留
4. 不要解释，不要加前后缀，不要用代码块包裹

草稿：
"""
${draft}
"""`;
}

/** 模型爱把结果裹进 ```，或前面加一句"这是改写后的版本"：只取正文。 */
export function extractRevised(raw) {
  const s = String(raw || "").trim();
  const fenced = s.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```\s*$/);
  return (fenced ? fenced[1] : s).trim();
}

/** 回填走一次 input 事件：自适应高度、草稿暂存、@提及高亮都挂在这个事件上。 */
function applyToInput(input, text) {
  input.value = text;
  input.dispatchEvent(new Event("input"));
  input.focus();
}

async function polishDraft() {
  if (aiFeatureBlocked("prompt_polish")) return;
  const input = document.getElementById("chat-input");
  const btn = document.getElementById("btn-polish");
  if (!input || !btn) return;
  const base = input.value;
  const draft = base.trim();
  if (!draft) { dlgToast(t("先写点内容再优化")); return; }

  const target = aiModelFor("prompt_polish", state.currentModel);
  if (!target.usable) { dlgToast(t("请先选择模型并配置 API Key")); return; }

  // 按钮按下去就 disabled：这既是"跑了就别再点一次"的闸门（免得白付两趟钱），
  // 也让请求在途时输入框右端看得出它在忙。
  btn.disabled = true;
  btn.classList.add("polish-busy");
  btn.title = t("优化中…");
  try {
    let out = "";
    for await (const chunk of streamChat({
      model: target.id,
      provider: target.provider,
      messages: [{ role: "user", content: buildPolishPrompt(draft) }],
      api_key: target.key,
      base_url: target.base_url,
      temperature: 0.3,
      max_tokens: 2048,
      stream: true,
    })) {
      // 带思考的模型（DeepSeek/GLM/o 系）把 reasoning 也混在这条流里，前缀是控制标记。
      // 这里的输出会原样回填输入框，所以思考必须整段丢掉，不能拼进去。
      const s = String(chunk || "");
      if (s.startsWith(REASONING_PREFIX) || s.startsWith(REASONING_INLINE_PREFIX)) continue;
      out += chunk;
    }

    const revised = extractRevised(out);
    if (!revised) { dlgToast(t("模型没有给出可用的改写")); return; }
    if (input.value !== base) { dlgToast(t("草稿已改动，请重新优化")); return; }
    if (!await dlgReview({ original: base, revised })) return;
    // 弹窗开着的时候语音听写照样能写字，写回前再认一次
    if (input.value !== base) { dlgToast(t("草稿已改动，请重新优化")); return; }
    applyToInput(input, revised);
  } catch (e) {
    reportError(e, "prompt_polish");
    dlgToast(t("优化失败：{msg}", { msg: String(e?.message || e).slice(0, 80) }));
  } finally {
    btn.disabled = false;
    btn.classList.remove("polish-busy");
    btn.title = t("优化提示词");
  }
}

export function initPromptPolish() {
  const btn = document.getElementById("btn-polish");
  if (!btn) return;
  btn.addEventListener("click", () => polishDraft());
}

export { polishDraft };
