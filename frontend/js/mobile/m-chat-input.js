/**
 * SLATE Mobile — 聊天输入区
 * textarea 自适应高度 / Enter 发送（Shift+Enter 换行）/ @ 提及浮层（技能/工具/项目文件）
 */

import { state } from "../store.js?v=20261024-001";
import { TOOLS } from "../services/tools.js?v=20261024-001";
import { t } from "./m-ui.js?v=20261024-001";
import { mSendMessage, isGenerating } from "./m-chat.js?v=20261024-001";
import { getCurrentTab } from "./m-app.js?v=20261024-001";

let _candidates = [];
let _index = 0;
let _tokenStart = -1;

function $id(id) { return document.getElementById(id); }

function autoResize() {
  const ta = $id("m-chat-input");
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 132) + "px";
}

function detectToken() {
  const ta = $id("m-chat-input");
  if (!ta) return null;
  const pos = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, pos);
  const quoted = /(^|[\s])@"([^"\n]*)$/.exec(before);
  if (quoted) return { start: pos - quoted[2].length - 2, query: quoted[2] };
  const m = /(^|[\s])@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: pos - m[2].length - 1, query: m[2] };
}

function formatInsert(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (/[\s"@]/.test(v)) return `@"${v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}" `;
  return `@${v} `;
}

function flattenFiles(entries, depth = 0, out = []) {
  if (!Array.isArray(entries) || out.length >= 60 || depth > 2) return out;
  for (const item of entries) {
    const path = item.path || item.name || "";
    if (!path) continue;
    out.push({ name: path, type: item.type === "dir" ? "目录" : "文件" });
    if (item.type === "dir") flattenFiles(item.children || item.entries, depth + 1, out);
    if (out.length >= 60) break;
  }
  return out;
}

function buildCandidates(query) {
  const q = (query || "").toLowerCase();
  const list = [];
  const skills = state.skills?.skills || {};
  const treeEntries = Array.isArray(state.projectFileTree?.entries)
    ? state.projectFileTree.entries
    : Array.isArray(state.projectFileTree) ? state.projectFileTree : [];
  const files = flattenFiles(treeEntries);

  for (const [name, skill] of Object.entries(skills)) {
    list.push({ kind: "技能", label: name, mention: name, desc: String(skill?.description || "").slice(0, 60) });
  }
  for (const [name, tool] of Object.entries(TOOLS || {})) {
    list.push({ kind: "工具", label: name, mention: name, desc: String(tool?.name || "").slice(0, 60) });
  }
  for (const f of files) {
    list.push({ kind: f.type === "目录" ? "目录" : "文件", label: f.name, mention: f.name, desc: "" });
  }
  const filtered = q ? list.filter(c => c.mention.toLowerCase().includes(q)) : list;
  return filtered.slice(0, 12);
}

function hideOverlay() {
  const ov = $id("m-mention-overlay");
  if (ov) {
    ov.classList.add("hidden");
    ov.innerHTML = "";
  }
  _candidates = [];
  _index = 0;
  _tokenStart = -1;
}

function renderOverlay() {
  const ov = $id("m-mention-overlay");
  if (!ov || !_candidates.length) {
    hideOverlay();
    return;
  }
  ov.innerHTML = "";
  _candidates.forEach((c, i) => {
    const item = document.createElement("div");
    item.className = `m-mention-item${i === _index ? " active" : ""}`;
    const kind = document.createElement("span");
    kind.className = "m-mention-kind";
    kind.textContent = c.kind;
    const label = document.createElement("span");
    label.className = "m-mention-label";
    label.textContent = c.label;
    item.appendChild(kind);
    item.appendChild(label);
    if (c.desc) {
      const desc = document.createElement("span");
      desc.className = "m-mention-desc";
      desc.textContent = c.desc;
      item.appendChild(desc);
    }
    item.addEventListener("click", () => insertCandidate(c));
    ov.appendChild(item);
  });
  ov.classList.remove("hidden");
  const active = ov.querySelector(".m-mention-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function insertCandidate(c) {
  const ta = $id("m-chat-input");
  if (!ta) return;
  const before = ta.value.slice(0, _tokenStart);
  const after = ta.value.slice(ta.selectionStart ?? ta.value.length);
  ta.value = before + formatInsert(c.mention) + after;
  const pos = (before + formatInsert(c.mention)).length;
  ta.setSelectionRange(pos, pos);
  ta.focus();
  hideOverlay();
  autoResize();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function onInput() {
  autoResize();
  const token = detectToken();
  if (!token) {
    hideOverlay();
    return;
  }
  _tokenStart = token.start;
  _index = 0;
  _candidates = buildCandidates(token.query);
  renderOverlay();
}

export function initMChatInput() {
  const ta = $id("m-chat-input");
  if (!ta) return;

  ta.addEventListener("input", onInput);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      hideOverlay();
      if (!isGenerating()) mSendMessage(ta.value);
      return;
    }
    if (_candidates.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      _index = (_index + (e.key === "ArrowDown" ? 1 : -1) + _candidates.length) % _candidates.length;
      renderOverlay();
      return;
    }
    if (_candidates.length && e.key === "Tab") {
      e.preventDefault();
      insertCandidate(_candidates[_index]);
    }
  });
  ta.addEventListener("blur", () => setTimeout(hideOverlay, 150));
  ta.addEventListener("focus", onInput);

  // 切换 tab 时收起浮层
  document.addEventListener("click", (e) => {
    const ov = $id("m-mention-overlay");
    if (ov && !ov.contains(e.target) && e.target !== ta) hideOverlay();
  });

  // 发送后清空由 mSendMessage 完成，这里兜底重置高度
  const btn = $id("m-btn-send");
  btn?.addEventListener("click", () => {
    if (getCurrentTab() === "chat" && !isGenerating()) autoResize();
  });
}

export { t };
