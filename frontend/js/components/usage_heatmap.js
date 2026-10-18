/**
 * 设置页「用量统计」里的活跃度热力图：按本地日期看每天的活动量。
 *
 * 数据来自 GET /api/chat/usage/summary 的 data.daily（后端只回有活动的日子，
 * 空档由这里补 0）。每条带三样东西：count（用户发言条数）、tokens（当天 token
 * 增量）、estimated（该天 token 是不是按对话累计摊出来的估算值）。老后端不带
 * daily 时 app.js 直接跳过渲染，这里不再兜底。
 *
 * 两个口径共用一份格子：消息看「发得勤不勤」，token 看「烧得狠不狠」。
 * 切口径只重算色阶、tooltip、汇总行与指标条，绝不重建 DOM——重建会让入场动效
 * 重播，还会把鼠标底下的那个格子换掉。口径记在 localStorage。
 *
 * 格子按 GitHub 口径排：一列一周，周日打头，53 列刚好对上后端的 371 天。
 * 53 列在窄的设置栏里铺不开，所以格子边长由 syncCellSize 量容器宽度回算成
 * --heat-cell（见 CSS 里 .heat-grid 的 repeat(53, var(--heat-cell))），而不是靠
 * 1fr 缩放——1fr 会把格子压成长条，宽度不够时照样撑出横向滚动条。上限 20px：
 * 到顶之后画布比容器窄，靠 .heat-canvas 的 max-content + min-width:100% +
 * margin-inline:auto 把整块居中（别改用 flex 的 align-items:center 居中——
 * 内容一旦比容器宽，溢出到左侧的半截就再也滚不到了）。
 *
 * 汇总行只报日期区间：周日打头的固定 53 列里非 future 格只有 365+今天星期数天，
 * 报「近 53 周」是虚的。指标条（最长/当前连续、单日最高、日均）同样只在这段
 * 可见区间里算，future 格不能混进来截断连续天数。
 *
 * 动效：首屏按周错峰点亮（--heat-i 排的延迟，只播一次，切口径不重播）、
 * 指标数字滚动、切口径时格子底色过渡。一律在 prefers-reduced-motion 下直出。
 *
 * 2048：双击任一格子，棋盘就地替掉热力图（见 game_2048.js）。
 * 不留可见入口，也不写提示文案——这是彩蛋，不是功能按钮。
 */

import { t } from "../services/i18n.js?v=20261017-001";
import { fmtTokens } from "../services/usage.js?v=20261017-001";
import { animateNumber, prefersReducedMotion } from "../services/anim.js?v=20261017-001";
import { mount2048 } from "./game_2048.js?v=20261017-001";

const WEEKS = 53;
const METRICS = ["count", "tokens"];
const METRIC_KEY = "slate_heat_metric";
const MONTHS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

function fmtDate(dt) {
  const p = n => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function readMetric() {
  try {
    const v = localStorage.getItem(METRIC_KEY);
    return METRICS.includes(v) ? v : "count";
  } catch { return "count"; }
}

function writeMetric(metric) {
  try { localStorage.setItem(METRIC_KEY, metric); } catch {}
}

/** 0 无活动；其余按占最大值的比例分 4 档（样本极小时直接按条数走） */
export function levelFor(count, max) {
  if (!count) return 0;
  if (max <= 4) return Math.min(4, count);
  const ratio = count / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

/**
 * 把一套口径压成指标条要的几个数。
 * 只认可见区间：future 格恒为 0，混进来会把末尾的连续天数直接截断。
 */
function summarize(visible, key) {
  let total = 0, max = 0, activeDays = 0;
  for (const c of visible) {
    const v = c[key];
    total += v;
    if (v) activeDays += 1;
    if (v > max) max = v;
  }
  let longestStreak = 0, run = 0;
  for (const c of visible) {
    run = c[key] > 0 ? run + 1 : 0;
    if (run > longestStreak) longestStreak = run;
  }
  let currentStreak = 0;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i][key] > 0) currentStreak += 1;
    // 今天往往还没过完：它没量不该把还在延续的连续记录断掉，跳过继续往前数
    else if (i !== visible.length - 1) break;
  }
  let bestDay = null;
  for (const c of visible) {
    if (c[key] > 0 && (!bestDay || c[key] > bestDay.value)) bestDay = { date: c.date, value: c[key] };
  }
  return {
    total, max, activeDays, longestStreak, currentStreak, bestDay,
    avgPerActiveDay: activeDays ? Math.round(total / activeDays) : 0,
  };
}

/** 把稀疏的 daily 摊成 53 列 × 7 行的格子，末尾未到的一周置 future */
export function buildGrid(daily, today = new Date()) {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const firstSunday = new Date(
    end.getFullYear(), end.getMonth(),
    end.getDate() - end.getDay() - (WEEKS - 1) * 7
  );
  const rows = new Map();
  for (const item of daily || []) {
    if (!item || !item.date) continue;
    rows.set(String(item.date), {
      count: Math.max(0, Number(item.count) || 0),
      tokens: Math.max(0, Number(item.tokens) || 0),
      estimated: item.estimated === true,
    });
  }
  const cells = [];
  for (let w = 0; w < WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const dt = new Date(firstSunday.getFullYear(), firstSunday.getMonth(), firstSunday.getDate() + w * 7 + d);
      const date = fmtDate(dt);
      const future = dt.getTime() > end.getTime();
      const rec = future ? null : rows.get(date);
      cells.push({
        date, week: w, dow: d, future,
        count: rec ? rec.count : 0,
        tokens: rec ? rec.tokens : 0,
        estimated: rec ? rec.estimated : false,
      });
    }
  }
  const visible = cells.filter(c => !c.future);
  return {
    cells, weeks: WEEKS, visibleDays: visible.length,
    metrics: { count: summarize(visible, "count"), tokens: summarize(visible, "tokens") },
    startDate: fmtDate(firstSunday), endDate: fmtDate(end),
  };
}

/** 换月的第一列出月份标签；整列都在未来的列不标 */
export function monthLabels(grid) {
  const out = [];
  let prev = -1;
  for (let w = 0; w < grid.weeks; w++) {
    const column = grid.cells.slice(w * 7, w * 7 + 7).filter(c => !c.future);
    if (!column.length) continue;
    const mid = column[Math.min(3, column.length - 1)];
    const m = Number(mid.date.slice(5, 7)) - 1;
    if (prev === -1) { prev = m; continue; }
    if (m !== prev) {
      out.push({ week: w, label: MONTHS[m] });
      prev = m;
    }
  }
  return out;
}

function div(cls, text) {
  const node = document.createElement("div");
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function cellTitle(cell, metric) {
  if (metric === "tokens") {
    if (!cell.tokens) return t("{date} · 未使用", { date: cell.date });
    const base = t("{date} · {n} tokens", { date: cell.date, n: fmtTokens(cell.tokens) });
    return cell.estimated ? `${base}${t("（估算）")}` : base;
  }
  return cell.count
    ? t("{date} · 发送 {n} 条消息", { date: cell.date, n: cell.count })
    : t("{date} · 未使用", { date: cell.date });
}

/** 画热力图；game 视图与热力图视图共用同一块地盘，切换靠 data-view */
export function renderActivityHeatmap(host, daily, opts = {}) {
  const grid = buildGrid(daily);
  const recordedFrom = opts.recordedFrom || null;
  const reduceMotion = prefersReducedMotion();
  host.innerHTML = "";

  const shell = div("heat-shell");
  const heat = div("heat");

  // ── 头部：标题 + 口径切换 + 汇总行 ──
  const head = div("heat-head");
  head.append(div("heat-title", t("活跃度")));

  const seg = div("heat-seg");
  const segBtns = {};
  for (const m of METRICS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "heat-seg-btn";
    btn.dataset.metric = m;
    btn.textContent = m === "tokens" ? "Tokens" : t("消息");
    btn.addEventListener("click", () => setMetric(m));
    seg.append(btn);
    segBtns[m] = btn;
  }
  head.append(seg);

  const totalEl = div("heat-total");
  head.append(totalEl);
  heat.append(head);

  // ── 指标条 ──
  const stats = div("heat-stats");
  const chips = [];
  for (let i = 0; i < 4; i++) {
    const box = div("heat-stat");
    const num = div("heat-stat-num", "0");
    const label = div("heat-stat-label");
    box.append(num, label);
    stats.append(box);
    chips.push({ box, num, label });
  }
  heat.append(stats);

  // ── 估算标注：只有 token 口径且真有估算日时才露 ──
  const note = div("heat-note hidden");
  heat.append(note);

  const scroll = div("heat-scroll");
  // 画布比容器窄时整块居中（min-width 撑满 + 行居中），比容器宽时退化成
  // max-content 的横向滚动区，见 CSS 里 .heat-canvas
  const canvas = div("heat-canvas");

  const monthsRow = div("heat-row");
  monthsRow.append(div("heat-daypad"));
  const months = div("heat-months");
  for (const label of monthLabels(grid)) {
    const cell = div("heat-month", t(label.label));
    cell.style.gridColumn = String(label.week + 1);
    months.append(cell);
  }
  monthsRow.append(months);
  canvas.append(monthsRow);

  const bodyRow = div("heat-row");
  const days = div("heat-days");
  const dayNames = { 1: t("周一"), 3: t("周三"), 5: t("周五") };
  for (let d = 0; d < 7; d++) days.append(div("heat-day", dayNames[d] || ""));
  bodyRow.append(days);

  const gridEl = div("heat-grid");
  const cellNodes = grid.cells.map((cell, i) => {
    const node = div("heat-cell lv0");
    if (cell.future) node.classList.add("future");
    node.dataset.date = cell.date;
    // 错峰下标按周排：点亮是从左到右一周一周推过去，不是满屏随机闪
    node.style.setProperty("--heat-i", String(i));
    gridEl.append(node);
    return node;
  });
  gridEl.addEventListener("dblclick", () => openGame(shell));
  bodyRow.append(gridEl);
  canvas.append(bodyRow);
  scroll.append(canvas);
  heat.append(scroll);

  const foot = div("heat-foot");
  foot.append(div("heat-legend-key", t("少")));
  for (let lv = 0; lv <= 4; lv++) foot.append(div(`heat-swatch lv${lv}`));
  foot.append(div("heat-legend-key", t("多")));
  heat.append(foot);

  // 必须是 .heat 的兄弟：openGame 给 .heat 加 .hidden，挂在里面会被一起藏掉
  const gameHost = div("heat-game hidden");

  shell.append(heat);
  shell.append(gameHost);
  host.append(shell);

  const shown = [0, 0, 0, 0];
  let metric = readMetric();

  function paintStats(m, animate) {
    const s = grid.metrics[m];
    const isTokens = m === "tokens";
    const totalFmt = isTokens ? fmtTokens : v => v.toLocaleString();
    const dayFmt = v => String(v);
    const best = s.bestDay;
    const cfg = [
      {
        to: s.longestStreak, format: dayFmt,
        label: t("最长连续（天）"),
        title: t("窗口内连续每天都发消息的最长天数"),
      },
      {
        to: s.currentStreak, format: dayFmt,
        label: t("当前连续（天）"),
        title: t("到今天为止连续有消息的天数；今天还没发则从昨天往前数"),
      },
      {
        to: best ? best.value : 0, format: totalFmt,
        label: t(isTokens ? "单日最高（tokens）" : "单日最高（条）"),
        title: best
          ? t(isTokens ? "最耗 token 的一天：{date}，{n} tokens" : "最活跃的一天：{date}，发送 {n} 条消息",
            { date: best.date, n: isTokens ? fmtTokens(best.value) : best.value })
          : t(isTokens ? "窗口内单日消耗 token 最多的一天" : "窗口内单日发送消息最多的一天"),
      },
      {
        to: s.avgPerActiveDay, format: totalFmt,
        label: t(isTokens ? "活跃日均（tokens）" : "活跃日均（条）"),
        title: t(isTokens ? "总 token ÷ 有活动的天数" : "总消息数 ÷ 有消息的天数"),
      },
    ];
    cfg.forEach((item, i) => {
      chips[i].label.textContent = item.label;
      chips[i].box.title = item.title;
      animateNumber(chips[i].num, shown[i], item.to, item.format, animate && !reduceMotion);
      shown[i] = item.to;
    });
  }

  function setMetric(next, { animate = true } = {}) {
    if (!METRICS.includes(next)) next = "count";
    metric = next;
    if (animate) writeMetric(next);
    for (const m of METRICS) segBtns[m].classList.toggle("active", m === next);
    segBtns[next].setAttribute("aria-pressed", "true");

    const s = grid.metrics[next];
    totalEl.textContent = next === "tokens"
      ? t("{start} 至 {end}：{n} tokens · {d} 天活跃", {
        start: grid.startDate, end: grid.endDate, n: fmtTokens(s.total), d: s.activeDays,
      })
      : t("{start} 至 {end}：发送 {n} 条消息 · {d} 天活跃", {
        start: grid.startDate, end: grid.endDate, n: s.total, d: s.activeDays,
      });

    grid.cells.forEach((cell, i) => {
      const node = cellNodes[i];
      node.className = `heat-cell lv${cell.future ? 0 : levelFor(cell[next], s.max)}`
        + (cell.future ? " future" : "");
      node.title = cellTitle(cell, next);
    });

    paintStats(next, animate);

    const estimated = grid.cells.some(c => !c.future && c.estimated);
    if (next === "tokens" && estimated) {
      note.textContent = recordedFrom
        ? t("逐日真实记账自 {date} 起；更早的 token 为估算（按对话累计摊分）", { date: recordedFrom })
        : t("token 暂全部为估算（按对话累计摊分），从下次对话起按日真实记账");
      note.classList.remove("hidden");
    } else {
      note.textContent = "";
      note.classList.add("hidden");
    }
  }

  setMetric(metric, { animate: false });
  syncCellSize(heat, scroll, days);

  // 首屏错峰点亮：只加一次类，播完就摘掉，切口径不会重播
  if (!reduceMotion) {
    gridEl.classList.add("heat-enter");
    setTimeout(() => gridEl.classList.remove("heat-enter"), 1400);
  }
  return grid;
}

// .heat-daypad/.heat-days 宽 22px、.heat-row 列间距 6px，改样式时改这里
const LABEL_W = 22;
const ROW_GAP = 6;
const CELL_GAP = 3;
const WIDE_GAP = 4;
const MIN_CELL = 5;
const MAX_CELL = 20;

let resizeObs = null;

/** 格子大了缝还留 3px 会显得糊成一坨，跨过 15px 就把缝放到 4px */
function gapFor(cell) {
  return cell >= 15 ? WIDE_GAP : CELL_GAP;
}

/** 53 列固定尺寸放不下就白瞎出滚动条：按可用宽度回算出最大的格子边长 */
function syncCellSize(heat, scroll, days) {
  const apply = () => {
    const avail = scroll.clientWidth - (days.clientWidth || LABEL_W) - ROW_GAP;
    if (avail <= 0) return;
    // 缝随边长变，所以从大到小试：第一个装得下的就是最大可行解
    let cell = MIN_CELL, gap = CELL_GAP;
    for (let c = MAX_CELL; c >= MIN_CELL; c--) {
      const g = gapFor(c);
      if (WEEKS * c + g * (WEEKS - 1) <= avail) { cell = c; gap = g; break; }
    }
    heat.style.setProperty("--heat-cell", `${cell}px`);
    heat.style.setProperty("--heat-gap", `${gap}px`);
  };
  apply();
  if (typeof ResizeObserver !== "function") return;
  if (resizeObs) resizeObs.disconnect();
  resizeObs = new ResizeObserver(apply);
  resizeObs.observe(scroll);
}

let current = null;

function openGame(shell) {
  if (shell.dataset.view === "game") return;
  const heat = shell.querySelector(".heat");
  const host = shell.querySelector(".heat-game");
  if (!heat || !host) return;
  shell.dataset.view = "game";
  heat.classList.add("hidden");
  host.classList.remove("hidden");
  current = mount2048(host, { onClose: () => closeGame(shell) });
}

function closeGame(shell) {
  if (current) { current.destroy(); current = null; }
  const heat = shell.querySelector(".heat");
  const host = shell.querySelector(".heat-game");
  if (heat) heat.classList.remove("hidden");
  if (host) host.classList.add("hidden");
  delete shell.dataset.view;
}

export { WEEKS };
