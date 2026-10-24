/**
 * SLATE 项目服务：封装项目相关 API
 *
 * 多项目之后的口径（backend/project_registry.py）：**在册**的项目全部留在服务端的
 * `data/projects.json`，**正在看的那一个**（active）仍只有一个，所以这里的
 * `getCurrentProject()` 语义与以前一样；新增的是"切换而不丢失"和"按项目寻址"。
 * 除 openProject/closeProject 之外，每个函数都可以带 projectId 去打别的项目，
 * 不带就是当前视野——老调用点一行不改也照旧。
 */

import { get, post, put, patch, del } from "./api.js?v=20261024-001";

async function openProject(path) {
  return post("/projects/open", { path });
}

async function getCurrentProject() {
  return get("/projects/current");
}

async function closeProject() {
  return post("/projects/close");
}

/** 在册清单：[{id,path,name,kind,pinned,archived,active,prefs{…}}, …]，服务端已排好序 */
async function getRegistry() {
  return get("/projects/registry");
}

/** 把某个在册项目设为"正在看的那一个"。只改视野，不碰任何在跑的东西。 */
async function setActiveProject(project) {
  return post("/projects/active", { project });
}

/** 改一条在册记录：pinned/archived 或现场（lastConversationId/draft/scroll/boardId/modelId/muted） */
async function patchRegistry(projectId, data) {
  return patch(`/projects/registry/${encodeURIComponent(projectId)}`, data || {});
}

/** 从册上移除。默认只摘索引；forget=true 才连带删 SLATE 私有的 data/projects/<id>/。 */
async function removeRegistry(projectId, forget = false) {
  return del(`/projects/registry/${encodeURIComponent(projectId)}${forget ? "?forget=true" : ""}`);
}

/** 把旧名称/旧 id 记成别名，用于"把这些未归类会话归到本项目" */
async function addProjectAliases(projectId, aliases) {
  return post(`/projects/registry/${encodeURIComponent(projectId)}/alias`, { aliases: aliases || [] });
}

async function updateProjectConfig(config, projectId = "") {
  return put("/projects/config", { config, project: projectId });
}

async function browseFiles(path = "", projectId = "") {
  return post("/projects/browse", { path, project: projectId });
}

async function listDrives() {
  return get("/projects/drives");
}

async function createWorkspace(name, folders) {
  return post("/projects/workspace", { name, folders });
}

async function switchProjectRoot(path, projectId = "") {
  return post("/projects/root", { path, project: projectId });
}

async function editWorkspaceFolders(action, path, projectId = "") {
  return post("/projects/workspace/folders", { action, path, project: projectId });
}

export {
  openProject, getCurrentProject, closeProject, updateProjectConfig,
  browseFiles, listDrives, createWorkspace, switchProjectRoot, editWorkspaceFolders,
  getRegistry, setActiveProject, patchRegistry, removeRegistry, addProjectAliases,
};
