/**
 * SLATE Mobile — 会话历史管理
 * 列表 / 切换 / 新建 / 重命名 / 删除（与桌面共享同一后端数据）
 */

import { state, setConversations } from "../store.js?v=20261024-001";
import { get, patch, del } from "../services/api.js?v=20261024-001";
import { t, mToast, mShowPrompt, mShowConfirm, mIcon } from "./m-ui.js?v=20261024-001";
import { mLoadConversation, mNewConversation } from "./m-chat.js?v=20261024-001";
import { onTab, switchTab } from "./m-app.js?v=20261024-001";

function $id(id) { return document.getElementById(id); }

function formatTime(iso) {
  if (!iso) return "";
  // 后端返回秒级 epoch，先转毫秒
  const ts = typeof iso === "number" ? iso * 1000 : Date.parse(iso);
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export async function refreshConversations() {
  try {
    const res = await get("/chat/conversations");
    if (res.code === 0 && Array.isArray(res.data)) setConversations(res.data);
  } catch (e) {
    console.warn("[SLATE-Mobile] 会话列表加载失败:", e);
  }
}

function renderList() {
  const listEl = $id("m-conv-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  const list = state.conversations || [];
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "m-list-empty";
    empty.textContent = t("还没有会话");
    listEl.appendChild(empty);
    return;
  }
  for (const conv of list) {
    const item = document.createElement("div");
    item.className = "m-list-item";
    const active = conv.id === state.currentConversationId;
    if (active) item.classList.add("active");

    const main = document.createElement("div");
    main.className = "m-list-item-main";
    const title = document.createElement("div");
    title.className = "m-list-item-title";
    title.textContent = conv.title || t("未命名会话");
    const sub = document.createElement("div");
    sub.className = "m-list-item-sub";
    const count = conv.message_count != null ? ` · ${conv.message_count} 条` : "";
    const proj = conv.project ? ` · ${conv.project}` : "";
    sub.textContent = `${formatTime(conv.updated_at)}${count}${proj}`;
    main.appendChild(title);
    main.appendChild(sub);
    item.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "m-list-item-action";
    const renameBtn = document.createElement("button");
    renameBtn.className = "m-btn-sm";
    renameBtn.innerHTML = mIcon("edit-2", "m-icon-sm");
    renameBtn.title = t("重命名");
    const delBtn = document.createElement("button");
    delBtn.className = "m-btn-sm";
    delBtn.innerHTML = mIcon("trash-2", "m-icon-sm");
    delBtn.title = t("删除");
    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);
    item.appendChild(actions);

    item.addEventListener("click", async (e) => {
      if (e.target.closest("button")) return;
      await mLoadConversation(conv.id);
      switchTab("chat");
    });
    renameBtn.addEventListener("click", async () => {
      const title = await mShowPrompt({ title: t("重命名会话"), value: conv.title || "", placeholder: t("会话名称") });
      if (!title) return;
      try {
        const res = await patch(`/chat/conversations/${conv.id}`, { title });
        if (res.code !== 0) mToast(res.message || t("重命名失败"), 3200);
        else {
          await refreshConversations();
          renderList();
          mToast(t("已重命名"));
        }
      } catch (e) {
        mToast(t("重命名失败: {msg}", { msg: e.message }), 3200);
      }
    });
    delBtn.addEventListener("click", async () => {
      const ok = await mShowConfirm({
        title: t("删除会话"),
        message: t("确定删除会话「{title}」？该操作不可恢复。", { title: (conv.title || "").slice(0, 30) }),
        okText: t("删除"),
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await del(`/chat/conversations/${conv.id}`);
        if (res.code !== 0) mToast(res.message || t("删除失败"), 3200);
        else {
          if (state.currentConversationId === conv.id) {
            state.currentConversationId = null;
            const { setMessages } = await import("../store.js?v=20261024-001");
            setMessages([]);
          }
          await refreshConversations();
          renderList();
          mToast(t("已删除"));
        }
      } catch (e) {
        mToast(t("删除失败: {msg}", { msg: e.message }), 3200);
      }
    });

    listEl.appendChild(item);
  }
}

export function initMConversations() {
  $id("m-btn-new-conv")?.addEventListener("click", mNewConversation);
  onTab("conversations", () => {
    refreshConversations().then(renderList);
  });
  renderList();
}

export { t };
