/**
 * SLATE 提示词工厂：将任务、项目约束和上下文整理为可交付 Prompt
 */

import { state, subscribe, addPromptSnippet, effectiveConstitution } from "../store.js?v=20261024-001";
import { get, post } from "../services/api.js?v=20261024-001";
import { browseFiles } from "../services/project.js?v=20261024-001";
import { t } from "../services/i18n.js?v=20261024-001";
import { iconSvg } from "../services/icons.js?v=20261024-001";
import { makeId } from "../services/utils.js?v=20261024-001";

const FACTORY_PRESETS = {
  codex: {
    label: "Codex",
    goal: "交给 Codex 在当前代码库中实现、验证并说明结果。",
    output: "请直接完成修改，并在最后简要说明改动文件、验证方式和剩余风险。",
  },
  claude: {
    label: "Claude Code",
    goal: "交给 Claude Code 按现有工程风格完成代码修改。",
    output: "请先阅读相关文件，再执行最小必要修改，最后给出测试结果。",
  },
  cursor: {
    label: "Cursor",
    goal: "交给 Cursor 作为编辑器内任务指令使用。",
    output: "请给出清晰的编辑步骤、目标文件和需要保留的行为。",
  },
  generic: {
    label: "通用 Agent",
    goal: "交给任意 Coding Agent 执行。",
    output: "请输出可执行方案、必要修改和验证清单。",
  },
};

const FACTORY_TEMPLATES = {
  feature: {
    label: "功能实现",
    task: "实现：\n\n期望行为：\n\n验收标准：",
    constraints: "遵循现有架构和代码风格。\n保持改动范围尽量小。\n完成后运行相关检查。",
  },
  bugfix: {
    label: "Bug 修复",
    task: "问题现象：\n\n复现路径：\n\n期望结果：",
    constraints: "先定位根因，再修改。\n不要回滚无关改动。\n补充或运行能覆盖该问题的验证。",
  },
  review: {
    label: "代码审查",
    task: "请审查以下变更或模块：\n\n重点关注：",
    constraints: "按严重程度列出问题。\n每条问题包含文件位置、风险和建议修复方式。",
  },
  refactor: {
    label: "重构整理",
    task: "重构目标：\n\n保持不变的行为：\n\n希望改善的问题：",
    constraints: "保持外部行为兼容。\n避免引入大型新依赖。\n优先沿用项目已有模式。",
  },
};

let factoryArea;
let fields = {};
let buttons = {};
let outputPre;
let outputPanel;
let checklistEl;
let fileListEl;
let constitutionDisplay;
let selectedFiles = new Map();

function showToast(message) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, 2200);
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getRules() {
  const c = effectiveConstitution();
  return Array.isArray(c?.rules) ? c.rules : [];
}

function getPromptText() {
  return outputPre?.textContent || "";
}

function makeSnippetId() {
  return makeId();
}

function renderShell() {
  factoryArea.innerHTML = `
    <div class="factory-workbench">
      <section class="factory-compose">
        <div class="factory-strip">
          <div>
            <div class="factory-kicker">Prompt Factory</div>
            <h1 class="factory-heading">把零散意图整理成可执行任务</h1>
          </div>
          <div class="factory-strip-actions">
            <button id="factory-btn-from-chat" class="factory-ghost-btn" type="button">引用最近对话</button>
            <button id="factory-btn-clear" class="factory-ghost-btn" type="button">清空</button>
          </div>
        </div>

        <div class="factory-control-row">
          <label class="factory-field">
            <span class="factory-label">目标 Agent</span>
            <select id="factory-agent" class="factory-select">
              ${Object.entries(FACTORY_PRESETS).map(([key, preset]) => `<option value="${key}">${preset.label}</option>`).join("")}
            </select>
          </label>
          <label class="factory-field">
            <span class="factory-label">任务类型</span>
            <select id="factory-template" class="factory-select">
              <option value="">从空白开始</option>
              ${Object.entries(FACTORY_TEMPLATES).map(([key, tpl]) => `<option value="${key}">${tpl.label}</option>`).join("")}
            </select>
          </label>
          <label class="factory-field">
            <span class="factory-label">输出语气</span>
            <select id="factory-tone" class="factory-select">
              <option value="direct">直接执行</option>
              <option value="careful">谨慎审计</option>
              <option value="explore">先探索再实现</option>
            </select>
          </label>
        </div>

        <label class="factory-field factory-field-main">
          <span class="factory-label">任务描述</span>
          <textarea id="factory-task" class="factory-input factory-task-input" placeholder="${t("写清楚你要 Agent 做什么、为什么做、怎样算完成。")}" rows="7"></textarea>
        </label>

        <div class="factory-grid">
          <label class="factory-field">
            <span class="factory-label">相关上下文</span>
            <textarea id="factory-context" class="factory-input" placeholder="${t("粘贴文件路径、报错、接口约定、关键代码片段。")}" rows="7"></textarea>
          </label>
          <label class="factory-field">
            <span class="factory-label">约束条件</span>
            <textarea id="factory-constraints" class="factory-input" placeholder="${t("不能改什么、必须保留什么、需要遵守哪些风格或流程。")}" rows="7"></textarea>
          </label>
        </div>

        <div class="factory-context-bar">
          <button id="factory-btn-insert-constitution" class="factory-ghost-btn" type="button">插入项目宪法</button>
          <button id="factory-btn-insert-files" class="factory-ghost-btn" type="button">插入勾选文件</button>
          <button id="btn-generate-prompt" class="generate-btn factory-primary-btn" type="button">生成 Prompt</button>
        </div>
      </section>

      <aside class="factory-sidebar">
        <section class="factory-side-section">
          <div class="factory-side-head">
            <span class="factory-label">项目宪法</span>
            <span id="factory-rule-count" class="factory-count">0</span>
          </div>
          <div id="constitution-display" class="constitution-display factory-constitution"></div>
        </section>

        <section class="factory-side-section">
          <div class="factory-side-head">
            <span class="factory-label">可引用文件</span>
            <span id="factory-file-count" class="factory-count">0</span>
          </div>
          <div id="factory-file-list" class="factory-file-list"></div>
        </section>

        <section class="factory-side-section">
          <div class="factory-side-head">
            <span class="factory-label">质量检查</span>
          </div>
          <div id="factory-checklist" class="factory-checklist"></div>
        </section>
      </aside>
    </div>

    <section id="prompt-output" class="prompt-output factory-output hidden">
      <div class="prompt-output-header">
        <span>生成结果</span>
        <div class="factory-output-actions">
          <button id="factory-btn-save-snippet" class="icon-btn" title="保存为素材" type="button">${iconSvg("star")}</button>
          <button id="factory-btn-download" class="icon-btn" title="下载 Markdown" type="button">${iconSvg("download")}</button>
          <button id="btn-copy-prompt" class="icon-btn" title="复制" type="button">⧉</button>
        </div>
      </div>
      <pre id="prompt-result" class="prompt-result"></pre>
    </section>
  `;
}

function bindElements() {
  fields = {
    agent: document.getElementById("factory-agent"),
    template: document.getElementById("factory-template"),
    tone: document.getElementById("factory-tone"),
    task: document.getElementById("factory-task"),
    context: document.getElementById("factory-context"),
    constraints: document.getElementById("factory-constraints"),
  };
  buttons = {
    fromChat: document.getElementById("factory-btn-from-chat"),
    clear: document.getElementById("factory-btn-clear"),
    insertConstitution: document.getElementById("factory-btn-insert-constitution"),
    insertFiles: document.getElementById("factory-btn-insert-files"),
    generate: document.getElementById("btn-generate-prompt"),
    copy: document.getElementById("btn-copy-prompt"),
    download: document.getElementById("factory-btn-download"),
    saveSnippet: document.getElementById("factory-btn-save-snippet"),
  };
  outputPanel = document.getElementById("prompt-output");
  outputPre = document.getElementById("prompt-result");
  checklistEl = document.getElementById("factory-checklist");
  fileListEl = document.getElementById("factory-file-list");
  constitutionDisplay = document.getElementById("constitution-display");
}

function bindEvents() {
  fields.template?.addEventListener("change", applyTemplate);
  Object.values(fields).forEach(el => el?.addEventListener("input", renderChecklist));
  buttons.fromChat?.addEventListener("click", insertRecentChat);
  buttons.clear?.addEventListener("click", clearFactory);
  buttons.insertConstitution?.addEventListener("click", insertConstitutionRules);
  buttons.insertFiles?.addEventListener("click", insertSelectedFiles);
  buttons.generate?.addEventListener("click", generatePrompt);
  buttons.copy?.addEventListener("click", copyPrompt);
  buttons.download?.addEventListener("click", downloadPrompt);
  buttons.saveSnippet?.addEventListener("click", savePromptAsSnippet);
}

function appendToTextarea(textarea, text) {
  if (!textarea || !text) return;
  const current = textarea.value.trimEnd();
  textarea.value = current ? `${current}\n\n${text}` : text;
  textarea.dispatchEvent(new Event("input"));
}

function applyTemplate() {
  const tpl = FACTORY_TEMPLATES[fields.template.value];
  if (!tpl) return;
  if (!fields.task.value.trim()) fields.task.value = tpl.task;
  if (!fields.constraints.value.trim()) fields.constraints.value = tpl.constraints;
  renderChecklist();
}

function insertRecentChat() {
  const recent = state.messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .slice(-6)
    .map(m => `[${m.role === "user" ? "用户" : "助手"}]\n${m.content || ""}`)
    .join("\n\n");
  if (!recent) {
    showToast("当前没有可引用的对话");
    return;
  }
  appendToTextarea(fields.context, `最近对话摘要：\n${recent.slice(0, 8000)}`);
  showToast("已引用最近对话");
}

function insertConstitutionRules() {
  const rules = getRules();
  if (rules.length === 0) {
    showToast("当前项目没有宪法规则");
    return;
  }
  appendToTextarea(fields.constraints, rules.map((rule, i) => `${i + 1}. ${rule}`).join("\n"));
  showToast("已插入项目宪法");
}

async function insertSelectedFiles() {
  const paths = [...selectedFiles.keys()];
  if (paths.length === 0) {
    showToast("先勾选需要引用的文件");
    return;
  }

  buttons.insertFiles.disabled = true;
  const oldText = buttons.insertFiles.textContent;
  buttons.insertFiles.textContent = "读取中...";

  try {
    const chunks = [];
    for (const path of paths.slice(0, 8)) {
      const res = await browseFiles(path);
      if (res.code === 0 && res.data?.type === "file") {
        const content = (res.data.content || "").slice(0, 6000);
        chunks.push(`文件：${res.data.path || path}\n\`\`\`\n${content}\n\`\`\``);
      }
    }
    if (chunks.length === 0) {
      showToast("没有读取到可用文件");
      return;
    }
    appendToTextarea(fields.context, chunks.join("\n\n"));
    showToast(t("已插入 {n} 个文件", { n: chunks.length }));
  } finally {
    buttons.insertFiles.disabled = false;
    buttons.insertFiles.textContent = oldText;
  }
}

function clearFactory() {
  fields.task.value = "";
  fields.context.value = "";
  fields.constraints.value = "";
  fields.template.value = "";
  outputPre.textContent = "";
  outputPanel.classList.add("hidden");
  renderChecklist();
}

function renderConstitution() {
  if (!constitutionDisplay) return;
  const rules = getRules();
  const count = document.getElementById("factory-rule-count");
  if (count) count.textContent = String(rules.length);

  if (rules.length === 0) {
    constitutionDisplay.innerHTML = '<div class="factory-empty">暂无项目宪法</div>';
    return;
  }

  constitutionDisplay.innerHTML = rules
    .map((rule, i) => `<div class="factory-rule"><span>${i + 1}</span>${escapeHtml(rule)}</div>`)
    .join("");
}

function renderFilePicker() {
  if (!fileListEl) return;
  const tree = state.projectFileTree;
  const entries = Array.isArray(tree?.entries) ? tree.entries : [];
  const count = document.getElementById("factory-file-count");
  const files = entries.filter(entry => entry.type === "file");
  if (count) count.textContent = String(files.length);

  if (!state.project) {
    fileListEl.innerHTML = '<div class="factory-empty">先在对话页打开项目</div>';
    return;
  }
  if (files.length === 0) {
    fileListEl.innerHTML = '<div class="factory-empty">当前目录没有可引用文件</div>';
    return;
  }

  fileListEl.innerHTML = files.slice(0, 30).map(file => `
    <label class="factory-file-row" title="${escapeHtml(file.path)}">
      <input type="checkbox" data-factory-file="${escapeHtml(file.path)}" ${selectedFiles.has(file.path) ? "checked" : ""}>
      <span>${escapeHtml(file.name)}</span>
      <small>${formatSize(file.size)}</small>
    </label>
  `).join("");

  fileListEl.querySelectorAll("input[data-factory-file]").forEach(input => {
    input.addEventListener("change", () => {
      const path = input.getAttribute("data-factory-file");
      if (input.checked) selectedFiles.set(path, true);
      else selectedFiles.delete(path);
      renderChecklist();
    });
  });
}

function formatSize(size) {
  if (size == null) return "";
  if (size < 1024) return `${size}B`;
  if (size < 1048576) return `${(size / 1024).toFixed(1)}K`;
  return `${(size / 1048576).toFixed(1)}M`;
}

function renderChecklist() {
  if (!checklistEl) return;
  const task = fields.task?.value.trim() || "";
  const context = fields.context?.value.trim() || "";
  const constraints = fields.constraints?.value.trim() || "";
  const rules = getRules();
  const checks = [
    { ok: task.length >= 12, label: "任务足够明确" },
    { ok: context.length > 0 || selectedFiles.size > 0, label: "包含上下文或文件" },
    { ok: constraints.length > 0 || rules.length > 0, label: "声明约束边界" },
    { ok: fields.agent?.value, label: "选择目标 Agent" },
  ];

  checklistEl.innerHTML = checks.map(check => `
    <div class="factory-check ${check.ok ? "ok" : ""}">
      <span>${check.ok ? iconSvg("check") : ""}</span>
      ${check.label}
    </div>
  `).join("");
}

function buildPrompt() {
  const task = fields.task.value.trim();
  const context = fields.context.value.trim();
  const constraints = fields.constraints.value.trim();
  const preset = FACTORY_PRESETS[fields.agent.value] || FACTORY_PRESETS.generic;
  const rules = getRules();
  const selected = [...selectedFiles.keys()];

  const toneMap = {
    direct: "请直接进入执行，不需要长篇方案铺垫。",
    careful: "请先审计风险和边界，再做修改。",
    explore: "请先给出 2-3 个可行方向，再选择最稳妥方案执行。",
  };

  const sections = [
    "# 任务",
    task,
    "",
    "# 执行对象",
    preset.goal,
    "",
    "# 工作方式",
    toneMap[fields.tone.value] || toneMap.direct,
    "阅读现有代码后再行动，优先沿用项目已有模式。",
  ];

  if (rules.length) {
    sections.push("", "# 项目宪法", ...rules.map((rule, i) => `${i + 1}. ${rule}`));
  }

  if (selected.length) {
    sections.push("", "# 重点文件", ...selected.map(path => `- ${path}`));
  }

  if (context) {
    sections.push("", "# 已知上下文", context);
  }

  if (constraints) {
    sections.push("", "# 约束条件", constraints);
  }

  sections.push(
    "",
    "# 交付要求",
    preset.output,
    "不要修改与任务无关的文件；遇到已有未提交改动时，先理解并兼容它们。",
    "完成后说明验证命令或无法验证的原因。"
  );

  return sections.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function generatePrompt() {
  if (!fields.task.value.trim()) {
    showToast("请先填写任务描述");
    fields.task.focus();
    return;
  }

  outputPre.textContent = buildPrompt();
  outputPanel.classList.remove("hidden");
  outputPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function copyPrompt() {
  const text = getPromptText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
  showToast("Prompt 已复制");
}

function downloadPrompt() {
  const text = getPromptText();
  if (!text) return;
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `slate-prompt-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function savePromptAsSnippet() {
  const text = getPromptText();
  if (!text) return;
  const snip = { id: makeSnippetId(), text, source: "提示词工厂 "};
  addPromptSnippet(snip);
  post("/chat/snippets", snip).catch(() => {});
  showToast("已保存到提示词素材");
}

async function loadConstitution() {
  try {
    const res = await get("/constitution");
    if (res.code === 0 && res.data) {
      state.constitution = res.data;
      renderConstitution();
      renderChecklist();
    }
  } catch (e) {
    renderConstitution();
  }
}

function initPromptFactory() {
  factoryArea = document.getElementById("factory-area");
  if (!factoryArea) return;

  renderShell();
  bindElements();
  bindEvents();

  loadConstitution();
  renderConstitution();
  renderFilePicker();
  renderChecklist();

  subscribe("constitution", () => {
    renderConstitution();
    renderChecklist();
  });
  subscribe("project", () => {
    // 切换项目后清空旧项目的勾选路径，防止串项目
    selectedFiles.clear();
    renderFilePicker();
    // 生效的宪法随项目换，展示区与清单要跟着重画
    renderConstitution();
    renderChecklist();
  });
  subscribe("projectFileTree", renderFilePicker);
  bindModalChannels();
}

// ── 弹窗：入口在「设置 → 上下文与项目」那颗「打开工作台」（顶栏页签与输入行都腾出来了）──
// 表单留在 DOM 里，收起只加 .hidden——再打开时草稿、勾选的文件、生成结果都还在。

function factoryModal() {
  return document.getElementById("factory-modal");
}

export function openPromptFactory() {
  const modal = factoryModal();
  if (!modal) return;
  modal.classList.remove("hidden");
  document.getElementById("factory-task")?.focus();
}

function closePromptFactory() {
  factoryModal()?.classList.add("hidden");
}

function bindModalChannels() {
  const modal = factoryModal();
  if (!modal) return;
  document.getElementById("btn-prompt-factory")?.addEventListener("click", openPromptFactory);
  modal.querySelectorAll("[data-factory-close]").forEach(el => {
    el.addEventListener("click", closePromptFactory);
  });
}

export { initPromptFactory, generatePrompt };
