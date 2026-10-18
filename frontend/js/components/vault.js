/**
 * SLATE 文库组件：Obsidian 风格的 Markdown 笔记管理
 * 文件夹/笔记树形浏览、编辑器+实时预览、[[wiki-link]] 双向链接、搜索与标签
 */

import { get, post, put, del } from "../services/api.js?v=20261017-001";
import { renderMarkdown } from "../services/markdown.js?v=20261017-001";
import { dlgConfirm, dlgPrompt } from "../services/dialog.js?v=20261017-001";
import { t } from "../services/i18n.js?v=20261017-001";
import { iconSvgEl } from "../services/icons.js?v=20261017-001";

let vaultSidebar, vaultEditorEmpty, vaultEditorActive;
let vaultSearchInput, vaultTagsBar;
let vaultNoteTitle, vaultNoteTags, vaultNoteSource, vaultNotePreview;
let vaultBacklinks;

let vaultTree = [];
let currentNotePath = "";
let currentNoteDirty = false;
let allTags = [];
let activeTagFilter = "";
let previewTimer = null;

// ── 工具函数 ───────────────────────────────────────────────────────────────

async function toast(msg) {
  try {
    const { toast: showToast } = await import("../app.js?v=20261017-001");
    showToast(msg);
  } catch { console.warn(msg); }
}

/** 从路径中提取笔记名（不含扩展名） */
function noteNameFromPath(path) {
  const name = path.split("/").pop() || path;
  return name.replace(/\.md$/, "");
}

/** 按路径段编码，避免 # ? 等字符截断 URL */
function encodeVaultPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** 渲染 wiki-link 为可点击 HTML */
function renderWikiLinks(html) {
  return html.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_, target, display) => {
      const label = display || target;
      return `<a class="vault-wikilink" data-target="${target.trim()}" title="${target.trim()}">${label}</a>`;
    }
  );
}

/** 渲染 Markdown 并处理 wiki-link */
function renderVaultMarkdown(text) {
  const html = renderMarkdown(text);
  return renderWikiLinks(html);
}

// ── 目录树渲染 ─────────────────────────────────────────────────────────────

async function loadVaultTree() {
  try {
    const res = await get("/vault/tree");
    if (res.code === 0) {
      vaultTree = res.data || [];
    }
  } catch (e) {
    vaultTree = [];
  }
  renderVaultTree();
}

function renderVaultTree() {
  if (!vaultSidebar) return;
  vaultSidebar.innerHTML = "";

  if (vaultTree.length === 0) {
    vaultSidebar.innerHTML = '<div class="vault-empty">文库是空的<br><small>点击上方按钮新建笔记或文件夹</small></div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  renderTreeItems(vaultTree, fragment, 0);
  vaultSidebar.appendChild(fragment);
}

function renderTreeItems(items, container, depth) {
  for (const item of items) {
    const el = document.createElement("div");
    el.className = "vault-tree-item";
    el.style.paddingLeft = `${depth * 16 + 8}px`;

    if (item.type === "folder") {
      el.classList.add("vault-tree-folder");
      const arrow = document.createElement("span");
      arrow.className = "vault-tree-arrow";
      arrow.textContent = "▶";
      el.appendChild(arrow);

      const icon = document.createElement("span");
      icon.className = "vault-tree-icon";
      icon.appendChild(iconSvgEl("folder"));
      el.appendChild(icon);

      const name = document.createElement("span");
      name.className = "vault-tree-name";
      name.textContent = item.name;
      el.appendChild(name);

      const actions = document.createElement("span");
      actions.className = "vault-tree-actions";
      const addNoteBtn = document.createElement("button");
      addNoteBtn.className = "icon-btn";
      addNoteBtn.textContent = "+";
      addNoteBtn.title = "在此文件夹新建笔记";
      addNoteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        createNewNote(item.path + "/");
      });
      actions.appendChild(addNoteBtn);
      el.appendChild(actions);

      el.addEventListener("click", () => {
        el.classList.toggle("collapsed");
        const children = el.nextElementSibling;
        if (children && children.classList.contains("vault-tree-children")) {
          children.classList.toggle("hidden");
          arrow.textContent = el.classList.contains("collapsed") ? "▶" : "▼";
        }
      });

      container.appendChild(el);

      const childContainer = document.createElement("div");
      childContainer.className = "vault-tree-children";
      renderTreeItems(item.children || [], childContainer, depth + 1);
      container.appendChild(childContainer);

    } else if (item.type === "note") {
      el.classList.add("vault-tree-note");
      if (item.path === currentNotePath) {
        el.classList.add("active");
      }

      const icon = document.createElement("span");
      icon.className = "vault-tree-icon";
      icon.appendChild(iconSvgEl("file"));
      el.appendChild(icon);

      const name = document.createElement("span");
      name.className = "vault-tree-name";
      name.textContent = item.name;
      el.appendChild(name);

      const delBtn = document.createElement("button");
      delBtn.className = "icon-btn vault-tree-del";
      delBtn.textContent = "×";
      delBtn.title = "删除";
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!await dlgConfirm(t("删除笔记「{name}」？", { name: item.name }), { danger: true, okText: "删除" })) return;
        try {
          const res = await del(`/vault/note/${encodeVaultPath(item.path)}`);
          if (res.code !== 0) {
            await toast(t("删除失败: {msg}", { msg: res.message }));
            return;
          }
        } catch (err) {
          await toast(t("删除失败: {msg}", { msg: err.message }));
          return;
        }
        if (currentNotePath === item.path) {
          currentNotePath = "";
          showEditorEmpty();
        }
        await loadVaultTree();
        loadAllTags();
      });
      el.appendChild(delBtn);

      el.addEventListener("click", () => openNote(item.path));
      container.appendChild(el);
    }
  }
}

// ── 笔记编辑 ───────────────────────────────────────────────────────────────

async function openNote(path) {
  if (currentNoteDirty && currentNotePath) {
    if (!await dlgConfirm("当前笔记未保存，是否放弃更改？", { okText: "放弃" })) return;
  }

  try {
    const res = await get(`/vault/note/${encodeVaultPath(path)}`);
    if (res.code !== 0) {
      await toast(t("加载失败: {msg}", { msg: res.message }));
      return;
    }
    const data = res.data;
    currentNotePath = path;
    currentNoteDirty = false;

    vaultNoteTitle.value = data.title || noteNameFromPath(path);
    vaultNoteTags.value = (data.tags || []).join(", ");
    vaultNoteSource.value = data.content || "";
    updatePreview();
    showEditorActive();
    loadBacklinks(noteNameFromPath(path));
    renderVaultTree();
  } catch (e) {
    await toast(t("加载笔记失败: {msg}", { msg: e.message }));
  }
}

function updatePreview() {
  if (!vaultNotePreview) return;
  const source = vaultNoteSource.value || "";
  vaultNotePreview.innerHTML = renderVaultMarkdown(source);
  bindWikiLinkClicks(vaultNotePreview);
}

function bindWikiLinkClicks(container) {
  container.querySelectorAll(".vault-wikilink").forEach(link => {
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      const target = link.dataset.target;
      if (!target) return;
      // 尝试在文库中查找该笔记
      const found = findNoteInTree(vaultTree, target);
      if (found) {
        openNote(found);
      } else {
        const create = await dlgConfirm(t("笔记「{name}」不存在，是否创建？", { name: target }), { okText: "创建" });
        if (create) {
          createNewNote("", target);
        }
      }
    });
  });
}

function findNoteInTree(items, name) {
  for (const item of items) {
    if (item.type === "note" && item.name === name) return item.path;
    if (item.type === "folder" && item.children) {
      const found = findNoteInTree(item.children, name);
      if (found) return found;
    }
  }
  return null;
}

async function saveCurrentNote() {
  if (!currentNotePath) return;
  const content = vaultNoteSource.value || "";
  const tags = vaultNoteTags.value.split(",").map(t => t.trim()).filter(Boolean);
  const title = vaultNoteTitle.value.trim();

  try {
    const res = await put(`/vault/note/${encodeVaultPath(currentNotePath)}`, { content, tags, title });
    if (res.code === 0) {
      currentNoteDirty = false;
      await toast(t("笔记已保存"));
      await loadVaultTree();
      loadAllTags();
    } else {
      await toast(t("保存失败: {msg}", { msg: res.message }));
    }
  } catch (e) {
    await toast(t("保存失败: {msg}", { msg: e.message }));
  }
}

async function deleteCurrentNote() {
  if (!currentNotePath) return;
  if (!await dlgConfirm(t("删除当前笔记？"), { danger: true, okText: "删除" })) return;
  try {
    await del(`/vault/note/${encodeVaultPath(currentNotePath)}`);
    currentNotePath = "";
    currentNoteDirty = false;
    showEditorEmpty();
    await loadVaultTree();
    loadAllTags();
    await toast(t("笔记已删除"));
  } catch (e) {
    await toast(t("删除失败: {msg}", { msg: e.message }));
  }
}

// ── 新建笔记/文件夹 ────────────────────────────────────────────────────────

async function createNewNote(prefix = "", defaultName = "") {
  const name = await dlgPrompt(t("笔记名称："), { title: t("新建笔记"), value: defaultName });
  if (name === null || !name.trim()) return;
  const cleanName = name.trim().replace(/\.md$/, "");
  const path = prefix ? `${prefix}${cleanName}.md` : `${cleanName}.md`;

  try {
    const res = await post("/vault/note", { path, content: "", tags: [] });
    if (res.code === 0) {
      await loadVaultTree();
      openNote(res.data.path);
      await toast(t("笔记已创建"));
    } else {
      await toast(t("创建失败: {msg}", { msg: res.message }));
    }
  } catch (e) {
    await toast(t("创建失败: {msg}", { msg: e.message }));
  }
}

async function createNewFolder() {
  const name = await dlgPrompt(t("文件夹名称："), { title: t("新建文件夹") });
  if (name === null || !name.trim()) return;
  try {
    const res = await post("/vault/folder", { path: name.trim() });
    if (res.code === 0) {
      await loadVaultTree();
      await toast(t("文件夹已创建"));
    } else {
      await toast(t("创建失败: {msg}", { msg: res.message }));
    }
  } catch (e) {
    await toast(t("创建失败: {msg}", { msg: e.message }));
  }
}

// ── 搜索 ───────────────────────────────────────────────────────────────────

async function searchVault() {
  const query = vaultSearchInput.value.trim();
  if (!query && !activeTagFilter) {
    await loadVaultTree();
    return;
  }

  try {
    const res = await post("/vault/search", { query, tag: activeTagFilter });
    if (res.code === 0) {
      renderSearchResults(res.data || []);
    }
  } catch (e) {
    console.warn("搜索失败:", e);
  }
}

function renderSearchResults(results) {
  if (!vaultSidebar) return;
  vaultSidebar.innerHTML = "";

  if (results.length === 0) {
    vaultSidebar.innerHTML = '<div class="vault-empty">无搜索结果</div>';
    return;
  }

  for (const item of results) {
    const el = document.createElement("div");
    el.className = "vault-tree-item vault-tree-note vault-search-result";
    if (item.path === currentNotePath) el.classList.add("active");

    const icon = document.createElement("span");
    icon.className = "vault-tree-icon";
    icon.appendChild(iconSvgEl("file"));
    el.appendChild(icon);

    const nameWrap = document.createElement("span");
    nameWrap.className = "vault-search-result-info";
    const name = document.createElement("span");
    name.className = "vault-tree-name";
    name.textContent = item.title || noteNameFromPath(item.path);
    nameWrap.appendChild(name);

    if (item.snippet) {
      const snippet = document.createElement("span");
      snippet.className = "vault-search-snippet";
      snippet.textContent = item.snippet.slice(0, 80);
      nameWrap.appendChild(snippet);
    }
    el.appendChild(nameWrap);

    el.addEventListener("click", () => openNote(item.path));
    vaultSidebar.appendChild(el);
  }
}

// ── 标签 ───────────────────────────────────────────────────────────────────

async function loadAllTags() {
  try {
    const res = await get("/vault/tags");
    if (res.code === 0) {
      allTags = res.data || [];
      renderTagsBar();
    }
  } catch (e) {
    allTags = [];
  }
}

function renderTagsBar() {
  if (!vaultTagsBar) return;
  vaultTagsBar.innerHTML = "";

  if (allTags.length === 0) return;

  const allBtn = document.createElement("button");
  allBtn.className = "vault-tag-btn" + (!activeTagFilter ? " active" : "");
  allBtn.textContent = "全部";
  allBtn.addEventListener("click", () => {
    activeTagFilter = "";
    renderTagsBar();
    searchVault();
  });
  vaultTagsBar.appendChild(allBtn);

  for (const tag of allTags) {
    const btn = document.createElement("button");
    btn.className = "vault-tag-btn" + (activeTagFilter === tag.name ? " active" : "");
    btn.textContent = `#${tag.name} (${tag.count})`;
    btn.addEventListener("click", () => {
      activeTagFilter = tag.name;
      renderTagsBar();
      searchVault();
    });
    vaultTagsBar.appendChild(btn);
  }
}

// ── 反向链接 ───────────────────────────────────────────────────────────────

async function loadBacklinks(noteName) {
  if (!vaultBacklinks) return;
  vaultBacklinks.innerHTML = "";
  try {
    const res = await get(`/vault/backlinks/${encodeURIComponent(noteName)}`);
    if (res.code === 0 && res.data && res.data.length > 0) {
      for (const bl of res.data) {
        const link = document.createElement("a");
        link.className = "vault-backlink-item";
        link.textContent = bl.title || noteNameFromPath(bl.path);
        link.title = bl.snippet || "";
        link.addEventListener("click", () => openNote(bl.path));
        vaultBacklinks.appendChild(link);
      }
    } else {
      vaultBacklinks.innerHTML = '<span class="vault-backlinks-empty">无</span>';
    }
  } catch (e) {
    vaultBacklinks.innerHTML = '<span class="vault-backlinks-empty">无</span>';
  }
}

// ── UI 状态切换 ────────────────────────────────────────────────────────────

function showEditorEmpty() {
  if (vaultEditorEmpty) vaultEditorEmpty.classList.remove("hidden");
  if (vaultEditorActive) vaultEditorActive.classList.add("hidden");
}

function showEditorActive() {
  if (vaultEditorEmpty) vaultEditorEmpty.classList.add("hidden");
  if (vaultEditorActive) vaultEditorActive.classList.remove("hidden");
}

// ── 初始化 ─────────────────────────────────────────────────────────────────

function initVaultPanel() {
  vaultSidebar = document.getElementById("vault-sidebar");
  vaultEditorEmpty = document.getElementById("vault-editor-empty");
  vaultEditorActive = document.getElementById("vault-editor-active");
  vaultSearchInput = document.getElementById("vault-search-input");
  vaultTagsBar = document.getElementById("vault-tags-bar");
  vaultNoteTitle = document.getElementById("vault-note-title");
  vaultNoteTags = document.getElementById("vault-note-tags");
  vaultNoteSource = document.getElementById("vault-note-source");
  vaultNotePreview = document.getElementById("vault-note-preview");
  vaultBacklinks = document.getElementById("vault-backlinks");

  if (!vaultSidebar) return;

  // 新建笔记/文件夹按钮
  document.getElementById("btn-vault-new-note")?.addEventListener("click", () => createNewNote());
  document.getElementById("btn-vault-new-folder")?.addEventListener("click", () => createNewFolder());

  // 保存/删除
  document.getElementById("btn-vault-save")?.addEventListener("click", () => saveCurrentNote());
  document.getElementById("btn-vault-delete")?.addEventListener("click", () => deleteCurrentNote());

  // 搜索
  vaultSearchInput?.addEventListener("input", () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => searchVault(), 300);
  });
  vaultSearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchVault();
  });

  // 编辑器实时预览
  vaultNoteSource?.addEventListener("input", () => {
    currentNoteDirty = true;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => updatePreview(), 300);
  });

  // Ctrl+S 保存
  vaultNoteSource?.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      saveCurrentNote();
    }
  });

  showEditorEmpty();
}

async function openVaultPanel() {
  await loadVaultTree();
  await loadAllTags();
}

export { initVaultPanel, openVaultPanel };
