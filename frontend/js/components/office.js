/**
 * 办公室面板（顶层页签「办公室」）：一面是对话，一面是工位（花名册 / 平面图 / 动态流 / 等你拍板 / 值班表 / 岗位）。
 *
 * 「等你拍板」那一栏只有两扇门：点头放回队列（revive）与同意不该办（decline），都是人按的；
 * 员工能把活判进去，不能自己判出来——这是这一版给「判断」划的界。
 *
 * 面板不发任何请求——读数全从 services/office.js 那份快照来，写动作也只调它那层的函数。
 * 再写一套轮询就会有两份状态：一处刚刷过、一处还停在旧数，界面会说出不实话。
 *
 * 四条接线口径：
 *   ① 工位与花名册都是真 <button>：键盘走到哪一盏灯，点下去就得选中那一位。
 *   ② 空态写真 DOM（CSS content: 的字符串翻不了，英文界面会留中文）。
 *   ③ 正文一律 textContent：同事与模型递回来的文本是外部输入，不参与建 HTML。
 *   ④ 快照每几秒刷一次，表单不能跟着刷——用户在打字，重画就是把那句话吃掉。
 *      所以这里只有展示区跟着 board 走，摊开的表（草稿、某个人的岗位）一律不碰；
 *      唯一跟着 board 补画的是「还没摊开表」时那张模板卡——第一轮快照里它是空的。
 */

import { state } from "../store.js?v=20261024-001";
import { t } from "../services/i18n.js?v=20261024-001";
import { allRegisteredModels } from "../services/ai_features.js?v=20261024-001";
import { dlgConfirm, dlgAlert } from "../services/dialog.js?v=20261024-001";
import {
  officeBoard, officeEvents, officeRunning, officeSeatStatus,
  hireEmployee, patchEmployee, fireEmployee, addDuty, patchDuty, removeDuty, runDutyNow,
  sayAtOffice, markOfficeRead, stopOfficeJob, startOfficeEngine, reviveJob, declineJob, closeOfficeNote,
} from "../services/office.js?v=20261024-001";

let rosterList, rosterFoot, floorEl, floorStats, feedEl, pendingEl, pendingCountEl;
let mastheadPending, mastheadPendingCount;
let dutiesEl, dutyFormHost, staffEl, toSelect, sayInput, sendBtn, reportEl;
let selectedId = "";
// 模板随第一次快照才到：≥0＝这一页正摆着模板卡（记着摆了几张），-1＝正在填一张表，快照不许碰
let staffTemplateCount = -1;
// 备忘清单的指纹：变了才补画那半块，整张表单跟着刷会把正在打的那一句吃掉
let notesStamp = "";
// 刚递过话的工位：气泡挂几秒就收，不跟着下一次刷新一起重播
const bubbles = new Map();
const BUBBLE_MS = 5200;

// 状态灯的文字全走字面键：查表取串再 t() 会让 i18n 覆盖守卫看不见这一句（词典漏了也不报错）
function statusLabel(status) {
  if (status === "busy") return t("在忙");
  if (status === "waiting") return t("等你拍板");
  if (status === "off") return t("下班");
  return t("空闲");
}

function fmtClock(ms) {
  if (!ms) return "--:--";
  const d = new Date(Number(ms));
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (d.toDateString() !== now.toDateString()) return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  return `${hh}:${mm}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function mark(glyph, hue, size) {
  const node = el("span", "office-mark", glyph || "?");
  node.style.setProperty("--office-hue", String(Number(hue) || 0));
  if (size) node.classList.add("is-lg");
  return node;
}

function employees() {
  return officeBoard().employees || [];
}

function selectedEmployee() {
  return employees().find(e => e.employeeId === selectedId) || null;
}

function jobOf(jobId) {
  return (officeBoard().jobs || []).find(j => j.jobId === String(jobId || "")) || null;
}

/** 只有工位面真的摊在眼前才算看过：对话面也挂在同一个 panel 里，别把聊天当成读过了工位 */
function panelVisible() {
  return !!document.getElementById("panel-office")?.classList.contains("active")
    && !!document.getElementById("office-view-desk")?.classList.contains("active");
}

// ── 花名册 ────────────────────────────────────

function renderRoster() {
  rosterList.replaceChildren();
  const list = employees();
  if (!list.length) {
    const empty = el("div", "office-empty");
    empty.appendChild(el("b", null, t("办公室还没招人")));
    empty.appendChild(el("div", null, t("按模板招一位，再交他一件事；模板里的每格都能改。")));
    rosterList.appendChild(empty);
  }
  for (const emp of list) {
    const status = officeSeatStatus(emp.employeeId);
    const row = el("button", `office-emp${emp.employeeId === selectedId ? " selected" : ""}`);
    row.type = "button";
    row.dataset.employeeId = emp.employeeId;
    row.dataset.status = status;
    row.appendChild(mark(emp.glyph, emp.hue));
    const nameCell = el("span", "office-emp-name");
    nameCell.appendChild(el("span", null, emp.name));
    nameCell.appendChild(el("span", "office-emp-role", emp.role || t("未填岗位")));
    row.appendChild(nameCell);
    const lamp = el("span", "office-lamp");
    lamp.dataset.status = status;
    row.appendChild(lamp);
    row.addEventListener("click", () => selectEmployee(emp.employeeId));
    rosterList.appendChild(row);
  }
  const open = (officeBoard().jobs || []).filter(j => j.status === "queued" || j.status === "running").length;
  rosterFoot.replaceChildren(el("span", null, t("{n} 位在册 · {m} 条活待办", { n: list.length, m: open })));
}

// ── 工位平面图 ────────────────────────────────

function renderFloor() {
  floorEl.replaceChildren();
  const list = employees();
  floorEl.classList.toggle("is-empty", !list.length);
  if (!list.length) {
    const empty = el("div", "office-empty is-hero");
    empty.appendChild(el("b", null, t("空办公室")));
    empty.appendChild(el("div", "office-empty-lede", t("先招一位人：按模板填好岗位，他会按值班表自己领活，交付直接回到你的对话里。")));
    const steps = el("ol", "office-empty-steps");
    for (const [no, text] of [
      ["01", t("招聘：从模板挑一位，改名字、岗位与职责")],
      ["02", t("交办：在下方写成一句话，选好交给谁")],
      ["03", t("回来验收：交付会出现在「动态」与对话里")],
    ]) {
      const li = el("li");
      li.appendChild(el("b", null, no));
      li.appendChild(el("span", null, text));
      steps.appendChild(li);
    }
    empty.appendChild(steps);
    const hire = el("button", "btn-primary", t("去招聘"));
    hire.type = "button";
    hire.addEventListener("click", () => document.getElementById("btn-office-hire")?.click());
    empty.appendChild(hire);
    floorEl.appendChild(empty);
    floorStats.replaceChildren();
    return;
  }
  for (const emp of list) {
    const status = officeSeatStatus(emp.employeeId);
    const desk = el("button", "office-desk");
    desk.type = "button";
    desk.dataset.employeeId = emp.employeeId;
    desk.dataset.status = status;
    if (emp.employeeId === selectedId) desk.classList.add("selected");

    const head = el("div", "office-desk-head");
    head.appendChild(mark(emp.glyph, emp.hue, true));
    const names = el("div", "office-desk-names");
    names.appendChild(el("div", "office-desk-name", emp.name));
    names.appendChild(el("div", "office-desk-role", `${emp.role || t("未填岗位")} · ${statusLabel(status)}`));
    head.appendChild(names);
    const lamp = el("span", "office-lamp is-end");
    lamp.dataset.status = status;
    head.appendChild(lamp);
    desk.appendChild(head);

    const live = officeRunning().find(r => r.employeeId === emp.employeeId);
    desk.appendChild(el("div", "office-desk-line", live?.line || lastQuietLine(emp)));
    const meta = el("div", "office-desk-meta");
    meta.appendChild(el("span", null, t("值班 {n}", { n: emp.dutyCount || 0 })));
    meta.appendChild(el("span", null, t("待办 {n}", { n: emp.queuedCount || 0 })));
    // 挂账的条数要看得见：只有"待办"的话，停在等人那一栏的活就像已经交了
    if (emp.pendingCount) meta.appendChild(el("span", "office-desk-wait", t("等你 {n}", { n: emp.pendingCount })));
    // 待审校既不是"等你拍板"也不是办完：这份交付卡在同事那一侧，用户手上还没有
    if (emp.pendingReviewCount) meta.appendChild(el("span", "office-desk-review", t("待审校 {n}", { n: emp.pendingReviewCount })));
    if (emp.doneToday) meta.appendChild(el("span", null, t("今天办 {n} 件", { n: emp.doneToday })));
    if (emp.returnedToday) meta.appendChild(el("span", "office-desk-back", t("退回 {n}", { n: emp.returnedToday })));
    if (emp.overBudget) meta.appendChild(el("span", "office-desk-cap", t("预算已满")));
    if (emp.openNoteCount) meta.appendChild(el("span", null, t("未闭环 {n}", { n: emp.openNoteCount })));
    meta.appendChild(el("span", null, emp.unattended ? t("托管") : t("要人拍板")));
    desk.appendChild(meta);

    const bub = bubbles.get(emp.employeeId);
    if (bub?.text) {
      const node = el("div", "office-bubble", bub.text);
      if (bub.fading) node.classList.add("is-out");
      desk.appendChild(node);
    }
    desk.addEventListener("click", () => selectEmployee(emp.employeeId));
    floorEl.appendChild(desk);
  }
  const busy = list.filter(e => officeSeatStatus(e.employeeId) === "busy").length;
  const waiting = list.filter(e => officeSeatStatus(e.employeeId) === "waiting").length;
  floorStats.replaceChildren(
    el("span", null, t("在忙 {n}", { n: busy })),
    el("span", null, t("等人 {n}", { n: waiting })),
    el("span", null, t("在册 {n}", { n: list.length })),
  );
}

/** 没在跑的时候工位上写什么：上一次交付的时间与结局，别说空话 */
function lastQuietLine(emp) {
  const last = emp.lastJob;
  if (!last) return t("还没接过活");
  if (last.status === "queued") return t("排队中 · {when}", { when: fmtClock(last.enqueuedAtMs) });
  // 卡住与「不该办」是等人，不是办完：这一行要写他停在什么上面
  if (last.status === "blocked") return t("受阻于：{why}", { why: last.stateReason || t("没写缺什么") });
  if (last.status === "dropped") return t("判为不该办：{why}", { why: last.stateReason || t("没写为什么") });
  if (last.status === "error") return t("没跑成 · {why}", { why: last.error || "" });
  if (last.status === "stopped") return t("被停止 · {when}", { when: fmtClock(last.finishedAtMs) });
  // 审校拦住的交付还没到用户手上：这一行写「上次交付」就是谎报
  if (last.status === "done" && last.reviewState === "pending") {
    return t("待 {name} 审校 · {when}", {
      name: emp.reviewGateName || t("审校人"), when: fmtClock(last.finishedAtMs),
    });
  }
  if (last.status === "done" && last.reviewState === "returned") {
    return t("审校退回：{why}", { why: last.stateReason || t("没写要改哪里") });
  }
  return t("上次交付 {when} · {n} 轮 / {m} 次工具", {
    when: fmtClock(last.finishedAtMs), n: last.rounds || 0, m: last.toolCalls || 0,
  });
}

// ── 动态流 ────────────────────────────────────

function renderFeed() {
  feedEl.replaceChildren();
  const messages = (officeBoard().messages || []).slice().reverse();
  if (!messages.length) {
    const empty = el("div", "office-empty");
    empty.appendChild(el("b", null, t("还没说过话")));
    empty.appendChild(el("div", null, t("交办一件活，或让同事之间先递一句。")));
    feedEl.appendChild(empty);
    return;
  }
  for (const msg of messages) {
    const row = el("div", "office-msg");
    row.dataset.from = msg.fromKind;
    row.dataset.messageId = String(msg.id);
    const head = el("div", "office-msg-head");
    head.appendChild(el("span", "office-msg-who", msg.fromName || t("办公室")));
    if (msg.toKind === "employee") head.appendChild(el("span", null, `→ ${msg.toName || ""}`));
    else if (msg.toKind === "broadcast") head.appendChild(el("span", null, `→ ${t("全体")}`));
    head.appendChild(el("span", null, fmtClock(msg.createdAtMs)));
    // 「第 N 手」数的是同事之间递话的来回；期限那句是时钟替人喊的，没有来回可言
    if (msg.hop > 0 && msg.fromKind !== "system") head.appendChild(el("span", null, t("第 {n} 手", { n: msg.hop })));
    row.appendChild(head);
    const body = el("div", "office-msg-body clamped", msg.text);
    body.tabIndex = 0;
    body.setAttribute("role", "button");
    const toggle = () => body.classList.toggle("clamped");
    body.addEventListener("click", toggle);
    body.addEventListener("keydown", ev => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
    });
    row.appendChild(body);
    const job = jobOf(msg.jobId);
    if (job?.conversationId) row.appendChild(conversationLink(job));
    feedEl.appendChild(row);
  }
  // 只有这一屏真的摊在人眼前才算「看过了」：后台刷新一律标已读等于替他做完了决定
  if (Number(officeBoard().unreadForUser || 0) > 0
    && panelVisible() && document.getElementById("office-pane-feed")?.classList.contains("active")) {
    markOfficeRead("").catch(() => {});
  }
}

/**
 * 办公室里的会话入口只发一条事件：由 app.js 切到「对话」那一面再换会话。
 * 这里不直接 import chat.js——办公室不该知道对话是怎么渲染的，也避免两块互相拽着初始化。
 */
function openOfficeConversation(job) {
  const id = String(job?.conversationId || "");
  if (!id) return;
  window.dispatchEvent(new CustomEvent("slate:open-conversation", {
    detail: { id, projectId: String(job.projectId || ""), from: "office" },
  }));
}

function conversationLink(job) {
  const btn = el("button", "office-msg-link", t("去看这一场"));
  btn.type = "button";
  btn.addEventListener("click", () => openOfficeConversation(job));
  return btn;
}

// ── 等你拍板 ──────────────────────────────────

/**
 * blocked（缺条件）与 dropped（他判定不该办）都停在这一栏。
 * 两扇门的差别：点头放回队列只有 revive，同意不该办只有 decline——
 * 员工自己两样都推不开，否则「不该办」就成了自我授权。
 */
function renderPending() {
  pendingEl.replaceChildren();
  const jobs = (officeBoard().jobs || []).filter(j => j.status === "blocked" || j.status === "dropped");
  if (pendingCountEl) {
    pendingCountEl.textContent = jobs.length ? String(jobs.length) : "";
    pendingCountEl.hidden = !jobs.length;
  }
  // 顶栏那枚小旗：在「对话」那一面也看得见有几件事等人点头
  if (mastheadPending) mastheadPending.hidden = !jobs.length;
  if (mastheadPendingCount) mastheadPendingCount.textContent = jobs.length ? String(jobs.length) : "";
  if (!jobs.length) {
    const empty = el("div", "office-empty");
    empty.appendChild(el("b", null, t("此刻没有要拍板的事")));
    empty.appendChild(el("div", null, t("员工受阻、或判定某件事不该办时，会进这一栏。")));
    pendingEl.appendChild(empty);
    return;
  }
  for (const job of jobs.slice().reverse()) {
    const card = el("div", "office-pending-item");
    card.dataset.jobId = job.jobId;
    card.dataset.status = job.status;
    const head = el("div", "office-pending-head");
    const emp = employees().find(e => e.employeeId === job.employeeId);
    if (emp) head.appendChild(mark(emp.glyph, emp.hue));
    else head.appendChild(mark("？", 0));
    head.appendChild(el("span", "office-pending-who", job.employeeName || t("已离职")));
    head.appendChild(el("span", "office-pending-kind",
      job.status === "blocked" ? t("缺条件") : t("判为不该办")));
    head.appendChild(el("span", "office-pending-when", fmtClock(job.finishedAtMs)));
    card.appendChild(head);
    card.appendChild(el("div", "office-pending-brief", job.brief));
    card.appendChild(el("div", "office-pending-why", job.stateReason || t("他没写为什么")));

    const actions = el("div", "office-pending-actions");
    const nod = el("button", "btn-mini", job.status === "blocked" ? t("补齐条件，放回队列") : t("不对，放回队列"));
    nod.type = "button";
    nod.addEventListener("click", async () => {
      nod.disabled = true;
      try {
        const res = await reviveJob(job.jobId);
        if (res?.code !== 0) await dlgAlert(res?.message || t("没放回去"));
        else renderViews();
      } finally {
        nod.disabled = false;
      }
    });
    actions.appendChild(nod);
    if (job.status === "dropped") {
      const agree = el("button", "btn-mini", t("同意不该办，结案"));
      agree.type = "button";
      agree.addEventListener("click", async () => {
        if (!await dlgConfirm(t("这条就按他说的不办了？它会移出「等你拍板」，这一趟的记录仍在。"))) return;
        agree.disabled = true;
        try {
          const res = await declineJob(job.jobId);
          if (res?.code !== 0) await dlgAlert(res?.message || t("没改成"));
          else renderViews();
        } finally {
          agree.disabled = false;
        }
      });
      actions.appendChild(agree);
    }
    if (job.conversationId) actions.appendChild(conversationLink(job));
    card.appendChild(actions);
    pendingEl.appendChild(card);
  }
}

// ── 站会与绩效 ────────────────────────────────

/** 一趟平均花多久：这一栏要的是量级，不是毫秒级凭证 */
function fmtSpan(ms) {
  const n = Number(ms) || 0;
  if (!n) return t("还没跑过");
  if (n < 60000) return t("{n} 秒", { n: Math.round(n / 1000) });
  return t("{n} 分", { n: Math.round(n / 60000) });
}

function renderReport() {
  const b = officeBoard();
  reportEl.replaceChildren();
  const byId = new Map(employees().map(e => [e.employeeId, e.name]));

  const standCard = el("section", "office-card");
  standCard.appendChild(el("h5", null, t("今日站会")));
  const stand = Array.isArray(b.standup) ? b.standup : [];
  if (!stand.length) {
    standCard.appendChild(el("div", "office-hint",
      t("还没人自报：给谁排一条勾了「晨会分诊」的值班，他跑完就会在这里留一句。")));
  }
  for (const s of stand) {
    const row = el("div", "office-standup-row");
    row.dataset.employeeId = s.employeeId;
    row.appendChild(el("span", "office-standup-who", byId.get(s.employeeId) || t("已离职")));
    row.appendChild(el("div", "office-standup-line", s.line));
    row.appendChild(el("span", "office-standup-when", fmtClock(s.atMs)));
    standCard.appendChild(row);
  }
  reportEl.appendChild(standCard);

  const perfCard = el("section", "office-card");
  perfCard.appendChild(el("h5", null, t("绩效")));
  perfCard.appendChild(el("div", "office-hint",
    t("办成、待人、被审校退回、一趟平均多久、今天用了多少——全部从队列现算，没有另记一份账。")));
  const perf = Array.isArray(b.performance) ? b.performance : [];
  if (!perf.length) perfCard.appendChild(el("div", "office-hint", t("还没有人可算。")));
  for (const p of perf) {
    const row = el("div", "office-perf-row");
    row.dataset.employeeId = p.employeeId;
    row.appendChild(el("span", "office-perf-who", byId.get(p.employeeId) || t("已离职")));
    const cells = [
      t("办成 {n}", { n: p.done || 0 }),
      p.error ? t("没跑成 {n}", { n: p.error }) : "",
      p.awaiting ? t("待人 {n}", { n: p.awaiting }) : "",
      p.pendingReview ? t("待审校 {n}", { n: p.pendingReview }) : "",
      p.returnedCount ? t("退回 {n}", { n: p.returnedCount }) : "",
      fmtSpan(p.avgWallMs),
      p.dailyTokenCap ? t("{a} / 上限 {b}", { a: p.tokensToday, b: p.dailyTokenCap })
        : t("今日 {n}", { n: p.tokensToday }),
    ].filter(Boolean);
    row.appendChild(el("span", "office-perf-cells", cells.join(" · ")));
    if (p.overBudget) row.appendChild(el("span", "office-perf-cap", t("预算已满")));
    perfCard.appendChild(row);
  }
  reportEl.appendChild(perfCard);
}

// ── 值班表 ────────────────────────────────────

function renderDuties() {
  dutiesEl.replaceChildren();
  const emp = selectedEmployee();
  if (!emp) {
    const empty = el("div", "office-empty");
    empty.appendChild(el("b", null, t("先选一位员工")));
    empty.appendChild(el("div", null, t("值班表是排给某个人的：点一位，这里才看得见他的班。")));
    dutiesEl.appendChild(empty);
    return;
  }
  const list = (officeBoard().duties || []).filter(d => d.employeeId === emp.employeeId);
  if (!list.length) {
    const empty = el("div", "office-empty");
    empty.appendChild(el("b", null, t("{name} 还没有班", { name: emp.name })));
    empty.appendChild(el("div", null, t("下面「新增值班」那条填好，到点或事件发生时会排一条活给他。")));
    dutiesEl.appendChild(empty);
  }
  for (const duty of list) dutiesEl.appendChild(dutyRow(duty));
}

function eventTypeLabel(eventType) {
  if (eventType === "file_change") return t("文件变更");
  if (eventType === "git_push") return t("Git 推送");
  if (eventType === "webhook") return t("外部回调");
  return t("未填");
}

// 同样走字面键： kinds 从后端来，标签在本页查表，i18n 覆盖守卫才看得见这几句
function guardKindLabel(kind) {
  if (kind === "open_jobs_max") return t("手上待办不超过几条");
  if (kind === "file_change") return t("文件有变更");
  if (kind === "git_head") return t("提交有前进");
  if (kind === "check_script") return t("自检脚本变红");
  return kind || t("未填");
}

function dutyWhenText(duty) {
  if (duty.mode === "interval") return t("每 {n} 分钟", { n: duty.everyMinutes });
  if (duty.mode === "once") return t("一次 · {when}", { when: duty.time });
  if (duty.mode === "daily") return t("每日 · {when}", { when: duty.time });
  return t("事件 · {kind}", { kind: eventTypeLabel(duty.eventType) });
}

/**
 * 守卫条件翻成人话。JSON 只在后端存一份（写入时 validate_guard 已规范化），
 * 这里读不出就如实说读不出，不猜——猜错的一行字会让人以为道闸是开着的。
 */
function guardText(raw) {
  if (!raw) return "";
  let doc = null;
  try { doc = JSON.parse(String(raw)); } catch { return t("守卫条件读不出"); }
  if (!doc || typeof doc !== "object") return t("守卫条件读不出");
  const kind = String(doc.kind || "");
  if (kind === "open_jobs_max") return t("手上待办不超过 {n} 条", { n: Number(doc.n) || 0 });
  if (kind === "file_change") return t("文件有变更{who}", { who: doc.paths ? `（${doc.paths}）` : "" });
  if (kind === "git_head") return t("提交有前进{who}", { who: doc.repo ? `（${doc.repo}）` : "" });
  if (kind === "check_script") return t("{script} 变红", { script: String(doc.script || "") });
  return t("条件 {kind} 已不认识", { kind: kind || "?" });
}

function dutyRow(duty) {
  const row = el("div", "office-duty");
  row.dataset.dutyId = duty.dutyId;
  const head = el("div", "office-duty-head");
  head.appendChild(el("span", "office-duty-name", duty.name || t("未命名值班")));
  head.appendChild(el("span", "office-duty-when", dutyWhenText(duty)));
  if (duty.triage) head.appendChild(el("span", "office-duty-flag", t("晨会分诊")));
  row.appendChild(head);
  row.appendChild(el("div", "office-duty-brief", duty.prompt));
  const guard = guardText(duty.guard);
  if (guard) row.appendChild(el("div", "office-duty-guard", t("只在 {when} 时才排", { when: guard })));
  const why = String(duty.lastStatus || "");
  const status = el("div", "office-duty-status", duty.lastRunMs
    ? t("上次 {when} · {why}", { when: fmtClock(duty.lastRunMs), why: why || "ok" })
    : (why || t("还没跑过")));
  if (/关闭|失败|没办完|不存在/.test(why)) status.dataset.kind = "error";
  row.appendChild(status);

  const actions = el("div", "office-duty-actions");
  const runBtn = el("button", "btn-mini", t("立即交班"));
  runBtn.type = "button";
  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    const res = await runDutyNow(duty.dutyId);
    runBtn.disabled = false;
    if (res?.code !== 0) await dlgAlert(res?.message || t("没排进去"));
  });
  actions.appendChild(runBtn);

  const toggleBtn = el("button", "btn-mini", duty.enabled ? t("停用") : t("启用"));
  toggleBtn.type = "button";
  toggleBtn.addEventListener("click", () => patchDuty(duty.dutyId, { enabled: !duty.enabled }));
  actions.appendChild(toggleBtn);

  const delBtn = el("button", "btn-mini", t("删除"));
  delBtn.type = "button";
  delBtn.addEventListener("click", async () => {
    if (!await dlgConfirm(t("取消这条值班？已交付的历史会保留。"))) return;
    await removeDuty(duty.dutyId);
  });
  actions.appendChild(delBtn);
  row.appendChild(actions);
  return row;
}

function dutyForm() {
  const wrap = el("div", "office-duty-new");
  const emp = selectedEmployee();
  if (!emp) {
    wrap.appendChild(el("div", "office-hint", t("先选一位员工才能排班")));
    return wrap;
  }
  wrap.appendChild(el("div", "office-pane-title", t("新增值班")));
  const nameInput = el("input", "office-input");
  nameInput.placeholder = t("这条值班叫什么");
  const briefInput = el("textarea", "office-textarea");
  briefInput.placeholder = t("到点要他做什么（这段就是给他的交办内容）");
  briefInput.rows = 2;

  const modeSelect = el("select", "office-select");
  for (const [value, label] of [["daily", t("每日定时")], ["once", t("只跑一次")],
    ["interval", t("每隔几分钟")], ["event", t("事件触发")]]) {
    const opt = el("option", null, label);
    opt.value = value;
    modeSelect.appendChild(opt);
  }
  const timeInput = el("input", "office-input");
  timeInput.type = "time";
  timeInput.value = "09:00";
  const everyInput = el("input", "office-input");
  everyInput.type = "number";
  everyInput.min = "1";
  everyInput.value = "60";
  const eventSelect = el("select", "office-select");
  for (const [value, label] of [["file_change", t("文件变更")], ["git_push", t("Git 推送")],
    ["webhook", t("外部回调")]]) {
    const opt = el("option", null, label);
    opt.value = value;
    eventSelect.appendChild(opt);
  }
  const watchInput = el("input", "office-input");
  watchInput.placeholder = t("盯哪些路径或仓库（留空按这一位的项目根）");

  field(wrap, t("名称"), nameInput);
  field(wrap, t("要做的事"), briefInput);
  field(wrap, t("模式"), modeSelect);
  const timeRow = field(wrap, t("时间"), timeInput);
  const everyRow = field(wrap, t("间隔"), everyInput);
  const eventRow = field(wrap, t("事件"), eventSelect);
  const watchRow = field(wrap, t("路径"), watchInput);
  const untilInput = el("input", "office-input");
  untilInput.type = "date";
  const untilRow = field(wrap, t("截止"), untilInput);

  // 守卫：条件种类从后端的 guardKinds 读，不在这里抄一份——两处各列一遍迟早对不上
  const guardSelect = el("select", "office-select");
  const noGuard = el("option", null, t("到点就动"));
  noGuard.value = "";
  guardSelect.appendChild(noGuard);
  for (const kind of officeBoard().guardKinds || []) {
    const opt = el("option", null, guardKindLabel(kind));
    opt.value = kind;
    guardSelect.appendChild(opt);
  }
  const guardRow = field(wrap, t("守卫"), guardSelect);
  const guardValue = el("input", "office-input");
  const guardValueRow = field(wrap, t("条件取值"), guardValue);
  guardValueRow.hidden = true;
  const triageInput = el("input", "office-input");
  triageInput.type = "checkbox";
  const triageRow = field(wrap, t("晨会分诊"), triageInput);
  triageRow.appendChild(el("span", "office-hint",
    t("到点先让他排一遍自己的队列：该办的排前面、暂缓的留下、判不该办要写理由（判了要人点头才回队列）")));

  modeSelect.addEventListener("change", syncModeRows);
  eventSelect.addEventListener("change", syncModeRows);
  guardSelect.addEventListener("change", syncGuardRows);
  function syncGuardRows() {
    const kind = guardSelect.value;
    guardValueRow.hidden = !kind;
    guardValue.placeholder = kind === "open_jobs_max" ? t("几条以内（0＝手上没活才动）")
      : kind === "file_change" ? t("盯哪些路径（留空按这一位的项目根）")
        : kind === "git_head" ? t("哪个仓库（留空按这一位的项目根）")
          : kind === "check_script" ? t("scripts/ 里的自检脚本文件名，如 check_office.mjs")
            : "";
    guardValue.type = kind === "open_jobs_max" ? "number" : "text";
    guardValue.min = kind === "open_jobs_max" ? "0" : undefined;
    guardValue.value = kind === "open_jobs_max" ? "0" : "";
  }
  syncGuardRows();
  function syncModeRows() {
    const mode = modeSelect.value;
    const isWatch = mode === "event" && eventSelect.value !== "webhook";
    timeRow.hidden = mode === "interval" || mode === "event";
    everyRow.hidden = mode !== "interval";
    eventRow.hidden = mode !== "event";
    watchRow.hidden = !isWatch;
    untilRow.hidden = mode === "daily";
  }
  syncModeRows();

  function guardPayload() {
    const kind = guardSelect.value;
    if (!kind) return "";
    const value = guardValue.value.trim();
    if (kind === "open_jobs_max") return JSON.stringify({ kind, n: Number(value) || 0 });
    if (kind === "check_script") return JSON.stringify({ kind, script: value });
    if (kind === "git_head") return JSON.stringify(value ? { kind, repo: value } : { kind });
    return JSON.stringify(value ? { kind, paths: value } : { kind });
  }

  const send = el("button", "btn-primary", t("排班"));
  send.type = "button";
  send.addEventListener("click", async () => {
    const prompt = briefInput.value.trim();
    if (!prompt) { await dlgAlert(t("要做什么还没写")); return; }
    const res = await addDuty({
      employeeId: emp.employeeId,
      name: nameInput.value.trim(),
      prompt,
      mode: modeSelect.value,
      time: timeInput.value,
      everyMinutes: Number(everyInput.value) || 60,
      eventType: modeSelect.value === "event" ? eventSelect.value : "",
      watchPaths: watchInput.value,
      gitRepo: modeSelect.value === "event" && eventSelect.value === "git_push" ? watchInput.value : "",
      untilMs: untilInput.value ? new Date(`${untilInput.value}T23:59:59`).getTime() : 0,
      guard: guardPayload(),
      triage: triageInput.checked ? 1 : 0,
    });
    if (res?.code !== 0) { await dlgAlert(res?.message || t("没能排上")); return; }
    briefInput.value = "";
    nameInput.value = "";
    renderDuties();
    renderRoster();
  });
  wrap.appendChild(send);
  return wrap;
}

// ── 岗位（选中那一位的可编辑表单）────────────────

function renderStaff() {
  staffEl.replaceChildren();
  const emp = selectedEmployee();
  if (emp) { staffTemplateCount = -1; staffEl.appendChild(staffForm(emp)); return; }
  staffEl.appendChild(el("h4", null, t("按模板招一位")));
  const grid = el("div", "office-template-grid");
  const templates = officeBoard().templates || [];
  staffTemplateCount = templates.length;
  if (!templates.length) {
    grid.appendChild(el("div", "office-hint", t("模板尚未读取完成，请稍后再点招聘。")));
  }
  for (const tpl of templates) {
    const card = el("button", "office-template");
    card.type = "button";
    card.appendChild(el("b", null, `${tpl.glyph || ""} ${tpl.name}`));
    card.appendChild(el("span", null, tpl.role));
    card.appendChild(el("span", "office-hint", String(tpl.duty_text || "").split("\n")[0]));
    card.addEventListener("click", () => openHireDraft(tpl));
    grid.appendChild(card);
  }
  staffEl.appendChild(grid);
  staffEl.appendChild(el("p", "office-hint", t("模板只是一张填好的表；招进来以后每一格都能改。")));
}

function openHireDraft(tpl) {
  selectedId = "";
  renderStaffWith({
    employeeId: "", name: tpl.name || "", role: tpl.role || "", dutyText: tpl.duty_text || "",
    modelId: "", glyph: tpl.glyph || "", hue: tpl.hue || 0,
    roundsBudget: 8, unattended: false, projectId: "",
  });
}

/** 草稿走同一张表单：模板只是把格子填满，落库与否由这张表上那颗「招聘」决定 */
function renderStaffWith(emp) {
  staffTemplateCount = -1;
  staffEl.replaceChildren();
  staffEl.appendChild(staffForm(emp));
}

function staffForm(emp) {
  const isNew = !emp.employeeId;
  const wrap = el("div", "office-staff-form");
  wrap.appendChild(el("h4", null, isNew ? t("新同事") : t("{name} 的岗位", { name: emp.name })));

  // 选中一位同事时，最近一趟交付与它那场会话就摊在岗位表最上面：
  // 这是「从工位走到对话」最顺的一条路，也不用再回去翻动态流。
  if (!isNew) {
    const recent = el("div", "office-staff-recent");
    recent.appendChild(el("span", "office-staff-recent-label", t("最近交付")));
    recent.appendChild(el("span", "office-staff-recent-line", lastQuietLine(emp)));
    if (emp.lastJob?.conversationId) {
      const go = el("button", "office-staff-recent-go", t("看对话"));
      go.type = "button";
      go.addEventListener("click", () => openOfficeConversation(emp.lastJob));
      recent.appendChild(go);
    }
    wrap.appendChild(recent);
  }

  const nameInput = el("input", "office-input");
  nameInput.value = emp.name || "";
  nameInput.placeholder = t("同事之间靠名字寻址，不能重名");
  const roleInput = el("input", "office-input");
  roleInput.value = emp.role || "";
  roleInput.placeholder = t("岗位一句话");
  const objectiveInput = el("textarea", "office-textarea");
  objectiveInput.value = emp.objective || "";
  objectiveInput.rows = 2;
  objectiveInput.placeholder = t("目标：他为什么在这儿（他排顺序、判该不该办时按这个取舍）");
  const dutyInput = el("textarea", "office-textarea");
  dutyInput.value = emp.dutyText || "";
  dutyInput.placeholder = t("职责：他该怎么干活（这段直接进他的系统提示词）");
  const glyphInput = el("input", "office-input");
  glyphInput.value = emp.glyph || "";
  glyphInput.maxLength = 2;
  glyphInput.placeholder = t("头像字符");
  const hueInput = el("input", "office-input");
  hueInput.type = "range";
  hueInput.min = "0";
  hueInput.max = "359";
  hueInput.value = String(emp.hue || 0);

  const modelSelect = el("select", "office-select");
  const follow = el("option", null, t("跟随当前主模型"));
  follow.value = "";
  modelSelect.appendChild(follow);
  for (const m of allRegisteredModels()) {
    if (!m?.id) continue;
    const opt = el("option", null, m.name || m.id);
    opt.value = m.id;
    modelSelect.appendChild(opt);
  }
  modelSelect.value = emp.modelId || "";
  if (modelSelect.value !== (emp.modelId || "")) {
    // 名册上钉的那只已从注册表里删掉了：如实留名，别让保存动作顺手把它洗成"跟随主模型"
    const gone = el("option", null, `${emp.modelId}（${t("注册表里已没有这只")}）`);
    gone.value = emp.modelId;
    modelSelect.appendChild(gone);
    modelSelect.value = emp.modelId;
  }

  const budgetInput = el("input", "office-input");
  budgetInput.type = "number";
  budgetInput.min = "1";
  budgetInput.max = "24";
  budgetInput.value = String(emp.roundsBudget || 8);

  // 审校人：只能选别人（自己判自己合格等于没有这道门，后端那一格也照样拒）
  const gateSelect = el("select", "office-select office-gate");
  const noGate = el("option", null, t("不设审校（交付直接给你）"));
  noGate.value = "";
  gateSelect.appendChild(noGate);
  for (const other of (officeBoard().employees || []).filter(e => e.employeeId !== emp.employeeId)) {
    const opt = el("option", null, `${other.name}（${other.role || t("未填岗位")}）`);
    opt.value = other.employeeId;
    gateSelect.appendChild(opt);
  }
  gateSelect.value = emp.reviewGate || "";
  if (emp.reviewGate && gateSelect.value !== emp.reviewGate) {
    // 那位已经不在名册上了：如实留着这一格，别保存时顺手把门洗成"没有"
    const gone = el("option", null, `${emp.reviewGate}（${t("名册里已没有这位")}）`);
    gone.value = emp.reviewGate;
    gateSelect.appendChild(gone);
    gateSelect.value = emp.reviewGate;
  }

  const capInput = el("input", "office-input office-cap");
  capInput.type = "number";
  capInput.min = "0";
  capInput.step = "1000";
  capInput.value = String(emp.dailyTokenCap || 0);

  const unattendedInput = el("input", "office-input");
  unattendedInput.type = "checkbox";
  unattendedInput.checked = !!emp.unattended;

  const projectSelect = el("select", "office-select");
  const anywhere = el("option", null, t("不指定项目（使用当前打开的项目）"));
  anywhere.value = "";
  projectSelect.appendChild(anywhere);
  for (const p of state.projects || []) {
    const opt = el("option", null, p.name || p.id);
    opt.value = p.id;
    projectSelect.appendChild(opt);
  }
  projectSelect.value = emp.projectId || "";
  if (projectSelect.value !== (emp.projectId || "") && emp.projectId) {
    const gone = el("option", null, `${emp.projectId}（${t("注册表里已没有这个项目")}）`);
    gone.value = emp.projectId;
    projectSelect.appendChild(gone);
    projectSelect.value = emp.projectId;
  }

  field(wrap, t("名字"), nameInput);
  field(wrap, t("岗位"), roleInput);
  field(wrap, t("目标"), objectiveInput);
  field(wrap, t("职责"), dutyInput);
  field(wrap, t("头像"), glyphInput);
  field(wrap, t("色相"), hueInput);
  field(wrap, t("模型"), modelSelect);
  field(wrap, t("轮数"), budgetInput);
  field(wrap, t("项目"), projectSelect);
  field(wrap, t("审校"), gateSelect).appendChild(
    el("span", "office-hint", t("设了之后，他的交付先进这位同事的队列，判合格才递到你手上")),
  );
  field(wrap, t("每日预算"), capInput).appendChild(
    el("span", "office-hint", t("0＝不限。用超之后值班不再排新活，已排队的照旧办完")),
  );
  field(wrap, t("托管"), unattendedInput).appendChild(
    el("span", "office-hint", t("托管＝这一场按夜间档跑：高危命令不问、缺条件也不反问")),
  );

  const actions = el("div", "office-staff-actions");
  const save = el("button", "btn-primary", isNew ? t("招聘") : t("保存"));
  save.type = "button";
  save.addEventListener("click", async () => {
    const payload = {
      name: nameInput.value.trim(),
      role: roleInput.value.trim(),
      objective: objectiveInput.value.trim(),
      dutyText: dutyInput.value.trim(),
      glyph: glyphInput.value.trim(),
      hue: Number(hueInput.value) || 0,
      modelId: modelSelect.value,
      roundsBudget: Number(budgetInput.value) || 8,
      unattended: unattendedInput.checked,
      projectId: projectSelect.value,
      reviewGate: gateSelect.value,
      dailyTokenCap: Number(capInput.value) || 0,
    };
    if (!payload.name) { await dlgAlert(t("名字还没填")); return; }
    const res = isNew ? await hireEmployee(payload) : await patchEmployee(emp.employeeId, payload);
    if (res?.code !== 0) { await dlgAlert(res?.message || t("没能存下来")); return; }
    selectedId = res.data?.employeeId || emp.employeeId;
    renderAll();
  });
  actions.appendChild(save);

  if (!isNew) {
    const jobBtn = el("button", "btn-mini", t("交办一条活"));
    jobBtn.type = "button";
    jobBtn.addEventListener("click", () => {
      toSelect.value = emp.employeeId;
      sayInput.focus();
    });
    actions.appendChild(jobBtn);

    const stopBtn = el("button", "btn-mini", t("停止这一趟"));
    stopBtn.type = "button";
    stopBtn.addEventListener("click", () => {
      const mine = officeRunning().filter(r => r.employeeId === emp.employeeId);
      if (!mine.length) { dlgAlert(t("此刻没有在跑的活")); return; }
      for (const rec of mine) stopOfficeJob(rec.jobId);
    });
    actions.appendChild(stopBtn);

    const fireBtn = el("button", "btn-mini", t("解雇"));
    fireBtn.type = "button";
    fireBtn.addEventListener("click", async () => {
      if (!await dlgConfirm(t("解雇 {name}？其值班表一并删除，已交付的历史会保留。", { name: emp.name }))) return;
      await fireEmployee(emp.employeeId);
      selectedId = "";
      renderAll();
    });
    actions.appendChild(fireBtn);
  } else {
    const cancel = el("button", "btn-mini", t("先不招"));
    cancel.type = "button";
    cancel.addEventListener("click", renderStaff);
    actions.appendChild(cancel);
  }
  wrap.appendChild(actions);
  if (!isNew) wrap.appendChild(noteList(emp));
  return wrap;
}

function noteKindLabel(kind) {
  if (kind === "open") return t("未闭环");
  if (kind === "ledger") return t("已定论");
  if (kind === "blocked") return t("受阻");
  return t("未填");
}

/**
 * 他自己记的事（备忘清单）。划掉只重画这一块：整张岗位表单跟着刷新，
 * 等于把用户正在打的另一格吃掉——这条口径本页到处都在守。
 */
function noteList(emp) {
  const host = el("div", "office-notes");
  host.dataset.employeeId = emp.employeeId;
  const draw = () => {
    host.replaceChildren(el("h5", null, t("他留下的备忘")));
    const notes = (officeBoard().notes || [])
      .filter(n => n.employeeId === emp.employeeId).slice().reverse();
    if (!notes.length) {
      host.appendChild(el("div", "office-hint",
        t("还没留下备忘。他办完一件事、或受阻的时候会写在这里。")));
      return;
    }
    for (const note of notes) {
      const row = el("div", "office-note");
      row.dataset.kind = note.kind;
      row.dataset.noteId = note.noteId;
      row.appendChild(el("span", "office-note-tag", noteKindLabel(note.kind)));
      row.appendChild(el("span", "office-note-text", `${note.text}${note.ref ? `（${note.ref}）` : ""}`));
      row.appendChild(el("span", "office-note-when", fmtClock(note.updatedAtMs)));
      const drop = el("button", "btn-mini", t("划掉"));
      drop.type = "button";
      drop.setAttribute("aria-label", t("划掉这条备忘"));
      drop.addEventListener("click", async () => {
        drop.disabled = true;
        const res = await closeOfficeNote(emp.employeeId, note.noteId);
        if (res?.code !== 0) {
          drop.disabled = false;
          await dlgAlert(res?.message || t("没划掉"));
        } else {
          draw();
        }
      });
      row.appendChild(drop);
      host.appendChild(row);
    }
  };
  draw();
  host.redraw = draw;
  return host;
}

function field(parent, label, node) {
  const row = el("div", "office-field-row");
  row.appendChild(el("span", null, label));
  row.appendChild(node);
  parent.appendChild(row);
  return row;
}

// ── 交办输入行 ────────────────────────────────

function renderComposerSelect() {
  const keep = toSelect.value;
  toSelect.replaceChildren();
  for (const emp of employees()) {
    const opt = el("option", null, `${emp.name} · ${emp.role || t("未填岗位")}`);
    opt.value = emp.employeeId;
    toSelect.appendChild(opt);
  }
  toSelect.value = [...toSelect.options].some(o => o.value === keep)
    ? keep : (employees()[0]?.employeeId || "");
  if (sendBtn) sendBtn.disabled = !employees().length;
}

async function sendFromComposer(asBroadcast) {
  const text = sayInput.value.trim();
  if (!text) { await dlgAlert(t("要说的话还是空的")); return; }
  const target = employees().find(e => e.employeeId === toSelect.value);
  if (!asBroadcast && !target) { await dlgAlert(t("先招一位员工")); return; }
  const res = asBroadcast
    ? await sayAtOffice({ toKind: "broadcast", toId: "", toName: "", text })
    : await sayAtOffice({ toKind: "employee", toId: target.employeeId, toName: target.name, text });
  if (res?.code !== 0) { await dlgAlert(res?.message || t("没送出去")); return; }
  sayInput.value = "";
  startOfficeEngine();
  // 只重画展示区：岗位/值班那两张表里可能正打着字
  renderViews();
}

// ── 气泡 ──────────────────────────────────────

function pushBubble(employeeId, text) {
  const id = String(employeeId || "");
  if (!id || !text) return;
  bubbles.set(id, { text, fading: false });
  renderFloor();
  setTimeout(() => {
    if (bubbles.get(id)?.text !== text) return;
    bubbles.set(id, { text, fading: true });
    renderFloor();
    setTimeout(() => {
      if (bubbles.get(id)?.fading) {
        bubbles.delete(id);
        renderFloor();
      }
    }, 400);
  }, BUBBLE_MS);
}

function renderViews() {
  renderRoster();
  renderFloor();
  renderFeed();
  renderPending();
  renderReport();
  renderDuties();
  renderComposerSelect();
}

/** 表单只跟着「选谁」重画：board 每几秒到一次，跟着刷就会把用户正在打的那句吃掉 */
function renderForms() {
  // 那位已经不在了（别的窗口解雇了 / 恢复备份换了库）：表单跟着回到模板页，别留半张空表
  if (selectedId && !selectedEmployee()) selectedId = "";
  renderStaff();
  dutyFormHost.replaceChildren(dutyForm());
}

/** 模板是随第一份快照才到的：只补画「正摆着模板」那一页，摊开在填的表一张都不碰 */
function refreshStaffTemplates() {
  const n = (officeBoard().templates || []).length;
  if (staffTemplateCount >= 0) {
    if (n !== staffTemplateCount) renderStaff();
    return;
  }
  // 摊着的是某人那张表而他已被这一场别的窗口解雇：留着就是半张空表，存盘只会报不存在
  if (selectedId && !selectedEmployee()) { renderForms(); return; }
  // 备忘是员工跑那一趟时长出来的：表单不能跟着刷（会吃掉正在打的那一格），只补画清单这一块
  const host = staffEl.querySelector(".office-notes");
  if (!host?.redraw) return;
  const stamp = (officeBoard().notes || [])
    .filter(x => x.employeeId === selectedId).map(x => `${x.noteId}:${x.updatedAtMs}`).join("|");
  if (stamp !== notesStamp) {
    notesStamp = stamp;
    host.redraw();
  }
}

function renderAll() {
  renderViews();
  renderForms();
}

function selectEmployee(employeeId) {
  selectedId = selectedId === employeeId ? "" : employeeId;
  renderViews();
  renderForms();
}

export function initOfficePanel() {
  rosterList = document.getElementById("office-roster-list");
  rosterFoot = document.getElementById("office-roster-foot");
  floorEl = document.getElementById("office-floor");
  floorStats = document.getElementById("office-floor-stats");
  feedEl = document.getElementById("office-feed");
  pendingEl = document.getElementById("office-pending");
  pendingCountEl = document.getElementById("office-pending-count");
  mastheadPending = document.getElementById("office-masthead-pending");
  mastheadPendingCount = document.getElementById("office-masthead-pending-count");
  dutiesEl = document.getElementById("office-duties");
  staffEl = document.getElementById("office-staff");
  reportEl = document.getElementById("office-report");
  toSelect = document.getElementById("office-to");
  sayInput = document.getElementById("office-say");
  sendBtn = document.getElementById("btn-office-send");
  if (!rosterList || !floorEl || !dutiesEl || !staffEl || !reportEl) return;

  // 新增表单跟在已排好的班后面：它不是快照的一部分，所以单独一个容器，不被刷新碰
  dutyFormHost = el("div", "office-duty-host");
  dutiesEl.parentElement?.appendChild(dutyFormHost);

  document.getElementById("btn-office-hire")?.addEventListener("click", () => {
    openHireDraft((officeBoard().templates || [])[0] || { name: "", role: "", duty_text: "", glyph: "", hue: 0 });
    activateSideTab("staff");
  });
  sendBtn?.addEventListener("click", () => sendFromComposer(false));
  document.getElementById("btn-office-broadcast")?.addEventListener("click", () => sendFromComposer(true));
  sayInput?.addEventListener("keydown", ev => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      sendFromComposer(false);
    }
  });
  document.querySelectorAll(".office-side-tab").forEach(tab => {
    tab.addEventListener("click", () => activateSideTab(tab.dataset.tab));
  });
  mastheadPending?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("slate:office-view", { detail: { view: "desk" } }));
    activateSideTab("pending");
  });

  officeEvents.on(ev => {
    if (ev.type === "activity") {
      pushBubble(ev.employeeId, ev.text);
      return;
    }
    if (ev.type === "job" && ev.status === "running") {
      pushBubble(ev.employeeId, t("接活了"));
      renderViews();
      return;
    }
    renderViews();
    refreshStaffTemplates();
  });
  renderAll();
}

function activateSideTab(name) {
  const key = String(name || "feed");
  document.querySelectorAll(".office-side-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.tab === key);
  });
  document.querySelectorAll(".office-side-pane").forEach(pane => {
    pane.classList.toggle("active", pane.id === `office-pane-${key}`);
  });
}

/** 页签切回来时补一次：引擎那份快照按慢探刷新，回到这一屏要立刻看见实况 */
export function refreshOfficePanel() {
  startOfficeEngine();
  renderAll();
}
