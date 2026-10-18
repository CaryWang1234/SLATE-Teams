/**
 * SLATE 团队星图：一场团队对话 = 中心一颗"会话星"，每个成员一颗行星，
 * 成员之间按真实交接画弧（reply），成员派生的工具/子代理挂在行星外侧（spawn）。
 *
 * 纯渲染层：只吃数据、只管画图与点选，不 fetch、不读 store——
 * 这样后端不可达时调用方能拿旧数据重画，守卫也能只对着形状断言。
 *
 * 数据契约（与 /api/events/team/latest 的返回同形）：
 *   { session:{topic,status,rounds,elapsedMs},
 *     members:[{id,name,role,hue,turns}],
 *     edges:[{from,to,kind:"reply",weight}],
 *     leaves:[{id,memberId,label,kind:"tool"|"subagent",count}] }
 *
 * 图上的文字一律在调用处过 t()：i18n 的 MutationObserver 跳过 svg 子树，
 * 这里不翻就永远是中文。
 */

import { t } from "./i18n.js?v=20261017-001";

const SVG_NS = "http://www.w3.org/2000/svg";

// 角色决定扇区顺序：决策者置顶，其余按固定次序，图就不会每次刷新换布局
const ROLE_ORDER = ["decider", "analyst", "creative", "member"];

export function roleRank(role) {
  const i = ROLE_ORDER.indexOf(String(role || ""));
  return i < 0 ? ROLE_ORDER.length : i;
}

/** 成员稳定色相：只由 id 决定，同一成员在任意一场会话里同色。 */
export function memberHue(id) {
  const s = String(id || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function el(tag, attrs = {}, text = "") {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text) node.textContent = text;
  return node;
}

function orderedMembers(members) {
  return [...members].sort((a, b) => {
    const d = roleRank(a.role) - roleRank(b.role);
    if (d !== 0) return d;
    return String(a.name || "").localeCompare(String(b.name || ""), "zh");
  });
}

/**
 * 极坐标布局：按角色分扇区，扇区内均分角度。
 * 返回值只由成员集合决定（与时间、状态无关），所以活数据刷新不会让星体乱跳。
 */
export function starPositions(members, { cx = 210, cy = 170, radius = 108 } = {}) {
  const list = orderedMembers(members || []);
  const groups = new Map();
  for (const m of list) {
    const key = ROLE_ORDER.includes(String(m.role)) ? String(m.role) : "member";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  // 扇区按 ROLE_ORDER 出现顺序铺开，空角色不占角度
  const used = ROLE_ORDER.filter(r => groups.has(r));
  const slotAngle = (Math.PI * 2) / Math.max(1, used.length);
  const out = [];
  used.forEach((role, gi) => {
    const bucket = groups.get(role);
    const center = -Math.PI / 2 + gi * slotAngle;   // 第一个扇区居中朝上
    const spread = Math.min(slotAngle * 0.78, 0.95);
    bucket.forEach((m, i) => {
      const angle = bucket.length === 1 ? center : center - spread / 2 + (spread * i) / (bucket.length - 1);
      out.push({
        member: m,
        role,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        angle,
      });
    });
  });
  return out;
}

function arcPath(x1, y1, x2, y2, cx, cy) {
  // 向中心方向收拢的控制点：弧线之间不打架，也读得出"绕着这场会话转"
  const mx = (x1 + x2) / 2 + (cx - (x1 + x2) / 2) * 0.42;
  const my = (y1 + y2) / 2 + (cy - (y1 + y2) / 2) * 0.42;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

/**
 * 渲染星图。container 会被清空重建；onSelect(memberId|null) 在点成员/点中心时回调。
 * @returns {SVGElement}
 */
export function renderStarMap(container, data, { onSelect } = {}) {
  const members = Array.isArray(data?.members) ? data.members : [];
  container.innerHTML = "";
  const svg = el("svg", {
    class: "star-map", viewBox: "0 0 420 340", role: "img",
    "aria-label": t("团队星图"), preserveAspectRatio: "xMidYMid meet",
  });
  if (!members.length) {
    const empty = el("text", { x: 210, y: 170, class: "star-empty", "text-anchor": "middle" });
    empty.textContent = t("尚无团队成员");
    svg.appendChild(empty);
    container.appendChild(svg);
    return svg;
  }

  const CX = 210, CY = 170;
  const pos = starPositions(members, { cx: CX, cy: CY });
  const byId = new Map(pos.map(p => [p.member.id, p]));

  // 交接弧（reply）：粗细随次数增长，最多五档，避免图上线条比字还抢戏
  const edges = Array.isArray(data.edges) ? data.edges : [];
  const gEdges = el("g", { class: "star-edges" });
  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b || a === b) continue;
    const w = Math.min(5, 1 + Math.max(0, (Number(e.weight) || 1) - 1) * 0.8);
    gEdges.appendChild(el("path", {
      d: arcPath(a.x, a.y, b.x, b.y, CX, CY),
      class: "star-edge", "stroke-width": w.toFixed(2), fill: "none",
      "data-from": e.from, "data-to": e.to,
    }));
  }
  svg.appendChild(gEdges);

  // 中心：这场会话本身
  const hub = el("g", { class: "star-hub", tabindex: "0", role: "button" });
  hub.appendChild(el("circle", { cx: CX, cy: CY, r: 30, class: "star-hub-dot" }));
  const hubLabel = el("text", { x: CX, y: CY + 4, class: "star-hub-label", "text-anchor": "middle" });
  hubLabel.textContent = t("本场");
  hub.appendChild(hubLabel);
  const topic = String(data?.session?.topic || "").slice(0, 22);
  if (topic) {
    const t2 = el("text", { x: CX, y: CY + 48, class: "star-hub-topic", "text-anchor": "middle" });
    t2.textContent = topic;
    hub.appendChild(t2);
  }
  hub.addEventListener("click", () => onSelect?.(null));
  svg.appendChild(hub);

  // 成员行星 + 其派生的工具/子代理卫星
  const leaves = Array.isArray(data.leaves) ? data.leaves : [];
  for (const p of pos) {
    const hue = Number.isFinite(Number(p.member.hue)) ? Number(p.member.hue) : memberHue(p.member.id);
    const g = el("g", { class: "star-member", tabindex: "0", role: "button", "data-member-id": p.member.id });
    const r = 13 + Math.min(9, (Number(p.member.turns) || 0) * 1.2);
    g.appendChild(el("circle", {
      cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: r.toFixed(1),
      class: "star-member-dot", fill: `hsl(${hue} 68% 58%)`,
    }));
    const name = el("text", {
      x: p.x.toFixed(1), y: (p.y + r + 13).toFixed(1), class: "star-member-name", "text-anchor": "middle",
    });
    name.textContent = `${p.member.name || p.member.id}${p.member.turns ? ` · ${p.member.turns}轮` : ""}`;
    g.appendChild(name);

    // 卫星：该成员的 spawn 边，沿"中心→成员"方向往外散开
    const mine = leaves.filter(l => l.memberId === p.member.id).slice(0, 6);
    mine.forEach((leaf, i) => {
      const spread = (i - (mine.length - 1) / 2) * 0.34;
      const angle = p.angle + spread;
      const dist = r + 26;
      const lx = p.x + Math.cos(angle) * dist;
      const ly = p.y + Math.sin(angle) * dist;
      g.appendChild(el("line", {
        x1: p.x.toFixed(1), y1: p.y.toFixed(1), x2: lx.toFixed(1), y2: ly.toFixed(1),
        class: "star-spoke",
      }));
      const dot = el("circle", {
        cx: lx.toFixed(1), cy: ly.toFixed(1), r: leaf.kind === "subagent" ? 6 : 4,
        class: `star-leaf star-leaf-${leaf.kind === "subagent" ? "sub" : "tool"}`,
      });
      dot.appendChild(el("title", {}, `${leaf.label || ""}${leaf.count > 1 ? ` ×${leaf.count}` : ""}`));
      g.appendChild(dot);
    });

    g.addEventListener("click", () => onSelect?.(p.member.id));
    g.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onSelect?.(p.member.id); }
    });
    svg.appendChild(g);
  }

  container.appendChild(svg);
  highlightStar(svg, null);
  return svg;
}

/** 选中一颗星：其余淡出。memberId 为 null 时恢复全景。 */
export function highlightStar(svg, memberId) {
  if (!svg) return;
  svg.classList.toggle("star-focused", Boolean(memberId));
  for (const g of svg.querySelectorAll(".star-member")) {
    g.classList.toggle("is-focus", Boolean(memberId) && g.dataset.memberId === memberId);
  }
  for (const path of svg.querySelectorAll(".star-edge")) {
    const on = !memberId || path.dataset.from === memberId || path.dataset.to === memberId;
    path.classList.toggle("is-dim", !on);
  }
}
