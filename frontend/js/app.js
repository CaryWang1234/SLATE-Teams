/**
 * SLATE 主控 v4：AI 团队、文件上传、上下文压缩
 */

import { state, subscribe, setCurrentModel, setModelKey, getModelKey, hasModelKey, addCustomModel, updateCustomModel, removeCustomModel, setModelRegistry, loadPersistent, loadSharedPersistent, savePersistent, toggleTheme, customThemeActive, getContextCap, setModelContextCap, contextBudgetOf, declaredContextWindow, defaultContextCap, fmtContextTokens, contextCapStops, contextCapStopIndex, contextWindowSource, getContextWindow, setModelContextWindow, getModelDefinition, setTaskListSort, effectiveConstitution, constitutionScope, setConstitution, setBgAutoResume, setMaxParallelRuns, setMaxConcurrentRunsPerProject, setBackgroundRuns, setDefaultPermissionMode, setKeepAwakeOnNightRun } from "./store.js?v=20261017-001";
import { initI18n, t } from "./services/i18n.js?v=20261017-001";
import { iconSvgEl } from "./services/icons.js?v=20261017-001";
import { modelIconKey, modelIconLabel } from "./services/model_logos.js?v=20261017-001";
import { groupConversationsByProject, taskStatusOf, statusBadge, statusMark, STATUS, SORT_MODES, normalizeTaskListSort } from "./services/task_list.js?v=20261017-001";
import { get, post, put } from "./services/api.js?v=20261017-001";
import { dlgConfirm } from "./services/dialog.js?v=20261017-001";
import { fmtTokens, tokenEquivalence } from "./services/usage.js?v=20261017-001";
import { initChat, refreshConversationList, openConversation } from "./components/chat.js?v=20261017-001";
import { initWhiteboard, refreshWhiteboard } from "./components/whiteboard.js?v=20261017-001";
import { initPromptFactory } from "./components/prompt_factory.js?v=20261017-001";
import { initSkillPanel, refreshSkills, refreshActions } from "./components/skill_panel.js?v=20261017-001";
import { initExtensions } from "./components/extensions.js?v=20261017-001";
import { initModePanel } from "./components/mode_panel.js?v=20261017-001";
import { initMcpServerPanel } from "./components/mcp_server_panel.js?v=20261017-001";
import { initTeamPanel } from "./components/team.js?v=20261017-001";
import { initProjectBar } from "./components/project_bar.js?v=20261017-001";
import { initSessionSummary } from "./components/session_summary.js?v=20261017-001";
import { initApiTest, refreshApiTestModels } from "./components/api_test.js?v=20261017-001";
import { initTypingGame } from "./components/typing_game.js?v=20261017-001";
import { renderActivityHeatmap } from "./components/usage_heatmap.js?v=20261017-001";
import { initMemoryPanel } from "./components/memory.js?v=20261017-001";
import { initExpertsPanel } from "./components/experts.js?v=20261017-001";
import { initSchedule } from "./components/schedule.js?v=20261017-001";
import { initRiskGuard } from "./services/riskguard.js?v=20261017-001";
import { initKeepAwake, keepAwakeStatus, isHoldingAwake, onKeepAwakeStatus } from "./services/keepawake.js?v=20261017-001";
import { initAiFeatureSettings, renderAiFeatureSettings } from "./services/ai_features.js?v=20261017-001";
import { initThemeSettings, renderThemeSettings } from "./components/theme_settings.js?v=20261017-001";
import { initSessionArchiveSettings, renderArchivedSessions } from "./components/session_archive.js?v=20261017-001";
import { applyCustomTheme } from "./services/theme_custom.js?v=20261017-001";
import { initUnderstandPanel } from "./components/understand.js?v=20261017-001";
import { getCurrentProject, browseFiles } from "./services/project.js?v=20261017-001";
import { setProject, setProjectFileTree } from "./store.js?v=20261017-001";
import { cxDockIn, cxPanelIn, cxHistReveal } from "./services/cx_motion.js?v=20261017-001";
import { installErrorSink } from "./services/error_sink.js?v=20261017-001";

// 异常兜底最先装：启动期任何未捕获错误都要留下栈迹
installErrorSink();

// ── Toast 通知 ──────────────────────────────

let activePanelName = "chat";
let prevUiMode = null;

function toast(msg, duration = 2200) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove());
  }, duration);
}

function switchPanel(panelName) {
  const prevName = document.querySelector(".panel.active")?.id.replace("panel-", "") || null;
  activePanelName = panelName || "chat";
  document.querySelectorAll(".tab-btn").forEach(t => {
    t.classList.toggle("active", t.dataset.panel === activePanelName);
  });
  document.querySelectorAll(".panel").forEach(el => {
    el.classList.toggle("active", el.id === `panel-${activePanelName}`);
  });
  if (activePanelName === "whiteboard") {
    requestAnimationFrame(() => refreshWhiteboard());
  }
  // 扩展页是"看手头有什么"的地方：进来就重取一次，别让用户对着上一个项目的清单挑
  if (activePanelName === "ext") {
    refreshSkills();
    refreshActions();
  }
  if (prevName && prevName !== activePanelName) {
    const panelEl = document.getElementById("panel-" + activePanelName);
    if (panelEl) cxPanelIn(panelEl, activePanelName === "whiteboard" ? 0 : 6);
  }
  updateDockActive();
}

function safeInit(name, fn) {
  try {
    fn();
    return true;
  } catch (e) {
    console.error(`[SLATE] ${name} 初始化失败`, e);
    toast(t("{name} 初始化失败，请查看控制台", { name }));
    return false;
  }
}

// ── 模型选择 ──────────────────────────────

const MODEL_GROUP_LABELS = {
  international: "国际模型",
  domestic: "国产模型",
  local: "本地模型",
};

/**
 * 品牌 mark：内联 SVG 画进一个 HTML span，而不是 <img src>——这套 mark 靠
 * fill="currentColor" 描色，作为图片加载只会退化成黑色，暗色主题与自定义主题的
 * 深色配色下等于没画出来。
 *
 * 认不出品牌就返回 null，调用方整个不画：留白比把 Qwen 的模型画成别人的标好。
 */
function modelMarkSpan(model, cls = "model-mark") {
  const key = modelIconKey(model);
  if (!key) return null;
  const span = document.createElement("span");
  span.className = cls;
  // 把"认成了哪一枚"留在 DOM 上：走查与排障才不用靠肉眼猜品牌判定结果
  span.dataset.modelIcon = key;
  span.title = modelIconLabel(key);
  span.appendChild(iconSvgEl(key));
  return span;
}

let _textMeasureCtx = null;

/**
 * 下拉宽度按"当前选中的那颗模型名"实算。
 * 写死宽度是个两难：窄了名字被省略号截掉，宽了这颗控件吃掉半条工具行——
 * 名字长度本来就是数据，不是布局能预设的。超过天花板仍由 select 自己省略（全名走 title）。
 */
function sizeModelSelect() {
  const sel = document.getElementById("model-select");
  if (!sel) return;
  const cs = getComputedStyle(sel);
  if (!_textMeasureCtx) _textMeasureCtx = document.createElement("canvas").getContext("2d");
  _textMeasureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  // 图标占位（padding-left）+ 浏览器画下拉箭头的固定开销
  const chrome = 28 + (parseFloat(cs.paddingRight) || 0) + 18;
  const text = sel.selectedOptions[0]?.textContent || sel.options[0]?.textContent || "";
  const w = Math.ceil(_textMeasureCtx.measureText(text).width + chrome);
  sel.style.width = `${Math.max(120, Math.min(320, w))}px`;
}

function updateModelIcon(model) {
  const slot = document.getElementById("model-icon");
  if (!slot) return;
  slot.textContent = "";
  const key = modelIconKey(model);
  if (key) {
    slot.dataset.modelIcon = key;
    slot.title = modelIconLabel(key);
    slot.appendChild(iconSvgEl(key));
    slot.style.display = "";
  } else {
    delete slot.dataset.modelIcon;
    slot.removeAttribute("title");
    slot.style.display = "none";
  }
  // 长名字：宽度按实算给（sizeModelSelect），超出天花板才由省略号收尾；
  // 收起状态下原生 select 不显示 option 的 title，所以把选中那一项的 title 提到控件上。
  const sel = document.getElementById("model-select");
  if (sel) sel.title = sel.selectedOptions[0]?.title || "";
  sizeModelSelect();
}

function modelNeedsKey(model) {
  return model?.id !== "local";
}

function formatModelOption(model) {
  const hasKey = !modelNeedsKey(model) || hasModelKey(model.id);
  const status = hasKey ? "●" : "○";
  return `${status} ${model.name || model.id}`;
}

function populateModelSelect() {
  const select = document.getElementById("model-select");
  select.innerHTML = '<option value="">选择模型…</option>';

  for (const [cat, label] of Object.entries(MODEL_GROUP_LABELS)) {
    const models = state.modelRegistry[cat];
    if (!models || models.length === 0) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = `${t(label)} (${models.length})`;
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = formatModelOption(m);
      opt.title = [
        m.name || m.id,
        m.id,
        m.base_url,
        m.supports_responses === true ? t("可在设置中启用 Responses API") : "",
        modelNeedsKey(m) ? (hasModelKey(m.id) ? t("API Key 已配置") : t("API Key 未配置")) : t("本地模型"),
      ].filter(Boolean).join(" · ");
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
      opt.textContent = formatModelOption({ ...m, provider: m.provider || "custom" });
      opt.title = [
        m.name || m.id,
        m.id,
        m.base_url,
        hasModelKey(m.id) ? t("API Key 已配置") : t("API Key 未配置"),
      ].filter(Boolean).join(" · ");
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }

  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "+ 自定义模型…";
  select.appendChild(customOpt);

  if (state.currentModel) select.value = state.currentModel.id;
  updateModelIcon(state.currentModel);
}

function getAllModels() {
  const allModels = [];
  for (const models of Object.values(state.modelRegistry)) {
    allModels.push(...models);
  }
  allModels.push(...state.customModels);
  return allModels;
}

function populateAutoReviewModelSelect() {
  const select = document.getElementById("setting-auto-review-model");
  if (!select) return;
  const currentValue = state.autoReview?.modelId || "";
  select.innerHTML = '<option value="">跟随当前主模型</option>';
  for (const m of getAllModels()) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    select.appendChild(opt);
  }
  select.value = currentValue;
}

function handleModelSelect(e) {
  const value = e.target.value;
  if (!value) return;
  if (value === "__custom__") {
    openCustomModelModal();
    e.target.value = state.currentModel?.id || "";
    return;
  }

  // 在所有分类中查找
  for (const models of Object.values(state.modelRegistry)) {
    const found = models.find(m => m.id === value);
    if (found) {
      updateModelIcon(found);
      if (!hasModelKey(found.id) && found.id !== "local") {
        // 没有 API key，弹出输入
        openKeyInputModal(found);

      } else {
        setCurrentModel(found);
        toast(t("已切换: {name}", { name: found.name }));
      }
      return;
    }
  }

  // 查找自定义模型
  const custom = state.customModels.find(m => m.id === value);

  if (custom) {
    updateModelIcon(custom);
    if (!hasModelKey(custom.id)) {
      openKeyInputModal(custom);
    } else {
      setCurrentModel(custom);
      toast(t("已切换: {name}", { name: custom.name }));
    }
  }
}

// ── 密钥输入弹窗 ────────────────────────────

let pendingKeyModel = null;

function openKeyInputModal(model) {
  pendingKeyModel = model;
  openSettings({ focusModelId: model.id });
  toast(t("请先配置 API Key: {name}", { name: model.name }));
}

// ── 自定义模型编辑──────────────────────────

let editingCustomModelId = null;

function openCustomModelModal(model = null) {
  openSettings();
  renderCustomModelManagement();
  renderKeyManagement();
  editingCustomModelId = model?.id || null;
  const editor = document.getElementById("custom-model-editor");
  document.getElementById("custom-model-editor-title").textContent = model
    ? `编辑自定义模型: ${model.name || model.id}`
    : "添加自定义模型";
  document.getElementById("btn-save-custom-model").textContent = model ? "保存" : "添加";
  document.getElementById("custom-model-name").value = model?.id || "";
  document.getElementById("custom-model-url").value = model?.base_url || "";
  document.getElementById("custom-model-key").value = model ? (getModelKey(model.id) || "") : "";
  document.getElementById("custom-model-ctx").value = model?.context_window || 32768;
  document.getElementById("custom-model-mode").value = ["openai", "anthropic", "curl"].includes(model?.provider) ? model.provider : "openai";
  editor?.classList.remove("hidden");
  document.getElementById("custom-model-name").focus();
}

function closeCustomModelModal() {
  document.getElementById("custom-model-editor")?.classList.add("hidden");
  editingCustomModelId = null;
  document.getElementById("custom-model-name").value = "";
  document.getElementById("custom-model-url").value = "";
  document.getElementById("custom-model-key").value = "";
  document.getElementById("custom-model-ctx").value = "32768";
  document.getElementById("custom-model-mode").value = "openai";
  document.getElementById("custom-model-editor-title").textContent = "添加自定义模型";
  document.getElementById("btn-save-custom-model").textContent = "添加";
}

function saveCustomModel() {
  const name = document.getElementById("custom-model-name").value.trim();
  const baseUrl = document.getElementById("custom-model-url").value.trim();
  const key = document.getElementById("custom-model-key").value.trim();
  const ctx = parseInt(document.getElementById("custom-model-ctx").value) || 32768;

  if (!name || !baseUrl) {
    toast(t("请填写模型名称和 Base URL"));
    return;
  }

  const model = {
    id: name,
    name,
    provider: document.getElementById("custom-model-mode").value || "openai",
    base_url: baseUrl,
    context_window: ctx,
  };
  const duplicate = state.customModels.some(m => m.id === name && m.id !== editingCustomModelId);
  if (duplicate) {
    toast(t("模型名称已存在"));
    return;
  }

  if (editingCustomModelId) {
    updateCustomModel(editingCustomModelId, model);
  } else {
    addCustomModel(model);
  }
  setModelKey(name, key);
  const wasEditing = !!editingCustomModelId;
  setCurrentModel(model);
  populateModelSelect();
  populateAutoReviewModelSelect();
  renderCustomModelManagement();
  renderKeyManagement();
  closeCustomModelModal();
  toast(t(wasEditing ? t("已更新自定义模型: {name}") : t("已添加自定义模型: {name}"), { name }));
}

// ── 密钥管理面板（设置弹窗内）──────────────

// ── 每模型上下文预算控件 ───────────────────────────────
// 一个控件背后三个数：滑杆档位（按这个模型的窗口生成）、精确预算（可手输，不被档位表裁剪）、
// 以及"这个窗口是从哪来的"（端点自带 / 探测所得 / 根本不知道）。
// 「自动」= 标称窗口 ×0.8。本地与自定义端点常把窗口写在 /api/show、/props、/v1/models 里，
// 所以给一个探测入口；探不到就明说，让用户手填，而不是拿一个猜出来的数冒充自动。
function buildContextCapControl(model) {
  const wrap = document.createElement("div");
  wrap.className = "ctx-cap";

  const name = document.createElement("span");
  name.className = "ctx-cap-name";
  name.textContent = t("最大上下文");

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "ctx-cap-slider";
  slider.min = "0";
  slider.step = "1";
  slider.dataset.modelCtx = model.id; // 走查与设置页定位用：控件必须能对应到具体模型
  slider.setAttribute("aria-label", `${t("最大上下文")} · ${model.name}`);

  const readout = document.createElement("span");
  readout.className = "ctx-cap-value";

  // 滑杆只有十几个点位，表达不了 131072 这种"窗口本来就是那个数"，所以配一个精确框
  const exact = document.createElement("input");
  exact.type = "number";
  exact.className = "ctx-cap-exact";
  exact.min = "1024";   // 与 store 的夹取下限同一个数（守卫按 CONTEXT_CAP_MIN 核对），别让控件谎报下限
  exact.step = "1";     // 保留精确值：step=512 会让 180000 这类合法值被判成 stepMismatch
  exact.dataset.modelCtxInput = model.id;
  exact.setAttribute("aria-label", `${t("精确上下文预算")} · ${model.name}`);

  const probeBtn = document.createElement("button");
  probeBtn.type = "button";
  probeBtn.className = "ctx-cap-probe";
  probeBtn.dataset.modelCtxProbe = model.id;

  const clearProbe = document.createElement("button");
  clearProbe.type = "button";
  clearProbe.className = "ctx-cap-probe-clear";
  clearProbe.dataset.modelCtxProbeClear = model.id;
  clearProbe.textContent = "×";
  clearProbe.title = t("清除探测到的窗口，回到端点自带值");
  clearProbe.addEventListener("click", () => {
    setModelContextWindow(model.id, 0);
    syncStops();
    paint();
    toast(t("已清除探测到的窗口"));
  });

  let stops = contextCapStops(model.id);

  function syncStops() {
    stops = contextCapStops(model.id);
    slider.max = String(stops.length - 1);
    slider.value = String(contextCapStopIndex(model.id, getContextCap(model.id)));
  }

  function paint(capOverride) {
    const declared = declaredContextWindow(model.id);
    const cap = capOverride === undefined ? getContextCap(model.id) : capOverride;
    const auto = !cap;
    const eff = auto ? contextBudgetOf(model.id) : Math.min(cap, declared || cap);
    const clamped = !auto && declared > 0 && cap > declared;
    const src = contextWindowSource(model.id);
    const perModel = auto && declared > 0 && defaultContextCap(model.id) > 0;
    readout.textContent = auto
      ? `${t("自动")} · ${fmtContextTokens(eff)}`
      : (clamped ? `${fmtContextTokens(cap)} → ${fmtContextTokens(eff)}` : fmtContextTokens(cap));
    const base = perModel
      ? t("按该模型标称窗口 {w} 留两成余量：压缩阈值与上下文条都按 {b} 计算", { w: fmtContextTokens(declared), b: fmtContextTokens(eff) })
      : t("压缩阈值与上下文条都按 {b} 计算", { b: fmtContextTokens(eff) });
    readout.title = clamped
      ? t("超出模型标称窗口，已按 {w} 封顶", { w: fmtContextTokens(declared) })
      : (src === "probed" ? `${base} · ${t("窗口为探测所得")}` : base);
    exact.value = String(eff);
    exact.classList.toggle("is-auto", auto);
    probeBtn.textContent = t(src === "probed" ? "重新探测" : "探测窗口");
    // 桌面 CSS 没有全局 .hidden，判隐藏的走查读不到像素，这里直接用 display
    clearProbe.style.display = src === "probed" ? "" : "none";
    slider.classList.toggle("is-auto", auto);
  }

  syncStops();
  paint();
  // 拖动只刷新读数，松手/键盘落定才写设置：免得每过一个中间值都持久化一次
  slider.addEventListener("input", () => paint(stops[Number(slider.value)] || 0));
  slider.addEventListener("change", () => {
    setModelContextCap(model.id, stops[Number(slider.value)] || 0);
    syncStops();
    paint();
  });
  exact.addEventListener("change", () => {
    const typed = parseInt(exact.value, 10);
    if (!Number.isFinite(typed) || typed <= 0) { paint(); return; }
    setModelContextCap(model.id, typed);
    syncStops();
    paint();
  });
  probeBtn.addEventListener("click", async () => {
    const def = getModelDefinition(model.id) || {};
    const baseUrl = String(def.base_url || "").trim();
    if (!baseUrl) { toast(t("这个模型没有可探测的 Base URL")); return; }
    probeBtn.disabled = true;
    probeBtn.textContent = t("探测中…");
    let found = 0;
    let source = "";
    let message = "";
    try {
      const res = await post("/proxy/probe-context", {
        model: model.id,
        base_url: baseUrl,
        provider: def.provider || "openai",
        api_key: getModelKey(model.id) || "",
      });
      found = Number(res?.data?.context_window) || 0;
      source = String(res?.data?.source || "");
      message = String(res?.message || "");
    } catch (err) {
      message = `${t("探测失败")}：${String(err?.message || err)}`;
    }
    probeBtn.disabled = false;
    if (found > 0) {
      setModelContextWindow(model.id, found);
      syncStops();
      paint();
      toast(t("探测到上下文窗口 {w}（来自 {s}）", { w: fmtContextTokens(found), s: source }));
      return;
    }
    paint();
    toast(message || t("这个端点没有暴露上下文窗口，请按模型文档手填"));
  });

  wrap.appendChild(name);
  wrap.appendChild(slider);
  wrap.appendChild(readout);
  wrap.appendChild(exact);
  wrap.appendChild(probeBtn);
  wrap.appendChild(clearProbe);
  return wrap;
}

function renderCustomModelManagement() {
  const container = document.getElementById("custom-model-list");
  if (!container) return;
  container.innerHTML = "";

  if (!state.customModels.length) {
    const empty = document.createElement("div");
    empty.className = "custom-model-empty";
    empty.textContent = "暂无自定义模型";
    container.appendChild(empty);
    return;
  }

  for (const model of state.customModels) {
    const row = document.createElement("div");
    row.className = "custom-model-row";

    const info = document.createElement("div");
    info.className = "custom-model-info";
    const name = document.createElement("div");
    name.className = "custom-model-name";
    const mark = modelMarkSpan(model);
    if (mark) name.appendChild(mark);
    name.appendChild(document.createTextNode(model.name));
    const meta = document.createElement("div");
    meta.className = "custom-model-meta";
    meta.textContent = `${model.base_url} · ${model.context_window || 32768} ctx`;
    info.appendChild(name);
    info.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "custom-model-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.appendChild(iconSvgEl("edit-2"));
    editBtn.title = "编辑";
    editBtn.addEventListener("click", () => openCustomModelModal(model));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn custom-model-delete";
    deleteBtn.textContent = "×";
    deleteBtn.title = "删除";
    deleteBtn.addEventListener("click", async () => {
      if (!await dlgConfirm(t("删除自定义模型「{name}」？", { name: model.name }), { danger: true, okText: "删除" })) return;
      removeCustomModel(model.id);
      if (state.autoReview?.modelId === model.id) {
        state.autoReview.modelId = "";
        savePersistent();
      }
      populateModelSelect();
      populateAutoReviewModelSelect();
      renderCustomModelManagement();
      renderKeyManagement();
      toast(t("已删除自定义模型: {name}", { name: model.name }));
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(info);
    row.appendChild(actions);
    row.appendChild(buildContextCapControl(model));
    container.appendChild(row);
  }
}

function renderKeyManagement() {
  const container = document.getElementById("key-management-list");
  if (!container) return;
  container.innerHTML = "";

  const allModels = getAllModels().filter(m => !state.customModels.some(custom => custom.id === m.id));

  for (const m of allModels) {
    const row = document.createElement("div");
    row.className = "key-mgmt-row";

    const info = document.createElement("div");
    info.className = "key-mgmt-info";
    const nameSpan = document.createElement("span");
    nameSpan.className = "key-mgmt-name";
    const mark = modelMarkSpan(m);
    if (mark) nameSpan.appendChild(mark);
    nameSpan.appendChild(document.createTextNode(m.name));
    const urlSpan = document.createElement("span");
    urlSpan.className = "key-mgmt-url";
    urlSpan.textContent = m.base_url;
    info.appendChild(nameSpan);
    info.appendChild(urlSpan);

    const inputWrap = document.createElement("div");
    inputWrap.className = "key-mgmt-input-wrap";
    const input = document.createElement("input");
    input.type = "password";
    input.className = "setting-input key-mgmt-input";
    input.dataset.modelKey = m.id;
    input.value = getModelKey(m.id) || "";
    input.placeholder = hasModelKey(m.id) ? t("已配置 (留空删除)") : t("未配置");

    const saveBtn = document.createElement("button");
    saveBtn.className = "icon-btn key-mgmt-save";
    saveBtn.appendChild(iconSvgEl("check"));
    saveBtn.title = "保存";
    saveBtn.addEventListener("click", () => {
      const val = input.value.trim();
      setModelKey(m.id, val);
      populateModelSelect();
      if (val && pendingKeyModel?.id === m.id) {
        setCurrentModel(m);
        pendingKeyModel = null;
        populateModelSelect();
      }
      toast(t(val ? t("已保存 {name}") : t("已删除 {name}"), { name: m.name }));
    });

    inputWrap.appendChild(input);
    inputWrap.appendChild(saveBtn);

    row.appendChild(info);
    row.appendChild(inputWrap);
    row.appendChild(buildContextCapControl(m));
    container.appendChild(row);
  }
  if (!allModels.length) {
    const empty = document.createElement("div");
    empty.className = "custom-model-empty";
    empty.textContent = "暂无内置模型";
    container.appendChild(empty);
  }
}

// ── 设置弹窗 ────────────────────────────────

let settingsModal;
let resyncSettingsNav = null;

// ── 设置页：项目宪法 ──────────────
// 框里是"当前生效的那一份"，下面一行说明这次保存会写到哪儿。以前打开项目会把项目的宪法
// 盖进全局状态，于是关掉项目、或切到一个没写宪法的项目，规则还在沿用——这里改成现算。
function renderConstitutionSettings() {
  const box = document.getElementById("setting-constitution");
  if (!box) return;
  const active = effectiveConstitution();
  if (active) box.value = JSON.stringify(active, null, 2);
  const hint = document.getElementById("constitution-scope");
  if (!hint) return;
  hint.textContent = constitutionScope() === "project"
    ? t("正在编辑项目「{name}」的宪法：存入该项目 .slate/config.json，只对该项目生效", { name: state.project?.name || "" })
    : t("正在编辑全局宪法：项目自带宪法时以项目为准");
}

function openSettings(options = {}) {
  settingsModal = document.getElementById("panel-settings");
  document.getElementById("setting-max-tokens").value = state.maxTokens || 64000;
  document.getElementById("setting-output-max-tokens").value = state.outputSettings?.maxTokens || 16384;
  document.getElementById("setting-output-unlimited").checked = state.outputSettings?.unlimitedFileOutput !== false;
  document.getElementById("setting-file-auto-apply").checked = state.fileOutput?.autoApply !== false;
  document.getElementById("setting-auto-review-enabled").checked = state.autoReview?.enabled !== false;
  document.getElementById("setting-auto-review-long-stall").checked = state.autoReview?.reviewLongStall === true;
  document.getElementById("setting-auto-review-min-chars").value = state.autoReview?.minChars || 120;
  document.getElementById("setting-continue-autopilot").checked = state.continueAutopilot !== false;
  populateAutoReviewModelSelect();
  // 通知设置
  document.getElementById("setting-notif-sound").checked = state.notifications?.soundEnabled !== false;
  document.getElementById("setting-notif-system").checked = state.notifications?.systemNotifEnabled === true;
  document.getElementById("setting-bg-auto-resume").checked = state.bgAutoResume !== false;
  renderParallelSettings();
  updateNotifPermissionHint();
  renderPermissionModeSettings();
  renderKeepAwakeSettings();
  document.getElementById("setting-ui-mode").checked = state.uiMode === "codex";
  renderWebSearchSettings();
  renderImageGenSettings();
  renderVideoGenSettings();
  renderAiFeatureSettings();
  renderThemeSettings();
  renderArchivedSessions();
  renderConstitutionSettings();
  renderCustomModelManagement();
  renderKeyManagement();
  refreshApiTestModels();
  renderUsageSummary();
  renderAbout();
  renderLanInfo();
  renderResponsesApiHint();
  switchPanel("settings");
  resyncSettingsNav?.();
  if (options.focusModelId) {
    requestAnimationFrame(() => {
      const input = [...document.querySelectorAll("[data-model-key]")]
        .find(el => el.dataset.modelKey === options.focusModelId);
      input?.focus();
      input?.scrollIntoView({ block: "center" });
    });
  } else if (options.focusCtxModelId) {
    // 从用量条点进来：定位到这个模型的上下文滑杆；模型没有独立滑杆时退到全局上限
    requestAnimationFrame(() => {
      const slider = [...document.querySelectorAll("[data-model-ctx]")]
        .find(el => el.dataset.modelCtx === options.focusCtxModelId);
      if (slider) {
        slider.closest(".key-mgmt-row, .custom-model-row")
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
        slider.focus();
        return;
      }
      document.getElementById("setting-max-tokens")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  } else if (options.focusConstitution) {
    requestAnimationFrame(() => {
      const input = document.getElementById("setting-constitution");
      input?.focus();
      input?.scrollIntoView({ block: "center" });
    });
  } else if (options.focusLan) {
    requestAnimationFrame(() => {
      document.getElementById("settings-lan")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

function closeSettings() { switchPanel("chat"); }

// ── 设置页：左侧导航（区块现读生成）+ 搜索 ──────────────
// 条目从 .settings-block 现读：以前手写清单漏过三块（后台任务、多任务与项目、MCP Server），
// 只要区块与导航不同源，「左栏收录全部条目」就没有保障。搜索过滤时同一份索引负责重建。

const SETTINGS_BLOCK_SEL = "#panel-settings .settings-main .settings-block";
// 命中标记的粒度：一行设置。外层 .setting-section 只包住命中行时不重复描框。
const SETTINGS_ROW_SEL = ".setting-group, .setting-section, .setting-check, .about-row, "
  + ".permission-mode-row, .web-search-mode-row, .custom-model-row, .key-mgmt-row, "
  + ".ai-feature-row, .skill-item, .mcp-server-item";

/** @type {{id: string, el: HTMLElement, title: string, nav: HTMLElement|null, visible: boolean}[]} */
let settingsSections = [];
let settingsPageEl = null;

function normSettingsText(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** 区块标题：取 h2 的首个非空文本节点，「实验性」这类徽标不跟着进导航 */
function settingsBlockTitle(block) {
  const h2 = block.querySelector(".settings-block-head h2");
  if (!h2) return block.id;
  for (const n of h2.childNodes) {
    if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) return n.textContent.trim();
  }
  return (h2.textContent || "").trim();
}

/** 可搜文本：可见文字（含 option 文本）+ 只存在于属性里的 placeholder / title */
function settingsHaystack(el) {
  let s = el.textContent || "";
  for (const node of el.querySelectorAll("[placeholder], [title]")) {
    s += " " + (node.getAttribute("placeholder") || "") + " " + (node.getAttribute("title") || "");
  }
  return normSettingsText(s);
}

function renderSettingsNav() {
  const nav = document.getElementById("settings-nav");
  if (!nav) return;
  nav.textContent = "";
  for (const sec of settingsSections) {
    if (!sec.visible) continue;
    const a = document.createElement("a");
    a.className = "settings-nav-item";
    a.dataset.target = sec.id;
    a.textContent = sec.title;
    a.title = sec.title;
    a.addEventListener("click", () => {
      sec.el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    nav.appendChild(a);
    sec.nav = a;
  }
}

/** 滚动高亮：取顶边已越过容器顶部 24px 线的最后一个可见区块（被搜掉的区块不参与） */
function syncSettingsNavHighlight() {
  if (!settingsPageEl) return;
  const visible = settingsSections.filter(s => s.visible);
  if (!visible.length) return;
  const pageTop = settingsPageEl.getBoundingClientRect().top;
  let active = visible[0];
  for (const sec of visible) {
    if (sec.el.getBoundingClientRect().top - pageTop <= 24) active = sec;
  }
  for (const sec of visible) {
    sec.nav?.classList.toggle("active", sec === active);
  }
}

function applySettingsFilter(query) {
  const q = normSettingsText(query);
  let matched = 0;
  for (const sec of settingsSections) {
    const rows = [...sec.el.querySelectorAll(SETTINGS_ROW_SEL)];
    let hitRow = null;
    for (const row of rows) {
      // 折叠起来的编辑器/详情没有渲染，标了也看不见，索性不标
      const on = !!q && row.offsetParent !== null && settingsHaystack(row).includes(q);
      row.classList.toggle("settings-search-hit", on);
      if (on && !hitRow) hitRow = row;
    }
    // 命中的是内层行时，去掉包住它的外层描边，避免一个开关套两层框
    if (hitRow) {
      for (const row of sec.el.querySelectorAll(".settings-search-hit")) {
        if (row !== hitRow && row.contains(hitRow)) row.classList.remove("settings-search-hit");
      }
    }
    // 标题/说明命中而整块没有单独成行的内容（如「用量统计」）时，整块留下但不描框
    sec.visible = !q || settingsHaystack(sec.el).includes(q);
    sec.el.classList.toggle("settings-hidden", !sec.visible);
    if (sec.visible) matched += 1;
  }
  renderSettingsNav();
  const status = document.getElementById("settings-search-status");
  if (status) {
    status.textContent = !q ? t("共 {n} 组设置", { n: settingsSections.length })
      : matched ? t("匹配到 {n} 组设置", { n: matched }) : t("没有匹配的设置项");
  }
  document.getElementById("btn-settings-search-clear")?.classList.toggle("hidden", !q);
  syncSettingsNavHighlight();
  return matched;
}

function initSettingsSearch() {
  const input = document.getElementById("settings-search");
  if (!input) return;
  // i18n 遍历刻意跳过 input，占位符得自己翻，否则英文界面留着中文
  input.placeholder = t("搜索设置项");
  const firstTarget = () => settingsSections.find(s => s.visible && s.el.querySelector(".settings-search-hit"))
    || settingsSections.find(s => s.visible);
  input.addEventListener("input", () => applySettingsFilter(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.value = ""; applySettingsFilter(""); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const sec = firstTarget();
    if (!sec) return;
    sec.el.scrollIntoView({ behavior: "smooth", block: "start" });
    const hit = sec.el.querySelector(".settings-search-hit");
    const control = hit?.querySelector("input, select, textarea, button");
    control?.focus({ preventScroll: true });
  });
  document.getElementById("btn-settings-search-clear")?.addEventListener("click", () => {
    input.value = "";
    applySettingsFilter("");
    input.focus();
  });
}

function initSettingsNav() {
  settingsPageEl = document.querySelector(".settings-page");
  const nav = document.getElementById("settings-nav");
  if (!settingsPageEl || !nav) return;
  settingsSections = [...document.querySelectorAll(SETTINGS_BLOCK_SEL)]
    .filter(el => el.id)
    .map(el => ({ id: el.id, el, title: settingsBlockTitle(el), nav: null, visible: true }));
  initSettingsSearch();
  applySettingsFilter("");   // 空查询即"全量"：生成条目 + 状态行都从这里出发
  // 设置页的滚动位置跨次打开是保留的：不在打开时对一次，高亮会停在列表第一项，
  // 指着「模型配置」却其实在看「备份」——不滚一下就不会自己纠正。
  settingsPageEl.addEventListener("scroll", syncSettingsNavHighlight, { passive: true });
  resyncSettingsNav = () => requestAnimationFrame(syncSettingsNavHighlight);
  resyncSettingsNav();
}

// ── 设置页：Responses API 提示 ──────────────

function renderResponsesApiHint() {
  const checkbox = document.getElementById("setting-use-responses");
  const hint = document.getElementById("responses-models-hint");
  if (!checkbox || !hint) return;

  checkbox.checked = state.useResponses === true;

  // 收集支持 Responses API 的模型名称
  const supportedModels = [];

  for (const models of Object.values(state.modelRegistry)) {
    for (const m of models) {
      if (m.supports_responses === true) {
        supportedModels.push(m.name);
      }
    }
  }

  if (supportedModels.length > 0) {
    hint.textContent = t("支持 Responses API 的模型：{models}", { models: supportedModels.join("、") });
  } else {
    hint.textContent = t("当前无模型支持 Responses API");
  }

  checkbox.onchange = () => {
    state.useResponses = checkbox.checked;
    savePersistent();
  };
}

// ── 设置页：关于与更新检查 ──────────────

let aboutVersionShown = false;

/** 展示当前版本号（首次打开设置页时拉取，失败保留占位符） */
async function renderAbout() {
  const verEl = document.getElementById("about-version");
  if (!verEl || aboutVersionShown) return;
  try {
    const res = await get("/update/check");
    const d = res?.code === 0 ? res.data : null;
    if (d?.current) {
      verEl.textContent = `v${d.current}`;
      aboutVersionShown = true;
    }
  } catch {}
}

// ── 设置页：局域网遥控（开关 + 地址获取 + 复制 + 二维码） ──────────

/** 应用开关（唯一的写入口）。失败就把勾恢复回去，别让界面停在一个没生效的态上。 */
async function toggleLanRemote(on, input) {
  if (input) input.disabled = true;
  try {
    const res = await post("/lan/enabled", { enabled: on });
    if (res?.code !== 0) throw new Error(res?.message || t("开关未生效"));
    await renderLanInfo();
  } catch (err) {
    if (input) input.checked = !on;
    toast(String(err?.message || err));
  } finally {
    if (input) input.disabled = false;
  }
}

/** 拉取局域网遥控状态与地址并渲染醒目展示（每次打开设置页刷新，IP 变化可及时反映） */
async function renderLanInfo() {
  const box = document.getElementById("lan-info");
  if (!box) return;
  box.innerHTML = '<div class="lan-info-loading">正在获取遥控地址…</div>';
  let data = null;
  try {
    const res = await get("/lan/info");
    if (res?.code === 0) data = res.data;
  } catch {}
  const toggle = document.getElementById("lan-enabled");
  if (toggle) {
    toggle.checked = !data || data.enabled !== false;
    toggle.disabled = false;
  }
  if (!data || !data.running) {
    box.innerHTML = "";
    const note = document.createElement("div");
    note.className = "lan-info-error";
    if (data && data.enabled === false) {
      note.textContent = t("遥控已关闭。打开上方开关后，这里会出现遥控地址与二维码。");
    } else {
      note.textContent = t("遥控服务未启动") + (data?.error ? ": " + data.error : t("，请重启应用"));
    }
    box.appendChild(note);
    return;
  }
  const url = data.urls[0];
  box.innerHTML = `
    <div class="lan-url-row">
      <code class="lan-url" id="lan-url-text">${url}</code>
      <button id="btn-lan-copy" class="send-btn send-btn-sm" type="button">复制地址</button>
    </div>
    <div class="lan-qr-row">
      <img class="lan-qr" src="/api/lan/qrcode?t=${Date.now()}" alt="遥控地址二维码">
      <div class="lan-qr-tip">手机扫码直接打开<br>（需连入同一局域网）</div>
    </div>
    ${data.forced ? `<p class="lan-tip">${t("本次由 --remote 启动：遥控已强制开启，开关仍可随时关闭。")}</p>` : ""}
    <p class="lan-tip">已启用授权链接：只有通过上方地址或二维码进入的设备可访问。请勿把链接分享给他人。</p>
  `;
  document.getElementById("btn-lan-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast(t("遥控地址已复制"));
    } catch {
      const el = document.getElementById("lan-url-text");
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast(t("自动复制失败，地址已选中"));
    }
  });
}

// ── 首次启动引导 ──────────────────────

function initOnboarding() {
  const modal = document.getElementById("onboarding-modal");
  if (!modal) return;
  const legacySeen = localStorage.getItem("slate_onboarded") === "1";
  if (legacySeen && state.onboardingSeen !== true) {
    state.onboardingSeen = true;
    savePersistent();
  }
  const close = () => {
    modal.classList.add("hidden");
    state.onboardingSeen = true;
    localStorage.setItem("slate_onboarded", "1");
    savePersistent();
  };
  document.getElementById("btn-onboarding-done")?.addEventListener("click", close);
  modal.querySelector(".modal-close")?.addEventListener("click", close);
  modal.querySelector(".modal-backdrop")?.addEventListener("click", close);
  // 设置·关于里可重新查看
  document.getElementById("btn-view-onboarding")?.addEventListener("click", () => {
    modal.classList.remove("hidden");
  });
  if (state.onboardingSeen !== true && !legacySeen) modal.classList.remove("hidden");
}

// ── 数据备份与恢复────────────────────

function initBackupRestore() {
  const statusEl = document.getElementById("backup-status");

  document.getElementById("btn-backup-export")?.addEventListener("click", async () => {
    try {
      const res = await get("/chat/export");
      if (res.code !== 0) throw new Error(res.message || "导出失败");
      let local = null;
      try { local = JSON.parse(localStorage.getItem("slate_state") || "null"); } catch {}
      const payload = {
        app: "SLATE Teams",
        kind: "full-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        backend: res.data,
        local,
      };
      let savedPath = "";
      try {
        const saveRes = await post("/chat/backup-file", { payload });
        if (saveRes.code === 0) savedPath = saveRes.data?.path || "";
      } catch (e) {
        console.warn("备份落盘失败:", e);
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = `SLATE-Teams-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const d = res.data || {};
      if (statusEl) {
        const base = t("已导出：{a} 会话 / {b} 条消息 / {c} 条记忆 / {d} 条素材", { a: d.conversations?.length || 0, b: d.messages?.length || 0, c: d.memories?.length || 0, d: d.snippets?.length || 0 });
        statusEl.textContent = savedPath ? `${base}；本地备份：${savedPath}` : base;
      }
      toast(savedPath ? t("备份已下载，并已保存到本地 backups 目录") : t("备份已下载"));
    } catch (e) {
      toast(t("导出备份失败: {msg}", { msg: e.message }));
    }
  });

  const fileInput = document.getElementById("backup-file-input");
  document.getElementById("btn-backup-import")?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const backend = payload.backend || payload;
      if (!Array.isArray(backend.conversations) && !Array.isArray(backend.messages)) {
        throw new Error("无法识别的备份文件");
      }
      if (!await dlgConfirm("导入备份？已存在的数据会跳过，不覆盖现有内容。导入后页面将重新加载。", { okText: "导入" })) return;
      const res = await post("/chat/import", { backend });
      if (res.code !== 0) throw new Error(res.message || "导入失败");
      if (payload.local && typeof payload.local === "object") {
        try { localStorage.setItem("slate_state", JSON.stringify(payload.local)); } catch {}
      }
      const s = res.data || {};
      if (statusEl) {
        statusEl.textContent = t("已导入：{a} 会话 / {b} 条消息 / {c} 条记忆 / {d} 条素材（已存在的跳过）", { a: s.conversations || 0, b: s.messages || 0, c: s.memories || 0, d: s.snippets || 0 });
      }
      toast(t("恢复完成，正在重载以应用本地设置…"));
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      toast(t("恢复失败: {msg}", { msg: e.message }));
    }
  });
}

// ── 关于区项目链接────────────────────

const WEBSITE_URL = "https://carywang1234.github.io/SLATE-Teams/";
const GITHUB_URL = "https://github.com/CaryWang1234/SLATE-Teams";

async function openProjectLink(url) {
  try {
    const res = await post("/update/open-url", { url });
    if (res.code !== 0) toast(res.message || t("打开链接失败"));
  } catch (e) {
    toast(t("打开链接失败"));
  }
}

function initAboutLinks() {
  document.getElementById("btn-open-website")?.addEventListener("click", () => openProjectLink(WEBSITE_URL));
  document.getElementById("btn-open-github")?.addEventListener("click", () => openProjectLink(GITHUB_URL));
}

// ── 存储空间管理 ──────────────────────

function fmtBytes(n) {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

async function runStorageCleanup(target, btn) {
  const statusEl = document.getElementById("storage-status");
  btn.disabled = true;
  try {
    const res = await post("/settings/storage/cleanup", { target });
    if (res.code !== 0) { toast(res.message || t("清理失败")); return; }
    const freed = res.data?.freed || 0;
    if (statusEl) statusEl.textContent = freed > 0 ? t("已释放 {size}", { size: fmtBytes(freed) }) : "无可释放空间（文件可能被占用，关闭应用后重试）";
    toast(freed > 0 ? t("已释放 {size}", { size: fmtBytes(freed) }) : t("清理完成"));
    if (target === "history") {
      // 清空历史后同步侧栏列表
      try { await refreshConversationList(); } catch (e) {}

    }
    await renderStorageUsage();
  } catch (e) {
    toast(t("清理失败: {msg}", { msg: e.message }));
  } finally {
    btn.disabled = false;
  }
}

async function renderStorageUsage() {
  const box = document.getElementById("storage-usage");
  if (!box) return;
  try {
    const res = await get("/settings/storage");
    if (res.code !== 0) throw new Error(res.message || "获取失败");
    const { total, items } = res.data;
    box.innerHTML = "";

    const totalRow = document.createElement("div");
    totalRow.className = "storage-total";
    totalRow.textContent = t("总占用 {size}", { size: fmtBytes(total) });
    box.appendChild(totalRow);

    for (const it of items) {
      const row = document.createElement("div");
      row.className = "storage-row";
      const label = document.createElement("span");
      label.className = "storage-label";
      label.textContent = it.label;
      const size = document.createElement("span");
      size.className = "storage-size";
      size.textContent = fmtBytes(it.size);
      row.append(label, size);

      if (it.key === "chat") {
        const vacuumBtn = document.createElement("button");
        vacuumBtn.className = "send-btn send-btn-sm";
        vacuumBtn.textContent = "压缩";
        vacuumBtn.title = "压缩数据库文件，释放已删除数据占用的空间";
        vacuumBtn.addEventListener("click", () => runStorageCleanup("vacuum", vacuumBtn));
        row.appendChild(vacuumBtn);

        const clearBtn = document.createElement("button");
        clearBtn.className = "send-btn send-btn-sm btn-danger";
        clearBtn.textContent = "清空对话";
        clearBtn.title = "删除全部历史会话与消息";
        clearBtn.addEventListener("click", async () => {
          if (!await dlgConfirm("清空全部对话历史？此操作不可恢复，建议先在「数据备份」导出备份。", { danger: true, okText: "清空" })) return;
          await runStorageCleanup("history", clearBtn);
        });
        row.appendChild(clearBtn);
      } else if (it.key === "webview") {
        const cleanBtn = document.createElement("button");
        cleanBtn.className = "send-btn send-btn-sm";
        cleanBtn.textContent = "清理缓存";
        cleanBtn.title = "清理内置浏览器缓存；被占用的文件将在重启后释放";
        cleanBtn.addEventListener("click", () => runStorageCleanup("webview", cleanBtn));
        row.appendChild(cleanBtn);
      }
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = "";
    const hint = document.createElement("span");
    hint.className = "setting-hint";
    hint.textContent = t("获取存储信息失败：{msg}", { msg: e.message });
    box.appendChild(hint);
  }
}

function initStorageManage() {
  renderStorageUsage();
  // 打开设置页时刷新一次用量
  document.getElementById("btn-settings")?.addEventListener("click", () => setTimeout(renderStorageUsage, 300));

}

/** 手动检查更新：结果内嵌展示，下载说明走后端白名单打开系统浏览器 */
async function checkUpdateNow(btn) {
  const info = document.getElementById("about-update-info");
  if (!info) return;
  btn.disabled = true;
  btn.textContent = "检查中…";
  info.classList.remove("hidden");
  info.textContent = "正在查询最新 Release…";
  try {
    const res = await get("/update/check");
    const d = res?.code === 0 ? res.data : null;
    info.innerHTML = "";
    if (!d?.checked) {
      info.textContent = "检查更新失败：网络不可用，请稍后重试。";
      return;
    }
    if (d.current) document.getElementById("about-version").textContent = `v${d.current}`;
    if (!d.hasUpdate) {
      info.textContent = t("已是最新版本（v{v}）。", { v: d.current });
      return;
    }
    const line = document.createElement("div");
    line.textContent = t("发现新版 v{latest}（当前 v{current}）", { latest: d.latest, current: d.current });
    info.appendChild(line);
    if (d.notes) {
      const notes = document.createElement("div");
      notes.style.color = "var(--text-muted)";
      notes.textContent = d.notes.slice(0, 200);
      info.appendChild(notes);
    }
    const actions = document.createElement("div");
    actions.className = "about-update-actions";
    const dlBtn = document.createElement("button");
    dlBtn.className = "send-btn send-btn-sm";
    dlBtn.textContent = "下载更新";
    dlBtn.addEventListener("click", () => post("/update/open-url", { url: d.downloadUrl }).catch(() => {}));
    const relBtn = document.createElement("button");
    relBtn.className = "icon-btn";
    relBtn.textContent = "更新说明";
    relBtn.addEventListener("click", () => post("/update/open-url", { url: d.releaseUrl }).catch(() => {}));
    actions.appendChild(dlBtn);
    actions.appendChild(relBtn);
    info.appendChild(actions);
  } catch (e) {
    info.textContent = t("检查更新失败：{msg}", { msg: e.message });
  } finally {
    btn.disabled = false;
    btn.textContent = "检查更新";
  }
}

// ── 设置页：用量统计（全部对话累计） ──────────────

async function renderUsageSummary() {
  const box = document.getElementById("usage-summary");
  if (!box) return;
    box.innerHTML = '<div class="usage-summary-loading">加载中…</div>';
  try {
    const res = await get("/chat/usage/summary");
    if (res.code !== 0) throw new Error(res.message || "加载失败");
    const d = res.data || {};
    box.innerHTML = "";

    const grid = document.createElement("div");
    grid.className = "usage-summary-grid";
    const equiv = tokenEquivalence(d.total_tokens);
    grid.innerHTML = `
      <div class="usage-summary-card usage-summary-main">
        <div class="usage-summary-num">${fmtTokens(d.total_tokens)}</div>
        <div class="usage-summary-label">总 Tokens</div>
        ${equiv ? `<div class="usage-summary-equiv">${equiv}</div>` : ""}
      </div>
      <div class="usage-summary-card">
        <div class="usage-summary-num">${fmtTokens(d.prompt_tokens)}</div>
        <div class="usage-summary-label">总输入</div>
      </div>
      <div class="usage-summary-card">
        <div class="usage-summary-num">${fmtTokens(d.completion_tokens)}</div>
        <div class="usage-summary-label">总输出</div>
      </div>
      <div class="usage-summary-card">
        <div class="usage-summary-num">${(d.message_count || 0).toLocaleString()}</div>
        <div class="usage-summary-label">总消息数</div>
      </div>
      <div class="usage-summary-card">
        <div class="usage-summary-num">${d.conversation_count || 0}</div>
        <div class="usage-summary-label">对话数</div>
      </div>
    `;
    box.appendChild(grid);

    const top = d.top || [];
    if (top.length) {
      const list = document.createElement("div");
      list.className = "usage-summary-top";
      const head = document.createElement("div");
      head.className = "usage-summary-top-head";
      head.textContent = "用量最高的对话";
      list.appendChild(head);
      for (const item of top) {
        const row = document.createElement("div");
        row.className = "usage-summary-top-row";
        const title = document.createElement("span");
        title.className = "usage-summary-top-title";
        title.textContent = item.title || t("对话 {id}", { id: String(item.id || "").slice(0, 6) });
        const tok = document.createElement("span");
        tok.className = "usage-summary-top-tokens";
        tok.textContent = t("{tokens} tokens · {n} 条消息", { tokens: fmtTokens(item.total_tokens), n: item.message_count || 0 });
        row.append(title, tok);
        list.appendChild(row);
      }
      box.appendChild(list);
    }

    // 按项目分摊：多项目在册之后"这个月花在哪了"是个按项目问的问题。
    // 口径和侧栏分组一致——没记 id 的老会话只有在名字唯一时才归到那个项目，
    // 归不进去的原样落在"未分类"，不猜。
    const byProject = d.by_project || [];
    if (byProject.length) {
      const list = document.createElement("div");
      list.className = "usage-summary-top usage-summary-project";
      const head = document.createElement("div");
      head.className = "usage-summary-top-head";
      head.textContent = t("按项目");
      list.appendChild(head);
      for (const item of byProject) {
        const row = document.createElement("div");
        row.className = "usage-summary-top-row";
        row.dataset.projectId = String(item.project_id || "");
        const title = document.createElement("span");
        title.className = "usage-summary-top-title";
        title.textContent = item.project || t("未分类");
        const tok = document.createElement("span");
        tok.className = "usage-summary-top-tokens";
        tok.textContent = t("{tokens} tokens · {n} 条会话", { tokens: fmtTokens(item.total_tokens), n: item.conversations || 0 });
        row.append(title, tok);
        list.appendChild(row);
      }
      box.appendChild(list);
    }

    // tokens_recorded_from = 第一条真实按天记账的日期；它之前的热力图 token 是估算值，
    // 传给组件是为了在界面上如实标注，别把摊出来的数字说得像真的。
    // 注意给组件的是一个自己的宿主：renderActivityHeatmap 进来先 host.innerHTML=""，
    // 直接把 #usage-summary 递给它，会把上面的总量卡片和两份清单一起抹掉。
    if (Array.isArray(d.daily)) {
      const heatHost = document.createElement("div");
      heatHost.className = "usage-summary-heat";
      box.appendChild(heatHost);
      renderActivityHeatmap(heatHost, d.daily, { recordedFrom: d.tokens_recorded_from || null });
    }
  } catch (e) {
    box.innerHTML = "";
    const err = document.createElement("div");
    err.className = "usage-summary-loading";
    err.textContent = t("用量加载失败：{msg}", { msg: e.message });
    box.appendChild(err);
  }
}

// 自动推进设置：变更后立即持久化，无需点保存按钮
function applyAutoReviewSettings() {
  state.autoReview = {
    enabled: document.getElementById("setting-auto-review-enabled").checked,
    modelId: document.getElementById("setting-auto-review-model").value || "",
    minChars: Math.max(20, Math.min(800, parseInt(document.getElementById("setting-auto-review-min-chars").value) || 120)),
    reviewLongStall: document.getElementById("setting-auto-review-long-stall")?.checked === true,
  };
  savePersistent();
}

function initAutoReviewPersistence() {
  document.getElementById("setting-auto-review-enabled")?.addEventListener("change", applyAutoReviewSettings);
  document.getElementById("setting-auto-review-model")?.addEventListener("change", applyAutoReviewSettings);
  document.getElementById("setting-auto-review-min-chars")?.addEventListener("change", applyAutoReviewSettings);
  document.getElementById("setting-auto-review-long-stall")?.addEventListener("change", applyAutoReviewSettings);
  // Continue Autopilot 是循环行为开关，不进 autoReview（那是审阅模型的配置），
  // 也刻意不同步到手机：末轮续跑只有桌面循环实现。
  document.getElementById("setting-continue-autopilot")?.addEventListener("change", (e) => {
    state.continueAutopilot = e.target.checked;
    savePersistent();
  });
  // 后台任务的空闲续跑：同样只存本机（只有桌面循环会自己开新一场）；
  // 走 store 的 setter 而不是直接改 state，配额与开关是同一份状态，别绕过它
  document.getElementById("setting-bg-auto-resume")?.addEventListener("change", (e) => {
    setBgAutoResume(e.target.checked);
  });
  document.getElementById("setting-background-runs")?.addEventListener("change", (e) => {
    setBackgroundRuns(e.target.checked);
  });
  document.getElementById("setting-max-parallel-runs")?.addEventListener("change", (e) => {
    setMaxParallelRuns(e.target.value);
  });
  document.getElementById("setting-max-runs-per-project")?.addEventListener("change", (e) => {
    setMaxConcurrentRunsPerProject(e.target.value);
  });
}

// 三个控件回显同一份偏好：设置页每次打开都重画，别留着上一次的值骗人
function renderParallelSettings() {
  const bg = document.getElementById("setting-background-runs");
  if (bg) bg.checked = state.backgroundRuns !== false;
  const mp = document.getElementById("setting-max-parallel-runs");
  if (mp) mp.value = String(state.maxParallelRuns ?? 2);
  const mr = document.getElementById("setting-max-runs-per-project");
  if (mr) mr.value = String(state.maxConcurrentRunsPerProject ?? 1);
}

// 通知设置：变更后立即持久化
function updateNotifPermissionHint() {
  const hint = document.getElementById("notif-permission-hint");
  if (!hint) return;
  if (!("Notification" in window)) {
    hint.textContent = t("当前环境不支持系统通知");
    return;
  }
  const perm = Notification.permission;
  if (perm === "granted") hint.textContent = t("已授权系统通知");
  else if (perm === "denied") hint.textContent = t("系统通知权限已被拒绝，请在浏览器设置中手动开启");
  else hint.textContent = t("开启系统通知后将请求浏览器授权");
}

function applyNotificationSettings() {
  state.notifications = {
    soundEnabled: document.getElementById("setting-notif-sound").checked,
    systemNotifEnabled: document.getElementById("setting-notif-system").checked,
  };
  savePersistent();
  // 开启系统通知时自动请求权限
  if (state.notifications.systemNotifEnabled && "Notification" in window && Notification.permission === "default") {
    import("./services/notify.js?v=20261017-001").then(({ requestNotificationPermission }) => {
      return requestNotificationPermission();
    }).then((perm) => {
      updateNotifPermissionHint();
      if (perm === "denied") {
        state.notifications.systemNotifEnabled = false;
        document.getElementById("setting-notif-system").checked = false;
        savePersistent();
      }
    }).catch(() => {});
  } else {
    updateNotifPermissionHint();
  }
}

function initNotificationPersistence() {
  document.getElementById("setting-notif-sound")?.addEventListener("change", applyNotificationSettings);
  document.getElementById("setting-notif-system")?.addEventListener("change", applyNotificationSettings);
}

// 默认审批模式：这里定的只是"每个新对话从哪一档起步"，单个对话在输入框的胶囊里随时改
const PERMISSION_MODE_HINTS = {
  ask: "默认逐条确认：AI 执行命令、访问网络前都会弹窗询问",
  auto: "默认只在命中高危规则（删除、提权、强制推送等）时弹窗询问，其余直接放行；灾难级命令（rm -rf /、format 等）仍强制拦截",
  full: "默认完全访问：命令与联网直接放行，仅在 AI 缺少条件时向你提问；灾难级命令（rm -rf /、format 等）仍强制拦截",
  night: "默认全托管：命令、联网，连「缺少条件时向你确认」也不询问，自行选定方案继续；灾难级命令（rm -rf /、format 等）仍强制拦截",
};

function renderPermissionModeSettings() {
  const mode = state.permissionMode || "ask";
  document.querySelectorAll(".permission-mode-row .review-mode-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  const hint = document.getElementById("permission-mode-hint");
  if (hint) hint.textContent = PERMISSION_MODE_HINTS[mode] || "";
}

function applyPermissionMode(mode) {
  // 走 store 的 setter：没单独选过的对话跟着默认档变，输入框那颗胶囊要收到通知重画
  setDefaultPermissionMode(mode);
  renderPermissionModeSettings();
}

function initPermissionModePersistence() {
  document.querySelectorAll(".permission-mode-row .review-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => applyPermissionMode(btn.dataset.mode));
  });
}

// 夜间模式跑任务时钉住系统别让电脑睡。真碰电源 API 的是后端那条常驻线程（backend/keepawake.py），
// 这里只把"这台机器支持吗 / 现在钉着没"翻译成人话——判据一律读后端回答，不读我们自己勾没勾：
// 勾了但页面没连上后端、或者跑的不是夜间模式那一档，钉住这件事都没发生。
function renderKeepAwakeSettings() {
  const box = document.getElementById("setting-keep-awake-night");
  const hint = document.getElementById("keep-awake-hint");
  const st = keepAwakeStatus();
  if (box) {
    box.checked = state.keepAwakeOnNightRun !== false;
    // 后端明确说了不支持就置灰：留着一颗永远不兑现的勾比没有这颗更糟
    box.disabled = Boolean(st && st.supported === false);
  }
  if (!hint) return;
  if (!st) { hint.textContent = ""; return; }
  if (st.supported === false) {
    hint.textContent = t("这一版只在 Windows 上生效，当前系统不会阻止睡眠");
    return;
  }
  hint.textContent = isHoldingAwake()
    ? t("正在替夜间模式的任务保持系统唤醒：系统不会进入睡眠（屏幕仍可正常熄灭；合盖、手动睡眠、已经入睡的机器无法唤醒）")
    : t("仅在夜间模式任务运行期间保持系统唤醒，任务结束后交还电源策略（屏幕仍可正常熄灭；合盖、手动睡眠、已经入睡的机器无法唤醒）");
}

function initKeepAwakeSettings() {
  document.getElementById("setting-keep-awake-night")?.addEventListener("change", (e) => {
    setKeepAwakeOnNightRun(e.target.checked);
    renderKeepAwakeSettings();
  });
  // 心跳续租/放手都会带回后端的状态，那句"正在钉住"要跟着改，不能等用户重开设置页
  onKeepAwakeStatus(() => renderKeepAwakeSettings());
}

// 联网搜索配置：默认引擎 + JS 渲染策略，变更后立即持久化
const WEB_SEARCH_ENGINE_HINTS = {
  auto: "同时搜索 Bing 与 DuckDuckGo，合并去重，结果更全更准（推荐）",
  bing: "仅用 Bing 搜索，中文结果质量好",
  ddg: "仅用 DuckDuckGo 搜索",
};
const WEB_SEARCH_RENDER_HINTS = {
  auto: "网页正文过短或直连失败时，自动用无头浏览器渲染后再提取（推荐）",
  on: "所有网页都先用无头浏览器渲染再提取，速度较慢",
  off: "不做 JS 渲染，只抓静态内容，动态页面可能为空",
};

function renderWebSearchSettings() {
  const cfg = state.webSearch || { engine: "auto", renderJs: "auto" };
  document.querySelectorAll("#web-search-engine-row .review-mode-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.value === cfg.engine);
  });
  document.querySelectorAll("#web-search-render-row .review-mode-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.value === cfg.renderJs);
  });
  const engineHint = document.getElementById("web-search-engine-hint");
  if (engineHint) engineHint.textContent = WEB_SEARCH_ENGINE_HINTS[cfg.engine] || "";
  const renderHint = document.getElementById("web-search-render-hint");
  if (renderHint) renderHint.textContent = WEB_SEARCH_RENDER_HINTS[cfg.renderJs] || "";
}

function applyWebSearchSetting(key, value) {
  state.webSearch = { ...(state.webSearch || {}), [key]: value };
  savePersistent();
  renderWebSearchSettings();
}

function initWebSearchPersistence() {
  document.querySelectorAll("#web-search-engine-row .review-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => applyWebSearchSetting("engine", btn.dataset.value));
  });
  document.querySelectorAll("#web-search-render-row .review-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => applyWebSearchSetting("renderJs", btn.dataset.value));
  });
}

// ── 通用 UI（Codex 风格极简布局）────────────────

// 面板类条目没有现成 svg，内置 4 个简短描边图标
const CX_ICON_CHAT = '<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const CX_ICON_TEAM = '<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
const CX_ICON_BOARD = '<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="7" y1="10" x2="17" y2="10"/></svg>';
const CX_ICON_EXT = '<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v6"/><path d="M12 16v6"/><path d="M2 12h6"/><path d="M16 12h6"/><circle cx="12" cy="12" r="4"/></svg>';

const CODEX_DOCK_GROUPS = [
  {
    items: [
      { key: "chat", label: "对话", text: "对话", customIcon: CX_ICON_CHAT },
      { key: "team", label: "团队", text: "团队", customIcon: CX_ICON_TEAM },
      { key: "whiteboard", label: "黑板", text: "黑板", customIcon: CX_ICON_BOARD },
      { key: "ext", label: "扩展", text: "扩展", customIcon: CX_ICON_EXT },
    ],
  },
  {
    items: [
      { key: "newchat", label: "新建会话", text: "新建会话", source: "btn-new-chat" },
    ],
  },
];

// 输入框上方工具行：收纳其余功能入口（原 dock 里的对话类与系统类按钮）
const CODEX_QUICK_ACTIONS = [
  { key: "compress", label: "压缩上下文", source: "btn-compress" },
  { key: "memory", label: "记忆与画像", source: "btn-memory" },
  { key: "experts", label: "专家包", source: "btn-experts" },
  { key: "snippets", label: "提示词素材", source: "btn-snippets" },
  { key: "todo", label: "任务清单", source: "btn-todo-panel" },
  { key: "bgtasks", label: "后台任务", source: "btn-bg-tasks" },
  { key: "theme", label: "明暗主题", source: "btn-theme" },
];

function ensureChatMode() {
  switchPanel("chat");
}

// 团队是顶层页签，不再是对话面板里的一个 mode 开关：所有"进团队"的入口
// （黑板工作流的「去团队」、右栏后台讨论回跳、Codex 侧栏 dock）都走同一条 switchPanel。
function openTeamConversation() {
  switchPanel("team");
}

function cxChatAction(sourceId) {
  ensureChatMode();
  document.getElementById(sourceId)?.click();
}

function handleCodexDock(key) {
  switch (key) {
    case "chat":
      switchPanel("chat");
      ensureChatMode();
      break;
    case "team":
      switchPanel("team");
      break;
    case "whiteboard":
      switchPanel("whiteboard");
      break;
    case "ext":
      switchPanel("ext");
      break;
    case "newchat":
      cxChatAction("btn-new-chat");
      setTimeout(refreshCodexHistory, 500);
      break;
    case "settings":
      openSettings();
      break;
  }
  updateDockActive();
}

function buildCodexDockItem(item) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "codex-dock-item";
  btn.dataset.cxKey = item.key;
  btn.title = item.label;
  const iconSpan = document.createElement("span");
  iconSpan.className = "codex-dock-icon";
  if (item.source) {
    const src = document.getElementById(item.source);
    if (src) {
      if (src.title) btn.title = src.title;
      const icon = src.querySelector("svg");
      if (icon) iconSpan.appendChild(icon.cloneNode(true));
      else if (src.firstChild && src.firstChild.nodeType === Node.TEXT_NODE && src.firstChild.textContent.trim()) {
        iconSpan.textContent = src.firstChild.textContent.trim().slice(0, 1);
      }
    }
  }
  if (!iconSpan.firstChild && item.customIcon) {
    const holder = document.createElement("span");
    holder.innerHTML = item.customIcon;
    const svg = holder.firstElementChild;
    if (svg) iconSpan.appendChild(svg);
  }
  if (!iconSpan.firstChild) iconSpan.textContent = (item.text || item.label).slice(0, 1);
  btn.appendChild(iconSpan);
  const label = document.createElement("span");
  label.className = "codex-dock-label";
  label.textContent = item.text || item.label;
  btn.appendChild(label);
  btn.addEventListener("click", () => handleCodexDock(item.key));
  return btn;
}

function buildCodexDock() {
  const dock = document.getElementById("codex-dock");
  if (!dock || dock.dataset.built) return;
  dock.dataset.built = "1";
  // 结构：#codex-dock > .codex-dock-nav(固定导航) + #codex-dock-history(历史，可滚动)
  //                + .codex-dock-bottom(底部设置)
  const nav = document.createElement("div");
  nav.className = "codex-dock-nav";
  for (const group of CODEX_DOCK_GROUPS) {
    const g = document.createElement("div");
    g.className = "codex-dock-group";
    for (const item of group.items) g.appendChild(buildCodexDockItem(item));
    nav.appendChild(g);
  }
  const history = document.createElement("div");
  history.id = "codex-dock-history";
  history.className = "codex-dock-history";
  history.innerHTML = '<div class="codex-hist-empty">暂无历史会话</div>';
  const bottom = document.createElement("div");
  bottom.className = "codex-dock-bottom";
  bottom.appendChild(buildCodexDockItem({ key: "settings", label: "设置", text: "设置", source: "btn-settings" }));
  dock.append(nav, buildCodexSortBar(), history, bottom);
}

// 排序偏好在两种布局里都得能改：只放在经典栏的话，一直用 Codex 的用户永远够不到这个开关。
// 控件仍是同一份 state.taskListSort，两处列表各自订阅，不各写各的。
function buildCodexSortBar() {
  const bar = document.createElement("div");
  bar.className = "codex-dock-sortbar";
  const sel = document.createElement("select");
  sel.id = "cx-conv-sort";
  sel.className = "conv-sort";
  sel.title = t("任务列表排序");
  sel.setAttribute("aria-label", t("任务列表排序"));
  for (const mode of SORT_MODES) {
    const opt = document.createElement("option");
    opt.value = mode.key;
    opt.textContent = t(mode.label);
    sel.appendChild(opt);
  }
  sel.value = normalizeTaskListSort(state.taskListSort);
  sel.addEventListener("change", () => setTaskListSort(sel.value));
  subscribe("taskListSort", (mode) => { sel.value = normalizeTaskListSort(mode); });
  bar.appendChild(sel);
  return bar;
}

function updateDockActive() {
  const dock = document.getElementById("codex-dock");
  if (!dock) return;
  const panelId = document.querySelector(".panel.active")?.id || "";
  let activeKey = "";
  if (panelId === "panel-chat") activeKey = "chat";
  else if (panelId === "panel-team") activeKey = "team";
  else if (panelId === "panel-whiteboard") activeKey = "whiteboard";
  else if (panelId === "panel-ext") activeKey = "ext";
  else if (panelId === "panel-settings") activeKey = "settings";
  dock.querySelectorAll(".codex-dock-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.cxKey === activeKey);
  });
}

// ── 输入框上方工具行（收纳其余功能入口）──────
// 该行插在 #chat-input-area 之前、始终留在 #chat-area 内，
// #chat-messages 会被消息渲染器整体 innerHTML="" 重写，不能放入其中。

function buildCodexQuickActions() {
  const inputArea = document.getElementById("chat-input-area");
  if (!inputArea || document.getElementById("cx-quick-actions")) return;
  const bar = document.createElement("div");
  bar.id = "cx-quick-actions";
  bar.className = "cx-quick-actions";
  for (const item of CODEX_QUICK_ACTIONS) bar.appendChild(buildCodexQuickItem(item));
  inputArea.parentNode.insertBefore(bar, inputArea);
}

function buildCodexQuickItem(item) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cx-quick-item";
  btn.dataset.cxKey = item.key;
  btn.title = item.label;
  const icon = document.createElement("span");
  icon.className = "cx-quick-icon";
  const src = document.getElementById(item.source);
  if (src) {
    if (src.title) btn.title = src.title;
    // 镜像出来的入口得从同步状态起步：顶栏那颗已经收起/置灰，这里还报"可按、已展开"就是骗人
    const pressed = src.getAttribute("aria-pressed");
    if (pressed !== null) btn.setAttribute("aria-pressed", pressed);
    if (src.disabled) {
      btn.disabled = true;
      btn.classList.toggle("is-na", true);
    }
    const svg = src.querySelector("svg");
    if (svg) icon.appendChild(svg.cloneNode(true));
    else if (src.firstChild && src.firstChild.nodeType === Node.TEXT_NODE && src.firstChild.textContent.trim()) {
      icon.textContent = src.firstChild.textContent.trim().slice(0, 1);
    }
  }
  if (!icon.firstChild) icon.textContent = item.label.slice(0, 1);
  btn.appendChild(icon);
  const label = document.createElement("span");
  label.className = "cx-quick-label";
  label.textContent = item.label;
  btn.appendChild(label);
  btn.addEventListener("click", () => handleCodexQuick(item.key));
  return btn;
}

function handleCodexQuick(key) {
  const item = CODEX_QUICK_ACTIONS.find(a => a.key === key);
  if (item) cxChatAction(item.source);
}

// ── 左侧历史会话：按项目分组陈列 ────────────

let cxConvsCache = [];
const cxHistoryCollapsed = new Set();
// 生成归属会话：由 chat.js 的 slate:task-badges-updated 事件带过来（切换会话即中断，
// 这个数只有那一侧知道），Codex 列表据此点亮"进行中"
let cxActiveConvId = "";

function cxTaskCtx() {
  // registry 进来是为了让分组按 project_id 认，不再被"两个同名项目"骗成一堆
  // runningConvIds 直接读 store 那份快照：两壳同一份真源，各自数一遍迟早数出两个答案
  return {
    flags: state.taskFlags,
    activeConvId: cxActiveConvId,
    runningConvIds: new Set((state.runs || []).map(r => r.conv_id).filter(Boolean)),
    registry: state.projects,
  };
}

async function refreshCodexHistory() {
  if (state.uiMode !== "codex") return;
  try {
    const res = await get("/chat/conversations");
    if (res.code === 0) {
      cxConvsCache = Array.isArray(res.data) ? res.data : [];
      renderCodexHistory();
    }
  } catch (e) { /* 列表刷新失败静默 */ }
}

// chat.js 落徽标/换排序/生成权变动时重绘（不重新拉列表：状态变了，数据没变）
window.addEventListener("slate:task-badges-updated", (e) => {
  cxActiveConvId = e?.detail?.activeConvId || "";
  renderCodexHistory();
});

function renderCodexHistory() {
  const box = document.getElementById("codex-dock-history");
  if (!box) return;
  if (document.documentElement.getAttribute("data-ui") !== "codex") return;
  box.innerHTML = "";
  if (!cxConvsCache.length) {
    box.innerHTML = '<div class="codex-hist-empty">暂无历史会话</div>';
    cxHistReveal(box);
    return;
  }
  const ctx = cxTaskCtx();
  // 分组顺序、组内条目次序都交给 task_list：换排序时两处列表才不会各排各的
  for (const [name, convs, meta] of groupConversationsByProject(cxConvsCache, state.taskListSort, ctx)) {
    box.appendChild(buildCodexHistGroup(name, convs, ctx, meta));
    if (cxHistoryCollapsed.has(name)) continue;
    const list = document.createElement("div");
    list.className = "codex-hist-list";
    for (const conv of convs) list.appendChild(buildCodexHistItem(conv, ctx));
    box.appendChild(list);
  }
  cxHistReveal(box);
}

function buildCodexHistGroup(name, convs, ctx, meta = {}) {
  const row = document.createElement("div");
  row.className = "codex-hist-group-row";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "codex-hist-group";
  const collapsed = cxHistoryCollapsed.has(name);
  const caret = document.createElement("span");
  caret.className = "codex-hist-caret" + (collapsed ? "" : " open");
  caret.textContent = "▸";
  head.appendChild(caret);
  const title = document.createElement("span");
  title.className = "codex-hist-group-name";
  title.textContent = name;
  head.appendChild(title);
  const num = document.createElement("span");
  num.className = "codex-hist-group-count";
  num.textContent = String(convs.length);
  head.appendChild(num);
  // 折叠起来也要看得见"这组里有要处理的"：取组内最急的那个状态
  const top = convs.map(c => taskStatusOf(c, ctx)).filter(s => s !== STATUS.IDLE)
    .sort((a, b) => statusMark(a).rank - statusMark(b).rank)[0];
  const badge = statusBadge(top || STATUS.IDLE);
  if (badge) {
    const mark = document.createElement("span");
    mark.className = badge.className + " codex-hist-group-status";
    mark.dataset.status = badge.status;
    mark.title = t(badge.label);
    mark.appendChild(iconSvgEl(badge.icon));
    head.appendChild(mark);
  }
  head.addEventListener("click", () => {
    if (collapsed) cxHistoryCollapsed.delete(name);
    else cxHistoryCollapsed.add(name);
    renderCodexHistory();
  });
  row.appendChild(head);

  // 组头操作：这一组对应一个在册项目时才给（"未分类"与按名称回落的那组没有 id 可操作）
  const projectId = String(meta?.projectId || "");
  if (projectId) {
    const entry = state.projects.find(p => p?.id === projectId);
    const acts = document.createElement("span");
    acts.className = "codex-hist-group-acts";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "codex-hist-group-act";
    open.appendChild(iconSvgEl("folder"));
    open.title = t("切到该项目");
    open.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { switchToProject } = await import("./services/project_scene.js?v=20261017-001");
      const out = await switchToProject(projectId);
      if (!out.ok) toast(out.reason || t("切换失败"));
      await refreshCodexHistory();
    });
    acts.appendChild(open);

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "codex-hist-group-act";
    pin.appendChild(iconSvgEl("star"));
    pin.title = entry?.pinned ? t("取消固定") : t("固定项目");
    pin.setAttribute("aria-pressed", entry?.pinned ? "true" : "false");
    pin.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { patchRegistry } = await import("./services/project.js?v=20261017-001");
      const { refreshRegistry } = await import("./services/project_scene.js?v=20261017-001");
      await patchRegistry(projectId, { pinned: !(entry?.pinned) });
      await refreshRegistry();
      renderCodexHistory();
    });
    acts.appendChild(pin);

    row.appendChild(acts);
  }
  return row;
}

function buildCodexHistItem(conv, ctx) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "codex-hist-item" + (conv.id === state.currentConversationId ? " active" : "");
  btn.dataset.convId = conv.id;
  const badge = statusBadge(taskStatusOf(conv, ctx));
  if (badge) btn.classList.add("is-" + badge.status);
  // 装饰点换成真状态点：没有徽标就是没有可说的状态，不占位也不画"正常"
  const dot = document.createElement("span");
  dot.className = "codex-hist-dot" + (badge ? " " + badge.className : "");
  if (badge) {
    dot.dataset.status = badge.status;
    dot.title = t(badge.label);
    dot.appendChild(iconSvgEl(badge.icon));
  }
  btn.appendChild(dot);
  const title = document.createElement("span");
  title.className = "codex-hist-item-title";
  title.textContent = conv.title || conv.id;
  btn.appendChild(title);
  btn.addEventListener("click", () => cxOpenConv(conv.id));
  return btn;
}

async function cxOpenConv(convId) {
  switchPanel("chat");
  ensureChatMode();
  await openConversation(convId);
  updateDockActive();
}

function applyUiMode() {
  const codexOn = state.uiMode === "codex";
  const enteringCodex = codexOn && prevUiMode !== "codex";
  prevUiMode = state.uiMode;
  const html = document.documentElement;
  if (codexOn) html.setAttribute("data-ui", "codex");
  else html.removeAttribute("data-ui");
  if (codexOn) buildCodexQuickActions();
  else document.getElementById("cx-quick-actions")?.remove();
  if (codexOn) refreshCodexHistory();
  updateDockActive();
  if (enteringCodex) {
    requestAnimationFrame(() => {
      cxDockIn();
      const panelEl = document.getElementById("panel-" + activePanelName);
      if (panelEl) cxPanelIn(panelEl, activePanelName === "whiteboard" ? 0 : 6);
      cxHistReveal(document.getElementById("codex-dock-history"), true);
    });
  }
}

// ── 明暗切换的唯一入口 ──────────────────────
// 顶栏按钮、Ctrl+D、通用 UI 的「明暗主题」快捷项（它点的是同一颗 btn-theme）都走这里。
// 自定义主题生效时 store 会拒绝切换，这里负责把"为什么没换"说出来：
// 只把按钮置灰不解释，最容易让人以为按钮坏了。
function requestThemeToggle() {
  if (toggleTheme()) {
    toast(state.theme === "dark" ? t("深色模式") : t("浅色模式"));
    return true;
  }
  toast(t("自定义主题生效中：先在「设置 → 自定义主题」里关掉它，才能切换深色/浅色"));
  return false;
}

// 锁的样子只改 class 与 title，不置 disabled：点了要有回应，禁用态给不了回应
function syncThemeLockUI() {
  const btn = document.getElementById("btn-theme");
  if (!btn) return;
  const locked = customThemeActive();
  btn.classList.toggle("is-locked", locked);
  btn.title = locked ? "自定义主题生效中，明暗切换已锁定" : "切换主题";
}

function initUiMode() {
  buildCodexDock();
  const setting = document.getElementById("setting-ui-mode");
  setting?.addEventListener("change", () => {
    state.uiMode = setting.checked ? "codex" : "classic";
    savePersistent();
    applyUiMode();
    toast(state.uiMode === "codex" ? t("已切换到通用 UI（Codex 风格）") : t("已恢复经典布局"));
  });
  window.addEventListener("slate:convs-updated", () => {
    if (state.uiMode === "codex") refreshCodexHistory();
  });
  window.addEventListener("slate:conv-active-changed", () => renderCodexHistory());
  applyUiMode();
}

// ── 左栏三页签：项目 / 任务 / 总结（滑块切换）──────────────

const LS_PANES = ["project", "task", "summary"];

function activateLeftPane(name) {
  const idx = LS_PANES.indexOf(name);
  if (idx < 0) return;
  document.querySelectorAll("#left-slider .ls-seg").forEach(seg => {
    const on = seg.dataset.pane === name;
    seg.classList.toggle("active", on);
    seg.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll("#project-sidebar .ls-pane").forEach(pane => {
    pane.classList.toggle("active", pane.id === `ls-pane-${name}`);
  });
  const thumb = document.getElementById("left-slider-thumb");
  if (thumb) thumb.style.transform = `translateX(${idx * 100}%)`;
  window.dispatchEvent(new CustomEvent("slate:left-pane", { detail: { pane: name } }));
}

function initLeftSidebar() {
  const slider = document.getElementById("left-slider");
  if (!slider) return;
  slider.addEventListener("click", (e) => {
    const seg = e.target.closest(".ls-seg");
    if (seg) activateLeftPane(seg.dataset.pane);
  });
  activateLeftPane(slider.querySelector(".ls-seg.active")?.dataset.pane || "project");
  initSessionSummary();
}

// ── 媒体生成配置（图片/视频）──────────────────

const GEN_CONFIGS = {
  image: {
    stateKey: "imageGen",
    label: "图片生成",
    modelInput: "image-gen-model",
    urlInput: "image-gen-url",
    keyInput: "image-gen-key",
    statusEl: "image-gen-status",
  },
  video: {
    stateKey: "videoGen",
    label: "视频生成",
    modelInput: "video-gen-model",
    urlInput: "video-gen-url",
    keyInput: "video-gen-key",
    statusEl: "video-gen-status",
  },
};

function renderGenSettings(kind) {
  const c = GEN_CONFIGS[kind];
  if (!c) return;
  const cfg = state[c.stateKey] || {};
  const modelEl = document.getElementById(c.modelInput);
  const urlEl = document.getElementById(c.urlInput);
  const keyEl = document.getElementById(c.keyInput);
  const statusEl = document.getElementById(c.statusEl);
  if (modelEl) modelEl.value = cfg.model || "";
  if (urlEl) urlEl.value = cfg.base_url || "https://api.openai.com/v1";
  if (keyEl) keyEl.value = cfg.api_key || "";
  if (statusEl) {
    statusEl.textContent = (cfg.model && cfg.api_key)
      ? t("已配置 — 当前模型：{model}（{url}）", { model: cfg.model, url: cfg.base_url || "https://api.openai.com/v1" })
      : t("未配置 — 调用 {tool} 工具会返回错误", { tool: kind === "image" ? "image_gen" : "video_gen" });
  }
}

function renderImageGenSettings() { renderGenSettings("image"); }
function renderVideoGenSettings() { renderGenSettings("video"); }

function applyGenSetting(kind, key, value) {
  const c = GEN_CONFIGS[kind];
  if (!c) return;
  state[c.stateKey] = { ...(state[c.stateKey] || {}), [key]: value };
  savePersistent();
  renderGenSettings(kind);
}

function initGenSettingsPersistence() {
  Object.entries(GEN_CONFIGS).forEach(([kind, c]) => {
    const modelEl = document.getElementById(c.modelInput);
    const urlEl = document.getElementById(c.urlInput);
    const keyEl = document.getElementById(c.keyInput);
    if (modelEl) modelEl.addEventListener("change", () => applyGenSetting(kind, "model", modelEl.value.trim()));
    if (urlEl) urlEl.addEventListener("change", () => applyGenSetting(kind, "base_url", urlEl.value.trim()));
    if (keyEl) keyEl.addEventListener("change", () => applyGenSetting(kind, "api_key", keyEl.value));
  });
}

async function saveSettings() {
  const maxTokens = parseInt(document.getElementById("setting-max-tokens").value) || 64000;
  state.maxTokens = maxTokens;
  state.outputSettings = {
    maxTokens: Math.max(1024, Math.min(65536, parseInt(document.getElementById("setting-output-max-tokens").value) || 16384)),
    unlimitedFileOutput: document.getElementById("setting-output-unlimited").checked,
  };
  state.fileOutput = {
    autoApply: document.getElementById("setting-file-auto-apply").checked,
  };
  state.autoReview = {
    enabled: document.getElementById("setting-auto-review-enabled").checked,
    modelId: document.getElementById("setting-auto-review-model").value || "",
    minChars: Math.max(20, Math.min(800, parseInt(document.getElementById("setting-auto-review-min-chars").value) || 120)),
    reviewLongStall: document.getElementById("setting-auto-review-long-stall")?.checked === true,
  };
  state.notifications = {
    soundEnabled: document.getElementById("setting-notif-sound").checked,
    systemNotifEnabled: document.getElementById("setting-notif-system").checked,
  };
  
  const constText = document.getElementById("setting-constitution").value.trim();
  if (constText) {
    let constData = null;
    try {
      constData = JSON.parse(constText);
    } catch {
      // 以前这里静默吞掉：填了个不合法 JSON，点保存什么也没发生
      toast(t("宪法不是合法 JSON，未保存"));
    }
    if (constData) {
      if (state.project) {
        // 打开着项目就写进项目（.slate/config.json，跟着仓库走），全局版本保持不动
        const { updateProjectConfig } = await import("./services/project.js?v=20261017-001");
        const config = { ...(state.project.config || {}), constitution: constData };
        const res = await updateProjectConfig(config);
        if (res.code === 0) setProject(res.data);
        else toast(t("项目宪法保存失败：{msg}", { msg: res.message || "" }));
      } else {
        await put("/constitution", constData);
        setConstitution(constData);
      }
    }
  }

  savePersistent();
  toast(t("设置已保存"));
}

// ── 标签页切换 ─────────────────────────────

function initTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  tabs.forEach(tab => tab.addEventListener("click", () => {
    // 设置页需通过 openSettings 渲染模型列表/用量等内容，否则直接切入为空
    if (tab.dataset.panel === "settings") openSettings();
    else switchPanel(tab.dataset.panel);
  }));
}

// ── 键盘快捷键──────────────────────────────

function initKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && copySelectedText()) {
      e.preventDefault();
      return;
    }
    // Ctrl+N: 新建对话（Mac 上是 ⌘N：那边的键盘没有 Ctrl 这个肌肉记忆，
    // 两个修饰键都认，界面里那句 "Ctrl+N" 在两边就都还是真的）
    // defaultPrevented 那条是给白板让的：⌘D 在板上是"复制选中卡片"，元素上的监听先跑，
    // 这里再跟着翻主题就是两个动作叠在一起（两个修饰键都认之后 Mac 也会撞上，所以一并让）
    if ((e.ctrlKey || e.metaKey) && !e.defaultPrevented && e.key === "n") {
      e.preventDefault();
      document.getElementById("btn-new-chat")?.click();
    }
    // Ctrl+D: 切换主题（同上，Mac 走 ⌘D）
    if ((e.ctrlKey || e.metaKey) && !e.defaultPrevented && e.key === "d") {
      e.preventDefault();
      requestThemeToggle();
    }
    // Escape: 关闭弹窗
    if (e.key === "Escape") {
      // 高危审批弹窗必须走 settle，否则 pendingResolve 永久挂起、守卫失效（BUG #12）
      const riskModal = document.getElementById("risk-modal");
      if (riskModal && !riskModal.classList.contains("hidden")) {
        document.getElementById("btn-risk-reject")?.click();
      }
      document.querySelectorAll(".modal:not(.hidden)").forEach(m => m.classList.add("hidden"));
    }
  });
}

function getSelectedPageText() {
  const active = document.activeElement;
  if (active && ["INPUT", "TEXTAREA"].includes(active.tagName)) return "";
  const selection = window.getSelection();
  const text = selection ? selection.toString() : "";
  return text.trim() ? text : "";
}

function copySelectedText() {
  const text = getSelectedPageText();
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {
      try { document.execCommand("copy"); } catch (e) {}
    });
  } else {
    try { document.execCommand("copy"); } catch (e) {}
  }
  return true;
}

function initSelectionCopySupport() {
  document.addEventListener("copy", (e) => {
    const text = getSelectedPageText();
    if (!text || !e.clipboardData) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  });
}

// ── 加载模型 ────────────────────────────────

async function loadModels() {
  try {
    const res = await get("/proxy/models");
    console.log("Model API response:", res);
    if (res.code === 0) {
      console.log("Model registry data:", res.data);
      setModelRegistry(res.data);
      populateModelSelect();
      populateAutoReviewModelSelect();
    } else {
      console.warn("Model API returned non-zero code:", res);
    }
  } catch (e) {
    console.error("加载模型列表失败:", e);
  }
}

// ── 启动时自动检查更新────────────────

/** 查询 GitHub 最新 Release，有新版本时展示金色横幅；失败静默，不打扰用户 */
async function checkAppUpdate() {
  try {
    const res = await get("/update/check");
    const d = res?.code === 0 ? res.data : null;
    if (!d?.hasUpdate) return;
    let dismissed = "";
    try { dismissed = localStorage.getItem("slate-update-dismissed") || ""; } catch {}
    if (dismissed === d.latest) return; // 用户已选择忽略该版本
    const banner = document.getElementById("update-banner");
    if (!banner) return;
    banner.innerHTML = "";

    const txt = document.createElement("span");
    txt.className = "update-banner-text";
    txt.textContent = t("发现新版 v{latest}（当前 v{current}）", { latest: d.latest, current: d.current });

    const openLink = (url) => async () => {
      const r = await post("/update/open-url", { url });
      if (r.code !== 0) toast(r.message || t("打开链接失败"), 3000);
    };

    const dl = document.createElement("button");
    dl.className = "update-banner-btn";
    dl.textContent = "下载更新";
    dl.addEventListener("click", openLink(d.downloadUrl));

    const rel = document.createElement("button");
    rel.className = "update-banner-btn update-banner-ghost";
    rel.textContent = "更新说明";
    rel.addEventListener("click", openLink(d.releaseUrl));

    const close = document.createElement("button");
    close.className = "update-banner-close";
    close.appendChild(iconSvgEl("x"));
    close.title = "忽略该版本";
    close.addEventListener("click", () => {
      banner.classList.add("hidden");
      try { localStorage.setItem("slate-update-dismissed", d.latest); } catch {}
    });

    banner.append(txt, dl, rel, close);
    banner.classList.remove("hidden");
  } catch (e) {
    console.warn("检查更新失败", e);
  }
}

// ── 初始化 ─────────────────────────────────

async function init() {
  // i18n 必须最先完成：英文模式要在任何界面渲染前挂好翻译监听
  await initI18n();


  loadPersistent();
  await loadSharedPersistent();

  // 应用保存的主题
  document.documentElement.setAttribute("data-theme", state.theme);
  // 自定义主题只走这一条生效通道：控件写 store → store 通知 → 这里注入样式并同步锁的样子。
  // 启动时也来一次，把上次存的色板装回去（背景图不在本机时自动退成"只换色、不铺图"）。
  subscribe("customTheme", (theme) => {
    applyCustomTheme(theme);
    renderThemeSettings();
    syncThemeLockUI();
  });
  applyCustomTheme(state.customTheme).then(syncThemeLockUI);
  applyUiMode();


  safeInit("标签页", initTabs);
  safeInit("对话", initChat);
  safeInit("黑板", initWhiteboard);
  safeInit("提示词工厂", initPromptFactory);
  // 分栏轨要先立起来：技能/MCP/专家包各栏渲染完会把条数写进轨上的徽标，晚一步就写空
  safeInit("扩展页", initExtensions);
  safeInit("技能面板", initSkillPanel);
  safeInit("模式栏", initModePanel);
  safeInit("MCP Server", initMcpServerPanel);
  safeInit("AI 团队", initTeamPanel);
  safeInit("项目栏", initProjectBar);
  safeInit("左栏页签", initLeftSidebar);
  safeInit("记忆面板", initMemoryPanel);
  safeInit("专家包", initExpertsPanel);
  safeInit("定时任务", initSchedule);
  safeInit("高危命令守卫", initRiskGuard);
  safeInit("项目理解", initUnderstandPanel);
  safeInit("快捷键", initKeyboardShortcuts);
  safeInit("文本复制", initSelectionCopySupport);

  // 模型选择
  document.getElementById("model-select").addEventListener("change", handleModelSelect);
  // 模型被任何路径改掉（读旧对话、手机遥控同步、注册表回填、密钥弹窗回落）都得跟着换图标：
  // 只在下拉的 change 事件里刷，会让图标停在上一个家，用户以为还在用原来的模型。
  subscribe("model", (model) => {
    const m = model || state.currentModel;
    const sel = document.getElementById("model-select");
    // 先对齐全局的值再刷图标：图标与 title 都读的是"当前选中那一项"，顺序反了会读到上一个家
    if (sel && m && sel.value !== m.id) sel.value = m.id;
    updateModelIcon(m);
  });

  // 密钥管理按钮
  document.getElementById("btn-manage-keys").addEventListener("click", openSettings);

  // 自定义模型编辑器
  document.getElementById("btn-save-custom-model").addEventListener("click", saveCustomModel);
  document.getElementById("btn-add-custom-model-settings")?.addEventListener("click", () => openCustomModelModal());
  document.getElementById("btn-cancel-custom-model")?.addEventListener("click", closeCustomModelModal);

  // 主题切换
  document.getElementById("btn-theme").addEventListener("click", () => {
    requestThemeToggle();
  });

  // 设置弹窗
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("btn-save-settings").addEventListener("click", saveSettings);
  // 顶栏局域网入口：直达设置页“局域网遥控”区块（明显的网址获取入口）
  document.getElementById("btn-lan")?.addEventListener("click", () => openSettings({ focusLan: true }));

  document.getElementById("btn-lan-refresh")?.addEventListener("click", renderLanInfo);
  // 遥控开关：只在桌面主端口生效，手机端调不动（后端会拒绝并回一句提示）
  document.getElementById("lan-enabled")?.addEventListener("change", (e) => toggleLanRemote(e.target.checked, e.target));
  initAutoReviewPersistence();
  initNotificationPersistence();
  initPermissionModePersistence();
  initKeepAwakeSettings();
  safeInit("夜间模式保持清醒", initKeepAwake);
  initWebSearchPersistence();
  initGenSettingsPersistence();
  safeInit("AI 辅助功能设置", initAiFeatureSettings);
  safeInit("自定义主题设置", initThemeSettings);
  safeInit("会话归档设置", initSessionArchiveSettings);
  initUiMode();
  safeInit("API 测试", initApiTest);
  safeInit("打字小游戏", initTypingGame);
  window.addEventListener("slate:open-settings", (event) => openSettings(event.detail || {}));

  // 设置页导航与关于
  safeInit("设置导航", initSettingsNav);

  document.getElementById("btn-check-update")?.addEventListener("click", (e) => checkUpdateNow(e.currentTarget));
  safeInit("首次启动引导", initOnboarding);
  safeInit("数据备份恢复", initBackupRestore);
  safeInit("关于区链接", initAboutLinks);
  safeInit("存储空间管理", initStorageManage);

  await loadModels();

  // 恢复上次的视野（失败不中断启动）。
  // 顺序换了：先问服务端"你在看哪个项目"——注册表落在 projects.json 之后，服务端重启
  // 也能自己把 active 认回来，不再依赖浏览器里那份 lastProjectPath。
  // lastProjectPath 退成第二道：老数据第一次升级到带注册表的版本时，册子是空的，
  // 拿它补登一次，用户不会感到"项目不见了"。
  try {
    const { refreshRegistry, restoreScene } = await import("./services/project_scene.js?v=20261017-001");
    const res = await getCurrentProject();
    let project = res.code === 0 ? res.data : null;
    if (!project && state._lastProjectPath) {
      const { openProject } = await import("./services/project.js?v=20261017-001");
      const openRes = await openProject(state._lastProjectPath);
      if (openRes.code === 0) project = openRes.data;
    }
    if (project) {
      setProject(project);
      await refreshRegistry();
      await restoreScene(project);
      // 确保文件树加载（还原现场可能已经切过会话，这里只补目录视图）
      const browseRes = await browseFiles("");
      if (browseRes.code === 0) setProjectFileTree(browseRes.data);
    } else {
      await refreshRegistry();
    }
  } catch (e) {
    console.warn("[SLATE] 恢复项目失败:", e);
  }

  // 启动时自动检查更新（不阻塞初始化，失败静默）
  checkAppUpdate();

}

document.addEventListener("DOMContentLoaded", init);

export { toast, openSettings, openTeamConversation };
