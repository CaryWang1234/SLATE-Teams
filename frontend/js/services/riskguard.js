/**
 * SLATE 审批门（命令执行 / 联网访问的唯一判口）
 * - 三档语义由这一场生效的审批模式决定（store.permissionModeFor），见 guardSkillCall 注释
 * - 高危判定为写死规则（与后端 backend/skills/terminal.py 同一份清单），auto 档只拦这一类
 * - 命中后弹出审批框，命令类还会调用当前模型解释命令目的
 * - 用户批准后注入 approved 参数放行；拒绝后把拒绝理由原样回给模型
 */

import { state, getModelKey, permissionModeFor } from "../store.js?v=20261024-001";
import { post } from "./api.js?v=20261024-001";
import { aiModelFor, isAiFeatureOn } from "./ai_features.js?v=20261024-001";
import { t } from "./i18n.js?v=20261024-001";

// 高危命令规则（写死）：命中任一条即要求批准
const HIGH_RISK_PATTERNS = [
  { re: /\brm\b/i, reason: "删除文件（rm）" },
  { re: /\b(rmdir|shred|unlink)\b/i, reason: "删除文件/目录" },
  { re: /\b(del|erase)\b\s/i, reason: "删除文件（del/erase）" },
  { re: /\brd\b\s/i, reason: "删除目录（rd）" },
  { re: /Remove-Item/i, reason: "删除文件（Remove-Item）" },
  { re: /\bdd\b(?=.*\bof=)/i, reason: "磁盘写入（dd）" },
  { re: /\b(fdisk|diskpart|parted)\b/i, reason: "磁盘分区操作" },
  { re: /\bdiskutil\s+(erase|reformat|partitionDisk|secureErase)/i, reason: "抹掉/重分区磁盘卷（macOS diskutil）" },
  { re: /\b(shutdown|reboot|poweroff|halt)\b/i, reason: "关机/重启" },
  { re: /\binit\s+[06]\b/, reason: "关机/重启" },
  { re: /\bsudo\b/i, reason: "提权执行（sudo）" },
  { re: /\b(taskkill|killall)\b/i, reason: "强制结束进程" },
  { re: /\bkill\s+-9\b/i, reason: "强制结束进程（kill -9）" },
  { re: /reg\s+(delete|add)\b/i, reason: "修改注册表" },
  { re: /\bsc\s+(delete|stop)\b/i, reason: "管理系统服务" },
  { re: /\bnet\s+user\b/i, reason: "修改用户账户" },
  { re: /\b(takeown|icacls)\b/i, reason: "修改文件所有权/权限" },
  { re: /\bchmod\s+(-R\s+)?777\b/i, reason: "开放全部权限（chmod 777）" },
  { re: /git\s+push\s+[^;]*(--force\b|-f\b|--force-with-lease)/i, reason: "Git 强制推送" },
  { re: /git\s+reset\s+--hard/i, reason: "Git 硬重置（丢弃改动）" },
  { re: /git\s+clean\s+-[a-z]*f/i, reason: "Git 清理未跟踪文件" },
  { re: /git\s+branch\s+-D\b/i, reason: "Git 强制删除分支" },
  { re: /(drop\s+(database|table|schema)|truncate\s+table)/i, reason: "数据库删表/删库" },
  { re: /(npm|pnpm|yarn)\s+(uninstall|remove)\s+(-g|--global)/i, reason: "卸载全局依赖" },
];

// 从网络下载并直接交给 shell 执行（整条命令级别判定）
const PIPE_TO_SHELL = /(curl|wget|invoke-webrequest|iwr)[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh|Invoke-Expression|\biex\b/i;

/**
 * 判断命令是否高危：返回 { risk, reason }
 */
function isHighRiskCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return { risk: false, reason: "" };
  if (PIPE_TO_SHELL.test(cmd)) return { risk: true, reason: "从网络下载并直接执行脚本" };
  // 拆分命令链（&&、||、;、|），逐段检测
  for (const seg of cmd.split(/&&|\|\||;|\|/)) {
    const s = seg.trim();
    if (!s) continue;
    for (const { re, reason } of HIGH_RISK_PATTERNS) {
      if (re.test(s)) return { risk: true, reason };
    }
  }
  return { risk: false, reason: "" };
}

/**
 * 用当前模型解释命令目的（失败时返回兜底文案）
 */
async function explainCommand(command) {
  // 关掉就少发一趟请求：审批照常拦，只是不再解释这条命令
  if (!isAiFeatureOn("command_explain")) return t("（命令目的说明已关闭，可在设置 → AI 辅助功能打开）");
  const target = aiModelFor("command_explain", state.currentModel);
  if (!target.usable) return t("（当前未配置模型或 API Key，无法生成目的说明）");
  try {
    const res = await post("/proxy/chat", {
      model: target.id,
      api_key: target.key,
      stream: false,
      temperature: 0.2,
      max_tokens: 200,
      messages: [
        { role: "system", content: "你是终端命令安全分析器。用一两句话客观解释该命令的目的与潜在影响，不超过60字，不要给出执行建议" },
        { role: "user", content: command },
      ],
    });
    const text = res?.data?.choices?.[0]?.message?.content?.trim();
    return text || t("（模型未返回说明）");
  } catch (e) {
    return t("（说明生成失败: {msg}）", { msg: e.message });
  }
}

// ── 审批弹窗（Promise 化） ───────────────────

let modal, titleEl, subjectLabelEl, cmdEl, reasonEl, explainLabelEl, explainEl, noteEl, approveBtn;
let pendingResolve = null;

function settle(approved) {
  modal?.classList.add("hidden");
  const resolveFn = pendingResolve;
  pendingResolve = null;
  if (resolveFn) resolveFn(approved);
}

/**
 * 这一笔归不归审批管，以及要给用户看的那"一个目标"：
 * - 命令类：terminal 执行命令、bg_task 起任务（status/log/stop 不改环境，不算）
 * - 联网类：搜索、抓网页、开浏览器（三者都是"从外面拿东西回来"）
 * 其余工具（读写本地文件等）不走这道门。
 */
function approvalSubjectOf(skill, params) {
  if (skill === "terminal" && params?.command) return { kind: "command", target: String(params.command) };
  if (skill === "bg_task" && params?.command && (params.action || "start") === "start") {
    return { kind: "command", target: String(params.command) };
  }
  if (skill === "web_search") return { kind: "network", target: String(params?.query || "") };
  if (skill === "web_fetch") return { kind: "network", target: String(params?.url || "") };
  if (skill === "browser_automation") {
    return { kind: "network", target: [params?.action, params?.url].filter(Boolean).join(" ") };
  }
  return null;
}

/**
 * 弹一次审批框（桌面那副 modal）。同一时刻只摆一张，后来的排在队里等：
 * ask 档下每一笔命令/联网都要问，并行子代理会一次挤出好几张——
 * 老做法是"已有待决审批就直接拒绝后来的"，那是让用户根本没见过面就替他们说了"不"。
 */
let approvalChain = Promise.resolve();

function requestApproval(subject, risk) {
  const asked = approvalChain.then(() => askInModal(subject, risk));
  // 队尾只认"上一张关掉了"，无论它是批准还是拒绝走完的
  approvalChain = asked.then(() => {}, () => {});
  return asked;
}

function askInModal(subject, risk) {
  if (!modal) return Promise.resolve(false);
  return new Promise((resolve) => {
    pendingResolve = resolve;
    const highRisk = Boolean(risk?.risk);
    const isCommand = subject.kind === "command";
    titleEl.textContent = t(highRisk ? "高危命令审批" : isCommand ? "命令执行审批" : "联网访问审批");
    subjectLabelEl.textContent = t(isCommand ? "命令" : "访问目标");
    cmdEl.textContent = subject.target;
    if (highRisk) {
      reasonEl.textContent = t("触发规则：{reason}", { reason: t(risk.reason) });
    } else {
      reasonEl.textContent = t("当前审批模式：{why}", {
        why: t(isCommand ? "手动审批下执行命令逐条确认" : "手动审批下访问网络逐条确认"),
      });
    }
    // 目的说明只对命令有意义（模型解释一条命令要干什么）；联网那一笔不编造说明，整块收起
    explainLabelEl.classList.toggle("hidden", !isCommand);
    explainEl.classList.toggle("hidden", !isCommand);
    noteEl.textContent = t(isCommand
      ? "批准后命令将直接执行，请确认已理解其影响"
      : "批准后 AI 将访问上面的地址并读取返回内容");
    approveBtn.textContent = t(isCommand ? "批准执行" : "允许访问");
    modal.classList.remove("hidden");
    if (isCommand) {
      explainEl.textContent = t("正在用模型分析命令目的…");
      explainCommand(subject.target).then(text => {
        if (pendingResolve === resolve) explainEl.textContent = text;
      });
    }
  });
}

/** 拒绝时回给模型的话：说清被拒的是哪一笔、为什么问，并明确别再重试。 */
function denialMessage(subject, risk) {
  if (risk?.risk) return `高危命令被用户拒绝执行（${risk.reason}）：${subject.target}`;
  const why = subject.kind === "command" ? "执行命令" : "访问网络";
  return `用户拒绝了本次${why}（手动审批模式下逐条确认）：${subject.target}。请不要重试同一笔调用，可改用本地证据、换成只读方式，或在回复里问用户要怎么做。`;
}

/**
 * 这一笔在当前档下要不要问人（纯判定，桌面与手机共用同一份口径）。
 * 不用问时返回 null；要问时返回 { subject, risk }。
 *
 * 四档语义（这一场生效哪一档由 store.permissionModeFor 现算）：
 * - ask 手动审批：执行命令、访问网络都先弹窗问
 * - auto 自动审批：只在命中高危规则时问，其余直接放行
 * - full 完全访问：命令与联网一律不问（灾难级命令仍由后端硬拦）；
 *   但"缺条件时问用户一句"这条路照旧——那条路在 tools.js 的 user_ask 里，只有 night 才关
 * - night 夜间模式（全托管）：与完全访问同一条放行口径，外加连选择题也不问
 *
 * opts.manual：技能面板里用户亲手点的「执行」——命令就是他自己在参数框里填的，
 * 再逐条问一遍等于问他两次，所以这一路只拦高危（与 auto 同一判口）。
 */
function approvalNeededFor(skill, params, opts = {}) {
  const subject = approvalSubjectOf(skill, params);
  if (!subject) return null;
  const mode = permissionModeFor(opts.convId);
  if (mode === "full" || mode === "night") return null;
  const risk = subject.kind === "command" ? isHighRiskCommand(subject.target) : { risk: false, reason: "" };
  if (!risk.risk && (mode === "auto" || opts.manual)) return null;
  return { subject, risk };
}

/**
 * 单笔工具调用的审批门（唯一执行处）。放行返回 { ok: true }，
 * 被拒返回 { ok: false, message }——message 是给模型看的拒绝理由，调用方原样回传。
 * 判定在这里，问人的那张脸可以换：手机遥控把 window.__slateGuardUi 换成底部 sheet。
 */
async function guardSkillCall(skill, params, opts = {}) {
  const need = approvalNeededFor(skill, params, opts);
  if (!need) return { ok: true };
  const ui = window.__slateGuardUi || requestApproval;
  const approved = await ui(need.subject, need.risk, { ...opts, skill });
  if (!approved) return { ok: false, message: denialMessage(need.subject, need.risk) };
  if (need.subject.kind === "command") params.approved = true;
  return { ok: true };
}

function initRiskGuard() {
  modal = document.getElementById("risk-modal");
  if (!modal) return;
  titleEl = document.getElementById("risk-title");
  subjectLabelEl = document.getElementById("risk-command-label");
  cmdEl = document.getElementById("risk-command");
  reasonEl = document.getElementById("risk-reason");
  explainLabelEl = document.getElementById("risk-explain-label");
  explainEl = document.getElementById("risk-explain");
  noteEl = modal.querySelector(".risk-note");
  approveBtn = document.getElementById("btn-risk-approve");

  document.getElementById("btn-risk-approve")?.addEventListener("click", () => settle(true));
  document.getElementById("btn-risk-reject")?.addEventListener("click", () => settle(false));
  modal.querySelector(".modal-close")?.addEventListener("click", () => settle(false));
  modal.querySelector(".modal-backdrop")?.addEventListener("click", () => settle(false));
}

export { isHighRiskCommand, approvalSubjectOf, approvalNeededFor, requestApproval, guardSkillCall, initRiskGuard };
