/**
 * 输入框左下的「回复模式」选择器：内置四档（智能 / 对话 / 经济 / 狂暴）＋ 自定义模式，
 * 在**这一场对话**里随时可改。模式本体（追加提示词、工具白名单、推理强度、轮数、模型）
 * 定义在 store.js 的注册表里（BUILTIN_MODES / customModes）；这里只管"屏幕上生效的是哪一个"
 * 与"改这一场用哪个"，不自己存一份模式定义——两处各写一份迟早分叉。
 *
 * 每个模式有自己的颜色：色落在容器上的 --mode-color，图标是 stroke:currentColor，跟 color 走。
 */

import {
  state, subscribe, modeRegistry, activeModeFor, activeModeIdFor, setModeFor,
  MODE_POPOVER_MAX, MODE_TOOLS_NONE,
} from "../store.js?v=20261017-001";
import { iconSvgEl } from "../services/icons.js?v=20261017-001";
import { t } from "../services/i18n.js?v=20261017-001";

const EFFORT_LABELS = { low: "低", medium: "中", high: "高" };

let popOpen = false;
let rowsSig = "";

function setPop(open) {
  const pop = document.getElementById("mode-pop");
  const btn = document.getElementById("btn-mode");
  if (!pop || !btn) return;
  popOpen = Boolean(open);
  pop.classList.toggle("hidden", !popOpen);
  btn.setAttribute("aria-expanded", popOpen ? "true" : "false");
  syncActiveRow();
}

/** 一行小字：这个模式跟别的比到底改了什么（工具范围 / 推理强度 / 轮数 / 模型）。
 *  扩展页的模式栏也用它——同一个模式在两处必须说同一句话。 */
export function modeHint(mode) {
  const parts = [];
  if (mode.tools === MODE_TOOLS_NONE) parts.push(t("不调用工具，单轮直答"));
  else if (Array.isArray(mode.tools)) parts.push(t("只读工具（{n} 个）", { n: mode.tools.length }));
  else parts.push(t("全部工具"));
  if (mode.effort) parts.push(t("推理强度固定：{level}", { level: t(EFFORT_LABELS[mode.effort] || mode.effort) }));
  if (mode.rounds) parts.push(t("最多 {n} 轮", { n: mode.rounds }));
  if (mode.model) parts.push(mode.model);
  return parts.join(" · ");
}

/** 浮层里最多摆 MODE_POPOVER_MAX 个；当前生效的那个无论排第几都要摆进来，不然看不出自己用的是哪个。 */
function popoverModes() {
  const all = modeRegistry();
  const active = activeModeIdFor(state.currentConversationId);
  const list = all.slice(0, MODE_POPOVER_MAX);
  if (!list.some(m => m.id === active)) {
    const picked = all.find(m => m.id === active);
    if (picked) list[MODE_POPOVER_MAX - 1] = picked;
  }
  return list;
}

function renderRows() {
  const pop = document.getElementById("mode-pop");
  if (!pop) return;
  const modes = popoverModes();
  const sig = modes.map(m => m.id).join("|");
  if (sig === rowsSig) return;
  rowsSig = sig;
  pop.textContent = "";

  const head = document.createElement("div");
  head.className = "mode-pop-head";
  const title = document.createElement("strong");
  title.textContent = t("回复模式");
  const scope = document.createElement("span");
  scope.className = "mode-pop-scope";
  scope.id = "mode-pop-scope";
  head.append(title, scope);
  pop.appendChild(head);

  for (const m of modes) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mode-opt";
    row.dataset.mode = m.id;
    row.setAttribute("role", "menuitemradio");
    row.style.setProperty("--mode-color", m.color);
    const ico = document.createElement("span");
    ico.className = "mode-opt-icon";
    ico.appendChild(iconSvgEl(m.icon));
    const wrap = document.createElement("span");
    wrap.className = "mode-opt-body";
    const name = document.createElement("b");
    name.textContent = t(m.label);
    const hint = document.createElement("span");
    hint.className = "mode-opt-hint";
    hint.textContent = modeHint(m);
    wrap.append(name, hint);
    row.append(ico, wrap);
    row.addEventListener("click", () => {
      setModeFor(state.currentConversationId, m.id);
      setPop(false);
    });
    pop.appendChild(row);
  }
}

function syncActiveRow() {
  const active = activeModeIdFor(state.currentConversationId);
  for (const row of document.querySelectorAll("#mode-pop .mode-opt")) {
    row.classList.toggle("is-on", row.dataset.mode === active);
    row.setAttribute("aria-checked", row.dataset.mode === active ? "true" : "false");
  }
  const scope = document.getElementById("mode-pop-scope");
  if (scope) {
    scope.textContent = state.currentConversationId
      ? t("只改这一场")
      : t("还没建会话：这一场的选择会带给它");
  }
}

function syncModePicker() {
  const btn = document.getElementById("btn-mode");
  const label = document.getElementById("mode-pill-label");
  const iconWrap = document.getElementById("mode-pill-icon");
  if (!btn || !label || !iconWrap) return;
  renderRows();
  const mode = activeModeFor(state.currentConversationId);
  btn.style.setProperty("--mode-color", mode.color);
  label.textContent = t(mode.label);
  if (iconWrap.dataset.icon !== mode.icon) {
    iconWrap.dataset.icon = mode.icon;
    iconWrap.textContent = "";
    iconWrap.appendChild(iconSvgEl(mode.icon));
  }
  btn.title = t("{mode}：{hint}", { mode: t(mode.label), hint: modeHint(mode) });
  syncActiveRow();
}

function initModePicker() {
  const btn = document.getElementById("btn-mode");
  if (!btn) return;
  renderRows();
  btn.addEventListener("click", () => setPop(!popOpen));
  document.addEventListener("pointerdown", (e) => {
    if (popOpen && !e.target?.closest?.("#mode-picker")) setPop(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && popOpen) {
      setPop(false);
      btn.focus();
    }
  });
  // 切会话、改默认档、扩展页增删模式、另一台设备同步下来——四种来源都要重画，
  // 且模式表可能变了（增删），所以先作废行签名再重画
  subscribe("mode", () => { rowsSig = ""; syncModePicker(); });
  subscribe("modes", () => { rowsSig = ""; syncModePicker(); });
  syncModePicker();
}

export { initModePicker, syncModePicker };
