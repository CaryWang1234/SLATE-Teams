/**
 * 动效小工具：数字滚动 + 减少动效判定。
 *
 * 抽成一份是因为用量热力图的指标条和 2048 的分数都要用——复制两份必然走样
 * （一边记得加兜底、另一边忘掉这种事迟早发生）。
 */

const rafTimers = new WeakMap();

/**
 * 数字从 from 滚到 to，用 format 落字。
 *
 * rAF 在后台标签页/嵌入式浏览器里可能整个停住（踩过：动画停在起始值不动），
 * 所以另挂一个定时器兜底写终值——动效可以丢，终值不能停在半路。
 * enabled 为 false 时直出终值（减少动效、或本来就没变化）。
 */
function animateNumber(node, from, to, format, enabled) {
  const pending = rafTimers.get(node);
  if (pending) {
    clearTimeout(pending.timer);
    if (pending.raf) cancelAnimationFrame(pending.raf);
    rafTimers.delete(node);
  }
  const finish = () => {
    node.textContent = format(to);
    rafTimers.delete(node);
  };
  if (!enabled || from === to || typeof requestAnimationFrame !== "function") {
    finish();
    return;
  }
  const dur = 460;
  const t0 = performance.now();
  const entry = { raf: 0, timer: 0 };
  const step = now => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = format(Math.round(from + (to - from) * eased));
    if (p < 1) entry.raf = requestAnimationFrame(step);
    else finish();
  };
  entry.raf = requestAnimationFrame(step);
  entry.timer = setTimeout(finish, dur + 220);
  rafTimers.set(node, entry);
}

/** 系统级「减少动效」。判不了就当没开——动效是加分项，不是功能前提 */
function prefersReducedMotion() {
  return typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export { animateNumber, prefersReducedMotion };
