/**
 * 扩展页外壳：左侧分栏轨（技能 / 工具 / 模式 / 新功能 / MCP / 专家包 / Actions）＋ 条目计数。
 *
 * 这里只管"看哪一栏"和"每栏有几份"，列表内容由各栏数据的主人自己渲染
 * （skill_panel / mcp_server_panel / experts）。计数由主人算完写进来：
 * 分栏轨上的数字与右侧标题上的数字必须是同一个来源，否则一刷新就各说各话。
 */

import { t } from "../services/i18n.js?v=20261024-001";

const EXT_SECTIONS = [
  { key: "skills", label: "技能" },
  { key: "tools", label: "工具" },
  { key: "modes", label: "模式" },
  { key: "evolved", label: "新功能" },
  { key: "mcp", label: "MCP" },
  { key: "experts", label: "专家包" },
  { key: "actions", label: "Actions" },
];

let currentKey = "skills";

/** 主人算好条数写进来：分栏轨与栏内标题共用，一处更新两处一致。 */
export function setExtCount(key, n) {
  const text = String(Number(n) || 0);
  const nav = document.getElementById(`ext-nav-count-${key}`);
  if (nav) nav.textContent = text;
  const head = document.getElementById(`ext-${key}-count`);
  if (head) head.textContent = text;
}

export function selectExtSection(key) {
  if (!EXT_SECTIONS.some(s => s.key === key)) return;
  currentKey = key;
  document.querySelectorAll("#panel-ext .ext-section").forEach(el => {
    el.classList.toggle("active", el.dataset.ext === key);
  });
  document.querySelectorAll("#ext-nav .ext-nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.ext === key);
  });
}

export function currentExtSection() {
  return currentKey;
}

export function initExtensions() {
  const nav = document.getElementById("ext-nav");
  if (nav) {
    nav.innerHTML = "";
    for (const s of EXT_SECTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ext-nav-item";
      btn.dataset.ext = s.key;
      const label = document.createElement("span");
      label.textContent = t(s.label);
      const count = document.createElement("span");
      count.className = "ext-nav-count";
      count.id = `ext-nav-count-${s.key}`;
      count.textContent = "0";
      btn.appendChild(label);
      btn.appendChild(count);
      btn.addEventListener("click", () => selectExtSection(s.key));
      nav.appendChild(btn);
    }
  }
  selectExtSection(currentKey);
}
