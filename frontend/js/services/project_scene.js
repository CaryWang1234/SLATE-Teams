/**
 * 每项目现场：离开一个项目时记下"停在哪条会话、输入框里打了什么字"，回来时还原。
 *
 * 为什么单独一个模块而不是塞进 project_bar.js：现场横跨三处状态（当前会话、输入框草稿、
 * 在册清单），而触发点有两处——顶栏切换器和 Codex 侧栏的组头。两边各写一份还原逻辑，
 * 迟早出现"从顶栏切回去草稿在、从侧栏切回去草稿没了"。
 *
 * 草稿只存 2KB（后端 prefs 也按上限截断），它是"回来接着打字"，不是无限暂存区。
 * 还原时任何一项缺失就跳过那一项，绝不因为"上次没有会话"而报错或清空现有的东西。
 */

import { state, notify } from "../store.js?v=20261024-001";
import { getRegistry, patchRegistry, setActiveProject } from "./project.js?v=20261024-001";

const INPUT_SELECTOR = "#chat-input";

/** 拉一次在册清单进 store；后端是唯一真源，这里只缓存读视图。 */
async function refreshRegistry() {
  const res = await getRegistry();
  if (res?.code !== 0) return null;
  const list = Array.isArray(res.data?.projects) ? res.data.projects : [];
  state.projects = list;
  state.activeProjectId = res.data?.active || list.find(p => p?.active)?.id || "";
  notify("projects", list);
  return res.data;
}

function draftValue() {
  const el = document.querySelector(INPUT_SELECTOR);
  return el ? String(el.value || "") : "";
}

function setDraftValue(text) {
  const el = document.querySelector(INPUT_SELECTOR);
  if (!el) return;
  el.value = text || "";
  // 输入框有自适应高度逻辑，直接赋值不会重算，这里手动补一次
  el.style.height = "";
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 记下当前视野项目的现场（切走之前调用）。没有视野就是空操作。 */
async function saveScene() {
  const projectId = state.project?.project_id || "";
  if (!projectId) return false;
  const patch = {
    last_conversation_id: state.currentConversationId || "",
    draft: draftValue(),
  };
  const res = await patchRegistry(projectId, patch);
  if (res?.code === 0) {
    const entry = state.projects.find(p => p?.id === projectId);
    if (entry) entry.prefs = { ...(entry.prefs || {}), ...patch };
  }
  return res?.code === 0;
}

/**
 * 换视野并还原现场。
 * 顺序是刻意的：先记旧项目 → 切 active → 换 state.project → 还原会话 → 填草稿。
 * 反过来（先切再记）会把旧项目的草稿记到新项目头上。
 */
async function switchToProject(key) {
  const target = String(key || "").trim();
  if (!target) return { ok: false, reason: "empty" };
  if (state.project?.project_id && state.project.project_id === target) return { ok: true, reason: "same" };
  await saveScene();
  const res = await setActiveProject(target);
  if (res?.code !== 0) return { ok: false, reason: res?.message || "切换失败" };
  const project = res.data?.project || null;
  state.project = project;
  notify("project", project);
  await refreshRegistry();
  await restoreScene(project);
  return { ok: true, project };
}

/** 把某个项目的现场读出来并应用。
 *
 * chat.js 走动态 import：它会经由项目服务回到这里，顶层静态 import 就成了环
 * （ESM 循环下对面拿到的还是未初始化的绑定）。
 *
 * "目标项目没有现场"是一等情形，不是可以跳过的缺省分支：切到一个从没看过的项目，
 * 必须把上一个项目的会话和草稿清掉。留着不动就等于让用户以为两个项目共用一条对话，
 * 而这串台正是本功能要消灭的东西（浏览器走查 W2 就是钉这条）。
 */
async function restoreScene(project) {
  const projectId = project?.project_id || "";
  if (!projectId) return;
  const entry = state.projects.find(p => p?.id === projectId);
  const prefs = entry?.prefs || {};
  const wanted = String(prefs.last_conversation_id || "");
  const chat = await loadChatApi();
  if (!wanted) {
    setDraftValue("");
    if (state.currentConversationId && typeof chat?.startNewChat === "function") chat.startNewChat();
    return;
  }
  if (state.currentConversationId !== wanted) {
    // 会话可能早被删了：停在原地继续切换，别把整件事打断
    try { await chat?.openConversation?.(wanted); } catch (e) {}
  }
  // 只有确实落回"上次那条"才动草稿输入框；上次没留草稿时也要显式清空，
  // 否则屏幕上还是上一个项目的半截话，而且会被防抖写进新项目名下。
  if (state.currentConversationId === wanted) {
    setDraftValue(String(prefs.draft || ""));
  }
}

let chatApiPromise = null;

function loadChatApi() {
  if (!chatApiPromise) {
    chatApiPromise = import("../components/chat.js?v=20261024-001")
      .then(mod => mod || null)
      .catch(() => null);
  }
  return chatApiPromise;
}

export { refreshRegistry, saveScene, switchToProject, restoreScene, draftValue };
