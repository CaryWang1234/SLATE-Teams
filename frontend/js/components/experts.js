/**
 * SLATE 专家包管理组件：列表 / 新建 / 导入导出 zip / 编辑 persona·rules / knowledge·skills 文件管理
 * 对话模式通过 #expert-select 注入；团队模式通过成员 expertId 注入
 */

import { state, setActiveExpertId } from "../store.js?v=20261017-001";
import {
  loadExperts, getExpert, createExpert, saveExpert, deleteExpert,
  importExpertZip, expertExportUrl, uploadExpertFile, deleteExpertFile,
} from "../services/experts.js?v=20261017-001";
import { dlgConfirm } from "../services/dialog.js?v=20261017-001";
import { t } from "../services/i18n.js?v=20261017-001";
import { setExtCount } from "./extensions.js?v=20261017-001";

let modal, expertListEl, extListEl, detailEmpty, detailForm;
let nameInput, descInput, personaInput, rulesInput;
let knowledgeListEl, skillsListEl;
let expertsCache = [];
let currentId = "";
let currentDetail = null;

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return `${n || 0} B`;
}

async function toast(msg) {
  try {
    const { toast: showToast } = await import("../app.js?v=20261017-001");
    showToast(msg);
  } catch {
    console.warn(msg);
  }
}

// ── 弹窗开关 ───────────────────────────────

function openExpertModal() {
  if (!modal) return;
  modal.classList.remove("hidden");
  refreshList();
}

function closeExpertModal() {
  modal?.classList.add("hidden");
}

// ── 列表 ────────────────────────────────────

async function refreshList(keepSelection = true) {
  try {
    expertsCache = await loadExperts();
  } catch (e) {
    expertsCache = [];
    await toast(t("专家包加载失败: {msg}", { msg: e.message }));
  }
  renderList();
  renderExtList();
  refreshExpertSelects();
  if (keepSelection && currentId && expertsCache.some(x => x.id === currentId)) {
    // 保持当前选中（保存后刷新场景）
  } else if (!keepSelection) {
    showEmpty();
  }
}

function renderList() {
  if (!expertListEl) return;
  expertListEl.innerHTML = "";
  if (expertsCache.length === 0) {
    expertListEl.innerHTML = '<div class="exp-list-empty">暂无专家包</div>';
    return;
  }
  for (const item of expertsCache) {
    const el = document.createElement("div");
    el.className = "exp-item" + (item.id === currentId ? " active" : "");
    el.dataset.expertId = item.id;

    const name = document.createElement("div");
    name.className = "exp-item-name";
    name.textContent = item.name || item.id;
    el.appendChild(name);

    const meta = document.createElement("div");
    meta.className = "exp-item-meta";
    const bits = [];
    if (item.description) bits.push(item.description);
    bits.push(t("知识 {k} · 技能 {s}", { k: item.knowledge_count, s: item.skills_count }));
    meta.textContent = bits.join(" | ");
    el.appendChild(meta);

    el.addEventListener("click", () => selectExpert(item.id));
    expertListEl.appendChild(el);
  }
}

/**
 * 扩展页的专家包一览：这一栏只回答"有哪些、各带多少知识与技能"，
 * 编辑仍留在原弹窗里——那边是表单加文件管理，塞进分栏会把两件事挤在一屏。
 */
function renderExtList() {
  if (!extListEl) return;
  extListEl.innerHTML = "";
  setExtCount("experts", expertsCache.length);
  if (!expertsCache.length) {
    const empty = document.createElement("div");
    empty.className = "ext-empty";
    empty.textContent = t("暂无专家包，点右上「＋ 新建专家包」或「导入」");
    extListEl.appendChild(empty);
    return;
  }
  for (const item of expertsCache) {
    const el = document.createElement("div");
    el.className = "exp-item" + (item.id === currentId ? " active" : "");
    el.title = t("点击在弹窗中编辑");

    const name = document.createElement("div");
    name.className = "exp-item-name";
    name.textContent = item.name || item.id;

    const meta = document.createElement("div");
    meta.className = "exp-item-meta";
    meta.textContent = [
      item.description,
      t("知识 {k} · 技能 {s}", { k: item.knowledge_count, s: item.skills_count }),
    ].filter(Boolean).join(" | ");

    el.appendChild(name);
    el.appendChild(meta);
    el.addEventListener("click", () => {
      openExpertModal();
      selectExpert(item.id);
    });
    extListEl.appendChild(el);
  }
}

function showEmpty() {
  currentId = "";
  currentDetail = null;
  detailEmpty?.classList.remove("hidden");
  detailForm?.classList.add("hidden");
}

// ── 详情加载 ────────────────────────────────

let selectSeq = 0;

async function selectExpert(id) {
  const seq = ++selectSeq;
  try {
    const detail = await getExpert(id, { force: true });
    if (seq !== selectSeq) return; // 用户已改选其他专家，丢弃过期响应
    currentId = id;
    currentDetail = detail;
    detailEmpty.classList.add("hidden");
    detailForm.classList.remove("hidden");
    nameInput.value = detail.name || "";
    descInput.value = detail.description || "";
    personaInput.value = detail.persona || "";
    rulesInput.value = detail.rules || "";
    renderFileList("knowledge");
    renderFileList("skills");
    renderList();
    switchTab("persona");
  } catch (e) {
    if (seq !== selectSeq) return;
    await toast(t("专家包打开失败: {msg}", { msg: e.message }));
  }
}

function switchTab(tab) {
  modal?.querySelectorAll(".exp-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  ["persona", "rules", "knowledge", "skills"].forEach(key => {
    document.getElementById(`expert-tab-${key}`)?.classList.toggle("active", key === tab);
  });
}

// ── knowledge / skills 文件管理 ──────────────

function renderFileList(folder) {
  const listEl = folder === "knowledge" ? knowledgeListEl : skillsListEl;
  if (!listEl || !currentDetail) return;
  listEl.innerHTML = "";
  const files = currentDetail[folder] || [];
  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "exp-file-empty";
    empty.textContent = "暂无文件，点击上方 + 添加文件";
    listEl.appendChild(empty);
    return;
  }
  for (const f of files) {
    const row = document.createElement("div");
    row.className = "exp-file-item";

    const name = document.createElement("span");
    name.className = "exp-file-name";
    name.textContent = f.name;
    row.appendChild(name);

    const size = document.createElement("span");
    size.className = "exp-file-size";
    size.textContent = fmtSize(f.size);
    row.appendChild(size);

    const del = document.createElement("button");
    del.className = "exp-file-remove";
    del.textContent = "×";
    del.title = "删除文件";
    del.addEventListener("click", async () => {
      try {
        await deleteExpertFile(currentId, folder, f.name);
        currentDetail = await getExpert(currentId, { force: true });
        renderFileList(folder);
        refreshList();
      } catch (e) {
        await toast(t("删除失败: {msg}", { msg: e.message }));
      }
    });
    row.appendChild(del);
    listEl.appendChild(row);
  }
}

async function handleFileUpload(folder, fileList) {
  if (!currentId) return;
  for (const file of fileList) {
    try {
      await uploadExpertFile(currentId, folder, file);
    } catch (e) {
      await toast(t("上传失败: {name}（{msg}）", { name: file.name, msg: e.message }));
    }
  }
  currentDetail = await getExpert(currentId, { force: true });
  renderFileList(folder);
  refreshList();
}

// ── 新建 / 导入 / 保存 / 导出 / 删除 ─────────

async function handleNew() {
  try {
    const id = await createExpert({ name: "新专家" });
    await refreshList();
    await selectExpert(id);
  } catch (e) {
    await toast(t("新建失败: {msg}", { msg: e.message }));
  }
}

async function handleImport(file) {
  try {
    const id = await importExpertZip(file);
    await refreshList();
    await selectExpert(id);
    await toast(t("专家包导入成功"));
  } catch (e) {
    await toast(t("导入失败: {msg}", { msg: e.message }));
  }
}

async function handleSave() {
  if (!currentId) return;
  try {
    await saveExpert(currentId, {
      name: nameInput.value.trim() || "未命名专家",
      description: descInput.value.trim(),
      persona: personaInput.value,
      rules: rulesInput.value,
    });
    currentDetail = await getExpert(currentId, { force: true });
    await refreshList();
    // 若正在使用当前专家，同步更新注入内容
    if (state.activeExpertId === currentId) {
      setActiveExpertId(currentId, currentDetail);
    }
    await toast(t("专家包已保存"));
  } catch (e) {
    await toast(t("保存失败: {msg}", { msg: e.message }));
  }
}

function handleExport() {
  if (!currentId) return;
  const a = document.createElement("a");
  a.href = expertExportUrl(currentId);
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function handleDelete() {
  if (!currentId) return;
  const name = currentDetail?.name || currentId;
  if (!await dlgConfirm(t("确定删除专家包「{name}」？该操作不可恢复。", { name }), { danger: true, okText: "删除" })) return;
  const id = currentId;
  try {
    await deleteExpert(id);
    if (state.activeExpertId === id) setActiveExpertId("");
    showEmpty();
    await refreshList();
    await toast(t("专家包已删除"));
  } catch (e) {
    await toast(t("删除失败: {msg}", { msg: e.message }));
  }
}

// ── 对话/团队中的专家下拉刷新 ────────────────

function fillExpertOptions(select, selectedId) {
  const value = selectedId ?? select.value;
  select.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "无专家";
  select.appendChild(none);
  for (const item of expertsCache) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.name || item.id;
    if (item.id === value) opt.selected = true;
    select.appendChild(opt);
  }
}

/** 刷新对话输入区与团队成员卡中的所有专家下拉框 */
function refreshExpertSelects() {
  const chatSelect = document.getElementById("expert-select");
  if (chatSelect) fillExpertOptions(chatSelect, state.activeExpertId);
  document.querySelectorAll(".member-expert-select").forEach(sel => {
    fillExpertOptions(sel, sel.dataset.current || "");
  });
}

function getExpertsCached() {
  return expertsCache;
}

// ── 初始化 ─────────────────────────────────

function initExpertsPanel() {
  modal = document.getElementById("expert-modal");
  if (!modal) return;
  expertListEl = document.getElementById("expert-list");
  extListEl = document.getElementById("ext-expert-list");
  detailEmpty = document.getElementById("expert-detail-empty");
  detailForm = document.getElementById("expert-detail-form");
  nameInput = document.getElementById("expert-name");
  descInput = document.getElementById("expert-desc");
  personaInput = document.getElementById("expert-persona");
  rulesInput = document.getElementById("expert-rules");
  knowledgeListEl = document.getElementById("expert-knowledge-list");
  skillsListEl = document.getElementById("expert-skills-list");

  modal.querySelector(".modal-backdrop").addEventListener("click", closeExpertModal);
  modal.querySelector(".modal-close").addEventListener("click", closeExpertModal);
  modal.querySelectorAll(".exp-tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.getElementById("btn-experts")?.addEventListener("click", openExpertModal);
  document.getElementById("btn-expert-new").addEventListener("click", handleNew);

  const zipInput = document.getElementById("expert-zip-input");
  document.getElementById("btn-expert-import").addEventListener("click", () => zipInput.click());
  // 扩展页那一栏的入口按钮：新建与导入是同一对处理函数，只是长在不同位置
  document.getElementById("btn-ext-expert-new")?.addEventListener("click", handleNew);
  document.getElementById("btn-ext-expert-import")?.addEventListener("click", () => zipInput.click());
  zipInput.addEventListener("change", async () => {
    const file = zipInput.files?.[0];
    zipInput.value = "";
    if (file) await handleImport(file);
  });

  document.getElementById("btn-expert-save").addEventListener("click", handleSave);
  document.getElementById("btn-expert-export").addEventListener("click", handleExport);
  document.getElementById("btn-expert-delete").addEventListener("click", handleDelete);

  const knowledgeInput = document.getElementById("expert-knowledge-input");
  document.getElementById("btn-expert-add-knowledge").addEventListener("click", () => knowledgeInput.click());
  knowledgeInput.addEventListener("change", async () => {
    const files = [...knowledgeInput.files];
    knowledgeInput.value = "";
    if (files.length) await handleFileUpload("knowledge", files);
  });

  const skillsInput = document.getElementById("expert-skills-input");
  document.getElementById("btn-expert-add-skills").addEventListener("click", () => skillsInput.click());
  skillsInput.addEventListener("change", async () => {
    const files = [...skillsInput.files];
    skillsInput.value = "";
    if (files.length) await handleFileUpload("skills", files);
  });

  // 初始加载列表，并恢复当前对话激活的专家详情
  refreshList().then(async () => {
    if (state.activeExpertId) {
      try {
        const detail = await getExpert(state.activeExpertId, { force: true });
        state.activeExpert = detail;
      } catch {
        setActiveExpertId("");
      }
    }
  });
}

export { initExpertsPanel, openExpertModal, refreshExpertSelects, getExpertsCached };
