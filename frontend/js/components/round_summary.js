/**
 * 本轮总结卡片：模型说完最后一句话后，把这一轮真落盘改过的文件收成一行，就地审阅、就地撤回。
 *
 * 卡片不自己记流水：清单只从后端 /projects/round-files 读。撤回状态、"这一项你后来自己
 * 改过所以撤不了"（drifted）都要按磁盘现场回答，所以消息里存的只有「哪一轮 + 哪个项目」
 * 这一对键——存一份文件清单的副本，刷新一次就跟现场不一致了。
 */

import { get, patch, post } from "../services/api.js?v=20261017-001";
import { roundQuery } from "../services/tools.js?v=20261017-001";
import { t } from "../services/i18n.js?v=20261017-001";
import { iconSvgEl } from "../services/icons.js?v=20261017-001";
import { fileTypeIcon } from "../services/file_icons.js?v=20261017-001";
import { dlgConfirm, dlgToast } from "../services/dialog.js?v=20261017-001";

const VISIBLE_FILES = 3;    // 默认只铺前三行，其余收成「再显示 N 个文件」

// 后端记的不可撤回原因 → 给用户看的说法。撤不了的原因必须写出来，
// 否则「已撤回」会让人以为整个项目都回去了。
const SKIP_TEXT = {
  "too-large": () => t("文件过大，未快照"),
  "unreadable": () => t("原文无法读取，未快照"),
  "gone": () => t("本轮之后文件已不存在"),
  "drifted": () => t("本轮之后又被改过"),
  "missing": () => t("文件已经不在了"),
  "pre-missing": () => t("快照已清理"),
  "delete-failed": () => t("删除失败"),
  "write-failed": () => t("还原失败"),
};

function noteOf(file) {
  if (!file.exists && file.revertible) return t("文件已经不在了");
  if (!file.revertible) return (SKIP_TEXT[file.reason] || (() => t("无法撤回")))();
  if (file.drifted) return SKIP_TEXT.drifted();
  return "";
}

/** 挂载：一轮结束时把这一对键写到最后一条回复的元数据上，桌面/移动共用一条口径。 */
export async function mountRoundSummary(run, onAttached) {
  const msg = run.lastMsg;
  const binding = roundQuery({ ledger: run.ledger, project: run.opts?.project });
  if (!msg?.id || !binding.run_id) return;
  try {
    const res = await get(`/projects/round-files?${new URLSearchParams(binding)}`);
    if (res.code !== 0 || !res.data?.files?.length) return;   // 这一轮没改文件：不留空卡
    msg.roundSummary = { runId: binding.run_id, project: binding.project || "" };
    // PATCH 的 metadata 是整块覆盖，不是合并（backend/routers/chat.py 里 UPDATE SET metadata=?），
    // 所以要把这条消息已有的那几样一起写回去，否则卡片挂上、工具结果就没了。
    const metadata = { roundSummary: msg.roundSummary };
    if (msg.toolResults) metadata.toolResults = msg.toolResults;
    if (msg.toolCalls) metadata.toolCalls = msg.toolCalls;
    if (msg.ledgerRunId) metadata.ledgerRunId = msg.ledgerRunId;
    await patch(`/chat/messages/${msg.id}`, { metadata });
    onAttached?.();
  } catch (e) {
    console.warn("本轮总结挂载失败:", e?.message || e);
  }
}

/**
 * 渲染卡片。清单读不到或这一轮其实没改文件时整张卡不出现（wrap 一直 hidden），
 * 不渲染"没有改动"的空壳——空壳会让人以为撤回按钮撤的是别的东西。
 */
export function renderRoundSummary(binding, { readOnly = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "round-summary";
  wrap.hidden = true;

  const qs = new URLSearchParams({
    run_id: String(binding?.runId || ""),
    project: String(binding?.project || ""),
  });
  const diffCache = new Map();      // rel → 差异文本（审阅展开时才取，撤过的轮不再取）
  let data = null;
  let showAll = false;
  let reviewing = false;

  function files() {
    const all = data?.files || [];
    return showAll ? all : all.slice(0, VISIBLE_FILES);
  }

  function paint() {
    wrap.replaceChildren();
    if (!data?.files?.length) { wrap.hidden = true; return; }
    wrap.hidden = false;

    const totals = data.totals || { files: data.files.length, added: 0, removed: 0 };
    const head = document.createElement("div");
    head.className = "round-summary-head";
    head.appendChild(iconSvgEl("file", "round-summary-icon"));

    const title = document.createElement("span");
    title.className = "round-summary-title";
    title.textContent = t("已编辑 {n} 个文件", { n: totals.files });
    head.appendChild(title);

    const stats = document.createElement("span");
    stats.className = "round-summary-stats";
    const add = document.createElement("span");
    add.className = "round-add";
    add.textContent = `+${totals.added || 0}`;
    const del = document.createElement("span");
    del.className = "round-del";
    del.textContent = `−${totals.removed || 0}`;
    stats.append(add, del);
    head.appendChild(stats);

    if (data.reverted_at) {
      const done = document.createElement("span");
      done.className = "round-summary-state";
      done.textContent = t("已撤回");
      head.appendChild(done);
    } else if (!readOnly) {
      const revertBtn = document.createElement("button");
      revertBtn.type = "button";
      revertBtn.className = "round-btn round-btn-revert";
      revertBtn.title = t("把这些文件还原到本轮开始前");
      revertBtn.append(iconSvgEl("rotate-ccw", "round-btn-icon"), document.createTextNode(t("撤销")));
      revertBtn.addEventListener("click", () => onRevert(revertBtn));
      head.appendChild(revertBtn);
    }

    const reviewBtn = document.createElement("button");
    reviewBtn.type = "button";
    reviewBtn.className = "round-btn";
    reviewBtn.setAttribute("aria-expanded", reviewing ? "true" : "false");
    reviewBtn.append(iconSvgEl("eye", "round-btn-icon"), document.createTextNode(reviewing ? t("收起审阅") : t("审阅")));
    reviewBtn.addEventListener("click", () => {
      reviewing = !reviewing;
      paint();
    });
    head.appendChild(reviewBtn);

    wrap.appendChild(head);

    const list = document.createElement("div");
    list.className = "round-files";
    for (const file of files()) list.appendChild(fileRow(file));
    wrap.appendChild(list);

    const hidden = (data.files.length || 0) - files().length;
    if (hidden > 0) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "round-more";
      more.setAttribute("aria-expanded", showAll ? "true" : "false");
      more.textContent = showAll ? t("收起文件列表") : t("再显示 {n} 个文件", { n: hidden });
      more.addEventListener("click", () => { showAll = !showAll; paint(); });
      wrap.appendChild(more);
    }
  }

  function fileRow(file) {
    const row = document.createElement("div");
    row.className = "round-file";
    const badge = document.createElement("span");
    badge.className = "round-file-icon";
    badge.innerHTML = fileTypeIcon(file.rel || "");
    const name = document.createElement("span");
    name.className = "round-file-name";
    name.textContent = file.rel || "";
    const s = document.createElement("span");
    s.className = "round-file-stats";
    s.textContent = `+${file.lines_added || 0} -${file.lines_removed || 0}`;
    row.append(badge, name, s);
    const note = noteOf(file);
    if (note) {
      const tag = document.createElement("span");
      tag.className = "round-file-note";
      tag.textContent = note;
      row.appendChild(tag);
    }
    if (reviewing) row.appendChild(diffBlock(file));
    return row;
  }

  function diffBlock(file) {
    const box = document.createElement("div");
    box.className = "round-file-diff";
    const rel = String(file.rel || "");
    if (diffCache.has(rel)) {
      fillDiff(box, diffCache.get(rel));
      return box;
    }
    box.textContent = t("加载差异…");
    get(`/projects/round-diff?${new URLSearchParams({ ...Object.fromEntries(qs), path: rel })}`)
      .then(res => {
        const text = res.code === 0 ? (res.data?.diff || "") : "";
        const out = res.code === 0 && res.data?.reason ? t("差异不可用") + `（${SKIP_TEXT[res.data.reason]?.() || res.data.reason}）` : text;
        diffCache.set(rel, out);
        if (box.isConnected) fillDiff(box, out);
      })
      .catch(() => {
        diffCache.set(rel, t("差异读取失败"));
        if (box.isConnected) fillDiff(box, t("差异读取失败"));
      });
    return box;
  }

  // 差异行复用工具卡那套 .diff-line 配色，不另立一份 diff 样式
  function fillDiff(box, text) {
    box.replaceChildren();
    if (!text) { box.textContent = t("没有可显示的差异"); return; }
    const pre = document.createElement("pre");
    pre.className = "file-edit-diff-pre";
    for (const line of text.split("\n")) {
      const span = document.createElement("span");
      span.className = "diff-line" +
        (line.startsWith("+") && !line.startsWith("+++") ? " diff-add" : "") +
        (line.startsWith("-") && !line.startsWith("---") ? " diff-del" : "") +
        (line.startsWith("@@") ? " diff-hunk" : "");
      span.textContent = line;
      pre.appendChild(span);
      pre.appendChild(document.createTextNode("\n"));
    }
    box.appendChild(pre);
  }

  async function onRevert(btn) {
    const n = data?.totals?.files || data?.files?.length || 0;
    const ok = await dlgConfirm(
      t("撤回本轮的 {n} 个文件改动？这些文件会回到本轮开始前的内容，本轮新建的文件会被删除。本轮之后手动修改过的文件将跳过，不会被覆盖。", { n }),
      { title: t("撤回本轮改动"), okText: t("撤回"), danger: true },
    );
    if (!ok) return;
    btn.disabled = true;
    try {
      const res = await post("/projects/round-revert", Object.fromEntries(qs));
      if (res.code !== 0) {
        dlgToast(t("撤回失败：{msg}", { msg: res.message || t("未知错误") }), 4000);
        btn.disabled = false;
        return;
      }
      const skipped = res.data?.skipped?.length || 0;
      const done = (res.data?.restored?.length || 0) + (res.data?.deleted?.length || 0);
      dlgToast(skipped ? t("已撤回 {done} 项，{skipped} 项已跳过", { done, skipped }) : t("已撤回 {done} 项", { done }), 4000);
      await reload();
    } catch (e) {
      dlgToast(t("撤回失败：{msg}", { msg: e?.message || e }), 4000);
    } finally {
      btn.disabled = false;
    }
  }

  async function reload() {
    try {
      const res = await get(`/projects/round-files?${qs}`);
      data = res.code === 0 ? res.data : null;
    } catch (e) {
      data = null;
    }
    paint();
  }

  reload();
  return wrap;
}
