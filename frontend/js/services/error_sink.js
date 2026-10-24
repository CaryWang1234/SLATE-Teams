/**
 * 前端异常兜底：把浏览器里抛出（以及被局部 catch 吞掉）的 JS 错误送到后端落盘。
 *
 * 为什么需要：SLATE 前端原先没有 window.onerror / unhandledrejection 兜底，
 * 而发消息、工具循环这些链路上的异常又被局部 catch 转成了气泡里的
 * 「请求失败: xxx」，栈迹当场丢掉——像 RangeError: Maximum call stack size exceeded
 * 这种偶发问题根本无从定位。这里只做「留下现场」，不改变任何既有行为。
 *
 * 三条纪律：
 * - 上报本身不能再抛错：全程 try/catch，日志挂了也不影响用户。
 * - 限量去重：同一「消息 + 出错位置」只报一次，单次会话最多 MAX_REPORTS 条，
 *   避免循环报错把 data/js_errors.log 灌满。
 * - 不外泄凭据：URL 只取 origin+path，query 里的 slate_lan_token 不进日志。
 */

import { API_BASE } from "../store.js?v=20261024-001";

const MAX_REPORTS = 30;          // 单次会话上报上限
const MAX_STACK_LINES = 24;      // 只留最近的栈帧，足够定位又不至于把整段求值栈贴回来

let reportedCount = 0;
let installed = false;
const seenKeys = new Set();

/** 取 style.css 上的缓存串当构建号，日志里能对上「哪一次打包的前端」 */
function buildVersion() {
  try {
    const link = document.querySelector('link[rel="stylesheet"][href*="style.css"]');
    const m = /[?&]v=([\w.-]{1,32})/.exec(link?.getAttribute("href") || "");
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

/** 明显不是代码缺陷的噪音：网络中断、超时、懒加载失败、观察器告警，不值得占日志 */
function isNoise(message) {
  const s = String(message || "");
  if (!s) return true;
  if (/ResizeObserver loop/i.test(s)) return true;
  if (/Failed to fetch|NetworkError|Load(ing)? (CSS|script|module) chunk|ERR_(NETWORK|CONNECTION|INTERNET)|aborted/i.test(s)) return true;
  // api.js 会把传输层故障改写成中文诊断文案，同样不是代码缺陷
  if (/网络连接失败|请求超时|无响应，已自动中断|已中断|没有拿到流式响应体/i.test(s)) return true;
  return false;
}

function normalizeStack(stack) {
  const lines = String(stack || "").split("\n").filter(Boolean);
  if (!lines.length) return "";
  return lines.slice(0, MAX_STACK_LINES).join("\n");
}

function send(entry) {
  try {
    if (isNoise(entry.message)) return;
    const key = `${entry.message}@@${(entry.stack || "").split("\n")[1] || ""}`;
    if (seenKeys.has(key) || reportedCount >= MAX_REPORTS) return;
    seenKeys.add(key);
    reportedCount += 1;
    fetch(`${API_BASE}/diagnostics/js-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...entry, version: buildVersion(), at: Date.now() / 1000 }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* 诊断通道自身出错一律静默 */ }
}

function baseEntry() {
  return {
    message: "",
    source: "",
    lineno: 0,
    colno: 0,
    stack: "",
    url: `${window.location.origin}${window.location.pathname}`,
    ua: navigator.userAgent || "",
  };
}

/**
 * 已被局部 catch 接住的异常也记一笔（发消息、续写、重生的 catch 分支调用）。
 * @param {unknown} err 捕获到的错误
 * @param {string} where 出错环节，写进 message 前缀，便于按链路筛选
 */
export function reportError(err, where = "") {
  const entry = baseEntry();
  entry.message = `${where ? `[${where}] ` : ""}${(err && err.message) || String(err || "")}`;
  entry.stack = normalizeStack(err && err.stack);
  send(entry);
}

export function installErrorSink() {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (ev) => {
    const entry = baseEntry();
    if (ev.error) {
      entry.message = ev.message || ev.error.message || "";
      entry.stack = normalizeStack(ev.error.stack);
    } else {
      entry.message = ev.message || "资源加载失败";
    }
    entry.source = ev.filename || "";
    entry.lineno = ev.lineno || 0;
    entry.colno = ev.colno || 0;
    send(entry);
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason;
    const entry = baseEntry();
    entry.message = `[unhandled] ${(reason && reason.message) || String(reason || "")}`;
    entry.stack = normalizeStack(reason && reason.stack);
    send(entry);
  });
}

/** 给走查/自测用：主动抛一条可识别的假异常，验证日志确实落地 */
export function emitTestError(message = "SLATE 自检：模拟异常") {
  try {
    throw new RangeError(message);
  } catch (err) {
    reportError(err, "selftest");
  }
}
