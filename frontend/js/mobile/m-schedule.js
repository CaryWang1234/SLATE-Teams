/**
 * SLATE Mobile — 待办 / 定时任务
 * 列表 / 新建（名称、提示词、模型、模式、时间/间隔）/ 启用停用 / 立即运行 / 删除
 */

import { state } from "../store.js?v=20261017-001";
import { get, post, patch, del } from "../services/api.js?v=20261017-001";
import { t, mToast, mShowPrompt, mShowConfirm, mShowSheet, mIcon } from "./m-ui.js?v=20261017-001";
import { onTab } from "./m-app.js?v=20261017-001";

function $id(id) { return document.getElementById(id); }

function scheduleSummary(task) {
  if (task.mode === "once") return t("单次 · {time}", { time: task.time || "" });
  if (task.mode === "interval") return t("每 {n} 分钟", { n: task.every_minutes || 60 });
  return t("每天 · {time}", { time: task.time || "09:00" });
}

function formatTs(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadTasks() {
  try {
    const res = await get("/schedule/tasks");
    return res.code === 0 ? (res.data || []) : [];
  } catch (e) {
    console.warn("[SLATE-Mobile] 定时任务加载失败:", e);
    return [];
  }
}

function modelOptions() {
  const groups = [
    [t("国产模型"), state.modelRegistry?.domestic],
    [t("国际模型"), state.modelRegistry?.international],
    [t("本地模型"), state.modelRegistry?.local],
    [t("自定义模型"), state.customModels],
  ];
  const options = [];
  for (const [label, models] of groups) {
    if (!Array.isArray(models) || !models.length) continue;
    options.push({ label, models });
  }
  return options;
}

async function showCreateSheet() {
  const body = document.createElement("div");
  body.style.cssText = "display:flex;flex-direction:column;gap:10px;";

  const mkInput = (placeholder) => {
    const input = document.createElement("input");
    input.className = "m-dlg-input";
    input.placeholder = placeholder;
    input.style.cssText =
      "border:1px solid var(--border);border-radius:var(--m-radius-sm);background:var(--bg-input);color:var(--text);" +
      "padding:11px 14px;font-size:15px;outline:none;";
    return input;
  };

  const nameInput = mkInput(t("任务名称"));
  body.appendChild(nameInput);

  const promptInput = mkInput(t("提示词（到点后交给模型执行）"));
  body.appendChild(promptInput);

  // 模式选择
  const modeRow = document.createElement("div");
  modeRow.style.cssText = "display:flex;gap:8px;";
  const modeLabels = [["once", t("单次")], ["daily", t("每天")], ["interval", t("间隔")]];
  const modeBtns = {};
  for (const [val, label] of modeLabels) {
    const btn = document.createElement("button");
    btn.className = "m-sheet-btn";
    btn.textContent = label;
    btn.style.flex = "1";
    btn.addEventListener("click", () => {
      for (const b of Object.values(modeBtns)) b.classList.remove("m-sheet-btn-primary");
      btn.classList.add("m-sheet-btn-primary");
      timeInput.style.display = val === "interval" ? "none" : "";
      minutesInput.style.display = val === "interval" ? "" : "none";
    });
    modeBtns[val] = btn;
    modeRow.appendChild(btn);
  }
  body.appendChild(modeRow);
  modeBtns.daily.classList.add("m-sheet-btn-primary");

  const timeInput = mkInput(t("时间（如 09:00）"));
  timeInput.value = "09:00";
  body.appendChild(timeInput);

  const minutesInput = mkInput(t("间隔分钟数"));
  minutesInput.value = "60";
  minutesInput.style.display = "none";
  body.appendChild(minutesInput);

  // 模型选择
  const modelSel = document.createElement("select");
  modelSel.style.cssText =
    "border:1px solid var(--border);border-radius:var(--m-radius-sm);background:var(--bg-input);color:var(--text);" +
    "padding:11px 14px;font-size:15px;outline:none;";
  const groups = modelOptions();
  let firstModel = "";
  for (const g of groups) {
    const og = document.createElement("optgroup");
    og.label = g.label;
    for (const m of g.models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name || m.id;
      og.appendChild(opt);
      if (!firstModel) firstModel = m.id;
    }
    modelSel.appendChild(og);
  }
  if (state.currentModel?.id) modelSel.value = state.currentModel.id;
  body.appendChild(modelSel);

  // 底部按钮
  const footer = document.createElement("div");
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "m-sheet-btn";
  cancelBtn.textContent = t("取消");
  const saveBtn = document.createElement("button");
  saveBtn.className = "m-sheet-btn m-sheet-btn-primary";
  saveBtn.textContent = t("创建");
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  const { close } = mShowSheet({ title: t("新建定时任务"), body, footer });

  const doClose = (v) => {
    const sheet = saveBtn.closest(".m-sheet");
    if (sheet) {
      sheet.classList.remove("open");
      const backdrop = sheet.previousElementSibling;
      setTimeout(() => { sheet.remove(); backdrop?.remove(); }, 200);
    }
    close(v);
  };
  cancelBtn.addEventListener("click", () => doClose(null));
  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const prompt = promptInput.value.trim();
    if (!name || !prompt) {
      mToast(t("请填写名称与提示词"));
      return;
    }
    let mode = "daily";
    for (const [val, btn] of Object.entries(modeBtns)) {
      if (btn.classList.contains("m-sheet-btn-primary")) mode = val;
    }
    const payload = {
      name,
      prompt,
      model_id: modelSel.value || firstModel,
      mode,
      time: mode === "interval" ? undefined : timeInput.value.trim() || "09:00",
      every_minutes: mode === "interval" ? Math.max(1, parseInt(minutesInput.value) || 60) : undefined,
    };
    try {
      const res = await post("/schedule/tasks", payload);
      if (res.code !== 0) mToast(res.message || t("创建失败"), 3200);
      else {
        doClose(null);
        mToast(t("已创建"));
        renderList();
      }
    } catch (e) {
      mToast(t("创建失败: {msg}", { msg: e.message }), 3200);
    }
  });
}

async function renderList() {
  const listEl = $id("m-schedule-list");
  if (!listEl) return;
  const tasks = await loadTasks();
  listEl.innerHTML = "";
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "m-list-empty";
    empty.textContent = t("暂无定时任务");
    listEl.appendChild(empty);
    return;
  }
  for (const task of tasks) {
    const item = document.createElement("div");
    item.className = "m-list-item" + (task.enabled ? "" : " disabled");
    item.style.opacity = task.enabled ? "1" : "0.55";

    const main = document.createElement("div");
    main.className = "m-list-item-main";
    const title = document.createElement("div");
    title.className = "m-list-item-title";
    title.textContent = task.name || task.model_id || t("未命名任务");
    const sub = document.createElement("div");
    sub.className = "m-list-item-sub";
    const status = task.last_status
      ? (task.last_status === "ok" ? t("上次运行 {time}", { time: formatTs(task.last_run) }) : task.last_status)
      : t("尚未运行");
    sub.textContent = `${scheduleSummary(task)} · ${task.model_id || ""} · ${status}`;
    main.appendChild(title);
    main.appendChild(sub);
    item.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "m-list-item-action";

    const runBtn = document.createElement("button");
    runBtn.className = "m-btn-sm";
    runBtn.innerHTML = mIcon("rotate-cw", "m-icon-sm");
    runBtn.title = t("立即运行");
    const delBtn = document.createElement("button");
    delBtn.className = "m-btn-sm";
    delBtn.innerHTML = mIcon("trash-2", "m-icon-sm");
    delBtn.title = t("删除");
    actions.appendChild(runBtn);
    actions.appendChild(delBtn);
    item.appendChild(actions);

    runBtn.addEventListener("click", async () => {
      try {
        const res = await post(`/schedule/tasks/${task.id}/run`);
        if (res.code === 0) mToast(t("任务已触发，结果稍后归档到 [定时] 会话"));
        else mToast(res.message || t("触发失败"), 3200);
      } catch (e) {
        mToast(t("触发失败: {msg}", { msg: e.message }), 3200);
      }
    });
    delBtn.addEventListener("click", async () => {
      const ok = await mShowConfirm({
        title: t("删除定时任务"),
        message: t("确定删除定时任务「{name}」？", { name: (task.name || "").slice(0, 30) }),
        okText: t("删除"),
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await del(`/schedule/tasks/${task.id}`);
        if (res.code !== 0) mToast(res.message || t("删除失败"), 3200);
        else {
          mToast(t("已删除"));
          renderList();
        }
      } catch (e) {
        mToast(t("删除失败: {msg}", { msg: e.message }), 3200);
      }
    });

    listEl.appendChild(item);
  }
}

export function initMSchedule() {
  $id("m-btn-add-task")?.addEventListener("click", showCreateSheet);
  onTab("schedule", () => renderList());
  renderList();
}

export { t };
