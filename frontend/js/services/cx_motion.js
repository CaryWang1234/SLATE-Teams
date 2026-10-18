/**
 * Codex（通用 UI）动效：基于 window.anime（CDN，index.html head 同步加载）。
 * 所有函数均为“增强型”：anime 缺失 / prefers-reduced-motion / 非 codex 时静默 no-op，
 * 动画结束后清除 inline transform/opacity，不改变最终布局。
 */

function codexOn() {
  return document.documentElement.getAttribute("data-ui") === "codex";
}

function motionAllowed() {
  if (typeof window.anime === "undefined") return false;
  if (!codexOn()) return false;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  return true;
}

const lastAt = new Map();
const DEDUPE_MS = 600;

function canPlay(el) {
  if (!el || !motionAllowed()) return false;
  const now = Date.now();
  if (lastAt.has(el) && now - lastAt.get(el) < DEDUPE_MS) return false;
  lastAt.set(el, now);
  return true;
}

function clearFx(el) {
  el.style.removeProperty("transform");
  el.style.removeProperty("opacity");
}

// 动画前同步预置初值，避免 DOM 已显示后首帧闪回 from 状态
function preset(el, props) {
  window.anime.set(el, props);
}

// rAF 停摆兜底：后台标签/窗口最小化时 anime 依赖的 rAF 不推进，元素会停在
// 透明/位移初态；到点后用 setTimeout 强制清除 inline，绝不把界面卡在隐藏态。
function fallbackClear(el, ms) {
  setTimeout(() => {
    if (el.isConnected) clearFx(el);
  }, ms);
}

// 左栏整条从左侧滑入（仅进入 codex 时播放）
export function cxDockIn() {
  const dock = document.getElementById("codex-dock");
  if (!canPlay(dock)) return;
  preset(dock, { translateX: "-16px", opacity: 0 });
  window.anime({
    targets: dock,
    translateX: ["-16px", "0px"],
    opacity: [0, 1],
    duration: 240,
    easing: "easeOutCubic",
    complete: () => clearFx(dock),
  });
  fallbackClear(dock, 380);
}

// 面板切换：新活动面板淡入（whiteboard 不做位移，避免画布坐标换算干扰）
export function cxPanelIn(panelEl, dy = 6) {
  if (!canPlay(panelEl)) return;
  preset(panelEl, { translateY: `${dy}px`, opacity: 0 });
  window.anime({
    targets: panelEl,
    opacity: [0, 1],
    translateY: [`${dy}px`, "0px"],
    duration: 200,
    easing: "easeOutCubic",
    complete: () => clearFx(panelEl),
  });
  fallbackClear(panelEl, 340);
}

// 历史会话列表交错浮现：仅当可见项集合发生变化（新增/展开/切 codex 首次渲染）时播放；
// 折叠（新集合是旧集合的子集）或内容未变（重渲高亮/刷新）时静默。
let histSignature = null;

export function cxHistReveal(box, force = false) {
  if (!box || !motionAllowed()) return;
  const items = Array.from(box.querySelectorAll(".codex-hist-item"));
  const sig = items.map(b => b.dataset.convId || "").join("|");
  if (!force && sig && sig === histSignature) return;
  const had = histSignature !== null && histSignature !== "";
  const prevIds = had ? histSignature.split("|") : [];
  const removedOnly = had && items.length < prevIds.length && items.every(b => prevIds.includes(b.dataset.convId || ""));
  histSignature = sig;
  if (removedOnly) return;
  const fresh = force ? items : items.filter(el => !(had && prevIds.includes(el.dataset.convId || "")));
  fresh.forEach((el, i) => {
    if (!canPlay(el)) return;
    const delay = Math.min(i, 24) * 12;
    preset(el, { translateY: "4px", opacity: 0 });
    window.anime({
      targets: el,
      opacity: [0, 1],
      translateY: ["4px", "0px"],
      duration: 200,
      easing: "easeOutCubic",
      delay,
      complete: () => clearFx(el),
    });
    fallbackClear(el, 340 + delay);
  });
}

// 空态欢迎页浮现：仅动画已渲染的 .chat-welcome（初始空 DOM 由整面板淡入覆盖，
// 不对滚动容器自身做 transform，避免影响 :has 空态判定与居中布局）
export function cxEmptyIn() {
  const welcome = document.querySelector("#chat-messages .chat-welcome");
  if (!canPlay(welcome)) return;
  preset(welcome, { translateY: "10px", opacity: 0 });
  window.anime({
    targets: welcome,
    opacity: [0, 1],
    translateY: ["10px", "0px"],
    duration: 260,
    easing: "easeOutQuad",
    complete: () => clearFx(welcome),
  });
  fallbackClear(welcome, 400);
}
