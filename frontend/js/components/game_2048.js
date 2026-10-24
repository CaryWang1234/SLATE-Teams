/**
 * 2048 小游戏：藏在设置页「用量统计」的热力图里（双击任一格子打开）。
 *
 * 纯逻辑（moveLine/move/spawn/isOver/maxTile）与渲染分开导出，供
 * scripts/check_usage_heatmap.mjs 在 node 里直接断言——合并规则写错
 * （一格一次移动里被合两回）肉眼很难看出来，只有断言钉得住。
 * 这几条的签名与语义不许动。moveLineDetailed / moveWithTrail 只是在它们之上
 * 多回一份「每个目标位来自哪些源位」：滑动动效要靠这份来源表才知道哪个方块
 * 该往哪儿飞，凭空重画一次是看不出位移的。
 *
 * 视觉：方块沿用热力图的墨金阶梯（--gold 逐级混到底色），退出不留按钮——
 * Esc 或点棋盘外，退路写在棋盘上方那行小字里。
 *
 * 棋盘留在模块变量里：设置页每次打开都会重画用量统计，不留着的话
 * 关个设置就丢一局。最高分只落 localStorage（与打字小游戏同套路），
 * 不进后端设置项，免得为一局小游戏做三处联动。
 */

import { t } from "../services/i18n.js?v=20261024-001";
import { animateNumber, prefersReducedMotion } from "../services/anim.js?v=20261024-001";

const BEST_KEY = "slate_2048_best";
const SIZE = 4;
const WIN_TILE = 2048;
// 滑动时长：动效结束才做合并/补牌，太长会让连按方向键像卡住
const SLIDE_MS = 110;

const CODE_KEYS = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  KeyA: "left",
  KeyD: "right",
  KeyW: "up",
  KeyS: "down",
};

let savedBoard = null;
let savedScore = 0;

export function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => 0));
}

/**
 * 推挤并合并，同时给出每个目标位来自哪些源位。
 * out 与 moveLine 的结果逐字一致，froms 只服务动效。
 */
function moveLineDetailed(line) {
  const filled = [];
  for (let i = 0; i < line.length; i++) if (line[i]) filled.push(i);
  const out = [];
  const froms = [];
  let gained = 0;
  for (let i = 0; i < filled.length; i++) {
    if (i + 1 < filled.length && line[filled[i]] === line[filled[i + 1]]) {
      const merged = line[filled[i]] * 2;
      out.push(merged);
      froms.push([filled[i], filled[i + 1]]);
      gained += merged;
      i += 1;
    } else {
      out.push(line[filled[i]]);
      froms.push([filled[i]]);
    }
  }
  while (out.length < line.length) {
    out.push(0);
    froms.push([]);
  }
  return { line: out, froms, gained };
}

/** 向索引 0 一侧推挤并合并：相邻同值合成一格，一格一次移动里只合一回 */
export function moveLine(line) {
  const res = moveLineDetailed(line);
  return { line: res.line, gained: res.gained };
}

/** (方向, 第几条轨道, 轨道内序号) → 格子坐标；序号从「推进的尽头」起算 */
function cellAt(dir, lane, pos) {
  if (dir === "left") return [lane, pos];
  if (dir === "right") return [lane, SIZE - 1 - pos];
  if (dir === "up") return [pos, lane];
  return [SIZE - 1 - pos, lane];
}

export function move(board, dir) {
  const next = emptyBoard();
  let gained = 0;
  for (let lane = 0; lane < SIZE; lane++) {
    const line = [];
    for (let pos = 0; pos < SIZE; pos++) {
      const [r, c] = cellAt(dir, lane, pos);
      line.push(board[r][c]);
    }
    const moved = moveLine(line);
    gained += moved.gained;
    for (let pos = 0; pos < SIZE; pos++) {
      const [r, c] = cellAt(dir, lane, pos);
      next[r][c] = moved.line[pos];
    }
  }
  return { board: next, gained, moved: !sameBoard(board, next) };
}

/** move 的带来源版本：trail 里每条给出目标位、源位与合成后的值 */
export function moveWithTrail(board, dir) {
  const next = emptyBoard();
  const trail = [];
  let gained = 0;
  for (let lane = 0; lane < SIZE; lane++) {
    const line = [];
    for (let pos = 0; pos < SIZE; pos++) {
      const [r, c] = cellAt(dir, lane, pos);
      line.push(board[r][c]);
    }
    const res = moveLineDetailed(line);
    gained += res.gained;
    for (let pos = 0; pos < SIZE; pos++) {
      const [r, c] = cellAt(dir, lane, pos);
      next[r][c] = res.line[pos];
      const srcs = res.froms[pos];
      if (srcs.length) {
        trail.push({
          to: [r, c],
          from: srcs.map(p => cellAt(dir, lane, p)),
          value: res.line[pos],
          merged: srcs.length > 1,
        });
      }
    }
  }
  return { board: next, gained, moved: !sameBoard(board, next), trail };
}

/** 空格里补一颗新方块：先抽位置再抽点数，各花一次 rng，方便测试复现 */
export function spawn(board, rng = Math.random) {
  const free = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (!board[r][c]) free.push([r, c]);
  }
  const next = board.map(row => [...row]);
  if (!free.length) return next;
  const [r, c] = free[Math.floor(rng() * free.length) % free.length];
  next[r][c] = rng() < 0.9 ? 2 : 4;
  return next;
}

export function isOver(board) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!board[r][c]) return false;
      if (c + 1 < SIZE && board[r][c] === board[r][c + 1]) return false;
      if (r + 1 < SIZE && board[r][c] === board[r + 1][c]) return false;
    }
  }
  return true;
}

export function maxTile(board) {
  let top = 0;
  for (const row of board) for (const v of row) if (v > top) top = v;
  return top;
}

function sameBoard(a, b) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (a[r][c] !== b[r][c]) return false;
  }
  return true;
}

function readBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}

function writeBest(v) {
  try { localStorage.setItem(BEST_KEY, String(Math.round(v))); } catch {}
}

function el(cls, text) {
  const node = document.createElement(cls === "button" ? "button" : "div");
  node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/** 挂载一副牌到 host；返回 destroy() 解绑全局按键与外部点击 */
export function mount2048(host, { onClose } = {}) {
  host.innerHTML = "";
  const reduceMotion = prefersReducedMotion();

  let board = savedBoard ? savedBoard.map(row => [...row]) : null;
  let score = savedBoard ? savedScore : 0;
  let won = false;
  let over = false;
  let busy = false;          // 滑动过程中不接受新输入，收尾时再补一次
  let queued = null;
  let destroyed = false;
  let tiles = [];
  let nextId = 1;
  let box = { pad: 8, gap: 8, cell: 60 };   // 由 measure() 刷新

  const wrap = el("t2048");

  const head = el("t2048-head");
  head.append(el("t2048-title", "2048"));

  const scoreBox = el("t2048-score");
  scoreBox.append(el("t2048-score-key", t("分数")));
  const scoreNum = el("t2048-score-num", "0");
  scoreBox.append(scoreNum);

  const bestBox = el("t2048-score");
  bestBox.append(el("t2048-score-key", t("最高分")));
  const bestNum = el("t2048-score-num", String(readBest()));
  bestBox.append(bestNum);
  head.append(scoreBox, bestBox);

  const btnNew = el("button", t("新游戏"));
  btnNew.className = "send-btn send-btn-sm";
  btnNew.type = "button";
  head.append(btnNew);
  wrap.append(head);

  const boardEl = el("t2048-board");
  for (let i = 0; i < SIZE * SIZE; i++) boardEl.append(el("t2048-slot"));
  wrap.append(boardEl);

  const hint = el("t2048-hint", t("方向键或 WASD 移动方块，合出 2048"));
  const escTip = el("t2048-esc", t("Esc 或点棋盘外返回"));
  const foot = el("t2048-foot");
  foot.append(hint, escTip);
  wrap.append(foot);
  host.append(wrap);

  // ── 布局：方块绝对定位，位置 = padding + 序号 × (边长 + 缝) ──
  function measure() {
    const cs = getComputedStyle(boardEl);
    const pad = parseFloat(cs.paddingLeft) || 0;
    const gap = parseFloat(cs.columnGap) || 0;
    const inner = boardEl.clientWidth - pad * 2 - gap * (SIZE - 1);
    box = { pad, gap, cell: Math.max(0, inner / SIZE) };
    return box;
  }

  function place(tile, animate) {
    const node = tile.node;
    node.style.width = `${box.cell}px`;
    node.style.height = `${box.cell}px`;
    tile.face.style.fontSize = `${Math.max(11, Math.round(box.cell * 0.34))}px`;
    const x = box.pad + tile.c * (box.cell + box.gap);
    const y = box.pad + tile.r * (box.cell + box.gap);
    if (!animate) node.style.transition = "none";
    node.style.transform = `translate(${x}px, ${y}px)`;
    if (!animate) {
      void node.offsetWidth;   // 逼一次回流，别让这次「瞬移」被过渡吃掉
      node.style.transition = "";
    }
  }

  function relayout() {
    measure();
    for (const tile of tiles) place(tile, false);
  }

  function paintTile(tile) {
    tile.face.textContent = String(tile.value);
    tile.face.className = `t2048-tile-face tv${tile.value}`;
  }

  function createTile(r, c, value, { spawnFx = false, mergeFx = false } = {}) {
    const node = el("t2048-tile");
    const face = el("t2048-tile-face");
    node.append(face);
    boardEl.append(node);
    const tile = { id: nextId++, r, c, value, node, face, dead: false };
    tiles.push(tile);
    paintTile(tile);
    place(tile, false);
    if (spawnFx) face.classList.add("is-new");
    if (mergeFx) {
      face.classList.add("is-merged");
      // 动画放完就摘类：留着的话金边会一直挂在每一颗合出来的方块上
      setTimeout(() => face.classList.remove("is-merged"), 320);
    }
    return tile;
  }

  function rebuild() {
    for (const tile of tiles) tile.node.remove();
    tiles = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c]) createTile(r, c, board[r][c]);
      }
    }
  }

  function paintScore(delta) {
    const to = score;
    const from = Math.max(0, to - (delta || 0));
    animateNumber(scoreNum, from, to, v => v.toLocaleString(), !reduceMotion && !!delta);
    bestNum.textContent = String(readBest());
    if (delta > 0 && !reduceMotion) {
      const float = el("t2048-gain", `+${delta}`);
      scoreBox.append(float);
      setTimeout(() => float.remove(), 820);
    }
  }

  function checkState() {
    if (!won && maxTile(board) >= WIN_TILE) {
      won = true;
      hint.textContent = t("已合成 2048，可继续挑战更高");
      boardEl.classList.remove("is-win");
      void boardEl.offsetWidth;
      boardEl.classList.add("is-win");
      setTimeout(() => boardEl.classList.remove("is-win"), 1000);
    }
    if (isOver(board) && !over) {
      over = true;
      hint.textContent = t("无可移动方向，点「新游戏」重新开始");
      boardEl.classList.add("is-over");
      setTimeout(() => boardEl.classList.remove("is-over"), 420);
    }
  }

  function push(dir) {
    if (destroyed || over || isOver(board)) return;
    if (busy) { queued = dir; return; }
    const plan = moveWithTrail(board, dir);
    if (!plan.moved) return;

    measure();
    // 先把「源位 → 目标位」翻成方块对象：合成的那两格都要滑到同一个目标位
    const moves = [];
    for (const step of plan.trail) {
      const sources = step.from
        .map(pos => tiles.find(x => !x.dead && x.r === pos[0] && x.c === pos[1]))
        .filter(Boolean);
      if (sources.length) moves.push({ step, sources });
    }

    busy = true;
    for (const { step, sources } of moves) {
      for (const tile of sources) {
        tile.r = step.to[0];
        tile.c = step.to[1];
        place(tile, true);
      }
    }
    board = plan.board;
    if (plan.gained > 0) {
      score += plan.gained;
      if (score > readBest()) writeBest(score);
    }
    paintScore(plan.gained);

    // 动画落定后再收尾：拿走被吃掉的两块、给新块弹一下、再补一颗新方块。
    // 合并必须等滑完——提前放上去会和正在飞的方块叠在同一格上，看着像闪了一下。
    setTimeout(() => {
      if (destroyed) return;
      for (const { step, sources } of moves) {
        if (step.merged) {
          for (const tile of sources) {
            tile.dead = true;
            tile.node.remove();
          }
          tiles = tiles.filter(x => !x.dead);
          createTile(step.to[0], step.to[1], step.value, { mergeFx: true });
        } else {
          const tile = sources[0];
          tile.value = step.value;
          paintTile(tile);
        }
      }
      const before = board;
      board = spawn(board);
      const spot = firstNewCell(before, board);
      if (spot) createTile(spot[0], spot[1], board[spot[0]][spot[1]], { spawnFx: true });
      savedBoard = board.map(row => [...row]);
      savedScore = score;
      busy = false;
      checkState();
      if (queued) {
        const next = queued;
        queued = null;
        push(next);
      }
    }, reduceMotion ? 0 : SLIDE_MS);
  }

  function firstNewCell(before, after) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!before[r][c] && after[r][c]) return [r, c];
      }
    }
    return null;
  }

  function restart() {
    board = spawn(spawn(emptyBoard()));
    score = 0;
    won = false;
    over = false;
    queued = null;
    savedBoard = board.map(row => [...row]);
    savedScore = 0;
    hint.textContent = t("方向键或 WASD 移动方块，合出 2048");
    boardEl.classList.remove("is-over");
    rebuild();
    // 开局两颗也走补牌动效，别让新局像「本来就摆在那儿」
    for (const tile of tiles) tile.face.classList.add("is-new");
    paintScore(0);
  }

  function onKey(e) {
    if (e.key === "Escape") {
      if (onClose) onClose();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const dir = CODE_KEYS[e.code];
    if (!dir) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable)) return;
    e.preventDefault();
    push(dir);
  }

  // 点棋盘外即退出。dblclick 那次手势的 click 早已派发完，这里不会自己把自己关掉
  function onDocClick(e) {
    if (!wrap.contains(e.target) && onClose) onClose();
  }

  if (!board) {
    board = spawn(spawn(emptyBoard()));
    savedBoard = board.map(row => [...row]);
    savedScore = score;
  }
  // 上一局存档可能就是终局/已过关：状态静默对齐，别开面板就闪一次金光
  won = maxTile(board) >= WIN_TILE;
  over = isOver(board);
  if (over) hint.textContent = t("无可移动方向，点「新游戏」重新开始");
  else if (won) hint.textContent = t("已合成 2048，可继续挑战更高");
  measure();
  rebuild();
  paintScore(0);

  btnNew.addEventListener("click", restart);
  window.addEventListener("keydown", onKey);
  document.addEventListener("click", onDocClick);
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(relayout) : null;
  if (ro) ro.observe(boardEl);

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onDocClick);
      if (ro) ro.disconnect();
      host.innerHTML = "";
    },
  };
}
