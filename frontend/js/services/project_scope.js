/**
 * 项目现场解析（并行运行的"这一场在哪个项目里干活"）
 *
 * 一句话：`state.project` 是"用户正在看的那一个"，而后台那一场要按它**自己**的项目
 * 落文件、开终端、读宪法。两者混用的话，用户在 A 项目里点一下，B 项目的任务就把
 * 文件写进了 A —— 这是并行最坏的一种串台，所以单独收在一处。
 *
 * 缓存只存"读到的现场"，不存 active：active 由后端 projects.json 说话，这里跟着
 * 注册表快照一起失效（换项目/删项目后重新取，不拿旧 path 去猜新项目）。
 */

import { state } from "../store.js?v=20261024-001";
import { get } from "./api.js?v=20261024-001";

const cache = new Map();   // project_id -> info（含 project_id / path / name / constitution）

/** 视野内那一项直接用 state.project：它已经带着前端展开好的字段，也不必多发一次请求 */
export function projectScopeOf(projectId = "") {
  const id = String(projectId || state.project?.project_id || "");
  if (!id) return null;
  if (id === String(state.project?.project_id || "")) return state.project;
  return cache.get(id) || null;
}

/**
 * 取一个项目的现场（有缓存就用，没有去后端读一次）。
 * 读不到就返回 null：调用方要**停下来问用户**，而不是退回 state.project——
 * 退回就等于把 B 项目的活儿干到 A 项目目录里。
 */
export async function ensureProjectScope(projectId = "") {
  const id = String(projectId || "");
  if (!id) return state.project || null;
  const hit = projectScopeOf(id);
  if (hit) return hit;
  const res = await get(`/projects/registry/${encodeURIComponent(id)}/info`);
  if (res.code !== 0 || !res.data?.path) return null;
  const info = { ...res.data, project_id: id };
  cache.set(id, info);
  return info;
}

export function forgetProjectScope(projectId = "") {
  cache.delete(String(projectId || ""));
}

/** 换项目 / 注册表变了：把除视野外的缓存全丢掉（磁盘上的宪法可能刚被改过） */
export function invalidateProjectScopes() {
  const activeId = String(state.project?.project_id || "");
  for (const key of [...cache.keys()]) if (key !== activeId) cache.delete(key);
  for (const key of [...catalogs.keys()]) if (key !== activeId) catalogs.delete(key);
}

/**
 * 一场生成用哪份宪法：它自己的项目那份，而不是"现在屏幕上那个项目"的。
 * 视野外的项目还没取到现场时回落全局——宁可用无项目规则的默认档，
 * 也不能拿别的项目的规则去约束这一场。
 */
export function constitutionForScope(project) {
  if (!project) return state.constitution;
  if (String(project.project_id || "") === String(state.project?.project_id || "")) {
    const own = state.project?.constitution;
    return own && typeof own === "object" ? own : state.constitution;
  }
  const own = project?.constitution;
  return own && typeof own === "object" ? own : state.constitution;
}

// ── 分项目的生效清单（Action 目录 / 远程 MCP 工具） ──────────────
/*
 * 与宪法同一套口径：全局版本是"屏幕上这个项目的生效版"，后台那场要读自己项目的
 * 生效版（同名 Action 顶掉全局、被掩码关掉的服务器整个不进清单）。
 * 快照由调用方在开场前取好，注入时同步读——组装系统提示是同步的，不能在那儿发请求。
 */
const catalogs = new Map();   // project_id -> { actions, remoteTools }

function activeCatalog() {
  return {
    actions: Array.isArray(state.actions) ? state.actions : [],
    remoteTools: Array.isArray(state.skills?.remoteTools) ? state.skills.remoteTools : [],
  };
}

/** 视野内（或没有项目）直接用 store 快照：那两份本来就是按当前项目取回来的。 */
export function catalogForScope(project = null) {
  const id = String(project?.project_id || "");
  if (!id || id === String(state.project?.project_id || "")) return activeCatalog();
  return catalogs.get(id) || activeCatalog();
}

/** 取一个项目的生效清单（有缓存就用）。取不到不报错：宁可退回全局版本，也不让一场任务卡死。 */
export async function ensureScopeCatalog(project = null) {
  const id = String(project?.project_id || "");
  if (!id || id === String(state.project?.project_id || "")) return activeCatalog();
  const hit = catalogs.get(id);
  if (hit) return hit;
  const next = { actions: [], remoteTools: [] };
  try {
    const res = await get(`/actions?project=${encodeURIComponent(id)}`);
    if (res.code === 0) next.actions = res.data?.actions || [];
  } catch { /* 静默：下面按空清单回落 */ }
  try {
    const res = await get(`/skills?project=${encodeURIComponent(id)}`);
    if (res.code === 0) next.remoteTools = res.data?.remoteTools || [];
  } catch { /* 静默 */ }
  // 两个都读空 ≈ 请求全挂了，这时拿全局版本兜底比"这个项目看起来没有工具"更接近事实。
  if (!next.actions.length && !next.remoteTools.length) return activeCatalog();
  catalogs.set(id, next);
  return next;
}

/** 项目版本改过了（写 Action / 换掩码）：丢掉缓存，下一场重新取。 */
export function forgetScopeCatalog(projectId = "") {
  const id = String(projectId || "");
  if (!id) catalogs.clear();
  else catalogs.delete(id);
}

