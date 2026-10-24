/**
 * SLATE Better Project Understanding 组件
 * AI 全量扫描项目，生成「导览·百科」与「规则手册」。
 * 三档深度：简略/ 平衡 / 详细（扫描预算与输出长度随档位变化）
 */

import { state, setProject, getModelKey } from "../store.js?v=20261024-001";
import { aiModelFor, aiFeatureBlocked } from "../services/ai_features.js?v=20261024-001";
import { post, streamChat, REASONING_PREFIX, REASONING_INLINE_PREFIX } from "../services/api.js?v=20261024-001";
import { updateProjectConfig } from "../services/project.js?v=20261024-001";
import { renderMarkdown } from "../services/markdown.js?v=20261024-001";
import { t } from "../services/i18n.js?v=20261024-001";
import { iconSvgEl } from "../services/icons.js?v=20261024-001";

const LEVELS = {
  brief: { label: "简略", tree: "目录深度 2 层", files: "精读 6 个关键文件", out: "输出约 900 字" },
  balanced: { label: "平衡", tree: "目录深度 3 层", files: "精读 16 个关键文件", out: "输出约 1800 字" },
  detailed: { label: "详细", tree: "目录深度 5 层", files: "精读 36 个关键文件", out: "输出约 3200 字" },
};
const LEVEL_TOKENS = { brief: 900, balanced: 1800, detailed: 3200 };

let modal, setupView, progressView, resultView;
let levelCards, btnStart, progressSteps, progressLog;
let resultTabs, resultBody, resultMeta, btnCopyResult;
let currentLevel = "balanced";
let currentResult = null; // { tour, rules }
let running = false;
let abortController = null;

// ── 视图切换 ──────────────────────────────────

function showView(name) {
  setupView?.classList.toggle("hidden", name !== "setup");
  progressView?.classList.toggle("hidden", name !== "progress");
  resultView?.classList.toggle("hidden", name !== "result");
}

function openUnderstandModal() {
  bindUnderstandModal();
  if (!state.project) {
    import("../app.js?v=20261024-001").then(({ toast }) => toast(t("请先打开一个项目"))).catch(() => {});
    return;
  }
  currentResult = state.project.config?.understanding || null;
  if (currentResult?.tour || currentResult?.rules) {
    renderResult();
    showView("result");
  } else {
    showView("setup");
  }
  modal.classList.remove("hidden");
}

// ── 档位选择 ──────────────────────────────────

function renderLevelCards() {
  if (!levelCards) return;
  levelCards.innerHTML = "";
  for (const [key, meta] of Object.entries(LEVELS)) {
    const card = document.createElement("div");
    card.className = `understand-level-card${key === currentLevel ? " selected" : ""}`;
    card.dataset.level = key;

    const title = document.createElement("div");
    title.className = "understand-level-title";
    title.textContent = t(meta.label);
    card.appendChild(title);

    for (const line of [meta.tree, meta.files, meta.out]) {
      const d = document.createElement("div");
      d.className = "understand-level-line";
      d.textContent = t(line);
      card.appendChild(d);
    }
    card.addEventListener("click", () => {
      currentLevel = key;
      renderLevelCards();
    });
    levelCards.appendChild(card);
  }
}

// ── 进度展示 ──────────────────────────────────

function setStepStatus(idx, status) {
  const step = progressSteps?.children[idx];
  if (!step) return;
  step.className = `understand-step ${status}`;
  const icon = step.querySelector(".understand-step-icon");
  if (icon) {
    icon.textContent = "";
    if (status === "done") icon.appendChild(iconSvgEl("check"));
    else if (status === "running") icon.appendChild(iconSvgEl("search"));
    else icon.textContent = status === "error" ? "!" : "·";
  }
}

function appendLog(text) {
  if (!progressLog) return;
  const line = document.createElement("div");
  line.textContent = text;
  progressLog.appendChild(line);
  progressLog.scrollTop = progressLog.scrollHeight;
}

// ── 生成编排 ──────────────────────────────────

async function startUnderstanding() {
  if (running) return;
  if (aiFeatureBlocked("code_understand")) return;
  const target = aiModelFor("code_understand", state.currentModel);
  const model = { id: target.id, provider: target.provider };
  const apiKey = target.key;
  if (!target.usable) {
    import("../app.js?v=20261024-001").then(({ toast }) => toast(t("请先选择模型并配置 API Key"))).catch(() => {});
    return;
  }

  running = true;
  abortController = new AbortController();
  if (progressLog) progressLog.innerHTML = "";
  [0, 1, 2].forEach(i => setStepStatus(i, "waiting"));
  showView("progress");

  try {
    // 扫描项目
    setStepStatus(0, "running");
    appendLog(t("开始扫描项目（档位：{level}）…", { level: LEVELS[currentLevel].label }));
    const scanRes = await post("/projects/understand/scan", { level: currentLevel });
    if (scanRes.code !== 0) throw new Error(scanRes.message || "扫描失败");
    const scan = scanRes.data;
    appendLog(t("扫描完成：{n} 个文件，精读 {h} 个", { n: scan.total_files, h: scan.heads.length }) + (scan.truncated ? t("（目录树已截断）") : ""));
    if (scan.heads.length === 0) appendLog(t("未读取到关键文本文件，将仅依据目录树生成"));
    throwIfAborted();
    setStepStatus(0, "done");

    const scanContext = buildScanContext(scan);

    // 生成导览·百科
    setStepStatus(1, "running");
    appendLog(t("正在生成导览·百科…"));
    const tour = await generateDoc(model.id, apiKey, model.provider, buildTourPrompt(scan.project, currentLevel), scanContext);
    throwIfAborted();
    appendLog(t("导览·百科完成（{n} 字符）", { n: tour.length }));
    setStepStatus(1, "done");

    // 生成规则手册
    setStepStatus(2, "running");
    appendLog(t("正在生成规则手册…"));
    const rules = await generateDoc(model.id, apiKey, model.provider, buildRulesPrompt(scan.project, currentLevel), scanContext);
    throwIfAborted();
    appendLog(t("规则手册完成（{n} 字符）", { n: rules.length }));
    setStepStatus(2, "done");

    // 保存到项目配置（合并式写入）
    appendLog(t("正在保存到项目配置…"));
    currentResult = {
      level: currentLevel,
      generated_at: new Date().toISOString(),
      model: model.id,
      tour,
      rules,
    };
    const config = { ...(state.project.config || {}), understanding: currentResult };
    const saveRes = await updateProjectConfig(config);
    if (saveRes.code === 0) {
      setProject(saveRes.data);
      appendLog(t("已保存到 .slate/config.json"));
    } else {
      appendLog(t("保存失败（仍可复制结果）: {msg}", { msg: saveRes.message }));
    }

    renderResult();
    showView("result");
    import("../app.js?v=20261024-001").then(({ toast }) => toast(t("项目理解已生成"))).catch(() => {});
  } catch (e) {
    if (e.name === "AbortError") {
      appendLog(t("已取消"));
      showView("setup");
    } else {
      const steps = progressSteps?.children || [];
      for (let i = 0; i < steps.length; i++) {
        if (steps[i].classList.contains("running")) setStepStatus(i, "error");
      }
      appendLog(t("失败: {msg}", { msg: e.message }));
      import("../app.js?v=20261024-001").then(({ toast }) => toast(t("项目理解生成失败: {msg}", { msg: e.message }))).catch(() => {});
    }
  } finally {
    running = false;
    abortController = null;
  }
}

function throwIfAborted() {
  if (abortController?.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

async function generateDoc(modelId, apiKey, provider, systemPrompt, scanContext) {
  let fullText = "";
  for await (const chunk of streamChat({
    model: modelId,
    provider,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: scanContext },
    ],
    api_key: apiKey,
    temperature: 0.3,
    max_tokens: LEVEL_TOKENS[currentLevel] + 400,
    stream: true,
    signal: abortController?.signal,
  })) {
    throwIfAborted();
    // 过滤掉 reasoning/thinking 内容，只保留正文
    const s = String(chunk || "");
    if (s.startsWith(REASONING_PREFIX) || s.startsWith(REASONING_INLINE_PREFIX)) {
      continue;
    }
    fullText += chunk;
  }
  if (!fullText.trim()) throw new Error(t("模型未返回内容"));
  return fullText.trim();
}

// ── 提示词 ───────────────────────────────────

function buildScanContext(scan) {
  const parts = [
    `项目名：${scan.project}`,
    `扫描档位：${scan.level || currentLevel}`,
    `精读文件数：${scan.heads?.length || 0}/${scan.total_files || 0}`,
    "",
    "== 目录树 ==",
    scan.tree || "（无目录树）",
    "",
    "== 关键文件内容（截取开头） ==",
  ];
  for (const h of scan.heads) {
    const note = h.truncated ? `（${h.lines} 行，已截取前 ${h.head_lines} 行）` : `（${h.lines} 行）`;
    parts.push("", `### ${h.path} ${note}`, "```", h.content, "```");
  }
  return parts.join("\n");
}

function buildTourPrompt(projectName, level) {
  const depth = level === "brief"
    ? "篇幅精炼（约600字），每个小节只写核心结论"
    : level === "balanced"
      ? "篇幅适中（约1200字），关键模块展开一两句说明"
      : "篇幅详尽（约2000字），每个模块都要展开说明";
  const extraSection = level === "detailed" ? "\n7. 数据流与调用链：梳理主要数据如何在模块间流转" : "";
  return `你是资深软件架构师。根据用户提供的项目扫描资料（目录树与关键文件内容），为项目「${projectName}」撰写一份「导览·百科」文档，帮助新成员或 AI 快速理解该项目。

要求：
- 使用 Markdown，只依据扫描资料中的事实撰写，无法确定的内容明确标注"待确定"
- ${depth}
- 章节结构：
1. 项目概述：一句话定位 + 解决什么问题
2. 技术栈：语言/框架/依赖/构建方式
3. 目录结构解读：每个顶层目录的职责
4. 核心模块：职责、关键文件、对外接口
5. 入口与启动方式${extraSection}
- 直接输出文档正文，不要任何前言或解释`;
}

function buildRulesPrompt(projectName, level) {
  const depth = level === "brief"
    ? "只提炼最关键的 5-8 条规范"
    : level === "balanced"
      ? "提炼 10-15 条规则，覆盖主要约定"
      : "提炼 15-25 条规则，覆盖所有可观察到的约定，并单列「扩展点与常见坑」小节";
  return `你是资深技术负责人。根据用户提供的项目扫描资料（目录树与关键文件内容），为项目「${projectName}」编写一份「规则手册」——供新成员与 AI 助手在后续开发中严格遵守的项目规则。

要求：
- 使用 Markdown，规则必须从扫描资料中真实存在的证据推导（如依赖文件、配置文件、代码风格、既有文档），禁止凭空捏造
- ${depth}
- 章节结构：
1. 技术边界：允许的依赖、构建方式、禁用的做法
2. 代码规范：从现有代码中观察到的命令结构/风格约定
3. 架构约束：模块划分、分层关系、扩展方式
4. 运行与构建命令：如何启动、测试、打开
- 每条规则一行，写成可直接执行的祈使句
- 直接输出文档正文，不要任何前言或解释`;
}

// ── 结果展示 ──────────────────────────────────

let activeTab = "tour";

function renderResult() {
  if (!resultView || !currentResult) return;
  const levelLabel = LEVELS[currentResult.level]?.label || currentResult.level || "";
  const time = currentResult.generated_at ? new Date(currentResult.generated_at).toLocaleString() : "";
  if (resultMeta) resultMeta.textContent = t("档位：{level} · 生成于 {date}", { level: t(levelLabel), date: time });
  renderResultTabs();
  renderResultBody();
}

function renderResultTabs() {
  if (!resultTabs) return;
  resultTabs.querySelectorAll(".understand-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.tab === activeTab);
  });
  if (btnCopyResult) btnCopyResult.title = "复制当前文档";
}

function renderResultBody() {
  if (!resultBody || !currentResult) return;
  const md = activeTab === "tour" ? (currentResult.tour || "") : (currentResult.rules || "");
  resultBody.innerHTML = renderMarkdown(md || "（暂无内容）");
  resultBody.scrollTop = 0;
}

async function copyCurrentResult() {
  if (!currentResult) return;
  const text = activeTab === "tour" ? currentResult.tour : currentResult.rules;
  try {
    await navigator.clipboard.writeText(text || "");
    import("../app.js?v=20261024-001").then(({ toast }) => toast(t("已复制到剪贴板"))).catch(() => {});
  } catch {
    import("../app.js?v=20261024-001").then(({ toast }) => toast(t("复制失败"))).catch(() => {});
  }
}

// ── 初始化 ───────────────────────────────────

let bound = false;

function bindUnderstandModal() {
  modal = document.getElementById("understand-modal");
  if (!modal || bound) return;
  bound = true;
  setupView = document.getElementById("understand-setup");
  progressView = document.getElementById("understand-progress");
  resultView = document.getElementById("understand-result");
  levelCards = document.getElementById("understand-levels");
  btnStart = document.getElementById("btn-understand-start");
  progressSteps = document.getElementById("understand-steps");
  progressLog = document.getElementById("understand-log");
  resultTabs = document.getElementById("understand-tabs");
  resultBody = document.getElementById("understand-body");
  resultMeta = document.getElementById("understand-meta");
  btnCopyResult = document.getElementById("btn-understand-copy");

  renderLevelCards();

  btnStart?.addEventListener("click", startUnderstanding);
  document.getElementById("btn-understand-cancel")?.addEventListener("click", () => {
    abortController?.abort();
    if (!running) showView("setup");
  });
  document.getElementById("btn-understand-regen")?.addEventListener("click", () => {
    currentResult = null;
    activeTab = "tour";
    showView("setup");
  });
  btnCopyResult?.addEventListener("click", copyCurrentResult);

  resultTabs?.querySelectorAll(".understand-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab;
      renderResultTabs();
      renderResultBody();
    });
  });

  modal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", () => {
      if (running) {
        abortController?.abort();
      }
      modal.classList.add("hidden");
    });
  });
}

function initUnderstandPanel() {
  bindUnderstandModal();
}

export { initUnderstandPanel, openUnderstandModal };
