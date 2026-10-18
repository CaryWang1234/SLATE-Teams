/**
 * SLATE Mobile — 长期记忆
 * 浏览 / 新增 / 编辑 / 删除（与桌面共享 /chat/memories 数据）
 */

import { state, setMemories, addMemory, updateMemory, removeMemory } from "../store.js?v=20261017-001";
import { get, post, patch, del } from "../services/api.js?v=20261017-001";
import { t, mToast, mShowPrompt, mShowConfirm, mShowSheet, mIcon } from "./m-ui.js?v=20261017-001";
import { onTab } from "./m-app.js?v=20261017-001";

function $id(id) { return document.getElementById(id); }

const CATEGORY_LABELS = {
  preference: t("偏好"), decision: t("决策"), project: t("项目"),
  term: t("术语"), fact: t("事实"), general: t("通用"), other: t("其他"),
};

const CATEGORY_ORDER = ["preference", "decision", "project", "term", "fact", "general", "other"];

function normalizeContent(content) {
  return String(content || "").replace(/\s+/g, " ").trim();
}

export async function loadMemories() {
  try {
    const res = await get("/chat/memories");
    if (res.code === 0 && Array.isArray(res.data)) setMemories(res.data);
  } catch (e) {
    console.warn("[SLATE-Mobile] 记忆加载失败:", e);
  }
}

function categoryPicker() {
  return new Promise((resolve) => {
    const body = document.createElement("div");
    for (const cat of CATEGORY_ORDER) {
      const row = document.createElement("div");
      row.className = "m-setting-row";
      const main = document.createElement("div");
      main.className = "m-setting-row-main";
      const title = document.createElement("div");
      title.className = "m-setting-row-title";
      title.textContent = CATEGORY_LABELS[cat] || cat;
      main.appendChild(title);
      row.appendChild(main);
      row.addEventListener("click", () => resolve(cat));
      body.appendChild(row);
    }
    mShowSheet({ title: t("选择分类"), body, onClose: () => resolve(null) });
  });
}

function renderList() {
  const listEl = $id("m-memory-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  const list = state.memories || [];
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "m-list-empty";
    empty.textContent = t("暂无记忆");
    listEl.appendChild(empty);
    return;
  }
  for (const mem of list) {
    const item = document.createElement("div");
    item.className = "m-list-item";
    item.style.alignItems = "flex-start";

    const main = document.createElement("div");
    main.className = "m-list-item-main";
    const title = document.createElement("div");
    title.className = "m-list-item-title";
    title.style.cssText = "font-size:12px;color:var(--accent);";
    title.textContent = CATEGORY_LABELS[mem.category] || mem.category || t("通用");
    const content = document.createElement("div");
    content.className = "m-list-item-sub";
    content.style.cssText = "white-space:pre-wrap;word-break:break-word;line-height:1.55;margin-top:4px;";
    content.textContent = mem.content || "";
    main.appendChild(title);
    main.appendChild(content);
    item.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "m-list-item-action";
    const editBtn = document.createElement("button");
    editBtn.className = "m-btn-sm";
    editBtn.innerHTML = mIcon("edit-2", "m-icon-sm");
    editBtn.title = t("编辑");
    const delBtn = document.createElement("button");
    delBtn.className = "m-btn-sm";
    delBtn.innerHTML = mIcon("trash-2", "m-icon-sm");
    delBtn.title = t("删除");
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    item.appendChild(actions);

    editBtn.addEventListener("click", async () => {
      const content = await mShowPrompt({
        title: t("编辑记忆"),
        value: mem.content || "",
        placeholder: t("记忆内容"),
      });
      if (!content) return;
      const next = { ...mem, content: normalizeContent(content) };
      try {
        const res = await patch(`/chat/memories/${mem.id}`, { category: mem.category, content: next.content });
        if (res.code !== 0) mToast(res.message || t("保存失败"), 3200);
        else {
          updateMemory(mem.id, next);
          renderList();
          mToast(t("已保存"));
        }
      } catch (e) {
        mToast(t("保存失败: {msg}", { msg: e.message }), 3200);
      }
    });
    delBtn.addEventListener("click", async () => {
      const ok = await mShowConfirm({
        title: t("删除记忆"),
        message: t("确定删除这条记忆？"),
        okText: t("删除"),
        danger: true,
      });
      if (!ok) return;
      try {
        await del(`/chat/memories/${mem.id}`);
      } catch (e) { console.warn("[SLATE-Mobile] 记忆删除失败:", e); }
      removeMemory(mem.id);
      renderList();
      mToast(t("已删除"));
    });

    listEl.appendChild(item);
  }
}

async function addNewMemory() {
  const content = await mShowPrompt({ title: t("新建记忆"), placeholder: t("要记住的内容…") });
  if (!content) return;
  const cat = await categoryPicker();
  if (!cat) return;
  const normalized = normalizeContent(content);
  try {
    const res = await post("/chat/memories", { category: cat, content: normalized });
    if (res.code !== 0) mToast(res.message || t("保存失败"), 3200);
    else {
      const saved = res.data;
      addMemory({ id: saved?.id || `m-${Date.now()}`, category: cat, content: normalized });
      renderList();
      mToast(t("已保存"));
    }
  } catch (e) {
    mToast(t("保存失败: {msg}", { msg: e.message }), 3200);
  }
}

export function initMMemory() {
  $id("m-btn-add-memory")?.addEventListener("click", addNewMemory);
  onTab("memory", () => {
    loadMemories().then(renderList);
  });
  renderList();
}

export { t };
