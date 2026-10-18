/**
 * 扩展页「模式」栏 + 回复模式编辑器。
 *
 * 模式本体（追加提示词 / 工具白名单 / 推理强度 / 轮数 / 模型）定义在 store.js 的注册表里，
 * 这一栏只是它的编辑器：内置四档（智能 / 对话 / 经济 / 狂暴）只读展示，自定义模式可增改删。
 * 与「输入框浮层选哪一场用哪个」是两件事——那边改"这一场"，这边改"模式本身长什么样"。
 *
 * 模型也能建模式：走 tools.js 的 mode_write，最终同样落在 store 的 addMode/updateMode/removeMode，
 * 所以这里订阅 "modes" 重画即可，不需要知道是谁改的。
 */

import {
  subscribe, modeRegistry, modeById, addMode, updateMode, removeMode,
  MODE_TOOLS_NONE, MODE_READONLY_TOOLS,
} from "../store.js?v=20261017-001";
import { TOOLS } from "../services/tools.js?v=20261017-001";
import { iconSvgEl } from "../services/icons.js?v=20261017-001";
import { t } from "../services/i18n.js?v=20261017-001";
import { dlgConfirm } from "../services/dialog.js?v=20261017-001";
import { allRegisteredModels } from "../services/ai_features.js?v=20261017-001";
import { setExtCount } from "./extensions.js?v=20261017-001";
import { modeHint } from "./mode_picker.js?v=20261017-001";

// 可选图标：够表达"这个模式是干什么的"即可，不做全量图标库（挑花眼反而选不出）。
const ICON_PALETTE = [
  "tool", "message-circle", "leaf", "flame", "zap", "target", "compass", "sparkles",
  "bot", "shield", "star", "lightbulb", "search", "sliders", "clock", "globe",
  "code", "terminal", "hash", "palette", "send", "moon", "factory", "package",
  "book-open", "activity", "crosshair", "bar-chart",
];
const COLOR_PRESETS = ["#7c8cff", "#2fd4c4", "#3fb950", "#ff7a45", "#e06c9f", "#d8a657", "#a78bfa", "#9aa4b2"];

let listEl, modal, titleEl, noteEl;
let fId, fLabel, fColor, fPrompt, fScope, fTools, fEffort, fRounds, fModel, msgEl, btnSave, btnDelete;
let iconWrap, swatchWrap;
let editingId = "";       // "" = 新建
let editingBuiltin = false;
let pickedIcon = "tool";
let pickedTools = [];

function toolNames() {
  return Object.keys(TOOLS);
}

function sameToolSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const s = new Set(b);
  return a.every(x => s.has(x));
}

// ── 列表 ────────────────────────────────────

function renderList() {
  if (!listEl) return;
  const modes = modeRegistry();
  listEl.innerHTML = "";
  setExtCount("modes", modes.length);

  for (const m of modes) {
    const builtin = ["smart", "chat", "eco", "turbo"].includes(m.id);
    const row = document.createElement("div");
    row.className = "skill-item mode-item";
    row.dataset.modeId = m.id;
    row.style.setProperty("--mode-color", m.color);

    const ico = document.createElement("span");
    ico.className = "mode-item-icon";
    ico.appendChild(iconSvgEl(m.icon));

    const info = document.createElement("div");
    const nameRow = document.createElement("div");
    nameRow.className = "skill-item-name";
    const badge = document.createElement("span");
    badge.className = "skill-kind-badge " + (builtin ? "skill-kind-builtin" : "skill-kind-model");
    badge.textContent = builtin ? t("内置") : t("自定义");
    nameRow.appendChild(badge);
    nameRow.appendChild(document.createTextNode(" " + t(m.label)));
    const desc = document.createElement("div");
    desc.className = "skill-item-desc";
    desc.textContent = modeHint(m);
    info.appendChild(nameRow);
    info.appendChild(desc);

    row.append(ico, info);
    row.addEventListener("click", () => openModeModal(m.id));
    listEl.appendChild(row);
  }
}

// ── 弹窗 ────────────────────────────────────

function openModeModal(id) {
  if (!modal) return;
  const builtin = ["smart", "chat", "eco", "turbo"].includes(id);
  editingBuiltin = builtin;
  editingId = builtin ? "" : id;
  const mode = builtin ? modeById(id) : (id ? modeById(id) : modeById("smart"));
  titleEl.textContent = builtin ? t("查看回复模式") : (id ? t("编辑回复模式") : t("新建回复模式"));
  noteEl.textContent = builtin
    ? t("内置模式只读：想改成别的样，就「+ 新建模式」复制一份再改")
    : "";
  noteEl.classList.toggle("hidden", !builtin);
  fillForm(builtin ? mode : (id ? mode : null));
  modal.classList.remove("hidden");
}

function closeModal() {
  modal?.classList.add("hidden");
}

function fillForm(mode) {
  const isNew = !mode;
  const src = mode || { id: "", label: "", icon: "tool", color: "#7c8cff", prompt: "", tools: null, effort: "", rounds: 0, model: "" };
  fId.value = src.id || "";
  // id 是引用键（每场会话 + 默认档都按它指），所以只有新建能填；改它等于把引用改断
  fId.disabled = !isNew;
  fLabel.value = src.id && src.label && src.label !== src.id ? src.label : "";
  fPrompt.value = src.prompt || "";
  fEffort.value = src.effort || "";
  fRounds.value = src.rounds ? String(src.rounds) : "";
  renderModelOptions(src.model || "");
  pickedIcon = src.icon || "tool";
  renderIconPick();
  fColor.value = /^#[0-9a-fA-F]{6}$/.test(src.color) ? src.color : "#7c8cff";
  renderSwatches();
  // 工具范围：none / 只读整集 / 受限自定义 / 不限制
  if (src.tools === MODE_TOOLS_NONE) fScope.value = "none";
  else if (sameToolSet(src.tools, MODE_READONLY_TOOLS)) fScope.value = "readonly";
  else if (Array.isArray(src.tools)) fScope.value = "custom";
  else fScope.value = "all";
  pickedTools = Array.isArray(src.tools) ? [...src.tools] : [];
  renderToolGrid();
  syncScopeUi();
  // 内置档不给保存/删除，整张表单也锁住：它们是产品语义的锚点
  btnSave.classList.toggle("hidden", editingBuiltin);
  btnDelete.classList.toggle("hidden", editingBuiltin || isNew);
  setFormDisabled(editingBuiltin);
  setMsg("");
}

function renderModelOptions(selectedId) {
  const opts = [`<option value="">${t("跟随当前主模型")}</option>`];
  for (const m of allRegisteredModels()) {
    if (!m?.id) continue;
    opts.push(`<option value="${m.id}">${m.name || m.id}</option>`);
  }
  if (selectedId && !allRegisteredModels().some(m => m?.id === selectedId)) {
    opts.push(`<option value="${selectedId}" selected>${selectedId}</option>`);
  }
  fModel.innerHTML = opts.join("");
  fModel.value = selectedId || "";
}

function renderIconPick() {
  if (!iconWrap) return;
  iconWrap.innerHTML = "";
  for (const name of ICON_PALETTE) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mode-icon-opt" + (name === pickedIcon ? " is-on" : "");
    b.dataset.icon = name;
    b.title = name;
    b.appendChild(iconSvgEl(name));
    b.addEventListener("click", () => { pickedIcon = name; renderIconPick(); });
    iconWrap.appendChild(b);
  }
}

function renderSwatches() {
  if (!swatchWrap) return;
  swatchWrap.innerHTML = "";
  for (const c of COLOR_PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mode-swatch" + (c.toLowerCase() === String(fColor.value).toLowerCase() ? " is-on" : "");
    b.style.background = c;
    b.title = c;
    b.addEventListener("click", () => { fColor.value = c; renderSwatches(); });
    swatchWrap.appendChild(b);
  }
}

function renderToolGrid() {
  if (!fTools) return;
  fTools.innerHTML = "";
  for (const name of toolNames()) {
    const id = `mode-tool-${name}`;
    const label = document.createElement("label");
    label.className = "mode-tool-opt";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.value = name;
    cb.checked = pickedTools.includes(name);
    const span = document.createElement("span");
    span.textContent = name;
    cb.addEventListener("change", () => {
      const set = new Set(pickedTools);
      if (cb.checked) set.add(name); else set.delete(name);
      pickedTools = [...set];
    });
    label.append(cb, span);
    fTools.appendChild(label);
  }
}

function syncScopeUi() {
  fTools.classList.toggle("hidden", fScope.value !== "custom");
}

/** 内置档是产品语义的锚点：整张表单锁住，只让人看它现在长什么样。
 *  id 单独定（见 fillForm 的 `fId.disabled = !isNew`）：新建要能自己填，已有/内置锁死——
 *  它是每场会话与默认档的引用键，改名等于把引用改断。 */
function setFormDisabled(disabled) {
  for (const el of [fLabel, fPrompt, fScope, fEffort, fRounds, fModel]) {
    if (el) el.disabled = disabled;
  }
  fColor.disabled = disabled;
  for (const b of iconWrap.querySelectorAll("button")) b.disabled = disabled;
  for (const b of swatchWrap.querySelectorAll("button")) b.disabled = disabled;
  for (const cb of fTools.querySelectorAll("input")) cb.disabled = disabled;
}

function setMsg(text, bad = false) {
  if (!msgEl) return;
  msgEl.textContent = text || "";
  msgEl.classList.toggle("is-bad", Boolean(bad));
}

function readForm() {
  const scope = fScope.value;
  let tools = null;
  if (scope === "none") tools = MODE_TOOLS_NONE;
  else if (scope === "readonly") tools = [...MODE_READONLY_TOOLS];
  else if (scope === "custom") tools = pickedTools.length ? [...pickedTools] : MODE_TOOLS_NONE;
  const rounds = Number(fRounds.value) || 0;
  return {
    id: String(fId.value || "").trim(),
    label: String(fLabel.value || "").trim(),
    icon: pickedIcon,
    color: fColor.value,
    prompt: fPrompt.value,
    tools,
    effort: fEffort.value,
    rounds,
    model: fModel.value || "",
  };
}

function save() {
  const spec = readForm();
  if (!spec.id) return setMsg(t("请先填 id（小写字母开头，如 deep_focus）"), true);
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(spec.id)) {
    return setMsg(t("id 只能是小写字母开头的 a-z0-9_-（不超过 40 字）"), true);
  }
  if (!spec.label) return setMsg(t("请给模式起个名字"), true);
  if (editingId) {
    const merged = updateMode(editingId, spec);
    if (!merged) return setMsg(t("保存失败：模式不存在或字段不合法"), true);
  } else {
    const created = addMode(spec);
    if (!created) return setMsg(t("新建失败：id 与内置模式或已有自定义模式冲突"), true);
  }
  closeModal();
}

async function del() {
  if (!editingId) return;
  const mode = modeById(editingId);
  const ok = await dlgConfirm(
    t("确定删除回复模式「{name}」？正在使用它的会话会回落到默认模式。", { name: t(mode.label) }),
    { title: t("删除回复模式"), okText: t("删除"), cancelText: t("取消") },
  );
  if (!ok) return;
  removeMode(editingId);
  closeModal();
}

// ── 初始化 ──────────────────────────────────

function initModePanel() {
  listEl = document.getElementById("ext-mode-list");
  modal = document.getElementById("mode-modal");
  titleEl = document.getElementById("mode-modal-title");
  noteEl = document.getElementById("mode-builtin-note");
  fId = document.getElementById("mode-f-id");
  fLabel = document.getElementById("mode-f-label");
  fColor = document.getElementById("mode-f-color");
  fPrompt = document.getElementById("mode-f-prompt");
  fScope = document.getElementById("mode-f-tools-scope");
  fTools = document.getElementById("mode-f-tools-pick");
  fEffort = document.getElementById("mode-f-effort");
  fRounds = document.getElementById("mode-f-rounds");
  fModel = document.getElementById("mode-f-model");
  msgEl = document.getElementById("mode-form-msg");
  btnSave = document.getElementById("btn-mode-save");
  btnDelete = document.getElementById("btn-mode-delete");
  iconWrap = document.getElementById("mode-f-icons");
  swatchWrap = document.getElementById("mode-f-swatches");

  renderList();

  document.getElementById("btn-ext-mode-new")?.addEventListener("click", () => openModeModal(""));
  document.getElementById("btn-ext-mode-refresh")?.addEventListener("click", renderList);
  fScope?.addEventListener("change", syncScopeUi);
  fColor?.addEventListener("input", renderSwatches);
  btnSave?.addEventListener("click", save);
  btnDelete?.addEventListener("click", del);
  modal?.querySelectorAll(".modal-close").forEach(b => b.addEventListener("click", closeModal));
  modal?.querySelector(".modal-backdrop")?.addEventListener("click", closeModal);

  // 谁改的都算：模型 mode_write、另一台设备同步、扩展页自己——一律重画
  subscribe("modes", renderList);
}

export { initModePanel };
