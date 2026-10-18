/**
 * 设置 → 会话归档
 *
 * 「任务」栏里归档的会话不在列表上了，只能回到这一栏：要么恢复（重新出现在任务栏），
 * 要么真删（连消息一起清掉）。这一栏每次打开都重新读后端——归档可能来自另一个窗口、
 * 手机端，或者上一轮还没刷新过的现场，拿本地缓存列就会让人对着已经不存在的行按恢复。
 *
 * 读失败和"没有归档"是两件事：前者要写明读不出来，后者才说空。把 500 报成"没有已归档
 * 的会话"，用户会以为自己没归档成，转头再去点一遍归档按钮。
 */

import { get, patch, del } from "../services/api.js?v=20261017-001";
import { t } from "../services/i18n.js?v=20261017-001";
import { dlgConfirm, dlgToast } from "../services/dialog.js?v=20261017-001";

// 标题是用户自己写的，不许原样拼进 innerHTML
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDay(ts) {
  if (!ts) return "";
  try { return new Date(ts * 1000).toLocaleDateString(); } catch (e) { return ""; }
}

function paintHint(text, cls = "setting-hint") {
  const list = document.getElementById("archived-session-list");
  if (!list) return;
  list.innerHTML = "";
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = text;
  list.appendChild(span);
}

export async function renderArchivedSessions() {
  const list = document.getElementById("archived-session-list");
  if (!list) return;
  paintHint(t("加载中..."));
  let res;
  try {
    res = await get("/chat/conversations?archived=1");
  } catch (e) {
    paintHint(t("归档会话读不出来：{msg}", { msg: String(e?.message || e).slice(0, 60) }));
    return;
  }
  if (res?.code !== 0) {
    paintHint(t("归档会话读不出来：{msg}", { msg: String(res?.message || "").slice(0, 60) }));
    return;
  }
  const rows = Array.isArray(res.data) ? res.data : [];
  if (!rows.length) {
    paintHint(t("没有已归档的会话"));
    return;
  }
  list.innerHTML = "";
  for (const conv of rows) {
    list.appendChild(buildRow(conv, list));
  }
}

function buildRow(conv, list) {
  const item = document.createElement("div");
  item.className = "archived-item";
  item.dataset.convId = String(conv.id || "");

  const info = document.createElement("div");
  info.className = "archived-info";
  const day = fmtDay(conv.updated_at);
  const meta = [conv.project ? t("项目：{name}", { name: conv.project }) : "", day ? t("更新于 {day}", { day }) : ""]
    .filter(Boolean).join(" · ");
  info.innerHTML = `<div class="archived-title">${esc(conv.title || t("新对话"))}</div>`
    + (meta ? `<div class="archived-meta">${esc(meta)}</div>` : "");
  item.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "archived-actions";

  const restoreBtn = document.createElement("button");
  restoreBtn.className = "send-btn send-btn-sm archived-restore";
  restoreBtn.type = "button";
  restoreBtn.textContent = t("恢复");
  restoreBtn.addEventListener("click", async () => {
    const res = await patch(`/chat/conversations/${conv.id}`, { archived: false });
    if (res?.code !== 0) { dlgToast(res?.message || t("恢复失败")); return; }
    dlgToast(t("已恢复到任务栏"));
    await renderArchivedSessions();
    // 动态 import 而不是顶层引 chat.js：它和 app.js 互相引，静态引会绕成环。
    // 走这个入口而不是自己 notify——它顺带把 Codex 侧栏与任务徽标一起对齐。
    const { refreshConversationList } = await import("./chat.js?v=20261017-001");
    await refreshConversationList();
  });
  actions.appendChild(restoreBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "send-btn send-btn-sm archived-delete";
  deleteBtn.type = "button";
  deleteBtn.textContent = t("删除");
  deleteBtn.addEventListener("click", async () => {
    const title = String(conv.title || "").slice(0, 30);
    const ok = await dlgConfirm(t("确定删除归档会话「{title}」？消息将一并清除，无法恢复。", { title }),
      { title: t("删除会话"), okText: t("删除"), danger: true });
    if (!ok) return;
    const res = await del(`/chat/conversations/${conv.id}`);
    if (res?.code !== 0) { dlgToast(res?.message || t("删除失败")); return; }
    dlgToast(t("已删除"));
    await renderArchivedSessions();
  });
  actions.appendChild(deleteBtn);

  item.appendChild(actions);
  return item;
}

export function initSessionArchiveSettings() {
  const btn = document.getElementById("btn-archived-refresh");
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => renderArchivedSessions());
  }
}
