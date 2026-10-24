/**
 * SLATE Mobile — 移动组件库
 * 底部 sheet / 确认 / toast / diff 预览 / 高危确认
 * 所有组件挂载到 #m-sheet-root / #m-toast-root
 */

import { t } from "../services/i18n.js?v=20261024-001";
import { iconSvg } from "../services/icons.js?v=20261024-001";

// ── Toast ─────────────────────────────────

export function mToast(msg, duration = 2200) {
  const root = document.getElementById("m-toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = "m-toast";
  el.textContent = msg;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, duration);
}

// ── 底部 sheet（通用） ────────────────────

let _sheetStack = [];

/**
 * 打开底部 sheet。
 * opts: { title, body, footer, onClose } body/footer 为 DOM 元素或 null
 * 返回 { el, close(value) }；close 触发 onClose(value)
 */
export function mShowSheet(opts = {}) {
  const root = document.getElementById("m-sheet-root");
  if (!root) return { el: null, close: () => {} };

  const backdrop = document.createElement("div");
  backdrop.className = "m-sheet-backdrop";

  const sheet = document.createElement("div");
  sheet.className = "m-sheet";

  const grab = document.createElement("div");
  grab.className = "m-sheet-grab";

  const head = document.createElement("div");
  head.className = "m-sheet-head";
  const title = document.createElement("div");
  title.className = "m-sheet-title";
  title.textContent = opts.title || "";
  const closeBtn = document.createElement("button");
  closeBtn.className = "m-sheet-close";
  closeBtn.textContent = "×";
  head.appendChild(title);
  head.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "m-sheet-body";
  if (opts.body) body.appendChild(opts.body);

  sheet.appendChild(grab);
  sheet.appendChild(head);
  sheet.appendChild(body);

  let footer = null;
  if (opts.footer) {
    footer = document.createElement("div");
    footer.className = "m-sheet-footer";
    footer.appendChild(opts.footer);
    sheet.appendChild(footer);
  }

  root.appendChild(backdrop);
  root.appendChild(sheet);
  _sheetStack.push(sheet);

  requestAnimationFrame(() => sheet.classList.add("open"));

  let done = false;
  const close = (value) => {
    if (done) return;
    done = true;
    sheet.classList.remove("open");
    _sheetStack = _sheetStack.filter(s => s !== sheet);
    setTimeout(() => {
      backdrop.remove();
      sheet.remove();
    }, 200);
    if (opts.onClose) opts.onClose(value);
  };

  backdrop.addEventListener("click", () => close(null));
  closeBtn.addEventListener("click", () => close(null));
  sheet.addEventListener("click", (e) => e.stopPropagation());

  // 限制同屏 sheet 数量：超 2 个先关最老的（连带移除 backdrop，避免残留遮罩）
  if (_sheetStack.length > 2) {
    const oldest = _sheetStack.shift();
    const oldestBackdrop = oldest?.previousElementSibling;
    oldest?.remove();
    if (oldestBackdrop?.classList.contains("m-sheet-backdrop")) oldestBackdrop.remove();
  }

  return { el: sheet, close, body };
}

/** 通用确认（返回 Promise<boolean>） */
export function mShowConfirm(opts = {}) {
  return new Promise((resolve) => {
    const footer = document.createElement("div");
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "m-sheet-btn";
    cancelBtn.textContent = opts.cancelText || t("取消");
    const okBtn = document.createElement("button");
    okBtn.className = opts.danger ? "m-sheet-btn m-sheet-btn-danger" : "m-sheet-btn m-sheet-btn-primary";
    okBtn.textContent = opts.okText || t("确定");
    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);

    const body = document.createElement("div");
    const msg = document.createElement("div");
    msg.style.cssText = "font-size:14px;line-height:1.7;user-select:text;";
    msg.textContent = opts.message || "";
    body.appendChild(msg);

    const sheet = mShowSheet({
      title: opts.title || t("请确认"),
      body,
      footer,
      onClose: (v) => resolve(v === true),
    });
    cancelBtn.addEventListener("click", () => sheet.close(false));
    okBtn.addEventListener("click", () => sheet.close(true));
  });
}

/** 文本输入对话框（返回 Promise<string|null>） */
export function mShowPrompt(opts = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.className = "m-dlg-input";
    input.value = opts.value || "";
    input.placeholder = opts.placeholder || "";
    input.style.cssText =
      "flex:1;border:1px solid var(--border);border-radius:var(--m-radius-sm);background:var(--bg-input);color:var(--text);" +
      "padding:11px 14px;font-size:15px;outline:none;";
    const body = document.createElement("div");
    body.style.cssText = "display:flex;gap:8px;align-items:center;";
    if (opts.message) {
      const msg = document.createElement("div");
      msg.textContent = opts.message;
      msg.style.cssText = "font-size:14px;color:var(--text-secondary);margin-bottom:10px;";
      body.appendChild(msg);
    }
    body.appendChild(input);

    const footer = document.createElement("div");
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "m-sheet-btn";
    cancelBtn.textContent = t("取消");
    const okBtn = document.createElement("button");
    okBtn.className = "m-sheet-btn m-sheet-btn-primary";
    okBtn.textContent = t("确定");
    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);

    const sheet = mShowSheet({
      title: opts.title || t("请输入"),
      body,
      footer,
      onClose: (v) => resolve(v),
    });
    cancelBtn.addEventListener("click", () => sheet.close(null));
    okBtn.addEventListener("click", () => sheet.close(opts.allowEmpty ? input.value.trim() : input.value.trim() || null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") okBtn.click();
    });
    setTimeout(() => input.focus(), 250);
  });
}

// ── diff 预览 sheet ──────────────────────

/** 行级着色 diff。diff 为原始文本（含 +/-/@@ 行） */
export function mShowDiffSheet({ filePath, diff, title }) {
  return new Promise((resolve) => {
    const body = document.createElement("div");
    const pathEl = document.createElement("div");
    pathEl.className = "m-diff-path";
    pathEl.style.cssText = "font-family:var(--font-code);font-size:12px;color:var(--text-secondary);margin-bottom:8px;word-break:break-all;";
    pathEl.textContent = filePath || "";
    body.appendChild(pathEl);

    const pre = document.createElement("pre");
    pre.className = "m-diff-pre";
    const lines = String(diff || "").split("\n");
    for (const line of lines) {
      const div = document.createElement("div");
      div.textContent = line || " ";
      if (line.startsWith("+")) div.className = "m-diff-add";
      else if (line.startsWith("-")) div.className = "m-diff-del";
      else if (line.startsWith("@@")) div.className = "m-diff-hunk";
      pre.appendChild(div);
    }
    body.appendChild(pre);

    const footer = document.createElement("div");
    const rejectBtn = document.createElement("button");
    rejectBtn.className = "m-sheet-btn m-sheet-btn-danger";
    rejectBtn.textContent = t("拒绝");
    const acceptBtn = document.createElement("button");
    acceptBtn.className = "m-sheet-btn m-sheet-btn-primary";
    acceptBtn.textContent = t("接受");
    const copyBtn = document.createElement("button");
    copyBtn.className = "m-sheet-btn";
    copyBtn.textContent = t("复制");
    copyBtn.style.flex = "0 0 auto";
    footer.appendChild(rejectBtn);
    footer.appendChild(copyBtn);
    footer.appendChild(acceptBtn);

    const sheet = mShowSheet({
      title: title || t("文件变更预览"),
      body,
      footer,
      onClose: () => resolve(null),
    });
    rejectBtn.addEventListener("click", () => sheet.close("reject"));
    acceptBtn.addEventListener("click", () => sheet.close("accept"));
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(diff || "");
        mToast(t("已复制"));
      } catch {
        mToast(t("复制失败"));
      }
    });
  });
}

// ── 高危命令确认 sheet ───────────────────

/**
 * 审批确认 sheet（手机遥控那侧的"问人"）。
 * 三种问法共用这张：高危命令、逐条确认的命令、逐条确认的联网——
 * 差别只在文案，所以标题/字段名/说明行都由调用方给，explain 传 null 表示这一笔没有目的说明可看。
 */
export function mShowRiskSheet({ title, subjectLabel, target, reason, explain, note }) {
  return new Promise((resolve) => {
    const body = document.createElement("div");
    const reasonEl = document.createElement("div");
    reasonEl.className = "m-risk-reason";
    reasonEl.textContent = reason;
    body.appendChild(reasonEl);

    const labelEl = document.createElement("div");
    labelEl.className = "m-risk-label";
    labelEl.textContent = subjectLabel;
    body.appendChild(labelEl);

    const cmdEl = document.createElement("div");
    cmdEl.className = "m-risk-command";
    cmdEl.textContent = target;
    body.appendChild(cmdEl);

    if (explain !== null) {
      const explainEl = document.createElement("div");
      explainEl.className = "m-risk-explain";
      explainEl.textContent = explain || t("正在分析命令目的…");
      body.appendChild(explainEl);
    }

    const noteEl = document.createElement("div");
    noteEl.className = "m-risk-note";
    noteEl.textContent = note || t("批准后该操作将立即执行");
    body.appendChild(noteEl);

    const footer = document.createElement("div");
    const rejectBtn = document.createElement("button");
    rejectBtn.className = "m-sheet-btn";
    rejectBtn.textContent = t("拒绝");
    const approveBtn = document.createElement("button");
    approveBtn.className = "m-sheet-btn m-sheet-btn-danger";
    approveBtn.textContent = t("放行");
    footer.appendChild(rejectBtn);
    footer.appendChild(approveBtn);

    const sheet = mShowSheet({
      title: title || t("高危命令确认"),
      body,
      footer,
      onClose: () => resolve(false),
    });
    rejectBtn.addEventListener("click", () => sheet.close(false));
    approveBtn.addEventListener("click", () => sheet.close(true));
  });
}

// ── 图标辅助 ─────────────────────────────

export function mIcon(name, cls = "") {
  return iconSvg(name, cls);
}

export { t };
