/**
 * SLATE 定时任务组件：创建和管理定时对话任务。
 * 后端调度器到点后自动调用模型，结果归档到 [定时] 前缀的专属会话。
 */

import { state } from "../store.js?v=20261024-001";
import { get, post, del, patch } from "../services/api.js?v=20261024-001";
import { dlgConfirm } from "../services/dialog.js?v=20261024-001";
import { t as tr } from "../services/i18n.js?v=20261024-001"; // 任务变量也叫 t，此处别名避免遮蔽

let modal, listEl;
let pollTimer = null;

function scheduleSummary(t) {
  if (t.mode === "once") return tr("单次 · {time}", { time: t.time || "" });
  if (t.mode === "interval") return tr("每 {n} 分钟", { n: t.every_minutes || 60 });
  return tr("每天 · {time}", { time: t.time || "09:00" });
}

function formatTs(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function toast(msg) {
  try {
    const app = await import("../app.js?v=20261024-001");
    app.toast(msg);
  } catch {}
}

function fillModelOptions() {
  const sel = document.getElementById("schedule-model");
  if (!sel) return;
  sel.innerHTML = "";
  const groups = [
    ["国产模型", state.modelRegistry?.domestic],
    ["国际模型", state.modelRegistry?.international],
    ["本地模型", state.modelRegistry?.local],
    ["自定义模型", state.customModels],
  ];
  for (const [label, models] of groups) {
    if (!Array.isArray(models) || !models.length) continue;
    const og = document.createElement("optgroup");
    og.label = tr(label);
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name || m.id;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  if (state.currentModel?.id) sel.value = state.currentModel.id;
}

function syncModeInputs() {
  const mode = document.getElementById("schedule-mode")?.value;
  const timeInput = document.getElementById("schedule-time");
  const minutesInput = document.getElementById("schedule-minutes");
  if (timeInput) timeInput.style.display = mode === "interval" ? "none" : "";
  if (minutesInput) minutesInput.style.display = mode === "interval" ? "" : "none";
}

async function loadTasks() {
  try {
    const res = await get("/schedule/tasks");
    return res.code === 0 ? (res.data || []) : [];
  } catch {
    return [];
  }
}

async function renderList() {
  if (!listEl) return;
  const tasks = await loadTasks();
  listEl.innerHTML = "";
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "schedule-empty";
    empty.textContent = "暂无定时任务，可在上方添加";
    listEl.appendChild(empty);
    return;
  }
  for (const t of tasks) {
    const item = document.createElement("div");
    item.className = "schedule-item" + (t.enabled ? "" : " disabled");

    const info = document.createElement("div");
    info.className = "schedule-item-info";
    const name = document.createElement("div");
    name.className = "schedule-item-name";
    name.textContent = t.name;
    const meta = document.createElement("div");
    meta.className = "schedule-item-meta";
    const status = t.last_status
      ? (t.last_status === "ok" ? tr("上次运行 {time}", { time: formatTs(t.last_run) }) : `${t.last_status}`)
      : "尚未运行";
    meta.textContent = `${scheduleSummary(t)} · ${t.model_id} · ${status}`;
    info.appendChild(name);
    info.appendChild(meta);
    item.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "schedule-item-actions";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = !!t.enabled;
    toggle.title = "启用/停用";
    toggle.addEventListener("change", async () => {
      try {
        await patch(`/schedule/tasks/${t.id}`, { enabled: toggle.checked });
        renderList();
      } catch (e) {
        console.warn("[SLATE] 切换任务状态失败:", e);
        toggle.checked = !toggle.checked; // 回滚UI
      }
    });
    actions.appendChild(toggle);

    const btnRun = document.createElement("button");
    btnRun.className = "msg-action-btn";
    btnRun.textContent = "▶";
    btnRun.title = "立即运行";
    btnRun.addEventListener("click", async () => {
      try {
        const res = await post(`/schedule/tasks/${t.id}/run`);
        if (res.code === 0) {
          toast(tr("任务已触发，结果稍后归档到 [定时] 会话"));
          startPolling();
        } else {
          toast(res.message || tr("触发失败"));
        }
      } catch (e) {
        console.warn("[SLATE] 触发任务失败:", e);
        toast(tr("触发失败: {msg}", { msg: e.message }));
      }
    });
    actions.appendChild(btnRun);

    const btnDel = document.createElement("button");
    btnDel.className = "msg-action-btn";
    btnDel.textContent = "×";
    btnDel.title = "删除任务";
    btnDel.addEventListener("click", async () => {
      if (!await dlgConfirm(tr("删除定时任务「{name}」？", { name: t.name }), { danger: true, okText: "删除" })) return;
      try {
        await del(`/schedule/tasks/${t.id}`);
        renderList();
      } catch (e) {
        console.warn("[SLATE] 删除任务失败:", e);
        toast(tr("删除失败: {msg}", { msg: e.message }));
      }
    });
    actions.appendChild(btnDel);

    item.appendChild(actions);
    listEl.appendChild(item);
  }
}

function startPolling() {
  if (pollTimer) return;
  let times = 0;
  pollTimer = setInterval(async () => {
    times += 1;
    await renderList();
    if (times >= 8) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 5000);
}

async function addTask() {
  const name = document.getElementById("schedule-name")?.value.trim();
  const prompt = document.getElementById("schedule-prompt")?.value.trim();
  const model_id = document.getElementById("schedule-model")?.value;
  const mode = document.getElementById("schedule-mode")?.value || "daily";
  const time = document.getElementById("schedule-time")?.value || "09:00";
  const every_minutes = parseInt(document.getElementById("schedule-minutes")?.value) || 60;

  if (!name) return toast(tr("请填写任务名称"));
  if (!prompt) return toast(tr("请填写提示词"));
  if (!model_id) return toast(tr("请选择模型"));

  try {
    const res = await post("/schedule/tasks", { name, prompt, model_id, mode, time, every_minutes });
    if (res.code !== 0) return toast(res.message || tr("添加失败"));
    document.getElementById("schedule-name").value = "";
    document.getElementById("schedule-prompt").value = "";
    toast(tr("定时任务已添加"));
    renderList();
  } catch (e) {
    toast(tr("添加失败: {msg}", { msg: e.message }));
  }
}

function openScheduleModal() {
  if (!modal) return;
  fillModelOptions();
  syncModeInputs();
  renderList();
  modal.classList.remove("hidden");
}

function closeScheduleModal() {
  modal?.classList.add("hidden");
}

function initSchedule() {
  modal = document.getElementById("schedule-modal");
  listEl = document.getElementById("schedule-list");
  if (!modal) return;

  modal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", closeScheduleModal);
  });
  document.getElementById("schedule-mode")?.addEventListener("change", syncModeInputs);
  document.getElementById("btn-add-schedule")?.addEventListener("click", addTask);
}

export { initSchedule, openScheduleModal };
