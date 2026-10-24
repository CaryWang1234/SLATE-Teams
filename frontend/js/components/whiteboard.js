/**
 * SLATE 白板组件 v2：卡片编辑、颜色标签、AI 整理
 */

import { state, subscribe, setBoardCards, addBoardCard, setBoardNotes, setBoardStrokes, getModelKey } from "../store.js?v=20261024-001";
import { aiModelFor, aiFeatureBlocked } from "../services/ai_features.js?v=20261024-001";
import { get, streamChat } from "../services/api.js?v=20261024-001";
import { dlgConfirm, dlgToast } from "../services/dialog.js?v=20261024-001";
import { t } from "../services/i18n.js?v=20261024-001";
import { iconSvgEl } from "../services/icons.js?v=20261024-001";
import { makeId } from "../services/utils.js?v=20261024-001";
import { reportError } from "../services/error_sink.js?v=20261024-001";
import { renderWorkflowView, startWorkflowTick, stopWorkflowTick, initBoardWorkflow } from "./board_workflow.js?v=20261024-001";

// 逐元素求极值：把整个数组当实参展开时，笔迹点上万会让 V8 抛
// RangeError: Maximum call stack size exceeded，所以这里一律不展开。
function maxOf(values, floor = -Infinity) {
  let m = floor;
  for (const v of values) if (v > m) m = v;
  return m;
}

let boardCanvas, boardCards, boardEmpty, drawCanvas, drawCtx, notesLayer, mermaidPreview, mermaidCode, mermaidRenderArea, selectionInfo, boardViewPanel, whiteboardPanel, boardModesBar, wfStopBtn;
let cardModal, cardModalTitle, cardInputTitle, cardInputBody, cardInputArrows, cardColorOptions;
let btnCardDelete, btnCardSave, btnCardCancel;
let editingCardId = null;
let selectedColor = "default";
let svgOverlay = null;
let mermaidVisible = false;
let boardViewFullscreen = false;
const DEFAULT_BOARD_VIEW = "kanban";

let currentBoardView = DEFAULT_BOARD_VIEW;
let boardViewCollapsed = false;
let currentToolMode = "select";
let connectSourceId = null;
let strokes = [];
let currentStroke = null;
let activeCardDrag = null;
let activeGitNodeDrag = null;
let activeGitPan = null;
let suppressCardClickUntil = 0;
let selectedCardIds = new Set();
let gitGraphState = { loading: false, data: null, error: "", repo: "" };
let gitNodePositions = {};
let gitGraphPan = { x: 0, y: 0 };
let boardOutlineCollapsed = new Set();
// 看板列是否显示工具步骤卡（默认隐藏，与用户卡片分离）；localStorage 记忆开关
let showToolSteps = (() => {
  try { return localStorage.getItem("slate_board_show_steps") === "1"; } catch { return false; }
})();

const CARD_LAYOUT = {
  width: 220,
  minGapX: 28,
  gapY: 28,
  startX: 24,
  startY: 24,
};

// 颜色选项
const CARD_COLORS = [
  { id: "default", name: "默认", bg: "var(--bg)", border: "var(--border)" },
  { id: "red", name: "红色", bg: "#fee", border: "#c99" },
  { id: "orange", name: "橙色", bg: "#fef3e2", border: "#f0b87a" },
  { id: "yellow", name: "黄色", bg: "#fffbe6", border: "#ffe58f" },
  { id: "green", name: "绿色", bg: "#f0fff0", border: "#95d475" },
  { id: "blue", name: "蓝色", bg: "#e6f4ff", border: "#91caff" },
  { id: "purple", name: "紫色", bg: "#f5f0ff", border: "#b37feb" },
];

const BOARD_VIEW_LABELS = {
  git: "Git 树",
  flow: "流程",
  kanban: "看板",
  outline: "纲要",
  workflow: "工作流",
};

const COLOR_META = {
  default: { label: "未分类", icon: "info" },
  red: { label: "风险", icon: "alert-triangle" },
  orange: { label: "待处理", icon: "clock" },
  yellow: { label: "想法", icon: "lightbulb" },
  green: { label: "完成", icon: "check" },
  blue: { label: "信息", icon: "info" },
  purple: { label: "创意", icon: "sparkles" },
};

const GIT_POSITION_KEY = "slate_git_graph_positions";
const OUTLINE_COLLAPSED_KEY = "slate_board_outline_collapsed";
const KANBAN_COLORS = ["red", "orange", "yellow", "blue", "purple", "green", "default"];

function loadGitNodePositions() {
  try {
    gitNodePositions = JSON.parse(localStorage.getItem(GIT_POSITION_KEY) || "{}") || {};
  } catch (e) {
    gitNodePositions = {};
  }
}

function loadOutlineCollapsed() {
  try {
    boardOutlineCollapsed = new Set(JSON.parse(localStorage.getItem(OUTLINE_COLLAPSED_KEY) || "[]"));
  } catch (e) {
    boardOutlineCollapsed = new Set();
  }
}

function saveOutlineCollapsed() {
  try { localStorage.setItem(OUTLINE_COLLAPSED_KEY, JSON.stringify([...boardOutlineCollapsed])); } catch (e) {}
}

function saveGitNodePositions() {
  try { localStorage.setItem(GIT_POSITION_KEY, JSON.stringify(gitNodePositions)); } catch (e) {}
}

function gitRepoKey(repo = gitGraphState.data?.repo || "") {
  return String(repo || state.project?.path || "default");
}

function gitNodeKey(nodeId, repo = gitGraphState.data?.repo || "") {
  return `${gitRepoKey(repo)}::${nodeId}`;
}

function getGitNodePosition(node, fallback) {
  const saved = gitNodePositions[gitNodeKey(node.id)];
  if (saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y))) {
    return { x: Number(saved.x), y: Number(saved.y) };
  }
  return fallback;
}

function setGitNodePosition(nodeId, x, y) {
  gitNodePositions[gitNodeKey(nodeId)] = {
    x: Math.max(12, Math.round(x)),
    y: Math.max(12, Math.round(y)),
  };
  saveGitNodePositions();
}

function resetGitNodePositions() {
  const repoPrefix = `${gitRepoKey()}::`;
  for (const key of Object.keys(gitNodePositions)) {
    if (key.startsWith(repoPrefix)) delete gitNodePositions[key];
  }
  gitGraphPan = { x: 0, y: 0 };
  saveGitNodePositions();
}

function gitId(type, value = "") {
  return `git-${type}-${String(value || "root").replace(/[^a-zA-Z0-9_.-]+/g, "-")}`;
}

// ── 卡片渲染 ─────────────────────────────────

function getBoardViewportSize() {
  const rect = boardCanvas?.getBoundingClientRect?.();
  return {
    width: Math.max(320, rect?.width || 900),
    height: Math.max(260, rect?.height || 600),
  };
}

function getNextCardPosition(index = state.boardCards.length) {
  const { width } = getBoardViewportSize();
  const columns = Math.max(1, Math.floor((width - CARD_LAYOUT.startX * 2) / (CARD_LAYOUT.width + CARD_LAYOUT.minGapX)));
  const col = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: CARD_LAYOUT.startX + col * (CARD_LAYOUT.width + CARD_LAYOUT.minGapX),
    y: CARD_LAYOUT.startY + row * (100 + CARD_LAYOUT.gapY),
  };
}

function normalizeBoardCardsLayout(cards = state.boardCards) {
  let changed = false;
  const normalized = cards.map((card, index) => {
    const hasX = Number.isFinite(Number(card.x));
    const hasY = Number.isFinite(Number(card.y));
    if (hasX && hasY) return card;
    changed = true;
    // 只补缺失的坐标，保留已有的有效坐标
    if (hasX) return { ...card, y: getNextCardPosition(index).y };
    if (hasY) return { ...card, x: getNextCardPosition(index).x };
    return { ...card, ...getNextCardPosition(index) };
  });
  if (changed) setBoardCards(normalized);
  return changed ? normalized : cards;
}

function placeNewCard(card, index = state.boardCards.length) {
  const pos = getNextCardPosition(index);
  return {
    ...card,
    x: Number.isFinite(Number(card.x)) ? Number(card.x) : pos.x,
    y: Number.isFinite(Number(card.y)) ? Number(card.y) : pos.y,
  };
}

function updateCardPosition(cardId, x, y) {
  const maxX = Math.max(CARD_LAYOUT.startX, (boardCanvas?.scrollWidth || getBoardViewportSize().width) - 180);
  const maxY = Math.max(CARD_LAYOUT.startY, (boardCanvas?.scrollHeight || getBoardViewportSize().height) - 80);
  const nx = Math.max(0, Math.min(maxX, Math.round(x)));
  const ny = Math.max(0, Math.min(maxY, Math.round(y)));
  const cards = state.boardCards.map(card => (
    card.id === cardId ? { ...card, x: nx, y: ny } : card
  ));
  setBoardCards(cards);
}

function updateCardPositions(updates) {
  const updateMap = new Map(updates.map(item => [item.id, item]));
  const maxX = Math.max(CARD_LAYOUT.startX, (boardCanvas?.scrollWidth || getBoardViewportSize().width) - 180);
  const maxY = Math.max(CARD_LAYOUT.startY, (boardCanvas?.scrollHeight || getBoardViewportSize().height) - 80);
  const cards = state.boardCards.map(card => {
    const next = updateMap.get(card.id);
    if (!next) return card;
    return {
      ...card,
      x: Math.max(0, Math.min(maxX, Math.round(next.x))),
      y: Math.max(0, Math.min(maxY, Math.round(next.y))),
    };
  });
  setBoardCards(cards);
}

function updateBoardLayerSize(cards = state.boardCards) {
  if (!boardCanvas || !boardCards) return;
  const viewport = getBoardViewportSize();
  const maxRight = cards.reduce((max, card) => Math.max(max, (Number(card.x) || 0) + CARD_LAYOUT.width + 80), viewport.width);
  const noteRight = (state.boardNotes || []).reduce((max, note) => Math.max(max, (Number(note.x) || 0) + (Number(note.width) || 180) + 80), viewport.width);
  const noteBottom = (state.boardNotes || []).reduce((max, note) => Math.max(max, (Number(note.y) || 0) + 120), viewport.height);
  const strokeRight = strokes.flatMap(s => s.points || []).reduce((max, p) => Math.max(max, (Number(p.x) || 0) + 80), viewport.width);
  const strokeBottom = strokes.flatMap(s => s.points || []).reduce((max, p) => Math.max(max, (Number(p.y) || 0) + 80), viewport.height);
  const maxBottom = cards.reduce((max, card) => Math.max(max, (Number(card.y) || 0) + 180), viewport.height);
  const width = Math.ceil(maxRight);
  const height = Math.ceil(Math.max(maxBottom, noteBottom, strokeBottom));
  const layerWidth = Math.ceil(Math.max(width, noteRight, strokeRight));
  boardCards.style.width = `${layerWidth}px`;
  boardCards.style.height = `${height}px`;
  if (notesLayer) {
    notesLayer.style.width = `${layerWidth}px`;
    notesLayer.style.height = `${height}px`;
  }
  if (drawCanvas) {
    drawCanvas.style.minWidth = `${layerWidth}px`;
    drawCanvas.style.minHeight = `${height}px`;
  }
  requestAnimationFrame(resizeDrawCanvas);
}

function selectCard(cardId, event = null) {
  if (!cardId) return;
  if (event?.shiftKey || event?.ctrlKey || event?.metaKey) {
    if (selectedCardIds.has(cardId)) selectedCardIds.delete(cardId);
    else selectedCardIds.add(cardId);
  } else if (!selectedCardIds.has(cardId) || selectedCardIds.size > 1) {
    selectedCardIds = new Set([cardId]);
  }
  renderSelection();
}

function clearSelection() {
  if (!selectedCardIds.size) return;
  selectedCardIds.clear();
  renderSelection();
}

function renderSelection() {
  boardCards?.querySelectorAll(".board-card").forEach(el => {
    el.classList.toggle("selected", selectedCardIds.has(el.dataset.cardId));
  });
  if (selectionInfo) {
    selectionInfo.textContent = selectedCardIds.size ? t("已选 {n}", { n: selectedCardIds.size }) : "";
  }
}

function cardByIdMap(cards = state.boardCards) {
  return new Map((cards || []).map(card => [card.id, card]));
}

function buildBoardGraph(cards = state.boardCards) {
  const cardMap = cardByIdMap(cards);
  const incoming = new Map(cards.map(card => [card.id, []]));
  const outgoing = new Map(cards.map(card => [card.id, []]));
  for (const card of cards) {
    for (const targetId of card.arrows || []) {
      if (!cardMap.has(targetId)) continue;
      outgoing.get(card.id).push(targetId);
      incoming.get(targetId).push(card.id);
    }
  }
  const roots = cards.filter(card => (incoming.get(card.id) || []).length === 0);
  return { cardMap, incoming, outgoing, roots: roots.length ? roots : cards.slice(0, 1) };
}

function boardCardSummary(card) {
  const meta = COLOR_META[card.color || "default"] || COLOR_META.default;
  const node = document.createElement("button");
  node.className = `board-view-card board-view-color-${card.color || "default"}`;
  node.type = "button";
  node.dataset.cardId = card.id;
  node.addEventListener("click", () => {
    selectedCardIds = new Set([card.id]);
    setBoardView("");
    requestAnimationFrame(() => {
      const el = boardCards?.querySelector(`[data-card-id="${card.id}"]`);
      if (el) {
        boardCanvas.scrollTo({
          left: Math.max(0, (Number(card.x) || 0) - 80),
          top: Math.max(0, (Number(card.y) || 0) - 80),
          behavior: "smooth",
        });
      }
      renderSelection();
    });
  });
  node.addEventListener("dblclick", () => openCardModal(card));

  const head = document.createElement("span");
  head.className = "board-view-card-head";
  const badge = document.createElement("span");
  badge.className = "board-view-card-badge";
  badge.appendChild(iconSvgEl(meta.icon));
  const title = document.createElement("strong");
  title.textContent = card.title || t("未命名");
  head.append(badge, title);
  node.appendChild(head);

  if (card.body) {
    const body = document.createElement("span");
    body.className = "board-view-card-body";
    body.textContent = card.body;
    node.appendChild(body);
  }
  return node;
}

function makeViewIconButton(text, title, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "board-view-icon-btn";
  btn.textContent = text;
  btn.title = title;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick?.(e);
  });
  return btn;
}

function makeCardActionRow(card, actions = []) {
  const wrap = document.createElement("div");
  wrap.className = "board-view-card-wrap";
  wrap.dataset.cardId = card.id;
  wrap.appendChild(boardCardSummary(card));
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "board-view-card-actions";
    actions.forEach(action => row.appendChild(makeViewIconButton(action.text, action.title, action.onClick)));
    wrap.appendChild(row);
  }
  return wrap;
}

function createBoardCard({ title, body = "", color = "default", arrows = [], parentId = "" }) {
  const card = placeNewCard({
    id: makeId("c"),
    title: title || t("未命名"),
    body,
    arrows,
    color,
  });
  const cards = [...state.boardCards];
  if (parentId) {
    let linked = false;
    for (let i = 0; i < cards.length; i += 1) {
      if (cards[i].id !== parentId) continue;
      const nextArrows = Array.isArray(cards[i].arrows) ? [...cards[i].arrows] : [];
      if (!nextArrows.includes(card.id)) nextArrows.push(card.id);
      cards[i] = { ...cards[i], arrows: nextArrows };
      linked = true;
      break;
    }
    if (linked) {
      setBoardCards([...cards, card]);
      return card;
    }
  }
  addBoardCard(card);
  return card;
}

function patchBoardCard(cardId, patch) {
  setBoardCards((state.boardCards || []).map(card => (
    card.id === cardId ? { ...card, ...patch } : card
  )));
}

function moveCardToColor(cardId, color) {
  if (!KANBAN_COLORS.includes(color)) return;
  patchBoardCard(cardId, { color });
}

function addChildCard(parentCard, color = parentCard?.color || "default") {
  if (!parentCard) return;
  createBoardCard({
    title: t("新子卡片"),
    body: "",
    color,
    parentId: parentCard.id,
  });
}

function removeCardLink(parentId, childId) {
  setBoardCards((state.boardCards || []).map(card => {
    if (card.id !== parentId) return card;
    return { ...card, arrows: (card.arrows || []).filter(id => id !== childId) };
  }));
}

function buildFlowLevels(cards) {
  const { incoming, outgoing, roots, cardMap } = buildBoardGraph(cards);
  const level = new Map();
  const queue = roots.map(card => card.id);
  roots.forEach(card => level.set(card.id, 0));
  const relaxLimit = Math.max(cards.length * cards.length, cards.length + 1);
  let relaxCount = 0;
  while (queue.length && relaxCount < relaxLimit) {
    const id = queue.shift();
    const base = level.get(id) || 0;
    for (const childId of outgoing.get(id) || []) {
      const next = Math.max(level.get(childId) ?? 0, base + 1);
      if (next !== level.get(childId)) {
        level.set(childId, next);
        queue.push(childId);
        relaxCount += 1;
      }
    }
  }
  cards.forEach((card, index) => {
    if (!level.has(card.id)) level.set(card.id, Math.floor(index / 4));
  });
  const columns = new Map();
  for (const card of cards) {
    const lane = level.get(card.id) || 0;
    if (!columns.has(lane)) columns.set(lane, []);
    columns.get(lane).push(card);
  }
  return { incoming, outgoing, cardMap, columns: [...columns.entries()].sort((a, b) => a[0] - b[0]) };
}

const boardControlHomes = new Map();

function parkBoardControl(el, slot) {
  if (!el) return;
  if (slot) {
    slot.appendChild(el);
    return;
  }
  const home = boardControlHomes.get(el);
  const parent = home?.parent;
  if (!parent) return;
  const next = home.next && home.next.parentNode === parent ? home.next : null;
  parent.insertBefore(el, next);
}

// 全屏时把视图切换条与工作流停止按钮搬进看板栏头部，退出时送回 panel-header
function mountBoardViewControls(modesSlot, stopSlot) {
  parkBoardControl(boardModesBar, boardViewFullscreen ? modesSlot : null);
  parkBoardControl(wfStopBtn, boardViewFullscreen ? stopSlot : null);
}

function renderBoardView() {
  if (!boardViewPanel || !currentBoardView) return;
  boardViewPanel.classList.toggle("git-mode", currentBoardView === "git" && !boardViewCollapsed);
  if (boardViewCollapsed) {
    setBoardViewFullscreen(false, { skipRender: true });
    boardViewPanel.innerHTML = "";
    const strip = document.createElement("div");
    strip.className = "board-view-collapse-strip";
    const label = document.createElement("span");
    label.textContent = `${t(BOARD_VIEW_LABELS[currentBoardView] || "视图")} ${t("已收起")}`;
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "board-view-collapse-btn";
    expand.textContent = t("展开");
    expand.title = t("展开模式区域");
    expand.addEventListener("click", () => {
      boardViewCollapsed = false;
      setBoardView(currentBoardView, { preserveCollapse: true });
    });
    strip.append(label, expand);
    boardViewPanel.appendChild(strip);
    return;
  }
  const allCards = state.boardCards || [];
  // 默认隐藏工具步骤卡：看板/流程/纲要列只呈现用户卡片，开关可恢复显示
  const cards = showToolSteps ? allCards : allCards.filter(c => !c._isToolStep);
  boardViewPanel.innerHTML = "";
  const header = document.createElement("div");
  header.className = "board-view-header";
  const titleGroup = document.createElement("div");
  titleGroup.className = "board-view-title-group";
  const title = document.createElement("strong");
  title.textContent = t(BOARD_VIEW_LABELS[currentBoardView] || "视图");
  const modesSlot = document.createElement("div");
  modesSlot.className = "board-view-header-modes";
  titleGroup.append(title, modesSlot);
  const actions = document.createElement("div");
  actions.className = "board-view-header-actions";
  const hiddenSteps = allCards.length - cards.length;
  const meta = document.createElement("span");
  meta.textContent = t("{n} 张卡片", { n: cards.length }) + (hiddenSteps > 0 ? ` · ${t("已隐藏 {m} 张步骤卡", { m: hiddenSteps })}` : "");
  const stepToggle = document.createElement("button");
  stepToggle.type = "button";
  stepToggle.className = "board-view-collapse-btn" + (showToolSteps ? " active" : "");
  // 工作流视图呈现的是 Action 与运行现场，画布步骤卡在这里没有对应物，不摆一个空开关
  stepToggle.classList.toggle("hidden", currentBoardView === "workflow");
  stepToggle.textContent = t("显示工具步骤");
  stepToggle.title = showToolSteps ? t("隐藏工具步骤") : t("显示工具步骤");
  stepToggle.addEventListener("click", () => {
    showToolSteps = !showToolSteps;
    try { localStorage.setItem("slate_board_show_steps", showToolSteps ? "1" : "0"); } catch {}
    renderBoardView();
  });
  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.className = "board-view-collapse-btn";
  collapse.textContent = t("收起");
  collapse.title = t("收起模式区域");
  collapse.addEventListener("click", () => {
    boardViewCollapsed = true;
    setBoardView(currentBoardView, { preserveCollapse: true });
  });
  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.type = "button";
  fullscreenBtn.className = "board-view-collapse-btn" + (boardViewFullscreen ? " active" : "");
  fullscreenBtn.appendChild(iconSvgEl(boardViewFullscreen ? "minimize" : "maximize"));
  fullscreenBtn.title = t(boardViewFullscreen ? "退出全屏" : "全屏");
  fullscreenBtn.setAttribute("aria-pressed", boardViewFullscreen ? "true" : "false");
  fullscreenBtn.addEventListener("click", () => setBoardViewFullscreen(!boardViewFullscreen));
  const stopSlot = document.createElement("span");
  stopSlot.className = "board-view-header-stop";
  actions.append(meta, stepToggle, stopSlot, collapse, fullscreenBtn);
  header.append(titleGroup, actions);
  boardViewPanel.appendChild(header);
  mountBoardViewControls(modesSlot, stopSlot);
  if (currentBoardView === "git") {
    renderGitTreeView(meta);
    return;
  }
  // 工作流视图不依赖黑板卡片（它呈现 Action 与运行现场），必须排在"卡片为空"早退之前
  if (currentBoardView === "workflow") {
    renderWorkflowView(boardViewPanel, meta);
    return;
  }
  if (!cards.length) {
    const empty = document.createElement("div");
    empty.className = "board-view-empty";
    empty.textContent = allCards.length > 0
      ? t("当前仅有工具步骤卡，点击右上「显示工具步骤」查看")
      : t("黑板是空的，请先添加卡片");
    boardViewPanel.appendChild(empty);
    return;
  }
  if (currentBoardView === "flow") renderFlowView(cards);
  else if (currentBoardView === "kanban") renderKanbanView(cards);
  else if (currentBoardView === "outline") renderOutlineView(cards);
}

async function refreshGitGraph(force = false) {
  if (!state.project) {
    gitGraphState = { loading: false, data: null, error: "未打开项目", repo: "" };
    return;
  }
  if (gitGraphState.loading) return;
  if (!force && gitGraphState.data && gitGraphState.repo === state.project.path) return;
  gitGraphState = { ...gitGraphState, loading: true, error: "", repo: state.project.path };
  renderBoardView();
  try {
    const res = await get("/projects/git/graph");
    if (res.code !== 0) {
      gitGraphState = { loading: false, data: null, error: res.message || "Git 图谱读取失败", repo: state.project.path };
    } else {
      gitGraphState = { loading: false, data: res.data, error: "", repo: state.project.path };
    }
  } catch (e) {
    gitGraphState = { loading: false, data: null, error: e.message || "Git 图谱读取失败", repo: state.project.path };
  }
  renderBoardView();
}

function makeGitNodes(data) {
  const nodes = [];
  const edges = [];
  const branchByHash = new Map();

  const addNode = (node) => {
    if (!node?.id || nodes.some(existing => existing.id === node.id)) return;
    nodes.push(node);
  };
  const addEdge = (from, to, kind = "") => {
    if (from && to && from !== to) edges.push({ from, to, kind });
  };

  addNode({
    id: gitId("repo", data.repo),
    type: "repo",
    lane: "repo",
    title: data.repo?.split(/[\\/]/).pop() || "Repository",
    eyebrow: "REPOSITORY",
    body: data.repo || "",
    badge: data.current_branch || "HEAD",
  });
  addNode({
    id: gitId("head", data.head),
    type: "head",
    lane: "refs",
    title: `HEAD ${data.head || ""}`.trim(),
    eyebrow: "HEAD",
    body: data.upstream ? `${data.upstream} · ahead ${data.ahead || 0} / behind ${data.behind || 0}` : "no upstream",
    badge: data.current_branch || "detached",
  });
  addEdge(gitId("repo", data.repo), gitId("head", data.head), "contains");

  for (const branch of data.branches || []) {
    const id = gitId("branch", branch.name);
    addNode({
      id,
      type: branch.current ? "branch-current" : "branch",
      lane: "refs",
      title: branch.name,
      eyebrow: branch.current ? "CURRENT BRANCH" : "BRANCH",
      body: branch.upstream ? `${branch.upstream} ${branch.track || ""}`.trim() : "local branch",
      badge: branch.hash,
    });
    if (branch.hash) {
      const list = branchByHash.get(branch.hash) || [];
      list.push(id);
      branchByHash.set(branch.hash, list);
    }
    if (branch.current) addEdge(id, gitId("head", data.head), "points");
  }

  for (const branch of data.remote_branches || []) {
    const id = gitId("remote", branch.name);
    addNode({
      id,
      type: "remote",
      lane: "refs",
      title: branch.name,
      eyebrow: "REMOTE",
      body: "remote tracking branch",
      badge: branch.hash,
    });
    if (branch.hash) {
      const list = branchByHash.get(branch.hash) || [];
      list.push(id);
      branchByHash.set(branch.hash, list);
    }
  }

  for (const tag of data.tags || []) {
    const id = gitId("tag", tag.name);
    addNode({
      id,
      type: "tag",
      lane: "refs",
      title: tag.name,
      eyebrow: "TAG",
      body: tag.date || "tag",
      badge: tag.hash,
    });
    if (tag.hash) {
      const list = branchByHash.get(tag.hash) || [];
      list.push(id);
      branchByHash.set(tag.hash, list);
    }
  }

  Object.entries(data.remotes || {}).forEach(([name, urls]) => {
    addNode({
      id: gitId("remote-name", name),
      type: "remote",
      lane: "repo",
      title: name,
      eyebrow: "REMOTE ORIGIN",
      body: urls.fetch || urls.push || "",
      badge: "remote",
    });
    addEdge(gitId("repo", data.repo), gitId("remote-name", name), "remote");
  });

  for (const wt of data.worktrees || []) {
    const id = gitId("worktree", wt.path);
    addNode({
      id,
      type: wt.path === data.repo ? "worktree-current" : "worktree",
      lane: "worktree",
      title: wt.path?.split(/[\\/]/).pop() || "worktree",
      eyebrow: wt.path === data.repo ? "CURRENT WORKTREE" : "WORKTREE",
      body: wt.path || "",
      badge: wt.branch || wt.head || "detached",
    });
    addEdge(gitId("repo", data.repo), id, "worktree");
  }

  for (const stash of data.stashes || []) {
    const id = gitId("stash", stash.name);
    addNode({
      id,
      type: "stash",
      lane: "worktree",
      title: stash.subject,
      eyebrow: "STASH",
      body: `${stash.name} · ${stash.date}`,
      badge: stash.hash,
    });
    addEdge(gitId("head", data.head), id, "stash");
  }

  const statusGroups = [
    ["staged", "暂存区", "STAGED", data.status?.staged || []],
    ["unstaged", "工作区变更", "CHANGES", data.status?.unstaged || []],
    ["untracked", "未跟踪", "UNTRACKED", data.status?.untracked || []],
  ];
  for (const [kind, title, eyebrow, files] of statusGroups) {
    const groupId = gitId(kind, "group");
    addNode({
      id: groupId,
      type: kind,
      lane: "worktree",
      title,
      eyebrow,
      body: files.length ? `${files.length} 个文件` : "无变更",
      badge: String(files.length),
    });
    addEdge(gitId("head", data.head), groupId, "status");
  }

  for (const commit of data.unpushed || []) {
    const id = gitId("unpushed", commit.hash);
    addNode({
      id,
      type: "unpushed",
      lane: "unpushed",
      title: commit.subject,
      eyebrow: "UNPUSHED COMMIT",
      body: `${commit.author} · ${commit.date}`,
      badge: commit.hash,
    });
    addEdge(gitId("head", data.head), id, "ahead");
  }

  for (const commit of (data.commits || []).slice(0, 28)) {
    const id = gitId("commit", commit.hash);
    addNode({
      id,
      type: "commit",
      lane: "commits",
      title: commit.subject,
      eyebrow: commit.refs || "COMMIT",
      body: `${commit.author} · ${commit.date}`,
      badge: commit.hash,
    });
    for (const refId of branchByHash.get(commit.hash) || []) addEdge(refId, id, "ref");
    for (const parent of commit.parents || []) addEdge(id, gitId("commit", parent), "parent");
  }

  return { nodes, edges };
}

function defaultGitNodePosition(node, index) {
  const lanes = { repo: 0, refs: 1, worktree: 2, unpushed: 3, commits: 4 };
  const lane = lanes[node.lane] ?? 0;
  const laneCounts = defaultGitNodePosition._laneCounts || (defaultGitNodePosition._laneCounts = {});
  const row = laneCounts[node.lane] || 0;
  laneCounts[node.lane] = row + 1;
  const offset = node.compact ? 84 : 118;
  return {
    x: 28 + lane * 280,
    y: 28 + row * offset + (lane % 2) * 20 + Math.floor(index / 18) * 28,
  };
}

function renderGitTreeView(metaEl) {
  if (metaEl) metaEl.textContent = gitGraphState.loading ? "Git 读取中" : "";
  if (!state.project) {
    const empty = document.createElement("div");
    empty.className = "board-view-empty";
    empty.textContent = t("未打开项目");
    boardViewPanel.appendChild(empty);
    return;
  }
  if (!gitGraphState.data && !gitGraphState.error) {
    refreshGitGraph();
    return;
  }

  const toolbar = document.createElement("div");
  toolbar.className = "board-git-toolbar";
  const status = document.createElement("div");
  status.className = "board-git-status";
  const actions = document.createElement("div");
  actions.className = "board-git-actions";
  const focus = document.createElement("button");
  focus.type = "button";
  focus.className = "board-git-refresh";
  focus.textContent = "聚焦 HEAD";
  focus.disabled = gitGraphState.loading || !!gitGraphState.error || !gitGraphState.data;
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "board-git-refresh";
  reset.textContent = "重置布局";
  reset.disabled = gitGraphState.loading || !!gitGraphState.error || !gitGraphState.data;
  reset.addEventListener("click", () => {
    resetGitNodePositions();
    renderBoardView();
  });
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "board-git-refresh";
  refresh.textContent = "刷新";
  refresh.disabled = gitGraphState.loading;
  refresh.addEventListener("click", () => refreshGitGraph(true));
  actions.append(focus, reset, refresh);
  toolbar.append(status, actions);
  boardViewPanel.appendChild(toolbar);

  if (gitGraphState.loading) {
    status.textContent = "正在读取 Git 状态…";
    return;
  }
  if (gitGraphState.error) {
    status.textContent = gitGraphState.error;
    return;
  }

  const data = gitGraphState.data;
  const { nodes, edges } = makeGitNodes(data);
  if (metaEl) metaEl.textContent = `${nodes.length} 个 Git 节点`;
  status.innerHTML = "";
  [
    `${data.current_branch || "HEAD"} @ ${data.head || ""}`,
    `ahead ${data.ahead || 0}`,
    `behind ${data.behind || 0}`,
    `staged ${data.status?.staged?.length || 0}`,
    `changed ${(data.status?.unstaged?.length || 0) + (data.status?.untracked?.length || 0)}`,
  ].forEach(text => {
    const chip = document.createElement("span");
    chip.className = "board-git-chip";
    chip.textContent = text;
    status.appendChild(chip);
  });

  defaultGitNodePosition._laneCounts = {};
  const wrap = document.createElement("div");
  wrap.className = "board-git-graph";
  wrap.title = t("按住空白区域拖动视野");
  const layer = document.createElement("div");
  layer.className = "board-git-layer";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "board-git-edges");
  layer.appendChild(svg);

  const positions = new Map();
  nodes.forEach((node, index) => {
    const pos = getGitNodePosition(node, defaultGitNodePosition(node, index));
    positions.set(node.id, pos);
    const el = document.createElement("div");
    el.className = `board-git-card board-git-type-${node.type}`;
    if (node.compact) el.classList.add("compact");
    el.dataset.gitNodeId = node.id;
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;

    const eyebrow = document.createElement("div");
    eyebrow.className = "board-git-eyebrow";
    eyebrow.textContent = node.eyebrow || node.type;
    const title = document.createElement("div");
    title.className = "board-git-title";
    title.textContent = node.title || node.id;
    const body = document.createElement("div");
    body.className = "board-git-body";
    body.textContent = node.body || "";
    const badge = document.createElement("span");
    badge.className = "board-git-badge";
    badge.textContent = node.badge || "";
    el.append(eyebrow, title);
    if (node.body) el.appendChild(body);
    if (node.badge) el.appendChild(badge);

    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      activeGitNodeDrag = {
        id: node.id,
        pointerX: e.clientX,
        pointerY: e.clientY,
        startX: parseFloat(el.style.left) || 0,
        startY: parseFloat(el.style.top) || 0,
        moved: false,
      };
      el.classList.add("dragging");
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!activeGitNodeDrag || activeGitNodeDrag.id !== node.id) return;
      const dx = e.clientX - activeGitNodeDrag.pointerX;
      const dy = e.clientY - activeGitNodeDrag.pointerY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) activeGitNodeDrag.moved = true;
      el.style.left = `${Math.max(12, Math.round(activeGitNodeDrag.startX + dx))}px`;
      el.style.top = `${Math.max(12, Math.round(activeGitNodeDrag.startY + dy))}px`;
      drawGitEdges(layer, svg, edges);
    });
    const finish = (e) => {
      if (!activeGitNodeDrag || activeGitNodeDrag.id !== node.id) return;
      activeGitNodeDrag = null;
      el.classList.remove("dragging");
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      setGitNodePosition(node.id, parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0);
      drawGitEdges(layer, svg, edges);
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
    layer.appendChild(el);
  });

  const maxX = maxOf([...positions.values()].map(p => p.x), 900) + 260;
  const maxY = maxOf([...positions.values()].map(p => p.y), 520) + 150;
  layer.style.width = `${maxX}px`;
  layer.style.height = `${maxY}px`;
  svg.setAttribute("width", String(maxX));
  svg.setAttribute("height", String(maxY));
  wrap.appendChild(layer);
  boardViewPanel.appendChild(wrap);
  applyGitGraphPan(layer);
  setupGitGraphPan(wrap, layer);
  focus.disabled = false;
  focus.addEventListener("click", () => centerGitNode(wrap, layer, gitId("head", data.head)));
  requestAnimationFrame(() => drawGitEdges(layer, svg, edges));
}

function applyGitGraphPan(layer) {
  layer.style.transform = `translate(${Math.round(gitGraphPan.x)}px, ${Math.round(gitGraphPan.y)}px)`;
}

function clampGitGraphPan(wrap, layer, x, y) {
  const margin = 90;
  const viewW = wrap.clientWidth || 0;
  const viewH = wrap.clientHeight || 0;
  const layerW = layer.offsetWidth || viewW;
  const layerH = layer.offsetHeight || viewH;
  return {
    x: Math.min(margin, Math.max(viewW - layerW - margin, x)),
    y: Math.min(margin, Math.max(viewH - layerH - margin, y)),
  };
}

function centerGitNode(wrap, layer, nodeId) {
  const node = layer.querySelector(`[data-git-node-id="${nodeId}"]`);
  if (!node) return;
  gitGraphPan = clampGitGraphPan(
    wrap,
    layer,
    (wrap.clientWidth || 0) / 2 - (node.offsetLeft + node.offsetWidth / 2),
    (wrap.clientHeight || 0) / 2 - (node.offsetTop + node.offsetHeight / 2),
  );
  applyGitGraphPan(layer);
}

function setupGitGraphPan(wrap, layer) {
  wrap.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".board-git-card, button, a, input, textarea, select")) return;
    e.preventDefault();
    activeGitPan = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      startX: gitGraphPan.x,
      startY: gitGraphPan.y,
    };
    wrap.classList.add("panning");
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!activeGitPan) return;
    e.preventDefault();
    gitGraphPan = clampGitGraphPan(
      wrap,
      layer,
      activeGitPan.startX + (e.clientX - activeGitPan.pointerX),
      activeGitPan.startY + (e.clientY - activeGitPan.pointerY),
    );
    applyGitGraphPan(layer);
  });
  const finish = (e) => {
    if (!activeGitPan) return;
    activeGitPan = null;
    wrap.classList.remove("panning");
    try { wrap.releasePointerCapture(e.pointerId); } catch (err) {}
  };
  wrap.addEventListener("pointerup", finish);
  wrap.addEventListener("pointercancel", finish);
}

function drawGitEdges(layer, svg, edges) {
  if (!layer || !svg) return;
  svg.innerHTML = "";
  const rect = layer.getBoundingClientRect();
  for (const edge of edges) {
    const from = layer.querySelector(`[data-git-node-id="${edge.from}"]`);
    const to = layer.querySelector(`[data-git-node-id="${edge.to}"]`);
    if (!from || !to) continue;
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const x1 = a.left - rect.left + a.width;
    const y1 = a.top - rect.top + a.height / 2;
    const x2 = b.left - rect.left;
    const y2 = b.top - rect.top + b.height / 2;
    const mid = Math.max(24, Math.abs(x2 - x1) * 0.45);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`);
    path.setAttribute("class", `board-git-edge board-git-edge-${edge.kind || "link"}`);
    svg.appendChild(path);
  }
}

function renderFlowView(cards) {
  const { incoming, outgoing, columns } = buildFlowLevels(cards);
  const actionBar = document.createElement("div");
  actionBar.className = "board-view-actionbar";
  actionBar.append(
    makeViewIconButton("排布", t("按流程层级重新排布画布卡片"), () => {
      autoLayoutCards();
      dlgToast(t("已按流程排布画布卡片"));
    }),
    makeViewIconButton("根卡", t("创建一个新的流程起点"), () => createBoardCard({ title: t("新流程起点"), color: "blue" })),
  );
  boardViewPanel.appendChild(actionBar);

  const wrap = document.createElement("div");
  wrap.className = "board-flow-view";
  for (const [level, levelCards] of columns) {
    const lane = document.createElement("div");
    lane.className = "board-flow-lane";
    const head = document.createElement("div");
    head.className = "board-flow-lane-head";
    head.textContent = `${t("阶段")} ${level + 1} (${levelCards.length})`;
    lane.appendChild(head);
    for (const card of levelCards) {
      const inbound = incoming.get(card.id)?.length || 0;
      const outbound = outgoing.get(card.id)?.length || 0;
      const item = makeCardActionRow(card, [
        { text: "+", title: t("添加后续卡片"), onClick: () => addChildCard(card) },
        { text: "编", title: t("编辑卡片"), onClick: () => openCardModal(card) },
      ]);
      const meta = document.createElement("div");
      meta.className = "board-flow-meta";
      meta.textContent = `${t("输入")} ${inbound} · ${t("输出")} ${outbound}`;
      item.appendChild(meta);
      lane.appendChild(item);
    }
    wrap.appendChild(lane);
  }
  if ([...incoming.values()].some(list => list.length > 1)) {
    const hint = document.createElement("div");
    hint.className = "board-view-hint";
    hint.textContent = t("存在合流节点，双击卡片可编辑连接关系。");
    wrap.appendChild(hint);
  }
  boardViewPanel.appendChild(wrap);
}

function renderKanbanView(cards) {
  const actionBar = document.createElement("div");
  actionBar.className = "board-view-actionbar";
  actionBar.append(
    makeViewIconButton(t("新增"), t("在未分类列新增卡片"), () => createBoardCard({ title: t("新卡片"), color: "default" })),
    makeViewIconButton(t("排布"), t("把看板列同步排布到画布"), () => {
      const columnIndex = new Map(KANBAN_COLORS.map((color, index) => [color, index]));
      const rowCounts = new Map();
      const nextCards = cards.map(card => {
        const color = card.color || "default";
        const col = columnIndex.get(color) ?? columnIndex.get("default");
        const row = rowCounts.get(color) || 0;
        rowCounts.set(color, row + 1);
        return {
          ...card,
          x: CARD_LAYOUT.startX + col * (CARD_LAYOUT.width + 60),
          y: CARD_LAYOUT.startY + row * (118 + CARD_LAYOUT.gapY),
        };
      });
      setBoardCards(nextCards);
      dlgToast(t("已按看板列排布画布卡片"));
    }),
  );
  boardViewPanel.appendChild(actionBar);

  const wrap = document.createElement("div");
  wrap.className = "board-kanban-view";
  for (const color of KANBAN_COLORS) {
    const colCards = cards.filter(card => (card.color || "default") === color);
    const col = document.createElement("div");
    col.className = `board-kanban-col board-view-color-${color}`;
    col.dataset.color = color;
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const cardId = e.dataTransfer.getData("text/plain");
      if (cardId) moveCardToColor(cardId, color);
    });

    const head = document.createElement("div");
    head.className = "board-kanban-head";
    const title = document.createElement("span");
    title.textContent = `${t(COLOR_META[color].label)} (${colCards.length})`;
    const add = makeViewIconButton("+", t("在此列新增卡片"), () => createBoardCard({ title: t(COLOR_META[color].label), color }));
    head.append(title, add);
    col.appendChild(head);
    colCards.forEach(card => {
      const item = makeCardActionRow(card, [
        { text: "编", title: t("编辑卡片"), onClick: () => openCardModal(card) },
      ]);
      const cardBtn = item.querySelector(".board-view-card");
      cardBtn.draggable = true;
      cardBtn.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
        item.classList.add("dragging");
      });
      cardBtn.addEventListener("dragend", () => item.classList.remove("dragging"));
      col.appendChild(item);
    });
    wrap.appendChild(col);
  }
  boardViewPanel.appendChild(wrap);
}

function renderOutlineView(cards) {
  const { outgoing, roots, cardMap } = buildBoardGraph(cards);
  const actionBar = document.createElement("div");
  actionBar.className = "board-view-actionbar";
  actionBar.append(
    makeViewIconButton("全部展开", t("展开所有纲要节点"), () => {
      boardOutlineCollapsed.clear();
      saveOutlineCollapsed();
      renderBoardView();
    }),
    makeViewIconButton("全部折叠", t("折叠所有有子项的节点"), () => {
      for (const card of cards) {
        if ((outgoing.get(card.id) || []).length) boardOutlineCollapsed.add(card.id);
      }
      saveOutlineCollapsed();
      renderBoardView();
    }),
    makeViewIconButton("根卡", t("新增顶层纲要卡片"), () => createBoardCard({ title: t("新顶层卡片"), color: "blue" })),
  );
  boardViewPanel.appendChild(actionBar);

  const seen = new Set();
  const makeList = (items, depth = 0, parentId = "") => {
    const ul = document.createElement("ul");
    ul.className = depth === 0 ? "board-outline-root" : "board-outline-children";
    for (const card of items) {
      if (!card || seen.has(card.id)) continue;
      seen.add(card.id);
      const li = document.createElement("li");
      const children = (outgoing.get(card.id) || []).map(id => cardMap.get(id)).filter(Boolean);
      li.className = children.length ? "has-children" : "";
      const collapsed = boardOutlineCollapsed.has(card.id);
      const row = document.createElement("div");
      row.className = "board-outline-row";
      if (children.length) {
        row.appendChild(makeViewIconButton(collapsed ? "+" : "-", collapsed ? t("展开") : t("折叠"), () => {
          if (boardOutlineCollapsed.has(card.id)) boardOutlineCollapsed.delete(card.id);
          else boardOutlineCollapsed.add(card.id);
          saveOutlineCollapsed();
          renderBoardView();
        }));
      } else {
        const spacer = document.createElement("span");
        spacer.className = "board-outline-spacer";
        row.appendChild(spacer);
      }
      row.appendChild(makeCardActionRow(card, [
        { text: "+", title: t("添加子卡片"), onClick: () => addChildCard(card) },
        { text: "编", title: t("编辑卡片"), onClick: () => openCardModal(card) },
        ...(parentId ? [{ text: "断", title: t("断开与父卡片的连接"), onClick: () => removeCardLink(parentId, card.id) }] : []),
      ]));
      li.appendChild(row);
      if (children.length && !collapsed) li.appendChild(makeList(children, depth + 1, card.id));
      ul.appendChild(li);
    }
    return ul;
  };
  boardViewPanel.appendChild(makeList(roots));
  const orphans = cards.filter(card => !seen.has(card.id));
  if (orphans.length) {
    const h = document.createElement("div");
    h.className = "board-view-hint";
    h.textContent = t("未连接卡片");
    boardViewPanel.appendChild(h);
    boardViewPanel.appendChild(makeList(orphans));
  }
}

function setBoardView(view, options = {}) {
  const nextView = BOARD_VIEW_LABELS[view] ? view : "";
  if (!options.preserveCollapse || !nextView) boardViewCollapsed = false;
  currentBoardView = nextView;
  if (!nextView || boardViewCollapsed) setBoardViewFullscreen(false, { skipRender: true });
  const mainBoardMode = !currentBoardView;
  const showCanvas = mainBoardMode || boardViewCollapsed;
  boardCanvas?.classList.toggle("hidden", !showCanvas);
  boardViewPanel?.classList.toggle("hidden", mainBoardMode);
  boardViewPanel?.classList.toggle("collapsed", boardViewCollapsed && !mainBoardMode);
  boardViewPanel?.classList.toggle("git-mode", currentBoardView === "git" && !mainBoardMode && !boardViewCollapsed);
  document.querySelectorAll(".board-view-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === currentBoardView);
  });
  // 工作流视图每秒只 patch 自己的活层；离开或收起就立刻停表，不在背后空转
  if (currentBoardView === "workflow" && !boardViewCollapsed) startWorkflowTick();
  else stopWorkflowTick();
  if (showCanvas) {
    renderAllCards();
    renderNotes();
    redrawStrokes();
  }
  if (!mainBoardMode) {
    clearSelection();
    renderBoardView();
  } else if (boardViewPanel) {
    boardViewPanel.innerHTML = "";
  }
}

function refreshWhiteboard() {
  if (!boardCanvas) return;
  resizeDrawCanvas();
  updateBoardLayerSize();
  // 切标签页等触发场景不强制重置：保留当前视图与折叠状态
  setBoardView(currentBoardView, { preserveCollapse: true });
}

function renderCard(card) {
  const el = document.createElement("div");
  el.className = "board-card";
  if (selectedCardIds.has(card.id)) el.classList.add("selected");
  el.draggable = false;
  el.dataset.cardId = card.id;
  el.style.left = `${Number(card.x) || 0}px`;
  el.style.top = `${Number(card.y) || 0}px`;

  // 应用颜色
  const color = CARD_COLORS.find(c => c.id === card.color) || CARD_COLORS[0];
  el.style.background = color.bg;
  el.style.borderColor = color.border;

  const title = document.createElement("div");
  title.className = "board-card-title";
  title.textContent = card.title;
  el.appendChild(title);

  if (card.body) {
    const body = document.createElement("div");
    body.className = "board-card-body";
    body.textContent = card.body;
    el.appendChild(body);
  }

  if (card.arrows && card.arrows.length > 0) {
    const arrow = document.createElement("div");
    arrow.className = "board-card-arrow";
    arrow.textContent = `${card.arrows.join(", ")}`;
    el.appendChild(arrow);
  }

  // 删除按钮
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "board-card-delete";
  deleteBtn.textContent = "×";
  deleteBtn.title = t("删除卡片");
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (await dlgConfirm(t('删除卡片 "{title}"？', { title: card.title }), { danger: true, okText: "删除" })) {
      const cards = state.boardCards
        .filter(c => c.id !== card.id)
        .map(c => ({ ...c, arrows: (c.arrows || []).filter(id => id !== card.id) }));
      setBoardCards(cards);
    }
  });
  el.appendChild(deleteBtn);

  el.addEventListener("click", (e) => {
    if (currentToolMode !== "connect") return;
    e.stopPropagation();
    handleConnectCard(card.id);
  });

  // 双击编辑
  el.addEventListener("dblclick", () => {
    if (currentToolMode === "select") openCardModal(card);
  });

  el.addEventListener("pointerdown", (e) => {
    if (currentToolMode !== "select") return;
    if (e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    selectCard(card.id, e);
    const dragIds = selectedCardIds.has(card.id) ? [...selectedCardIds] : [card.id];
    const starts = new Map(state.boardCards
      .filter(c => dragIds.includes(c.id))
      .map(c => [c.id, { x: Number(c.x) || 0, y: Number(c.y) || 0 }]));
    activeCardDrag = {
      id: card.id,
      ids: dragIds,
      starts,
      startX: Number(card.x) || 0,
      startY: Number(card.y) || 0,
      pointerX: e.clientX,
      pointerY: e.clientY,
      moved: false,
    };
    el.classList.add("dragging");
    for (const id of dragIds) {
      boardCards.querySelector(`[data-card-id="${id}"]`)?.classList.add("dragging");
    }
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener("pointermove", (e) => {
    if (!activeCardDrag || activeCardDrag.id !== card.id) return;
    e.preventDefault();
    const dx = e.clientX - activeCardDrag.pointerX;
    const dy = e.clientY - activeCardDrag.pointerY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) activeCardDrag.moved = true;
    for (const id of activeCardDrag.ids || [card.id]) {
      const start = activeCardDrag.starts?.get(id) || { x: activeCardDrag.startX, y: activeCardDrag.startY };
      const node = boardCards.querySelector(`[data-card-id="${id}"]`);
      if (!node) continue;
      node.style.left = `${Math.max(0, Math.round(start.x + dx))}px`;
      node.style.top = `${Math.max(0, Math.round(start.y + dy))}px`;
    }
    drawArrows();
  });

  const finishDrag = (e) => {
    if (!activeCardDrag || activeCardDrag.id !== card.id) return;
    const drag = activeCardDrag;
    activeCardDrag = null;
    boardCards.querySelectorAll(".board-card.dragging").forEach(node => node.classList.remove("dragging"));
    try { el.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!drag.moved) return;
    suppressCardClickUntil = Date.now() + 250;
    const updates = (drag.ids || [card.id]).map(id => {
      const node = boardCards.querySelector(`[data-card-id="${id}"]`);
      return { id, x: parseFloat(node?.style.left) || 0, y: parseFloat(node?.style.top) || 0 };
    });
    updateCardPositions(updates);
  };
  el.addEventListener("pointerup", finishDrag);
  el.addEventListener("pointercancel", finishDrag);
  el.addEventListener("click", (e) => {
    if (Date.now() < suppressCardClickUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  return el;
}

function renderAllCards() {
  const cards = normalizeBoardCardsLayout();
  if (cards !== state.boardCards) return;
  updateBoardLayerSize(cards);
  boardCards.innerHTML = "";
  svgOverlay = null;
  if (cards.length === 0) {
    boardEmpty.style.display = "";
    return;
  }
  boardEmpty.style.display = "none";
  for (const card of cards) {
    boardCards.appendChild(renderCard(card));
  }
  renderSelection();
  // 绘制箭头（延迟确定DOM 已更新）
  setTimeout(drawArrows, 50);
}

// ─ SVG 箭头绘制 ─────────────────────────────

function initSvgOverlay() {
  if (svgOverlay) return;
  svgOverlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgOverlay.setAttribute("class", "board-svg-layer board-svg-overlay");
  boardCards.insertBefore(svgOverlay, boardCards.firstChild);
}

function drawArrows() {
  if (!svgOverlay) initSvgOverlay();
  if (!svgOverlay) return;

  // 清空旧箭头
  svgOverlay.innerHTML = "";


  const containerRect = boardCards.getBoundingClientRect();
  const cards = state.boardCards;

  for (const card of cards) {
    if (!card.arrows || card.arrows.length === 0) continue;

    const fromEl = boardCards.querySelector(`[data-card-id="${card.id}"]`);
    if (!fromEl) continue;

    for (const targetId of card.arrows) {
      const toEl = boardCards.querySelector(`[data-card-id="${targetId}"]`);
      if (!toEl) continue;

      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();

      // 计算连接点（从卡片右侧中心到目标卡片左侧中心）
      const x1 = fromRect.right - containerRect.left;

      const y1 = fromRect.top + fromRect.height / 2 - containerRect.top;
      const x2 = toRect.left - containerRect.left;
      const y2 = toRect.top + toRect.height / 2 - containerRect.top;

      // 绘制贝塞尔曲线
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");

      const midX = (x1 + x2) / 2;
      const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "var(--text-muted)");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("marker-end", "url(#arrowhead)");
      svgOverlay.appendChild(path);
    }
  }

  // 添加箭头标记定义
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="var(--text-muted)" />
    </marker>
  `;
  svgOverlay.insertBefore(defs, svgOverlay.firstChild);
}

// ── 工具模式 ───────────────────────────────────

// 视图栏（看板/流程等）展开时选择工具：自动收起视图栏，回到画布操作
function ensureCanvasVisible() {
  if (!boardViewPanel || boardViewPanel.classList.contains("hidden") || boardViewPanel.classList.contains("collapsed")) return;
  boardViewCollapsed = true;
  setBoardView(currentBoardView, { preserveCollapse: true });
}

function setToolMode(mode) {
  ensureCanvasVisible();
  currentToolMode = mode || "select";
  connectSourceId = null;
  document.querySelectorAll(".board-tool-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === currentToolMode);
  });
  if (boardCanvas) {
    boardCanvas.classList.remove("mode-select", "mode-connect", "mode-draw", "mode-text");
    boardCanvas.classList.add(`mode-${currentToolMode}`);
  }
  if (drawCanvas) {
    drawCanvas.classList.toggle("drawing", currentToolMode === "draw");
  }
  renderAllCards();
}

function getBoardPoint(e, target = boardCanvas) {
  const rect = target.getBoundingClientRect();
  return {
    x: e.clientX - rect.left + (target === boardCanvas ? boardCanvas.scrollLeft : 0),
    y: e.clientY - rect.top + (target === boardCanvas ? boardCanvas.scrollTop : 0),
  };
}

function setupBoardTools() {
  document.querySelectorAll(".board-tool-btn").forEach(btn => {
    btn.addEventListener("click", () => setToolMode(btn.dataset.mode || "select"));
  });
  document.getElementById("btn-undo-stroke")?.addEventListener("click", () => { ensureCanvasVisible(); undoStroke(); });
  document.getElementById("btn-clear-strokes")?.addEventListener("click", () => { ensureCanvasVisible(); clearStrokesAndNotes(); });
  setToolMode(currentToolMode);
}

function handleConnectCard(cardId) {
  if (!connectSourceId) {
    connectSourceId = cardId;
    boardCards.querySelectorAll(".board-card").forEach(el => {
      el.classList.toggle("connect-source", el.dataset.cardId === cardId);
    });
    return;
  }
  if (connectSourceId === cardId) {
    connectSourceId = null;
    renderAllCards();
    return;
  }
  const cards = state.boardCards.map(card => {
    if (card.id !== connectSourceId) return card;
    const arrows = Array.isArray(card.arrows) ? [...card.arrows] : [];
    if (!arrows.includes(cardId)) arrows.push(cardId);
    return { ...card, arrows };
  });
  connectSourceId = null;
  setBoardCards(cards);
}

function resizeDrawCanvas() {
  if (!drawCanvas || !boardCanvas) return;
  const rect = boardCanvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const cssWidth = Math.max(rect.width, boardCanvas.scrollWidth || rect.width);
  const cssHeight = Math.max(rect.height, boardCanvas.scrollHeight || rect.height);
  const width = Math.max(1, Math.round(cssWidth * scale));
  const height = Math.max(1, Math.round(cssHeight * scale));
  if (drawCanvas.width !== width || drawCanvas.height !== height) {
    drawCanvas.width = width;
    drawCanvas.height = height;
    drawCanvas.style.width = `${cssWidth}px`;
    drawCanvas.style.height = `${cssHeight}px`;
  }
  drawCtx = drawCanvas.getContext("2d");
  drawCtx.setTransform(scale, 0, 0, scale, 0, 0);
  redrawStrokes();
}

function redrawStrokes() {
  if (!drawCtx || !drawCanvas) return;
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  for (const stroke of strokes) drawStroke(stroke);
  if (currentStroke) drawStroke(currentStroke);
}

function drawStroke(stroke) {
  if (!drawCtx || !stroke?.points?.length) return;
  drawCtx.save();
  drawCtx.strokeStyle = stroke.color || "#1A1A1A";
  drawCtx.lineWidth = stroke.width || 2;
  drawCtx.lineCap = "round";
  drawCtx.lineJoin = "round";
  drawCtx.beginPath();
  stroke.points.forEach((point, index) => {
    if (index === 0) drawCtx.moveTo(point.x, point.y);
    else drawCtx.lineTo(point.x, point.y);
  });
  drawCtx.stroke();
  drawCtx.restore();
}

function setupDrawing() {
  if (!drawCanvas) return;
  drawCanvas.addEventListener("pointerdown", (e) => {
    if (currentToolMode !== "draw") return;
    e.preventDefault();
    drawCanvas.setPointerCapture(e.pointerId);
    currentStroke = {
      color: getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#1A1A1A",
      width: 2,
      points: [getBoardPoint(e, drawCanvas)],
    };
    redrawStrokes();
  });
  drawCanvas.addEventListener("pointermove", (e) => {
    if (!currentStroke) return;
    const point = getBoardPoint(e, drawCanvas);
    const last = currentStroke.points[currentStroke.points.length - 1];
    // 亚像素抖动不入栈：高频笔/鼠标会灌进大量近似重复点，既拖慢重绘又让笔迹存档无界增长
    if (last && Math.abs(point.x - last.x) < 0.5 && Math.abs(point.y - last.y) < 0.5) return;
    currentStroke.points.push(point);
    redrawStrokes();
  });
  const endStroke = (e) => {
    if (!currentStroke) return;
    if (currentStroke.points.length > 1) {
      strokes.push(currentStroke);
      setBoardStrokes(strokes);
    }
    currentStroke = null;
    try { drawCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
    redrawStrokes();
  };
  drawCanvas.addEventListener("pointerup", endStroke);
  drawCanvas.addEventListener("pointercancel", endStroke);
}

function undoStroke() {
  if (strokes.length > 0) {
    strokes.pop();
    setBoardStrokes(strokes);
    redrawStrokes();
  }
}

function clearStrokesAndNotes() {
  strokes = [];
  currentStroke = null;
  setBoardStrokes([]);
  setBoardNotes([]);
  redrawStrokes();
}

function renderNotes() {
  if (!notesLayer) return;
  notesLayer.innerHTML = "";
  for (const note of state.boardNotes || []) {
    const wrap = document.createElement("div");
    wrap.className = "board-note-wrap";
    wrap.dataset.noteId = note.id;
    wrap.style.left = `${Number(note.x) || 0}px`;
    wrap.style.top = `${Number(note.y) || 0}px`;
    wrap.style.width = `${Math.max(90, Number(note.width) || 180)}px`;

    const textarea = document.createElement("textarea");
    textarea.className = "board-note";
    textarea.value = note.text || "";
    textarea.rows = 1;
    textarea.placeholder = t("输入文字");
    const autosize = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.max(28, textarea.scrollHeight)}px`;
    };
    textarea.addEventListener("input", () => {
      autosize();
      updateNote(note.id, { text: textarea.value }, { silent: true });
    });
    textarea.addEventListener("blur", () => {
      if (!textarea.value.trim()) removeNote(note.id);
      else updateNote(note.id, { text: textarea.value });
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") textarea.blur();
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") textarea.blur();
    });
    wrap.appendChild(textarea);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "board-note-delete";
    deleteBtn.textContent = "×";
    deleteBtn.title = t("删除");
    deleteBtn.addEventListener("click", () => removeNote(note.id));
    wrap.appendChild(deleteBtn);

    let drag = null;
    wrap.addEventListener("pointerdown", (e) => {
      if (e.target === textarea || e.target.closest("button")) return;
      e.preventDefault();
      drag = {
        pointerId: e.pointerId,
        startX: Number(note.x) || 0,
        startY: Number(note.y) || 0,
        pointerX: e.clientX,
        pointerY: e.clientY,
      };
      wrap.classList.add("dragging");
      wrap.setPointerCapture(e.pointerId);
    });
    wrap.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const x = Math.max(0, Math.round(drag.startX + e.clientX - drag.pointerX));
      const y = Math.max(0, Math.round(drag.startY + e.clientY - drag.pointerY));
      wrap.style.left = `${x}px`;
      wrap.style.top = `${y}px`;
    });
    const finish = (e) => {
      if (!drag) return;
      drag = null;
      wrap.classList.remove("dragging");
      try { wrap.releasePointerCapture(e.pointerId); } catch (err) {}
      updateNote(note.id, { x: parseFloat(wrap.style.left) || 0, y: parseFloat(wrap.style.top) || 0 });
    };
    wrap.addEventListener("pointerup", finish);
    wrap.addEventListener("pointercancel", finish);

    notesLayer.appendChild(wrap);
    requestAnimationFrame(autosize);
  }
  updateBoardLayerSize();
}

function updateNote(id, patch, options = {}) {
  const notes = (state.boardNotes || []).map(note => note.id === id ? { ...note, ...patch } : note);
  if (options.silent) {
    state.boardNotes = notes;
    return;
  }
  setBoardNotes(notes);
}

function removeNote(id) {
  setBoardNotes((state.boardNotes || []).filter(note => note.id !== id));
}

function addNoteAt(x, y) {
  const note = {
    id: makeId("note_"),
    text: "",
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: 190,
  };
  setBoardNotes([...(state.boardNotes || []), note]);
  requestAnimationFrame(() => {
    const node = notesLayer?.querySelector(`[data-note-id="${note.id}"] textarea`);
    node?.focus();
  });
}

function setupTextNotes() {
  if (!boardCanvas || !notesLayer) return;
  boardCanvas.addEventListener("click", (e) => {
    if (currentToolMode !== "text") return;
    if (e.target.closest(".board-card, .board-note-wrap, .board-note, button")) return;
    const point = getBoardPoint(e);
    addNoteAt(point.x, point.y);
  });
}

// ── 拖拽排序 ─────────────────────────────────

function setupDragDrop() {
  boardCards.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });

  boardCards.addEventListener("drop", (e) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData("text/plain");
    const cards = [...state.boardCards];
    const dragIdx = cards.findIndex(c => c.id === draggedId);
    if (dragIdx === -1) return;

    const target = e.target.closest(".board-card");
    const [dragged] = cards.splice(dragIdx, 1);

    if (target && target.dataset.cardId !== draggedId) {
      const targetIdx = cards.findIndex(c => c.id === target.dataset.cardId);
      cards.splice(targetIdx, 0, dragged);
    } else {
      cards.push(dragged);
    }

    setBoardCards(cards);
  });
}

// ── 卡片模态框 ───────────────────────────────

function openCardModal(card = null) {
  editingCardId = card?.id || null;
  cardModalTitle.textContent = card ? t("编辑卡片") : t("添加卡片");
  cardInputTitle.value = card?.title || "";
  cardInputBody.value = card?.body || "";
  cardInputArrows.value = card?.arrows?.join(", ") || "";
  selectedColor = card?.color || "default";
  renderColorOptions();

  // 删除按钮只在编辑时显示
  btnCardDelete.style.display = card ? "" : "none";

  cardModal.classList.remove("hidden");
  cardInputTitle.focus();
}

function closeCardModal() {
  cardModal.classList.add("hidden");
  editingCardId = null;
}

function saveCard() {
  const title = cardInputTitle.value.trim();
  if (!title) {
    dlgToast(t("请输入标题"));
    return;
  }

  const body = cardInputBody.value.trim();
  const arrowsStr = cardInputArrows.value.trim();
  const arrows = arrowsStr ? arrowsStr.split(",").map(s => s.trim()).filter(Boolean) : [];

  if (editingCardId) {
    // 更新现有卡片
    const cards = state.boardCards.map(c =>
      c.id === editingCardId
        ? { ...c, title, body, arrows, color: selectedColor }
        : c
    );
    setBoardCards(cards);
  } else {
    // 添加新卡片
    const card = placeNewCard({

      id: `c${Date.now().toString(36)}`,
      title,
      body,
      arrows,
      color: selectedColor,
    });
    addBoardCard(card);
  }

  closeCardModal();
}

async function deleteCard() {
  if (!editingCardId) return;
  if (!await dlgConfirm(t("确认删除此卡片？"), { danger: true, okText: t("删除") })) return;

  const cards = state.boardCards
    .filter(c => c.id !== editingCardId)
    .map(c => ({ ...c, arrows: (c.arrows || []).filter(id => id !== editingCardId) }));
  setBoardCards(cards);
  closeCardModal();
}

function deleteSelectedCards() {
  if (!selectedCardIds.size) return false;
  const selected = new Set(selectedCardIds);
  const cards = state.boardCards
    .filter(card => !selected.has(card.id))
    .map(card => ({ ...card, arrows: (card.arrows || []).filter(id => !selected.has(id)) }));
  selectedCardIds.clear();
  setBoardCards(cards);
  return true;
}

function duplicateSelectedCards() {
  if (!selectedCardIds.size) return false;
  const selected = state.boardCards.filter(card => selectedCardIds.has(card.id));
  if (!selected.length) return false;
  const idMap = new Map(selected.map(card => [card.id, makeId("c")]));
  const clones = selected.map((card, index) => ({
    ...card,
    id: idMap.get(card.id),
    title: `${card.title || t("未命名")} 副本`,
    x: (Number(card.x) || 0) + 32 + index * 8,
    y: (Number(card.y) || 0) + 32 + index * 8,
    arrows: (card.arrows || []).map(id => idMap.get(id) || id),
    _isToolStep: false,
  }));
  selectedCardIds = new Set(clones.map(card => card.id));
  setBoardCards([...state.boardCards, ...clones]);
  return true;
}

function autoLayoutCards() {
  const cards = state.boardCards || [];
  if (!cards.length) return;
  const indegree = new Map(cards.map(card => [card.id, 0]));
  const outgoing = new Map(cards.map(card => [card.id, []]));
  for (const card of cards) {
    for (const target of card.arrows || []) {
      if (!indegree.has(target)) continue;
      indegree.set(target, indegree.get(target) + 1);
      outgoing.get(card.id).push(target);
    }
  }
  const level = new Map();
  const queue = cards.filter(card => (indegree.get(card.id) || 0) === 0).map(card => card.id);
  for (const id of queue) level.set(id, 0);
  const relaxLimit = Math.max(cards.length * cards.length, cards.length + 1);
  let relaxCount = 0;
  while (queue.length && relaxCount < relaxLimit) {
    const id = queue.shift();
    const base = level.get(id) || 0;
    for (const target of outgoing.get(id) || []) {
      const next = Math.max(level.get(target) || 0, base + 1);
      if (next !== level.get(target)) {
        level.set(target, next);
        queue.push(target);
        relaxCount += 1;
      }
    }
  }
  cards.forEach((card, index) => {
    if (!level.has(card.id)) level.set(card.id, Math.floor(index / 4));
  });
  const groups = new Map();
  for (const card of cards) {
    const l = level.get(card.id) || 0;
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(card);
  }
  const laidOut = cards.map(card => {
    const l = level.get(card.id) || 0;
    const group = groups.get(l) || [];
    const row = group.findIndex(item => item.id === card.id);
    return {
      ...card,
      x: CARD_LAYOUT.startX + l * (CARD_LAYOUT.width + 90),
      y: CARD_LAYOUT.startY + row * (118 + CARD_LAYOUT.gapY),
    };
  });
  setBoardCards(laidOut);
  requestAnimationFrame(focusBoardContent);
}

function focusBoardContent() {
  if (!boardCanvas) return;
  const cards = state.boardCards || [];
  if (!cards.length && !(state.boardNotes || []).length && !strokes.length) {
    boardCanvas.scrollTo({ left: 0, top: 0, behavior: "smooth" });
    return;
  }
  // 逐点扫描求左上界：既不再展开实参（笔迹上万点会爆栈），也不复制两份大数组
  let minX = Infinity;
  let minY = Infinity;
  const consider = (rawX, rawY) => {
    const x = Number(rawX) || 0;
    const y = Number(rawY) || 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  };
  cards.forEach(card => consider(card.x, card.y));
  (state.boardNotes || []).forEach(note => consider(note.x, note.y));
  strokes.forEach(stroke => (stroke.points || []).forEach(p => consider(p.x, p.y)));
  boardCanvas.scrollTo({
    left: Math.max(0, (Number.isFinite(minX) ? minX : 0) - 40),
    top: Math.max(0, (Number.isFinite(minY) ? minY : 0) - 40),
    behavior: "smooth",
  });
}

function setupBoardShortcuts() {
  if (!boardCanvas) return;
  boardCanvas.tabIndex = 0;
  boardCanvas.addEventListener("click", (e) => {
    if (currentToolMode === "select" && !e.target.closest(".board-card, .board-note-wrap, button")) {
      clearSelection();
    }
  });
  boardCanvas.addEventListener("keydown", async (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "Escape") {
      clearSelection();
      setToolMode("select");
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedCardIds.size) {
      e.preventDefault();
      if (await dlgConfirm(t("删除选中的 {n} 张卡片？", { n: selectedCardIds.size }), { danger: true, okText: t("删除") })) {
        deleteSelectedCards();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicateSelectedCards();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      autoLayoutCards();
    }
  });
}

function renderColorOptions() {
  cardColorOptions.innerHTML = "";
  for (const color of CARD_COLORS) {
    const btn = document.createElement("button");
    btn.className = "card-color-btn" + (selectedColor === color.id ? " active" : "");
    btn.style.background = color.bg;
    btn.style.borderColor = color.border;
    btn.title = t(color.name);
    btn.addEventListener("click", () => {
      selectedColor = color.id;
      renderColorOptions();
    });
    cardColorOptions.appendChild(btn);
  }
}

// ── Mermaid 渲染 ─────────────────────────────

function cardsToMermaid(cards) {
  if (cards.length === 0) return "";
  const lines = ["flowchart LR"];

  for (const card of cards) {
    const safeTitle = card.title.replace(/"/g, '#quot;');
    lines.push(`  ${card.id}["${safeTitle}"]`);
  }

  for (const card of cards) {
    if (card.arrows) {
      for (const target of card.arrows) {
        lines.push(`  ${card.id} --> ${target}`);
      }
    }
  }

  return lines.join("\n");
}

function exportBoard() {
  const cards = state.boardCards || [];
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    "# " + t("SLATE Teams 黑板导出"),
    "",
    `${t("导出时间")}: ${new Date().toLocaleString()}`,
    `${t("卡片数量")}: ${cards.length}`,
    "",
    `## ${t("卡片")}`,
    "",
  ];

  if (cards.length === 0) {
    lines.push(t("暂无卡片。"), "");
  } else {
    for (const card of cards) {
      lines.push(`### ${card.id} · ${card.title || t("未命名")}`);
      if (card.body) lines.push("", card.body);
      if (card.arrows?.length) lines.push("", `${t("关联")}: ${card.arrows.join(", ")}`);
      if (card.color && card.color !== "default") lines.push("", `${t("颜色")}: ${card.color}`);
      lines.push("");
    }
  }

  const mermaid = cardsToMermaid(cards);
  if (mermaid) {
    lines.push("## Mermaid", "", "```mermaid", mermaid, "```", "");
  }

  lines.push("## JSON", "", "```json", JSON.stringify(cards, null, 2), "```", "");
  if ((state.boardNotes || []).length) {
    lines.push("## Notes", "");
    for (const note of state.boardNotes) {
      if (note.text?.trim()) lines.push(`- ${note.text.trim()}`);
    }
    lines.push("");
  }
  if ((state.boardStrokes || []).length) {
    lines.push("## Drawing", "", `${t("笔画数量")}: ${state.boardStrokes.length}`, "");
  }

  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `slate-board-${date}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function renderMermaid() {
  const code = cardsToMermaid(state.boardCards);
  if (!code) {
    mermaidPreview.classList.add("hidden");
    return;
  }

  mermaidCode.textContent = code;

  if (!mermaidVisible) return;

  mermaidPreview.classList.remove("hidden");
  mermaidRenderArea.innerHTML = "";

  try {
    if (window.mermaid) {
      const { svg } = await mermaid.render("mermaid-svg-" + Date.now(), code);
      mermaidRenderArea.innerHTML = svg;
    }
  } catch (e) {
    reportError(e, "Mermaid 渲染");
    mermaidRenderArea.innerHTML = `<div style="color:#999;font-size:11px;padding:8px;">${t("Mermaid 渲染失败：{msg}", { msg: e.message })}</div>`;
  }
}

function setBoardViewFullscreen(on, options = {}) {
  const next = !!on;
  if (next === boardViewFullscreen) return;
  boardViewFullscreen = next;
  whiteboardPanel?.classList.toggle("board-view-fullscreen", next);
  if (!next) mountBoardViewControls(null, null);
  if (!options.skipRender) renderBoardView();
}

function toggleMermaid() {
  mermaidVisible = !mermaidVisible;
  if (mermaidVisible) {
    mermaidPreview.classList.remove("hidden");
    renderMermaid();
  } else {
    mermaidPreview.classList.add("hidden");
  }
}

// ── AI 整理 ──────────────────────────────────

async function aiOrganize() {
  if (aiFeatureBlocked("whiteboard_organize")) return;
  if (state.boardCards.length === 0) {
    dlgToast(t("黑板是空的，请先添加卡片"));
    return;
  }

  const target = aiModelFor("whiteboard_organize", state.currentModel);
  if (!target.usable) {
    dlgToast(t("请先选择模型并配置 API Key"));
    return;
  }
  const modelId = target.id;
  const apiKey = target.key;

  // 构建卡片信息（含颜色）
  const cardsInfo = state.boardCards.map(c => {

    let info = `- [${c.id}] ${c.title}`;
    if (c.body) info += `: ${c.body}`;
    if (c.color && c.color !== "default") info += ` (颜色: ${c.color})`;
    return info;
  }).join("\n");

  const prompt = `你是一个结构化思维专家。请分析以下黑板卡片，进行整体重构优化。
当前卡片${cardsInfo}

请完成以下工作：
1. 优化卡片标题，使其简洁明确（不超过 10 字）
2. 补充/精炼卡片详情（不超过 3 行）
3. 根据逻辑关系建立 arrows 连接（指向目标卡片 ID）
4. 按语义分配颜色：
   - red = 问题/风险/阻塞
   - orange = 进行中/待处理
   - yellow = 想法/待讨论
   - green = 已完成/通过
   - blue = 信息/数据/资源
   - purple = 创意/设计
   - default = 未分类

只输出 JSON 数组，不要 Markdown，不要解释。每项包含 id、title、body、arrows、color。保持原有卡片 ID 不变。
示例：[{"id":"c1","title":"需求分析","body":"收集并整理用户需求","arrows":["c2"],"color":"blue"}]`;

  const messages = [{ role: "user", content: prompt }];
  let response = "";

  try {
    for await (const chunk of streamChat({
      model: modelId,
      provider: target.provider,
      messages,
      api_key: apiKey,
      base_url: target.base_url,
      temperature: 0.3,
      max_tokens: 4096,
      stream: true,
    })) {
      response += chunk;
    }

    // 解析 JSON
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      dlgToast(t("AI 返回格式错误，请重试"));
      return;
    }

    const newCards = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(newCards)) {
      dlgToast(t("AI 返回格式错误，请重试"));
      return;
    }

    const VALID_COLORS = ["default", "red", "orange", "yellow", "green", "blue", "purple"];

    // 全量更新：保留原 ID 匹配，应用 title/body/arrows/color 全部字段
    const updatedCards = state.boardCards.map(card => {
      const aiCard = newCards.find(c => c.id === card.id);
      if (!aiCard) return card;
      return {
        ...card,
        title: aiCard.title || card.title,
        body: aiCard.body ?? card.body,
        arrows: Array.isArray(aiCard.arrows) ? aiCard.arrows : (card.arrows || []),
        color: VALID_COLORS.includes(aiCard.color) ? aiCard.color : card.color,
      };
    });

    setBoardCards(updatedCards);
    requestAnimationFrame(autoLayoutCards);
    dlgToast(t("AI 重构完成"));
  } catch (e) {
    dlgToast(t("AI 整理失败：{msg}", { msg: e.message }));
  }
}

// ── LLM 输出解析卡片 ───────────────────────

function parseCardsFromLLM(text) {
  const cards = [];
  const jsonMatch = text.match(/\[.*\]/s);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          cards.push({
            id: item.id || `c${Date.now().toString(36)}_${cards.length}`,
            title: item.title || item.name || t("未命名"),
            body: item.body || item.description || "",
            arrows: item.arrows || item.depends || [],
            color: item.color || "default",
          });
        }
      }
    } catch (e) { /* ignore invalid JSON */ }
  }
  return cards;
}

// ── 初始化 ──────────────────────────────────

function initWhiteboard() {
  loadGitNodePositions();
  loadOutlineCollapsed();
  boardCanvas = document.getElementById("whiteboard-canvas");
  boardCards = document.getElementById("board-cards");
  boardEmpty = document.getElementById("board-empty");
  drawCanvas = document.getElementById("board-draw-canvas");
  notesLayer = document.getElementById("board-notes");
  selectionInfo = document.getElementById("board-selection-info");
  boardViewPanel = document.getElementById("board-view-panel");
  mermaidPreview = document.getElementById("mermaid-preview");
  mermaidCode = document.getElementById("mermaid-code");
  mermaidRenderArea = document.getElementById("mermaid-render-area");
  whiteboardPanel = document.getElementById("panel-whiteboard");
  boardModesBar = document.getElementById("board-view-modes");
  wfStopBtn = document.getElementById("btn-wf-stop");
  for (const el of [boardModesBar, wfStopBtn]) {
    if (el?.parentElement) boardControlHomes.set(el, { parent: el.parentElement, next: el.nextElementSibling });
  }

  // 卡片模态框
  cardModal = document.getElementById("card-modal");
  cardModalTitle = document.getElementById("card-modal-title");
  cardInputTitle = document.getElementById("card-input-title");
  cardInputBody = document.getElementById("card-input-body");
  cardInputArrows = document.getElementById("card-input-arrows");
  cardColorOptions = document.getElementById("card-color-options");
  btnCardDelete = document.getElementById("btn-card-delete");
  btnCardSave = document.getElementById("btn-card-save");
  btnCardCancel = document.getElementById("btn-card-cancel");

  // 添加卡片按钮
  document.getElementById("btn-add-card").addEventListener("click", () => openCardModal());
  document.getElementById("btn-layout-board")?.addEventListener("click", autoLayoutCards);
  document.getElementById("btn-focus-board")?.addEventListener("click", focusBoardContent);

  // AI 整理按钮
  document.getElementById("btn-ai-organize").addEventListener("click", aiOrganize);

  // Mermaid 切换按钮
  document.getElementById("btn-toggle-mermaid").addEventListener("click", toggleMermaid);
  document.getElementById("btn-export-board")?.addEventListener("click", exportBoard);
  document.getElementById("btn-close-mermaid").addEventListener("click", () => {
    mermaidVisible = false;
    mermaidPreview.classList.add("hidden");
  });

  // 清空黑板
  document.getElementById("btn-clear-board").addEventListener("click", async () => {
    if (await dlgConfirm(t("确认清空黑板？"), { danger: true, okText: t("清空") })) {
      selectedCardIds.clear();
      setBoardCards([]);
      setBoardNotes([]);
      setBoardStrokes([]);
    }
  });

  // 模态框按钮
  btnCardSave.addEventListener("click", saveCard);
  btnCardCancel.addEventListener("click", closeCardModal);
  btnCardDelete.addEventListener("click", deleteCard);

  // 关闭模态框
  cardModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", closeCardModal);
  });

  // Enter 保存
  cardInputTitle.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveCard();
  });

  setupDragDrop();
  setupBoardTools();
  document.querySelectorAll(".board-view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view || "";
      setBoardView(view === currentBoardView ? "" : view);
    });
  });
  setupDrawing();
  setupTextNotes();
  setupBoardShortcuts();
  initBoardWorkflow();   // 工作流视图要跟着模型/模式/档位订阅重算可选档位
  strokes = Array.isArray(state.boardStrokes) ? [...state.boardStrokes] : [];
  resizeDrawCanvas();
  if (window.ResizeObserver && boardCanvas) {
    new ResizeObserver(resizeDrawCanvas).observe(boardCanvas);
  } else {
    window.addEventListener("resize", resizeDrawCanvas);
  }

  // 初始化 Mermaid
  function initMermaidTheme() {
    if (window.mermaid) {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? "dark" : "neutral",
        flowchart: { curve: "basis", padding: 12 },
        themeVariables: isDark
          ? { primaryColor: "#1E1E1E", primaryTextColor: "#E0E0E0", primaryBorderColor: "#2A2A2A", lineColor: "#555", secondaryColor: "#161616" }
          : {},
      });
    }
  }
  initMermaidTheme();

  subscribe("theme", () => {
    initMermaidTheme();
    redrawStrokes();
    if (state.boardCards.length > 0) renderMermaid();
  });

  subscribe("boardCards", () => {
    renderAllCards();
    renderMermaid();
    renderBoardView();
  });
  subscribe("boardNotes", renderNotes);
  subscribe("boardStrokes", (next) => {
    strokes = Array.isArray(next) ? [...next] : [];
    redrawStrokes();
  });
  subscribe("project", () => {
    gitGraphState = { loading: false, data: null, error: "", repo: state.project?.path || "" };
    if (currentBoardView === "git") renderBoardView();
  });

  renderAllCards();
  renderNotes();
  redrawStrokes();
  refreshWhiteboard();
}

// ── 自动记录：工具步骤卡（agent 事件账本的投影） ─────────────────

/** 步骤状态 → 卡片颜色：running=黄，done=绿，error/failed=红，cancelled=灰 */
const STEP_COLORS = { running: "yellow", done: "green", error: "red", failed: "red", cancelled: "default" };

/** 卡片正文：跑完显示结果摘录，跑前显示账本里的参数摘要 */
function stepCardBody(step) {
  if (step.status === "error" || step.status === "failed") {
    return t("失败：{detail}", { detail: step.excerpt || t("执行失败") });
  }
  if (step.status === "cancelled") return t("已取消");
  if (step.status === "done") return step.excerpt || t("完成");
  return step.argsSummary || t("(无参数)");
}

/**
 * 用投影出的步骤描述符刷新画布上的步骤链（agent_ledger.projectSteps 的产物）。
 * 以 callId 为键复用：已存在的卡只回写状态与正文，位置与编号不动；新出现的按账序追加，
 * 并串到上一步的箭头上。runId 不同的旧步骤链整批淘汰（一次任务一条链）。
 */
function syncToolStepCards(steps, runId = "") {
  const kept = state.boardCards.filter(c => !c._isToolStep || c._stepRunId === runId);
  const byCallId = new Map(kept.filter(c => c._isToolStep).map(c => [c._stepCallId, c]));
  const next = [...kept];
  let prevStepId = null;
  let dirty = kept.length !== state.boardCards.length;
  for (const step of steps) {
    const existing = byCallId.get(step.callId);
    if (existing) {
      const body = stepCardBody(step);
      if (existing._status !== step.status || existing.body !== body) {
        existing.color = STEP_COLORS[step.status] || existing.color;
        existing._status = step.status;
        existing.body = body;
        dirty = true;
      }
      prevStepId = existing.id;
      continue;
    }
    const stepNum = next.filter(c => c._isToolStep).length + 1;
    const card = placeNewCard({
      id: makeId("step_"),
      title: t("步骤 {n}: {label}", { n: stepNum, label: step.label }),
      body: stepCardBody(step),
      color: STEP_COLORS[step.status] || "default",
      arrows: prevStepId ? [prevStepId] : [],
      _isToolStep: true,
      _stepRunId: runId,
      _stepCallId: step.callId,
      _toolName: step.tool,
      _stepNum: stepNum,
      _status: step.status,
      _timestamp: Date.now(),
    });
    next.push(card);
    byCallId.set(step.callId, card);
    prevStepId = card.id;
    dirty = true;
  }
  if (dirty) setBoardCards(next);
}

/** 新任务开始：只淘汰别的 run 的步骤链，本次 run 的卡片由投影自己维护 */
function clearToolStepCards(runId = "") {
  const nonStepCards = state.boardCards.filter(c => !c._isToolStep || c._stepRunId === runId);
  if (nonStepCards.length !== state.boardCards.length) setBoardCards(nonStepCards);
}

export { initWhiteboard, refreshWhiteboard, parseCardsFromLLM, cardsToMermaid, syncToolStepCards, clearToolStepCards };
