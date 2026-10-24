/**
 * SLATE Mobile — 应用外壳
 * 底部 tab 切换 / 顶部状态条 / 键盘适配 / 空状态
 */

import { state, subscribe, toggleTheme } from "../store.js?v=20261024-001";
import { t } from "../services/i18n.js?v=20261024-001";
import { mToast } from "./m-ui.js?v=20261024-001";

const $ = (id) => document.getElementById(id);

let _currentTab = "chat";
const _tabHandlers = {};

export function getCurrentTab() {
  return _currentTab;
}

export function onTab(tab, handler) {
  _tabHandlers[tab] = handler;
}

export function switchTab(tab) {
  if (!["chat", "conversations", "memory", "schedule", "settings"].includes(tab)) return;
  _currentTab = tab;
  document.querySelectorAll(".m-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.querySelectorAll(".m-view").forEach((view) => {
    view.classList.toggle("active", view.id === `view-${tab}`);
  });
  // 仅对话视图显示输入条
  $("m-chat-input-bar")?.classList.toggle("hidden", tab !== "chat");
  const handler = _tabHandlers[tab];
  if (handler) handler();
}

export function setTopbarTitle(text) {
  const el = $("m-topbar-title");
  if (el) el.textContent = text || "SLATE";
}

export function initMApp() {
  // 底部 tab 切换
  document.querySelectorAll(".m-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // 顶部右侧：主题切换
  const right = $("m-topbar-right");
  if (right) {
    const themeBtn = document.createElement("button");
    themeBtn.className = "m-topbar-btn";
    themeBtn.innerHTML = "◐";
    themeBtn.title = t("切换主题");
    themeBtn.addEventListener("click", () => {
      // 自定义主题生效时 store 会拒绝切换：这里负责把原因说出来，而不是继续播报上一个模式的名字
      if (!toggleTheme()) { mToast(t("自定义主题生效中，明暗切换已锁定")); return; }
      mToast(state.theme === "dark" ? t("深色模式") : t("浅色模式"));
    });
    right.appendChild(themeBtn);
  }

  // 键盘弹出适配（visualViewport）
  const setKb = () => {
    const vv = window.visualViewport;
    if (!vv) return;
    const offset = Math.max(0, window.innerHeight - vv.height - (window.outerHeight - window.innerHeight));
    document.documentElement.style.setProperty("--kb-offset", `${offset}px`);
  };
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", setKb);
    window.visualViewport.addEventListener("scroll", setKb);
  }

  // 空状态文案
  const emptyText = $("m-chat-empty-text");
  if (emptyText) emptyText.textContent = t("本地 AI 协作工作台");

  // 会话名跟随
  subscribe("conversations", () => {
    if (_currentTab !== "chat") return;
    const conv = state.conversations.find((c) => c.id === state.currentConversationId);
    if (conv?.title) setTopbarTitle(conv.title);
  });

  switchTab("chat");
}
