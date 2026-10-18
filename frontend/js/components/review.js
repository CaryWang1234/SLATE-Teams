/**
 * SLATE Code Review 组件
 * 读取 git diff（staged/unstaged/commit range），AI 四维度结构化审查 + 行级评论
 */

import { state, getModelKey } from "../store.js?v=20261017-001";
import { aiModelFor, aiFeatureBlocked } from "../services/ai_features.js?v=20261017-001";
import { post, streamChat } from "../services/api.js?v=20261017-001";
import { renderMarkdown } from "../services/markdown.js?v=20261017-001";
import { t } from "../services/i18n.js?v=20261017-001";
import { setIconText } from "../services/icons.js?v=20261017-001";

const DIFF_MODES = {
  unstaged: { label: "未暂存变更" },
  staged:   { label: "已暂存变更" },
  commit:   { label: "提交范围" },
};

const DIMENSIONS = {
  quality:       { label: "代码质量", icon: "sparkles", color: "#4a9eff" },
  security:      { label: "安全性",   icon: "shield", color: "#ff6b6b" },
  performance:   { label: "性能",     icon: "zap", color: "#ffd93d" },
  maintainability: { label: "可维护性", icon: "tool", color: "#6bcb77" },
};

const SEVERITY_LABELS = { critical: "严重", major: "重要", minor: "建议", info: "信息" };
const SEVERITY_COLORS = { critical: "#ff4444", major: "#ff8800", minor: "#4488ff", info: "#888888" };

let modal, setupView, progressView, resultView;
let diffMode = "unstaged";
let fromCommitInput, toCommitInput, commitRangeRow;
let progressLog, diffSummary;
let resultTabs, resultBody, resultMeta, btnCopyResult;
let currentDiff = null;
let currentReview = null;  // { report, comments, raw }
let running = false;
let abortController = null;
let activeResultTab = "report";
let bound = false;

// ── 视图切换 ──────────────────────────────────

function showView(name) {
  setupView?.classList.toggle("hidden", name !== "setup");
  progressView?.classList.toggle("hidden", name !== "progress");
  resultView?.classList.toggle("hidden", name !== "result");
}

function openReviewModal() {
  bindReviewModal();
  if (!state.project) {
    import("../app.js?v=20261017-001").then(({ toast }) => toast(t("请先打开一个项目"))).catch(() => {});
    return;
  }
  currentDiff = null;
  currentReview = null;
  showView("setup");
  syncModeUI();
  modal.classList.remove("hidden");
}

function syncModeUI() {
  if (commitRangeRow) {
    commitRangeRow.classList.toggle("hidden", diffMode !== "commit");
  }
}

// ── 进度展示 ──────────────────────────────────

function appendLog(text) {
  if (!progressLog) return;
  const line = document.createElement("div");
  line.textContent = text;
  progressLog.appendChild(line);
  progressLog.scrollTop = progressLog.scrollHeight;
}

function renderDiffSummary(data) {
  if (!diffSummary) return;
  diffSummary.innerHTML = "";
  if (!data || data.total_changes === 0) {
    diffSummary.textContent = t("无变更");
    return;
  }
  const info = t("{n} 个文件变更，+{a} / -{d} 行", {
    n: data.total_files, a: data.total_add, d: data.total_del,
  });
  diffSummary.textContent = info + (data.truncated ? t("（已截断）") : "");
}

// ── 审查编排 ──────────────────────────────────

async function startReview() {
  if (running) return;
  if (aiFeatureBlocked("code_review")) return;
  const target = aiModelFor("code_review", state.currentModel);
  const model = { id: target.id, provider: target.provider };
  const apiKey = target.key;
  if (!target.usable) {
    import("../app.js?v=20261017-001").then(({ toast }) => toast(t("请先选择模型并配置 API Key"))).catch(() => {});
    return;
  }

  running = true;
  abortController = new AbortController();
  if (progressLog) progressLog.innerHTML = "";
  showView("progress");

  try {
    // ① 获取 diff
    appendLog(t("正在读取 git diff（模式：{m}）...", { m: DIFF_MODES[diffMode].label }));
    const body = { mode: diffMode, max_lines: 8000 };
    if (diffMode === "commit") {
      body.from_commit = fromCommitInput?.value.trim() || "";
      body.to_commit = toCommitInput?.value.trim() || "HEAD";
      if (!body.from_commit) throw new Error("commit 模式需要指定起始提交");
    }
    const diffRes = await post("/projects/review/diff", body);
    if (diffRes.code !== 0) throw new Error(diffRes.message || "获取 diff 失败");
    currentDiff = diffRes.data;
    renderDiffSummary(currentDiff);

    if (!currentDiff.raw) {
      appendLog(t("无变更，无需审查"));
      running = false;
      abortController = null;
      return;
    }
    appendLog(t("diff 就绪：{n} 文件，{c} 行变更", { n: currentDiff.total_files, c: currentDiff.total_changes }));

    // ② AI 审查
    appendLog(t("正在进行 AI 代码审查..."));
    const reviewPrompt = buildReviewPrompt(currentDiff);
    let fullText = "";
    for await (const chunk of streamChat({
      model: model.id,
      provider: model.provider,
      messages: [{ role: "user", content: reviewPrompt }],
      api_key: apiKey,
      temperature: 0.2,
      max_tokens: 4096,
      stream: true,
      signal: abortController?.signal,
    })) {
      fullText += chunk;
    }
    if (!fullText.trim()) throw new Error("模型未返回内容");

    // ③ 解析结果
    appendLog(t("正在解析审查结果..."));
    currentReview = parseReviewResult(fullText, currentDiff);
    appendLog(t("审查完成：{n} 条行级评论", { n: currentReview.comments.length }));

    renderReviewResult();
    showView("result");
    import("../app.js?v=20261017-001").then(({ toast }) => toast(t("代码审查完成"))).catch(() => {});
  } catch (e) {
    if (e.name === "AbortError") {
      appendLog(t("已取消"));
      showView("setup");
    } else {
      appendLog(t("审查失败: {msg}", { msg: e.message }));
      import("../app.js?v=20261017-001").then(({ toast }) => toast(t("代码审查失败: {msg}", { msg: e.message }))).catch(() => {});
    }
  } finally {
    running = false;
    abortController = null;
  }
}

// ── 提示词构建 ──────────────────────────────────

function buildReviewPrompt(diff) {
  const diffPreview = diff.raw.slice(0, 120000);
  return `你是一位资深代码审查专家。请对以下 git diff 进行全面代码审查。

审查维度（四个维度逐一分析）：
1. 代码质量：命名规范、代码风格、逻辑清晰度、重复代码、错误处理
2. 安全性：注入风险、敏感信息泄露、认证/授权缺陷、不安全的输入处理
3. 性能：算法复杂度、不必要的计算、内存泄漏风险、N+1 查询
4. 可维护性：模块耦合度、接口设计、注释充分性、测试覆盖暗示

输出格式（严格遵守）：

## 总体评价

（一段话概括变更目的和整体质量）

## 代码质量

（分析内容，引用具体文件和行号）

## 安全性

（分析内容，如果没有安全问题则说明"未发现安全问题"）

## 性能

（分析内容，如果没有性能问题则说明"未发现性能问题"）

## 可维护性

（分析内容）

## 行级评论

（每条一行，格式如下，没有评论则留空）
- [严重程度] 文件路径:行号 — 评论内容

严重程度选项：critical（严重缺陷/安全漏洞）、major（重要问题）、minor（改进建议）、info（信息提示）

示例：
- [major] src/auth.py:42 — 密码哈希使用了 MD5，建议改用 bcrypt
- [minor] utils/helpers.js:15 — 变量名 \`d\` 含义不清，建议改为 \`data\`

---
以下是 git diff：

\`\`\`diff
${diffPreview}
\`\`\``;
}

// ── 结果解析 ──────────────────────────────────

function parseReviewResult(text, diff) {
  // 提取行级评论
  const comments = [];
  const commentRegex = /-\s*\[(critical|major|minor|info)\]\s*([^\s:]+):(\d+)\s*[—–-]\s*(.+)/g;
  let match;
  while ((match = commentRegex.exec(text)) !== null) {
    comments.push({
      severity: match[1],
      file: match[2],
      line: parseInt(match[3], 10),
      content: match[4].trim(),
    });
  }

  // 提取各维度内容（## 标题之间的内容）
  const sections = {};
  const sectionNames = ["总体评价", "代码质量", "安全性", "性能", "可维护性"];
  for (const name of sectionNames) {
    const regex = new RegExp(`##\\s*${name}\\s*\\n([\\s\\S]*?)(?=##|$)`);
    const m = text.match(regex);
    if (m) sections[name] = m[1].trim();
  }

  // 构建报告 Markdown（去掉行级评论部分）
  let report = text;
  const lineCommentsIdx = text.indexOf("## 行级评论");
  if (lineCommentsIdx !== -1) {
    report = text.slice(0, lineCommentsIdx).trim();
  }

  return { report, comments, sections, raw: text };
}

// ── 结果渲染 ──────────────────────────────────

function renderReviewResult() {
  if (!resultView || !currentReview) return;
  const mode = currentDiff?.mode || diffMode;
  const time = new Date().toLocaleString();
  if (resultMeta) {
    resultMeta.textContent = t("{m} · {f} 文件 · {date}", {
      m: DIFF_MODES[mode]?.label || mode,
      f: currentDiff?.total_files || 0,
      date: time,
    });
  }
  renderResultTabs();
  renderResultBody();
}

function renderResultTabs() {
  if (!resultTabs) return;
  resultTabs.querySelectorAll(".review-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.tab === activeResultTab);
  });
}

function renderResultBody() {
  if (!resultBody || !currentReview) return;
  resultBody.innerHTML = "";
  resultBody.scrollTop = 0;

  if (activeResultTab === "report") {
    // 渲染 Markdown 报告
    const reportEl = document.createElement("div");
    reportEl.className = "review-report-md";
    reportEl.innerHTML = renderMarkdown(currentReview.report || t("（暂无内容）"));
    resultBody.appendChild(reportEl);
  } else if (activeResultTab === "comments") {
    // 渲染行级评论列表
    renderLineComments();
  } else if (activeResultTab === "dimensions") {
    // 四维度卡片视图
    renderDimensionCards();
  }
}

function renderLineComments() {
  const comments = currentReview.comments || [];
  if (comments.length === 0) {
    resultBody.textContent = "";
    const empty = document.createElement("div");
    empty.className = "review-empty-comments";
    empty.textContent = t("未发现行级问题");
    resultBody.appendChild(empty);
    return;
  }

  // 按严重程度排序
  const severityOrder = { critical: 0, major: 1, minor: 2, info: 3 };
  const sorted = [...comments].sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

  const list = document.createElement("div");
  list.className = "review-comments-list";

  for (const c of sorted) {
    const card = document.createElement("div");
    card.className = `review-comment-card severity-${c.severity}`;

    const head = document.createElement("div");
    head.className = "review-comment-head";

    const badge = document.createElement("span");
    badge.className = "review-severity-badge";
    badge.style.background = SEVERITY_COLORS[c.severity] || "#888";
    badge.textContent = SEVERITY_LABELS[c.severity] || c.severity;
    head.appendChild(badge);

    const loc = document.createElement("span");
    loc.className = "review-comment-loc";
    loc.textContent = `${c.file}:${c.line}`;
    loc.title = t("跳转到文件位置");
    loc.style.cursor = "pointer";
    loc.addEventListener("click", () => copyToClipboard(`${c.file}:${c.line}`));
    head.appendChild(loc);

    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "review-comment-body";
    body.textContent = c.content;
    card.appendChild(body);

    list.appendChild(card);
  }

  resultBody.appendChild(list);
}

function renderDimensionCards() {
  const sections = currentReview.sections || {};
  const grid = document.createElement("div");
  grid.className = "review-dimensions-grid";

  for (const [key, meta] of Object.entries(DIMENSIONS)) {
    const card = document.createElement("div");
    card.className = "review-dimension-card";
    card.style.borderLeftColor = meta.color;

    const title = document.createElement("div");
    title.className = "review-dimension-title";
    setIconText(title, meta.icon, meta.label);
    card.appendChild(title);

    const content = document.createElement("div");
    content.className = "review-dimension-content";
    const text = sections[meta.label] || t("未发现问题");
    content.innerHTML = renderMarkdown(text);
    card.appendChild(content);

    // 统计该维度相关的行级评论数
    const dimComments = (currentReview.comments || []).filter(c => {
      const content = c.content.toLowerCase();
      if (key === "quality") return /命名|风格|重复|规范|逻辑|错误处理|naming|style|duplicate/i.test(content);
      if (key === "security") return /安全|注入|泄露|认证|授权|security|inject|leak|auth/i.test(content);
      if (key === "performance") return /性能|复杂|内存|查询|慢|performance|complexity|memory|slow/i.test(content);
      if (key === "maintainability") return /维护|耦合|接口|注释|测试|maintain|coupling|interface|comment|test/i.test(content);
      return false;
    });
    if (dimComments.length > 0) {
      const count = document.createElement("div");
      count.className = "review-dimension-count";
      count.textContent = t("{n} 条相关评论", { n: dimComments.length });
      card.appendChild(count);
    }

    grid.appendChild(card);
  }

  resultBody.appendChild(grid);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    import("../app.js?v=20261017-001").then(({ toast }) => toast(t("已复制"))).catch(() => {});
  } catch {
    import("../app.js?v=20261017-001").then(({ toast }) => toast(t("复制失败"))).catch(() => {});
  }
}

async function copyReviewResult() {
  if (!currentReview) return;
  const text = currentReview.raw || "";
  await copyToClipboard(text);
}

// ── 初始化 ─────────────────────────────────────

function bindReviewModal() {
  modal = document.getElementById("review-modal");
  if (!modal || bound) return;
  bound = true;

  setupView = document.getElementById("review-setup");
  progressView = document.getElementById("review-progress");
  resultView = document.getElementById("review-result");
  progressLog = document.getElementById("review-log");
  diffSummary = document.getElementById("review-diff-summary");
  resultTabs = document.getElementById("review-result-tabs");
  resultBody = document.getElementById("review-result-body");
  resultMeta = document.getElementById("review-result-meta");
  btnCopyResult = document.getElementById("btn-review-copy");
  fromCommitInput = document.getElementById("review-from-commit");
  toCommitInput = document.getElementById("review-to-commit");
  commitRangeRow = document.getElementById("review-commit-range");

  // diff 模式选择
  const modeButtons = modal.querySelectorAll(".review-mode-btn");
  modeButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      diffMode = btn.dataset.mode;
      modeButtons.forEach(b => b.classList.toggle("active", b === btn));
      syncModeUI();
    });
  });

  // 开始审查
  document.getElementById("btn-review-start")?.addEventListener("click", startReview);

  // 取消
  document.getElementById("btn-review-cancel")?.addEventListener("click", () => {
    abortController?.abort();
    if (!running) showView("setup");
  });

  // 重新审查
  document.getElementById("btn-review-redo")?.addEventListener("click", () => showView("setup"));

  // 复制结果
  btnCopyResult?.addEventListener("click", copyReviewResult);

  // 结果 Tab 切换
  resultTabs?.querySelectorAll(".review-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      activeResultTab = tab.dataset.tab;
      renderResultTabs();
      renderResultBody();
    });
  });

  // 关闭弹窗
  modal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", () => {
      if (running) abortController?.abort();
      modal.classList.add("hidden");
    });
  });
}

function initReviewPanel() {
  bindReviewModal();
}

export { initReviewPanel, openReviewModal };
