/**
 * AI 辅助功能登记表
 * 除「对话 / 团队对话 / 提示词工厂」以外，所有会自己去找模型要结果的功能都在这一张
 * 表上挂号：设置页据此渲染「开关 + 选模型」，各调用点据此决定这次到底跑不跑、用哪个模型。
 *
 * 为什么是一张表而不是十几个设置字段：一条持久化链（state 声明 / builder / 共享块 /
 * 两条读盘 / 后端白名单）要钉十几个字段会散成几十处，登记表只需要一个 aiHelpers 对象；
 * 以后加功能改这张表一行 + 调用点一行。
 *
 * 默认全开：这些功能原本就都在跑，默认关会让升级后的观感从「什么都没变」变成「功能没了」。
 * mode 只是给人看的标签：自动 = 后台自己会发请求，手动 = 你点一下才发，模型调用 = 由模型自己决定调不调。
 */

import { state, getModelKey, savePersistent, notify } from "../store.js?v=20261024-001";
import { t } from "./i18n.js?v=20261024-001";

export const AI_FEATURES = [
  {
    id: "context_compress", name: "上下文压缩摘要", mode: "自动", model: true,
    note: "每轮回复后判断是否超出上下文预算，超了就把旧消息压成一段历史摘要（手动点「压缩」也走这一档）",
  },
  {
    id: "memory_distill", name: "记忆自动蒸馏", mode: "自动", model: true,
    note: "每轮回复后静默读最近对话，沉淀长期记忆与用户资料；45 秒内不重复",
  },
  {
    id: "memory_extract", name: "记忆手动提取", mode: "手动", model: true,
    note: "记忆面板「从当前对话提取」：把这场对话整理成候选记忆供你挑选",
  },
  {
    id: "conversation_spark", name: "对话洞察捕获", mode: "自动", model: true,
    note: "切换会话时把上一场里值得留的决策、方案提炼成灵光卡片；120 秒内不重复",
  },
  {
    id: "session_title", name: "自动会话标题", mode: "自动", model: true,
    note: "新对话首轮结束后请模型补一个短标题换上，仅替换「首条消息前 30 字」形式的占位标题，手动修改过的名称不变",
  },
  {
    id: "code_understand", name: "代码理解文档", mode: "手动", model: true,
    note: "扫描项目后生成「导览·百科」与「规则手册」两份文档，一次两趟请求，是全表中开销最大的一项",
  },
  {
    id: "code_review", name: "代码审查", mode: "手动", model: true,
    note: "读 git diff 做四维度结构化审查；取 diff 本身不调模型，仅审查环节调用",
  },
  {
    id: "whiteboard_organize", name: "黑板 AI 整理", mode: "手动", model: true,
    note: "把黑板现有卡片交给模型重排：改标题、补详情、连依赖、按语义分色",
  },
  {
    id: "prompt_polish", name: "提示词优化", mode: "手动", model: true,
    note: "输入框「优化提示词」按钮：把草稿交给模型改写一遍，须比对确认后才回填，未确认则不修改任何内容",
  },
  {
    id: "subagent", name: "子代理并行", mode: "模型调用", tool: "subagent_run", model: true,
    note: "主模型一次派出多个子代理并行执行的工具。关闭后该工具不再出现在工具目录中，模型无法调用",
  },
  {
    id: "command_explain", name: "高危命令目的说明", mode: "自动", model: true,
    note: "审批弹窗中「这条命令的用途」由模型生成。关闭后弹窗照常拦截，只是不再发送请求，仅显示规则命中的原因",
  },
  {
    id: "workflow_dag", name: "团队工作流执行", mode: "手动", model: true,
    note: "黑板工作流按 DAG 逐节点调模型。这里选的模型是「节点既没绑定团队成员也没写死模型」时的默认档；绑定了的仍以绑定为准",
  },
  {
    id: "scheduled_task", name: "定时与事件任务", mode: "自动", model: false,
    modelNote: "模型在每个任务里各自选",
    note: "到点或命中事件时由后端发起一次模型请求，结果存成专属会话。关闭后任务不再执行（触发记录仍保留）",
  },
  {
    id: "image_gen", name: "AI 图片生成", mode: "模型调用", tool: "image_gen", model: false,
    modelNote: "模型与 Key 在下方「图片生成」区块配置",
    note: "生成图片的技能工具。关闭后不再出现在工具目录里",
  },
  {
    id: "video_gen", name: "AI 视频生成", mode: "模型调用", tool: "video_gen", model: false,
    modelNote: "模型与 Key 在下方「视频生成」区块配置",
    note: "生成短视频的技能工具。关闭后不再出现在工具目录里",
  },
];

export const AI_FEATURE_MAP = Object.fromEntries(AI_FEATURES.map(f => [f.id, f]));

function entryOf(id) {
  const raw = state.aiHelpers?.[id];
  return raw && typeof raw === "object" ? raw : {};
}

/** 这个功能开着吗。登记表里没有的 id 一律按开处理：漏挂号不该变成静默禁用。 */
export function isAiFeatureOn(id) {
  if (!AI_FEATURE_MAP[id]) return true;
  return entryOf(id).enabled !== false;
}

/** 该功能指定的模型 id（空串 = 跟随当前主模型）。 */
export function aiFeatureModelId(id) {
  return typeof entryOf(id).modelId === "string" ? entryOf(id).modelId : "";
}

/** 唯一的写入口：归一 → 落盘 → 通知订阅者（设置页与工具目录都订阅 aiHelpers）。 */
export function setAiFeature(id, patch = {}) {
  if (!AI_FEATURE_MAP[id]) return;
  const cur = entryOf(id);
  const next = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled !== false,
    modelId: typeof patch.modelId === "string" ? patch.modelId : (cur.modelId || ""),
  };
  if (next.enabled === (cur.enabled !== false) && next.modelId === (cur.modelId || "")) return;
  state.aiHelpers = { ...(state.aiHelpers || {}), [id]: next };
  savePersistent();
  notify("aiHelpers", state.aiHelpers);
}

// 注册表在 store 里按分类分组成对象，这里摊平一份出来给下拉和解析用。
// 不 import app.js 的 getAllModels()：app.js 会拉起整个界面，登记处在链路上游必须能独立求值。
export function allRegisteredModels() {
  const out = [];
  for (const models of Object.values(state.modelRegistry || {})) {
    if (Array.isArray(models)) out.push(...models);
  }
  for (const m of state.customModels || []) out.push(m);
  return out;
}

function findRegisteredModel(modelId) {
  if (!modelId) return null;
  return allRegisteredModels().find(m => m?.id === modelId) || null;
}

/**
 * 解析某个功能这次该用哪个模型：功能指定 > 传入的兜底（通常就是主模型）。
 * 返回 { id, provider, base_url, key, usable }。usable 是"这次真能发请求"：
 * 没模型、或者模型没配 Key（本地模型不算）就为 false，调用点据此决定是弹提示还是静默跳过。
 * fallback 可以是模型对象，也可以只是一个模型 id 字符串。
 */
export function aiModelFor(id, fallback = null) {
  const fb = typeof fallback === "string" ? { id: fallback } : (fallback || state.currentModel || {});
  const pinned = aiFeatureModelId(id);
  const picked = pinned ? (findRegisteredModel(pinned) || { id: pinned }) : fb;
  const modelId = picked?.id || "";
  const known = findRegisteredModel(modelId) || {};
  // 功能没另指模型时，调用点手上已经握着主模型的 Key（可能来自本地模型之外的临时输入），
  // 别因为它不在 modelKeys 里就把这趟请求判成不可用。
  const key = getModelKey(modelId) || (modelId && modelId === fb.id ? (fb.key || "") : "");
  return {
    id: modelId,
    provider: picked?.provider || known.provider || fb.provider || "openai",
    base_url: picked?.base_url || known.base_url || fb.base_url || undefined,
    key,
    usable: !!modelId && (!!key || modelId === "local"),
  };
}

export function aiFeatureOffTip(id) {
  const f = AI_FEATURE_MAP[id];
  return t("{name}已关闭，可在「设置 → AI 辅助功能」中打开", { name: f ? t(f.name) : "" });
}

/**
 * 调用点的闸门：开着返回 false 照常跑，关着弹一句提示返回 true（调用方直接 return）。
 * 提示走动态 import，避开 app.js ↔ 各组件的循环依赖（其他地方 toast 也这么做）。
 */
export function aiFeatureBlocked(id) {
  if (isAiFeatureOn(id)) return false;
  import("../app.js?v=20261024-001").then(({ toast }) => toast(aiFeatureOffTip(id))).catch(() => {});
  return true;
}

/** 工具名 → 功能 id（没有挂号返回空串） */
export function aiFeatureIdOfTool(toolName) {
  const f = AI_FEATURES.find(x => x.tool === toolName);
  return f ? f.id : "";
}

/** 该工具当前是否被关掉（工具目录与原生 schema 都要按这个过滤） */
export function isAiToolOff(toolName) {
  const id = aiFeatureIdOfTool(toolName);
  return !!id && !isAiFeatureOn(id);
}

// ── 设置页渲染 ──────────────────────────────

let listEl = null;

function modelOptions(selectedId) {
  const opts = [`<option value="">${t("跟随当前主模型")}</option>`];
  for (const m of allRegisteredModels()) {
    if (!m?.id) continue;
    const hasKey = !!getModelKey(m.id) || m.id === "local";
    const name = m.name || m.id;
    opts.push(`<option value="${m.id}">${hasKey ? name : `${name}${t("（未配置 Key）")}`}</option>`);
  }
  // 用户选过的模型后来被删了：留着这一项好让下拉不至于悄悄改回默认值
  if (selectedId && !findRegisteredModel(selectedId)) {
    opts.push(`<option value="${selectedId}" selected>${selectedId}${t("（已不在模型列表）")}</option>`);
  }
  return opts.join("");
}

function updateAiFeatureSummary() {
  const summary = document.getElementById("ai-feature-summary");
  if (!summary) return;
  const off = AI_FEATURES.filter(f => !isAiFeatureOn(f.id)).length;
  summary.textContent = off
    ? t("共 {n} 项，已关闭 {off} 项（关闭即不再为此发模型请求）", { n: AI_FEATURES.length, off })
    : t("共 {n} 项，全部开启（关闭即不再为此发模型请求）", { n: AI_FEATURES.length });
}

export function renderAiFeatureSettings() {
  if (!listEl) listEl = document.getElementById("ai-feature-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  for (const f of AI_FEATURES) {
    const on = isAiFeatureOn(f.id);
    const row = document.createElement("div");
    row.className = `ai-feature-row${on ? "" : " is-off"}`;
    row.dataset.feature = f.id;
    const modelId = aiFeatureModelId(f.id);
    row.innerHTML = `
      <label class="setting-check">
        <input type="checkbox" data-ai-enabled${on ? " checked" : ""}>
        <span class="ai-feature-name">${t(f.name)}</span>
        <span class="ai-feature-mode">${t(f.mode)}</span>
      </label>
      <div class="setting-hint ai-feature-note">${t(f.note)}</div>
      ${f.model ? `<div class="ai-feature-model">
        <label class="setting-label">${t("模型")}</label>
        <select class="setting-input" data-ai-model>${modelOptions(modelId)}</select>
      </div>` : `<div class="ai-feature-model ai-feature-model-note">${t(f.modelNote || "")}</div>`}
    `;
    if (f.model) {
      const select = row.querySelector("[data-ai-model]");
      if (select) select.value = modelId;
    }
    listEl.appendChild(row);
  }
  updateAiFeatureSummary();
}

export function initAiFeatureSettings() {
  if (!listEl) listEl = document.getElementById("ai-feature-list");
  if (!listEl || listEl.dataset.bound === "1") return;
  listEl.dataset.bound = "1";
  listEl.addEventListener("change", (e) => {
    const row = e.target.closest?.(".ai-feature-row");
    if (!row) return;
    const id = row.dataset.feature;
    if (e.target.matches("[data-ai-enabled]")) {
      setAiFeature(id, { enabled: e.target.checked });
    } else if (e.target.matches("[data-ai-model]")) {
      setAiFeature(id, { modelId: e.target.value || "" });
    }
    row.classList.toggle("is-off", !isAiFeatureOn(id));
    updateAiFeatureSummary();
  });
}
