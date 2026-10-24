/**
 * SLATE 项目栏组件：打开/关闭项目、文件树浏览
 */

import { state, subscribe, setProject, setProjectFileTree } from "../store.js?v=20261024-001";
import {
  openProject, closeProject, browseFiles, listDrives,
  createWorkspace, switchProjectRoot, editWorkspaceFolders,
  removeRegistry, patchRegistry,
} from "../services/project.js?v=20261024-001";
import { refreshRegistry, saveScene, switchToProject, restoreScene } from "../services/project_scene.js?v=20261024-001";
import { fileTypeIcon, extToLang } from "../services/file_icons.js?v=20261024-001";
import { iconSvgEl, setIconText } from "../services/icons.js?v=20261024-001";
import { t } from "../services/i18n.js?v=20261024-001";
import { dlgConfirm, dlgPrompt, dlgToast } from "../services/dialog.js?v=20261024-001";

let projectBar, projectOpenModal, projectPathInput, projectDrivesList, projectSidebar;
let workspaceNameInput, workspaceFoldersInput;
let fileTreeContainer, projectInfoEl, projectCloseBtn;
let currentBrowsePath = "";
let sidebarCollapsed = false;

// ── 项目栏渲染 ───────────────────────────────

function renderProjectBar() {
  if (!projectBar) return;
  const proj = state.project;
  const actions = document.createElement("div");
  actions.className = "project-bar-actions";

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "icon-btn";
  toggleBtn.textContent = sidebarCollapsed ? "›" : "‹";
  toggleBtn.title = sidebarCollapsed ? "展开项目栏" : "折叠项目栏";
  toggleBtn.addEventListener("click", toggleProjectSidebar);
  actions.appendChild(toggleBtn);

  if (proj) {
    projectBar.innerHTML = "";

    const info = document.createElement("div");
    info.className = "project-bar-info";

    // 项目名是切换器入口：一颗只读的名字标签没法表达"还有别的项目在册"这件事
    const name = document.createElement("button");
    name.type = "button";
    name.className = "project-bar-name project-bar-switch";
    name.textContent = proj.name;
    name.title = `${proj.workspace_dir || proj.path}\n${t("点击切换在册项目")}`;
    name.setAttribute("aria-haspopup", "menu");
    name.addEventListener("click", (e) => { e.stopPropagation(); toggleProjectSwitcher(name); });
    info.appendChild(name);

    const icon = document.createElement("span");
    icon.className = "project-bar-icon";
    icon.appendChild(iconSvgEl(proj.kind === "workspace" ? "copy" : "folder"));
    info.insertBefore(icon, name);

    if (proj.kind === "workspace") {
      const badge = document.createElement("span");
      badge.className = "project-bar-kind";
      badge.textContent = "工作区";
      badge.title = `${t("工作区包含 {n} 个文件夹", { n: (proj.roots || []).length })}，${t("当前")}: ${dirBase(proj.path)}`;
      info.appendChild(badge);
    }

    projectBar.appendChild(info);

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "icon-btn";
    refreshBtn.textContent = "↻";
    refreshBtn.title = "刷新项目";
    refreshBtn.addEventListener("click", () => handleRefreshProject(refreshBtn));
    actions.appendChild(refreshBtn);

    const understandBtn = document.createElement("button");
    understandBtn.className = "icon-btn";
    understandBtn.appendChild(iconSvgEl("book-open"));
    understandBtn.title = "Better Project Understanding：AI 扫描项目生成导览·百科与规则手册";
    understandBtn.addEventListener("click", () => {
      import("./understand.js?v=20261024-001")
        .then(({ openUnderstandModal }) => openUnderstandModal())
        .catch(() => {});
    });
    actions.appendChild(understandBtn);

    const reviewBtn = document.createElement("button");
    reviewBtn.className = "icon-btn";
    reviewBtn.appendChild(iconSvgEl("search"));
    reviewBtn.title = "Code Review\uff1aAI \u4ee3\u7801\u5ba1\u67e5\uff08git diff \u00b7 \u56db\u7ef4\u5ea6 \u00b7 \u884c\u7ea7\u8bc4\u8bba\uff09";
    reviewBtn.addEventListener("click", () => {
      import("./review.js?v=20261024-001")
        .then(({ openReviewModal }) => openReviewModal())
        .catch(() => {});
    });
    actions.appendChild(reviewBtn);


    const configBtn = document.createElement("button");
    configBtn.className = "icon-btn";
    configBtn.appendChild(iconSvgEl("settings"));
    configBtn.title = "项目设置";
    configBtn.addEventListener("click", openProjectSettings);
    actions.appendChild(configBtn);

    const closeBtn = document.createElement("button");
    closeBtn.className = "icon-btn";
    closeBtn.textContent = "×";
    // 这颗 × 不再"关闭项目"，只是把当前视野收起来：项目仍在册，从切换器点回来即可。
    // 文案要是还写"关闭项目"，用户就会以为点下去它的会话/宪法没了，于是不敢点。
    closeBtn.title = t("收起当前项目（仍保留，点项目名可切回）");
    closeBtn.addEventListener("click", handleCloseProject);
    actions.appendChild(closeBtn);

    projectBar.appendChild(actions);

    // 自动浏览根目录（数组自带 .entries 方法，判空必须按类型判，否则关项目后重开不会自动浏览）
    if (!Array.isArray(state.projectFileTree?.entries)) {

      refreshFileTree("");
    }
  } else {
    projectBar.innerHTML = "";

    const openBtn = document.createElement("button");
    openBtn.className = "project-bar-open";
    setIconText(openBtn, "folder-open", "打开项目…");
    openBtn.addEventListener("click", openProjectModal);
    projectBar.appendChild(openBtn);
    projectBar.appendChild(actions);

    // 清空文件树，显示占位
    if (fileTreeContainer) {
      fileTreeContainer.innerHTML = '<div class="file-tree-empty">打开项目以浏览文件</div>';
    }
  }
}

function toggleProjectSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  projectSidebar?.classList.toggle("collapsed", sidebarCollapsed);
  renderProjectBar();
}

// ── 项目切换器（在册清单一眼可切） ────────────────

let switcherEl = null;

function closeProjectSwitcher() {
  if (!switcherEl) return;
  switcherEl.remove();
  switcherEl = null;
  document.removeEventListener("click", onDocClickCloseSwitcher, true);
}

function onDocClickCloseSwitcher(e) {
  if (switcherEl && !switcherEl.contains(e.target)) closeProjectSwitcher();
}

function toggleProjectSwitcher(anchor) {
  if (switcherEl) { closeProjectSwitcher(); return; }
  void renderSwitcher(anchor);
}

async function renderSwitcher(anchor) {
  await refreshRegistry();
  if (switcherEl) closeProjectSwitcher();
  const list = Array.isArray(state.projects) ? state.projects : [];
  switcherEl = document.createElement("div");
  switcherEl.className = "project-switcher";
  switcherEl.setAttribute("role", "menu");

  const head = document.createElement("div");
  head.className = "project-switcher-head";
  head.textContent = t("在册项目");
  switcherEl.appendChild(head);

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "project-switcher-empty";
    empty.textContent = t("还没有在册项目，打开一个目录试试");
    switcherEl.appendChild(empty);
  }
  for (const entry of list) {
    switcherEl.appendChild(buildSwitcherRow(entry));
  }

  const foot = document.createElement("button");
  foot.type = "button";
  foot.className = "project-switcher-open";
  setIconText(foot, "folder-open", t("打开其他目录…"));
  foot.addEventListener("click", () => { closeProjectSwitcher(); openProjectModal(); });
  switcherEl.appendChild(foot);

  document.body.appendChild(switcherEl);
  const rect = anchor.getBoundingClientRect();
  switcherEl.style.left = `${Math.max(8, rect.left)}px`;
  switcherEl.style.top = `${rect.bottom + 6}px`;
  // 捕获阶段监听：菜单里的按钮也有 click 冒泡，冒泡版会把刚点的那一下当成"点外面"
  document.addEventListener("click", onDocClickCloseSwitcher, true);
}

function buildSwitcherRow(entry) {
  const row = document.createElement("div");
  row.className = "project-switcher-item" + (entry.active ? " active" : "") + (entry.archived ? " archived" : "");
  // 带 id 上 DOM：在册项目可以重名，按名字找行就会点错（走查踩过）
  row.dataset.projectId = String(entry.id || "");

  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "project-switcher-pick";
  pick.title = entry.path;
  const label = document.createElement("span");
  label.className = "project-switcher-name";
  label.textContent = entry.name || entry.id;
  pick.appendChild(label);
  if (entry.kind === "workspace") {
    const k = document.createElement("span");
    k.className = "project-switcher-kind";
    k.textContent = t("工作区");
    pick.appendChild(k);
  }
  if (entry.pinned) {
    const p = document.createElement("span");
    p.className = "project-switcher-pin";
    p.textContent = "★";
    p.title = t("已固定");
    pick.appendChild(p);
  }
  pick.addEventListener("click", async () => {
    closeProjectSwitcher();
    const out = await switchToProject(entry.id);
    if (!out.ok) dlgToast(out.reason || t("切换失败"), 3200);
  });
  row.appendChild(pick);

  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = "project-switcher-act";
  setIconText(pin, "star", entry.pinned ? t("取消固定") : t("固定"));
  pin.title = entry.pinned ? t("取消固定") : t("固定");
  pin.addEventListener("click", async () => {
    await patchRegistry(entry.id, { pinned: !entry.pinned });
    await refreshRegistry();
    if (state.project?.project_id === entry.id) setProject({ ...state.project });
  });
  row.appendChild(pin);

  const forget = document.createElement("button");
  forget.type = "button";
  forget.className = "project-switcher-act danger";
  setIconText(forget, "x", t("从最近移除"));
  // 移除只摘索引，删数据是另一件事，这里不问也不做——两个动作合并成一个按钮
  // 就会被用户当成"删除项目"而不敢点，或者当成"只是移除"而误删了数据。
  forget.title = t("从最近移除（不删除任何文件与会话）");
  forget.addEventListener("click", async () => {
    if (!await dlgConfirm(t("从清单移除「{name}」？会话、宪法与磁盘文件都会保留，只是不再出现在切换器里。", { name: entry.name || entry.id }), { okText: t("移除") })) return;
    await removeRegistry(entry.id);
    await refreshRegistry();
    if (state.project?.project_id === entry.id) setProject(null);
  });
  row.appendChild(forget);

  return row;
}

// ── 打开项目弹窗 ──────────────────────────────

async function openProjectModal() {
  projectPathInput.value = state._lastProjectPath || "";
  projectOpenModal.classList.remove("hidden");
  projectPathInput.focus();

  // 在册项目排在弹窗最前面：绝大多数时候用户要的是"回到开过的那个"，不是重新找路径
  await refreshRegistry();
  renderRegistryList();

  // 加载磁盘列表
  const res = await listDrives();
  if (res.code === 0) {
    renderDrivesList(res.data);
  }
}

function renderRegistryList() {
  const box = document.getElementById("project-registry-list");
  if (!box) return;
  box.innerHTML = "";
  const list = Array.isArray(state.projects) ? state.projects : [];
  if (!list.length) {
    const empty = document.createElement("span");
    empty.className = "project-registry-empty";
    empty.textContent = t("暂无在册项目，用下面的路径打开一个目录");
    box.appendChild(empty);
    return;
  }
  for (const entry of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "project-registry-item" + (entry.active ? " active" : "") + (entry.archived ? " archived" : "");
    btn.dataset.projectId = entry.id || "";
    btn.title = entry.path;
    const label = document.createElement("span");
    label.className = "project-registry-name";
    label.textContent = entry.name || entry.id;
    btn.appendChild(label);
    if (entry.pinned) {
      const star = document.createElement("span");
      star.className = "project-registry-pin";
      star.textContent = "★";
      btn.appendChild(star);
    }
    btn.addEventListener("click", async () => {
      const out = await switchToProject(entry.id);
      if (!out.ok) { dlgToast(out.reason || t("切换失败"), 3200); return; }
      projectOpenModal.classList.add("hidden");
      currentBrowsePath = "";
      await refreshFileTree("");
    });
    box.appendChild(btn);
  }
}

function renderDrivesList(drives) {
  if (!projectDrivesList) return;
  projectDrivesList.innerHTML = "";
  for (const d of drives) {
    const btn = document.createElement("button");
    btn.className = "project-drive-btn";
    btn.textContent = d.name;
    btn.title = d.path;
    btn.addEventListener("click", () => {
      projectPathInput.value = d.path;
    });
    projectDrivesList.appendChild(btn);
  }
}

async function handleOpenProject() {
  const path = projectPathInput.value.trim();
  if (!path) return;

  // 先记下旧项目的现场再开新的：不记就等于"打开新项目把上一个的草稿弄丢了"
  await saveScene();
  const res = await openProject(path);
  if (res.code === 0) {
    setProject(res.data);
    projectOpenModal.classList.add("hidden");
    await refreshRegistry();
    await restoreScene(res.data);
    // 自动浏览根目录
    currentBrowsePath = "";

    await refreshFileTree("");
  } else {
    dlgToast(res.message || "打开失败", 3200);
  }
}

async function handleCreateWorkspace() {
  const name = (workspaceNameInput?.value || "").trim();
  const folders = (workspaceFoldersInput?.value || "")
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!name) { dlgToast("请填写工作区名称", 2600); return; }
  if (!folders.length) { dlgToast("请至少填写一个文件夹路径", 2600); return; }
  const res = await createWorkspace(name, folders);
  if (res.code === 0) {
    setProject(res.data);
    projectOpenModal.classList.add("hidden");
    await refreshRegistry();
    currentBrowsePath = "";
    await refreshFileTree("");
  } else {
    dlgToast(res.message || "新建工作区失败", 3200);
  }
}

async function handleCloseProject() {
  if (!await dlgConfirm(t("收起当前项目？会话、宪法与文件都不受影响。"), { okText: t("收起") })) return;
  await saveScene();
  await closeProject();
  setProject(null);
  setProjectFileTree([]);
  await refreshRegistry();
}

async function handleRefreshProject(button) {
  if (!state.project) return;
  // 工作区要重开宿主目录：开当前根会把它降级成普通单目录项目
  const path = state.project.workspace_dir || state.project.path;
  const browsePath = currentBrowsePath || "";
  if (button) button.disabled = true;
  try {
    const opened = await openProject(path);
    if (opened.code === 0) {
      setProject(opened.data);
    }
    const refreshed = await refreshFileTree(browsePath);
    if (!refreshed && browsePath) {
      await refreshFileTree("");
    }
  } finally {
    if (button) button.disabled = false;
  }
}

// ── 工作区：成员目录与当前根 ────────────────────

function dirBase(p) {
  return String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(p || "");
}

async function applyWorkspaceResult(res, keptBrowse) {
  if (res.code !== 0) {
    dlgToast(res.message || "操作失败", 3200);
    return false;
  }
  setProject(res.data);
  if (!keptBrowse) currentBrowsePath = "";
  await refreshFileTree(keptBrowse || "");
  return true;
}

async function handleSwitchRoot(rootPath) {
  if (!state.project || rootPath === state.project.path) return;
  await applyWorkspaceResult(await switchProjectRoot(rootPath));
}

async function handleAddRoot() {
  const raw = await dlgPrompt("文件夹的绝对路径：", { title: "添加到工作区", placeholder: "C:\\Users\\...\\other" });
  const path = (raw || "").trim();
  if (!path) return;
  await applyWorkspaceResult(await editWorkspaceFolders("add", path), currentBrowsePath);
}

async function handleRemoveRoot(rootPath) {
  const ok = await dlgConfirm(t("从工作区移除「{name}」？磁盘上的文件不会被删除。", { name: dirBase(rootPath) }),
    { danger: true, okText: t("移除") });
  if (!ok) return;
  const kept = rootPath === state.project?.path ? "" : currentBrowsePath;
  await applyWorkspaceResult(await editWorkspaceFolders("remove", rootPath), kept);
}

function renderWorkspaceRoots() {
  const proj = state.project;
  if (!proj || proj.kind !== "workspace") return null;
  const roots = Array.isArray(proj.roots) ? proj.roots : [];

  const row = document.createElement("div");
  row.className = "workspace-roots";

  for (const r of roots) {
    const active = r === proj.path;
    const chip = document.createElement("button");
    chip.className = `workspace-root-chip${active ? " active" : ""}`;
    chip.title = active ? `${r}（${t("当前工作文件夹")}）` : `${t("切换到")} ${r}`;
    const label = document.createElement("span");
    label.className = "workspace-root-name";
    label.textContent = dirBase(r);
    chip.appendChild(label);
    chip.addEventListener("click", () => handleSwitchRoot(r));
    if (roots.length > 1) {
      const x = document.createElement("span");
      x.className = "workspace-root-remove";
      x.textContent = "×";
      x.title = `${t("从工作区移除")} ${r}`;
      x.addEventListener("click", (e) => { e.stopPropagation(); handleRemoveRoot(r); });
      chip.appendChild(x);
    }
    row.appendChild(chip);
  }

  const add = document.createElement("button");
  add.className = "workspace-root-add";
  add.textContent = "＋";
  add.title = "把一个文件夹加入本工作区";
  add.addEventListener("click", handleAddRoot);
  row.appendChild(add);

  return row;
}

// ── 文件树 ───────────────────────────────────

let fileTreeSeq = 0;

async function refreshFileTree(path) {
  const seq = ++fileTreeSeq;
  const res = await browseFiles(path);
  if (seq !== fileTreeSeq) return false; // 已有更新的刷新请求，丢弃过期响应
  if (res.code === 0) {
    setProjectFileTree(res.data);
    currentBrowsePath = res.data.path || "";
    renderFileTree();
    return true;
  }
  return false;
}

function renderFileTree() {
  if (!fileTreeContainer) return;
  fileTreeContainer.innerHTML = "";

  const rootsRow = renderWorkspaceRoots();
  const data = state.projectFileTree;
  if (!Array.isArray(data?.entries)) {
    fileTreeContainer.innerHTML = '<div class="file-tree-empty">未浏览目录</div>';
    if (rootsRow) fileTreeContainer.prepend(rootsRow);
    return;
  }
  if (rootsRow) fileTreeContainer.appendChild(rootsRow);

  // 面包屑导入
  if (currentBrowsePath && currentBrowsePath !== ".") {

    const breadcrumb = document.createElement("div");
    breadcrumb.className = "file-tree-breadcrumb";
    const rootLink = document.createElement("span");
    rootLink.textContent = state.project?.name || "/";
    rootLink.className = "file-tree-link";
    rootLink.addEventListener("click", () => refreshFileTree(""));
    breadcrumb.appendChild(rootLink);

    const parts = currentBrowsePath.split(/[/\\]/).filter(Boolean);
    let accumulated = "";
    for (const part of parts) {
      accumulated += (accumulated ? "/" : "") + part;
      const sep = document.createElement("span");
      sep.textContent = " / ";
      sep.className = "file-tree-sep";
      breadcrumb.appendChild(sep);

      const link = document.createElement("span");
      link.textContent = part;
      link.className = "file-tree-link";
      const targetPath = accumulated;
      link.addEventListener("click", () => refreshFileTree(targetPath));
      breadcrumb.appendChild(link);
    }

    fileTreeContainer.appendChild(breadcrumb);
  }

  // 返回上级
  if (currentBrowsePath && currentBrowsePath !== ".") {
    const parentBtn = document.createElement("div");
    parentBtn.className = "file-tree-item file-tree-dir";
    parentBtn.textContent = "↰ ..";
    parentBtn.addEventListener("click", () => {
      const parts = currentBrowsePath.split(/[/\\]/).filter(Boolean);
      parts.pop();
      refreshFileTree(parts.join("/"));
    });
    fileTreeContainer.appendChild(parentBtn);
  }

  // 文件和目录
  for (const entry of data.entries) {

    const item = document.createElement("div");
    item.className = `file-tree-item ${entry.type === "dir" ? "file-tree-dir" : "file-tree-file"}`;

    item.innerHTML = fileTypeIcon(entry.name, { dir: entry.type === "dir" });
    const nameSpan = document.createElement("span");
    nameSpan.className = "file-tree-name";
    nameSpan.textContent = entry.name;
    item.appendChild(nameSpan);

    if (entry.type === "dir") {
      item.addEventListener("click", () => refreshFileTree(entry.path));
    } else {
      item.addEventListener("click", () => openFile(entry.path));
      if (entry.size != null) {
        const size = document.createElement("span");
        size.className = "file-tree-size";
        size.textContent = entry.size < 1024 ? `${entry.size}B`
          : entry.size < 1048576 ? `${(entry.size / 1024).toFixed(1)}K`
          : `${(entry.size / 1048576).toFixed(1)}M`;
        item.appendChild(size);
      }
    }

    fileTreeContainer.appendChild(item);
  }
}

let filePreviewEl;

async function openFile(path) {
  if (!filePreviewEl) filePreviewEl = document.getElementById("file-preview");
  const res = await browseFiles(path);
  if (res.code !== 0 || res.data.type !== "file") return;

  const { name, content, size } = res.data;
  filePreviewEl.innerHTML = "";
  filePreviewEl.classList.remove("hidden");

  // 标题
  const header = document.createElement("div");

  header.className = "file-preview-header";

  const title = document.createElement("span");
  title.className = "file-preview-title";
  title.innerHTML = fileTypeIcon(name, { size: 13 });
  const titleText = document.createElement("span");
  titleText.textContent = name;
  title.appendChild(titleText);
  title.title = path;
  header.appendChild(title);

  const actions = document.createElement("div");
  actions.className = "file-preview-actions";

  const insertBtn = document.createElement("button");
  insertBtn.className = "icon-btn";
  insertBtn.textContent = "＋";
  insertBtn.title = "插入到聊天";
  insertBtn.addEventListener("click", () => {
    const chatInput = document.getElementById("chat-input");
    if (chatInput) {
      const snippet = `\n[文件: ${name}]\n\`\`\`\n${(content || "").slice(0, 5000)}\n\`\`\``;
      chatInput.value += snippet;
      chatInput.focus();
    }
  });
  actions.appendChild(insertBtn);

  const closeBtn = document.createElement("button");
  closeBtn.className = "icon-btn";
  closeBtn.textContent = "×";
  closeBtn.title = "关闭预览";
  closeBtn.addEventListener("click", () => {
    filePreviewEl.classList.add("hidden");
    filePreviewEl.innerHTML = "";
  });
  actions.appendChild(closeBtn);

  header.appendChild(actions);
  filePreviewEl.appendChild(header);

  // 文件内容（按扩展名语法高亮，未知类型走 highlightAuto）
  const pre = document.createElement("pre");

  pre.className = "file-preview-content";
  const text = (content || "(空文件)").slice(0, 10000);
  let highlighted = false;
  if (content && window.hljs) {
    try {
      const lang = extToLang(name);
      if (lang && lang !== "plaintext" && hljs.getLanguage(lang)) {
        pre.innerHTML = hljs.highlight(text, { language: lang }).value;
      } else if (lang !== "plaintext") {
        pre.innerHTML = hljs.highlightAuto(text).value;
      }
      if (pre.innerHTML) {
        pre.classList.add("hljs");
        highlighted = true;
      }
    } catch { /* 高亮失败则退回纯文本 */ }
  }
  if (!highlighted) pre.textContent = text;
  filePreviewEl.appendChild(pre);
}

// ── 项目设置 ──────────────────────────────────

function openProjectSettings() {
  window.dispatchEvent(new CustomEvent("slate:open-settings", { detail: { focusConstitution: true } }));
}

// ── 现场自动记录 ──────────────────────────────
//
// 只靠"切走之前存一次"是不够的：浏览器被直接关掉时没人调用过切换器。
// 所以切会话与打字都触发一次防抖写盘。防抖窗口取 1.5s——再短就成了每次击键一个请求，
// 再长则用户"打完字立刻关窗口"会丢最后一段；丢一段草稿可接受，卡输入不可接受。

let sceneSaveTimer = null;

function queueSceneSave() {
  if (!state.project?.project_id) return;
  if (sceneSaveTimer) clearTimeout(sceneSaveTimer);
  sceneSaveTimer = setTimeout(() => {
    sceneSaveTimer = null;
    void saveScene();
  }, 1500);
}

// ── 初始化 ───────────────────────────────────

function initProjectBar() {
  projectBar = document.getElementById("project-bar");
  projectSidebar = document.getElementById("project-sidebar");
  fileTreeContainer = document.getElementById("project-file-tree");
  projectOpenModal = document.getElementById("project-open-modal");
  projectPathInput = document.getElementById("project-path-input");
  projectDrivesList = document.getElementById("project-drives-list");
  workspaceNameInput = document.getElementById("workspace-name-input");
  workspaceFoldersInput = document.getElementById("workspace-folders-input");

  // 打开项目按钮
  const btnConfirmOpen = document.getElementById("btn-confirm-open-project");
  if (btnConfirmOpen) {
    btnConfirmOpen.addEventListener("click", handleOpenProject);
  }

  const btnCreateWs = document.getElementById("btn-create-workspace");
  if (btnCreateWs) {
    btnCreateWs.addEventListener("click", handleCreateWorkspace);
  }

  // 路径输入回车
  if (projectPathInput) {
    projectPathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleOpenProject();
    });
  }

  // 关闭弹窗
  if (projectOpenModal) {
    projectOpenModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
      el.addEventListener("click", () => projectOpenModal.classList.add("hidden"));
    });
  }

  // 订阅项目状态变化
  subscribe("project", renderProjectBar);

  subscribe("projectFileTree", renderFileTree);

  // 现场记录挂在两条真实入口上：切会话、打字。都只防抖写服务端 prefs，不重绘任何东西。
  window.addEventListener("slate:conv-active-changed", queueSceneSave);
  document.addEventListener("input", (e) => {
    if (e.target && e.target.id === "chat-input") queueSceneSave();
  });
  window.addEventListener("beforeunload", () => {
    // 关窗口前把定时器兑现成一次真实写入（navigator.sendBeacon 那套对本地后端没必要）
    if (sceneSaveTimer) { clearTimeout(sceneSaveTimer); sceneSaveTimer = null; void saveScene(); }
  });
  void refreshRegistry();

  // 初始渲染
  renderProjectBar();
}

export { initProjectBar };
