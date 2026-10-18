/**
 * 侧栏任务列表的排序与状态判定 —— classic 的 #conv-list 与 Codex 的历史分组共用这一份纯函数。
 *
 * 状态刻意分两层：
 *   进行中 —— 只有持有生成权的那一侧知道（切会话即中断）。落库就会在重启后留下
 *             永远转不完的僵尸态，所以它只来自实时参数 activeConvId，绝不进 taskFlags。
 *   其余三态 —— 记的是"上一场怎么结束的"，用户可能明天才回来处理，必须跨重启仍在，
 *             所以由 store 持久化，并带 seen 位来支撑"已完成未查看"。
 *
 * 徽标只在"这条记录确实是该会话的最新一句"时才亮：flag.at 早于会话 updated_at，
 * 说明后来又在别处（手机遥控/另一台机器）继续过，旧结局不该继续压在列表上。
 *
 * 本模块不 import 任何依赖（守卫可在 Node 里直接真跑这些函数），
 * 标签文本在这里只是中文键，渲染处一律过 t() 再上 DOM。
 */

export const STATUS = { RUNNING: "running", NEEDS: "needs", ERROR: "error", UNREAD: "unread", IDLE: "idle" };

/** rank = 按状态排序时的轻重（0 最该先看到）；icon 取自 icons.js 的现有图标名 */
export const STATUS_MARKS = {
  running: { icon: "activity", label: "进行中", rank: 2 },
  needs: { icon: "bell", label: "需要操作", rank: 0 },
  error: { icon: "alert-triangle", label: "出错", rank: 1 },
  unread: { icon: "check", label: "已完成未查看", rank: 3 },
  idle: { icon: "", label: "", rank: 4 },
};

/** 落库的结局只有三种：进行中由实时层负责，未查看只是 done 的一个位 */
export const FLAG_KINDS = ["done", "needs", "error"];

export const SORT_MODES = [
  { key: "recent", label: "最近更新" },
  { key: "project", label: "按项目" },
  { key: "status", label: "按状态" },
  { key: "created", label: "创建时间" },
  { key: "usage", label: "按用量" },
];

export const UNGROUPED = "未分类";

// 会话 updated_at 是服务端 epoch 秒，flag.at 是本地毫秒：跨口径比较留 2s 容差
const STALE_TOLERANCE_S = 2;

export function normalizeTaskListSort(value) {
  return SORT_MODES.some(m => m.key === value) ? value : "recent";
}

export function normalizeTaskFlag(flag) {
  if (!flag || typeof flag !== "object") return null;
  if (!FLAG_KINDS.includes(flag.kind)) return null;
  const at = Number(flag.at) || 0;
  if (!at) return null;
  return { kind: flag.kind, at, seen: flag.seen === true };
}

/** 清洗并裁剪持久化映射：只留最近 TASK_FLAG_MAX 条，会话被删后这些残项也靠裁剪自然消化 */
export function normalizeTaskFlags(flags, max = 300) {
  const out = {};
  if (!flags || typeof flags !== "object") return out;
  const clean = Object.entries(flags)
    .map(([id, flag]) => [id, normalizeTaskFlag(flag)])
    .filter(([, flag]) => flag)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, Math.max(1, max));
  for (const [id, flag] of clean) out[id] = flag;
  return out;
}

export function projectLabel(conv) {
  const name = typeof conv?.project === "string" ? conv.project.trim() : "";
  return name || UNGROUPED;
}

/**
 * 分组身份：优先 project_id，其次名称，都没有才算"未分类"。
 *
 * 为什么不能只用名称：两个不同目录的同名项目会被合成一组，历史串成一堆——
 * 这正是这轮回 id 之后要修掉的毛病。老会话没有 id（刻意没做回填），
 * 所以读时按名称回落，口径与后端 GET /chat/conversations?project_id= 一致。
 */
export function projectGroupKey(conv, registry = []) {
  const id = typeof conv?.project_id === "string" ? conv.project_id.trim() : "";
  if (id) return `id:${id}`;
  const known = (Array.isArray(registry) ? registry : [])
    .filter(e => e?.name === projectLabel(conv) && e.name !== UNGROUPED);
  // 名字在册里唯一时按名字归并是安全的（后端 find_entry 也只在唯一时才认名字）；
  // 一旦重名，没 id 的老会话就只能停在"按名字"这一组，不猜该归哪个。
  if (known.length === 1 && conv?.project) return `id:${known[0].id}`;
  const name = projectLabel(conv);
  return name === UNGROUPED ? "none" : `name:${name}`;
}

/** 组标签：默认用项目名；两组重名时补上路径尾段，否则界面看上去就是"同一项目被拆成两堆"。 */
function groupLabels(groups, registry, convsByKey) {
  const list = Array.isArray(registry) ? registry : [];
  const byId = new Map(list.filter(e => e?.id).map(e => [e.id, e]));
  const labelOf = (key) => {
    if (key === "none") return UNGROUPED;
    if (key.startsWith("id:")) {
      const entry = byId.get(key.slice(3));
      if (entry?.name) return entry.name;
    }
    if (key.startsWith("name:")) return key.slice(5);
    const first = (convsByKey.get(key) || [])[0];
    return first?.project || UNGROUPED;
  };
  const counts = new Map();
  for (const key of groups) {
    const label = labelOf(key);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const used = new Map();
  const out = new Map();
  for (const key of groups) {
    let label = labelOf(key);
    if ((counts.get(label) || 0) > 1 && key.startsWith("id:")) {
      const entry = byId.get(key.slice(3));
      const tail = String(entry?.path || "").replace(/[\\/]+$/, "").split(/[\\/]/).slice(-2, -1)[0];
      if (tail) {
        label = `${label} · ${tail}`;
      } else {
        const n = (used.get(label) || 0) + 1;   // 连路径尾段都一样（极端情况）就编号，绝不重名
        used.set(label, n);
        label = `${label} (${n})`;
      }
    }
    out.set(key, label);
  }
  return out;
}

/**
 * 会话 → 四态之一。
 * activeConvId 是"此刻屏幕上正在生成"的那一场；runningConvIds 是登记表里全部在跑的
 * 那些（并行时后台那几场也在跑，只点亮 activeConvId 会让它们看着像已经停了）。
 * 两者都只来自实时参数，绝不进 taskFlags——进行中是"这一刻"的事实，不是结局。
 */
export function taskStatusOf(conv, { flags = {}, activeConvId = "", runningConvIds = null } = {}) {
  const id = conv?.id;
  if (!id) return STATUS.IDLE;
  if (activeConvId && activeConvId === id) return STATUS.RUNNING;
  if (runningConvIds?.has(id)) return STATUS.RUNNING;
  const flag = normalizeTaskFlag(flags[id]);
  if (!flag) return STATUS.IDLE;
  const updatedS = Number(conv.updated_at) || 0;
  if (updatedS && flag.at / 1000 < updatedS - STALE_TOLERANCE_S) return STATUS.IDLE;
  if (flag.kind === "error") return STATUS.ERROR;
  if (flag.kind === "needs") return STATUS.NEEDS;
  return flag.seen ? STATUS.IDLE : STATUS.UNREAD;
}

export function statusMark(status) {
  return STATUS_MARKS[status] || STATUS_MARKS[STATUS.IDLE];
}

/**
 * 徽标的单一定义：classic 的 .conv-item-status 与 Codex 的同一枚标识都从这里取，
 * 两处渲染只差外层容器类名，图标/文案/色调（data-status 驱动 CSS）不会再各写一份。
 * idle 返回 null —— 没有状态就是没有徽标，不画一个"正常"占位。
 */
export function statusBadge(status) {
  const mark = statusMark(status);
  if (!mark.icon) return null;
  return { className: "conv-item-status", status, icon: mark.icon, label: mark.label };
}

function recencyOf(conv) {
  return Number(conv?.updated_at) || 0;
}

function compareByMode(a, b, mode, ctx) {
  switch (mode) {
    case "project": {
      const pa = projectGroupKey(a, ctx?.registry), pb = projectGroupKey(b, ctx?.registry);
      if (pa !== pb) {
        // 未分类永远垫底，其余按名称：项目多的时候"没有项目"混在中间最难找
        if (pa === "none") return 1;
        if (pb === "none") return -1;
        return projectLabel(a).localeCompare(projectLabel(b), "zh-Hans-CN");
      }
      return 0;
    }
    case "status":
      return statusMark(taskStatusOf(a, ctx)).rank - statusMark(taskStatusOf(b, ctx)).rank;
    case "created":
      return (Number(b?.created_at) || 0) - (Number(a?.created_at) || 0);
    case "usage":
      return (Number(b?.total_tokens) || 0) - (Number(a?.total_tokens) || 0);
    default:
      return recencyOf(b) - recencyOf(a);
  }
}

/** 返回新数组：主键按 mode，一律以"最近更新"兜底，保证同键次序稳定 */
export function sortConversations(convs, mode, ctx = {}) {
  const key = normalizeTaskListSort(mode);
  return [...(Array.isArray(convs) ? convs : [])].sort((a, b) => {
    const primary = compareByMode(a, b, key, ctx);
    if (primary) return primary;
    return recencyOf(b) - recencyOf(a);
  });
}

/**
 * 项目分组：分组顺序跟随同一排序偏好（组序取组内最佳条目），组内条目同样按偏好排。
 * 返回 `[[标签, 会话[], {projectId}], …]` —— 第三项是给组头操作用的，
 * 老调用点解构前两项照样能用，不必一起改。
 */
export function groupConversationsByProject(convs, mode, ctx = {}) {
  const key = normalizeTaskListSort(mode);
  const registry = Array.isArray(ctx?.registry) ? ctx.registry : [];
  const groups = new Map();
  for (const conv of Array.isArray(convs) ? convs : []) {
    const gk = projectGroupKey(conv, registry);
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(conv);
  }
  for (const list of groups.values()) list.sort((a, b) => compareByMode(a, b, key, ctx) || (recencyOf(b) - recencyOf(a)));
  const labels = groupLabels([...groups.keys()], registry, groups);
  // 按项目排时组名即主键；其余模式下组序按"组内最好的那条"跟随偏好
  const ordered = [...groups.entries()];
  if (key === "project") {
    ordered.sort((a, b) => {
      if (a[0] === b[0]) return 0;
      if (a[0] === "none") return 1;
      if (b[0] === "none") return -1;
      return labels.get(a[0]).localeCompare(labels.get(b[0]), "zh-Hans-CN");
    });
  } else {
    ordered.sort((a, b) => {
      const best = (list) => list[0];
      const head = compareByMode(best(a[1]), best(b[1]), key, ctx);
      return head || recencyOf(best(b[1])) - recencyOf(best(a[1]));
    });
  }
  return ordered.map(([gk, list]) => [labels.get(gk) || UNGROUPED, list, {
    projectId: gk.startsWith("id:") ? gk.slice(3) : "",
    projectName: labels.get(gk) || UNGROUPED,
  }]);
}
