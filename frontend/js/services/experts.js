/**
 * SLATE 专家包服务：zip 导入/导出、增删改查、文件管理。
 * 专家包结构：persona.md + rules.md + data.json + knowledge/ + skills/
 */

import { get, post, put, del, upload } from "./api.js?v=20261024-001";

/** 专家详情缓存（expertId -> detail），供对话团队注入时免重复请求 */
const expertCache = new Map();

async function loadExperts() {
  const res = await get("/experts");
  if (res.code !== 0) throw new Error(res.message || "专家包列表加载失败");
  return res.data || [];
}

async function getExpert(id, { force = false } = {}) {
  if (!force && expertCache.has(id)) return expertCache.get(id);
  const res = await get(`/experts/${id}`);
  if (res.code !== 0) throw new Error(res.message || "专家包加载失败");
  expertCache.set(id, res.data);
  return res.data;
}

async function createExpert({ name, description = "", persona = "", rules = "" }) {
  const res = await post("/experts", { name, description, persona, rules });
  if (res.code !== 0) throw new Error(res.message || "创建失败");
  return res.data.id;
}

async function saveExpert(id, payload) {
  const res = await put(`/experts/${id}`, payload);
  if (res.code !== 0) throw new Error(res.message || "保存失败");
  expertCache.delete(id);
}

async function deleteExpert(id) {
  const res = await del(`/experts/${id}`);
  if (res.code !== 0) throw new Error(res.message || "删除失败");
  expertCache.delete(id);
}

async function importExpertZip(file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await upload("/experts/import", fd);
  if (res.code !== 0) throw new Error(res.message || "导入失败");
  return res.data.id;
}

/** 导出 zip 的下载地址（浏览器直接下载） */
function expertExportUrl(id) {
  const origin = window.location.port === "8130" || window.location.protocol === "file:"
    ? `${window.location.protocol}//${window.location.hostname}:8130`
    : window.location.origin;
  return `${origin}/api/experts/${id}/export`;
}

async function uploadExpertFile(id, folder, file) {
  const fd = new FormData();
  fd.append("folder", folder);
  fd.append("file", file);
  const res = await upload(`/experts/${id}/files`, fd);
  if (res.code !== 0) throw new Error(res.message || "上传失败");
  expertCache.delete(id);
}

async function deleteExpertFile(id, folder, name) {
  const res = await del(`/experts/${id}/files?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`);
  if (res.code !== 0) throw new Error(res.message || "删除失败");
  expertCache.delete(id);
}

async function readExpertFile(id, folder, name) {
  const res = await get(`/experts/${id}/file?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`);
  if (res.code !== 0) throw new Error(res.message || "读取失败");
  return res.data.content;
}

/**
  * 构建专家注入提示词（persona + rules + 知识文件清单）。
  * detail 为 getExpert 返回的完整结果。
 */
function buildExpertPrompt(detail) {
  if (!detail) return "";
  const parts = [`[专家包· ${detail.name || "未命名"}]`];
  if (detail.persona?.trim()) {
    parts.push("[专家人格]");
    parts.push(detail.persona.trim());
  }
  if (detail.rules?.trim()) {
    parts.push("[专家规则]");
    parts.push(detail.rules.trim());
  }
  const knowledgeNames = (detail.knowledge || []).map(f => f.name).slice(0, 20);
  if (knowledgeNames.length) {
    parts.push(`[专家知识文件] ${knowledgeNames.join("、")}`);
  }
  return parts.length > 1 ? "\n\n" + parts.join("\n") : "";
}

export {
  loadExperts, getExpert, createExpert, saveExpert, deleteExpert,
  importExpertZip, expertExportUrl, uploadExpertFile, deleteExpertFile,
  readExpertFile, buildExpertPrompt, expertCache,
};
