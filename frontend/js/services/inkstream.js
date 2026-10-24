/**
 * 砚流（InkStream）· 落笔即所见
 *
 * 模型正在逐个 token 写工具参数时，用本地 schema 与前缀扫描推断「哪些字段已闭合、哪个字段正在写」，
 * 让参数成形过程可见。只做预览，绝不参与执行判定（半成品参数永不触发 execute）。
 */

import { TOOLS } from "./tools.js?v=20261024-001";
import { t } from "./i18n.js?v=20261024-001";
import { setIconText } from "./icons.js?v=20261024-001";

const PAINT_THROTTLE_MS = 150;   // 合并重绘节律（设计 §4.8 规则 3）
const MAX_FIELDS = 4;            // 单行最多展示的闭合字段数
const INLINE_CHARS = 60;         // 超过此长度按「有界摘录」处理，不逐字铺开
const SKIP_TOTAL_CHARS = 80;     // 短参跳过：整体还没写满这么多字就不演
const LAST_LINE_CHARS = 48;      // 末行摘录上限

// 内容型字段：值可能是几十 KB 正文，一律只显示行数/字数
const BIG_KEYS = new Set([
  "content", "markdown", "html", "code", "body", "text", "source", "script",
  "css", "csv", "json", "data", "slides", "edits", "steps", "items", "rows", "pages",
]);

const FILE_RAW_TOOLS = new Set(["file_create", "file_append"]);

// ── 容错前缀扫描 ──────────────────────────────

function skipWs(raw, i) {
  while (i < raw.length && (raw[i] === " " || raw[i] === "\n" || raw[i] === "\t" || raw[i] === "\r")) i += 1;
  return i;
}

function isWs(ch) {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

function unescapeChar(ch) {
  if (ch === "n") return "\n";
  if (ch === "t") return "\t";
  if (ch === "r") return "\r";
  if (ch === "b") return "\b";
  if (ch === "f") return "\f";
  return ch; // " \ / 以及其他转义按原字符处理
}

/** 读取 JSON 字符串：raw[i] 必须是引号；截断时 complete=false 且 value 为已到达部分 */
function readJsonString(raw, i) {
  let j = i + 1;
  let value = "";
  while (j < raw.length) {
    const ch = raw[j];
    if (ch === "\\") {
      const next = raw[j + 1];
      if (next === undefined) break;
      if (next === "u") {
        const hex = raw.slice(j + 2, j + 6);
        if (hex.length < 4) return { value, end: raw.length, complete: false };
        const cp = Number.parseInt(hex, 16);
        if (Number.isNaN(cp)) return { value, end: raw.length, complete: false };
        value += String.fromCodePoint(cp);
        j += 6;
        continue;
      }
      value += unescapeChar(next);
      j += 2;
      continue;
    }
    if (ch === '"') return { value, end: j + 1, complete: true };
    value += ch;
    j += 1;
  }
  return { value, end: raw.length, complete: false };
}

/** 扫描一个值：返回闭合位置与是否完整；容器只统计顶层成员数，不做深解析 */
function scanJsonValue(raw, i) {
  const ch = raw[i];
  if (ch === '"') {
    const s = readJsonString(raw, i);
    return { kind: "string", value: s.value, end: s.end, complete: s.complete };
  }
  if (ch === "{" || ch === "[") {
    const kind = ch === "{" ? "object" : "array";
    const close = ch === "{" ? "}" : "]";
    let j = i + 1;
    let depth = 1;
    let commas = 0;
    let hasContent = false;
    while (j < raw.length) {
      const c = raw[j];
      if (c === '"') { hasContent = true; j = readJsonString(raw, j).end; continue; }
      if (c === ch) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) return { kind, count: hasContent ? commas + 1 : 0, end: j + 1, complete: true };
      } else if (c === "," && depth === 1) commas += 1;
      else if (!isWs(c)) hasContent = true;
      j += 1;
    }
    return { kind, count: hasContent ? commas + 1 : 0, end: raw.length, complete: false };
  }
  const rest = raw.slice(i);
  for (const lit of ["true", "false", "null"]) {
    if (rest.startsWith(lit)) return { kind: "literal", value: lit === "null" ? null : lit === "true", end: i + lit.length, complete: true };
  }
  const num = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
  // 数字一直写到文本末尾时无法定界（3 还可能流成 30），值带出但不算闭合
  if (num) return { kind: "number", value: Number(num[1]), end: i + num[1].length, complete: i + num[1].length < raw.length };
  return { kind: "unknown", end: raw.length, complete: false };
}

function stripFence(s) {
  const trimmed = s.trimStart();
  if (!trimmed.startsWith("```")) return s;
  const nl = trimmed.indexOf("\n");
  if (nl < 0) return "";
  let body = trimmed.slice(nl + 1);
  const end = body.lastIndexOf("```");
  if (end >= 0) body = body.slice(0, end);
  return body;
}

function measureString(value) {
  const s = String(value ?? "");
  const lines = s.split("\n");
  return { chars: s.length, lines: lines.length, lastLine: lines[lines.length - 1] || "" };
}

/**
 * 扫描参数 JSON 前缀 → { fields, complete, started }
 * fields: [{ key, closed, kind, value, chars, lines, lastLine, count }]
 */
export function scanArgs(text) {
  const raw = stripFence(String(text || ""));
  const start = raw.indexOf("{");
  if (start < 0) return { fields: [], complete: false, started: false };
  const fields = [];
  let i = start + 1;
  let complete = false;
  while (i < raw.length) {
    i = skipWs(raw, i);
    if (i >= raw.length) break;
    if (raw[i] === "}") { complete = true; break; }
    if (raw[i] !== '"') {
      // 字段名正在写（模型漏了引号等情况）
      const partial = raw.slice(i).slice(0, 24);
      fields.push({ key: partial.replace(/[^\w.-]/g, ""), closed: false, kind: "key", chars: raw.length - i, lines: 1, lastLine: "", count: 0 });
      break;
    }
    const key = readJsonString(raw, i);
    if (!key.complete) {
      fields.push({ key: key.value, closed: false, kind: "key", ...measureString(key.value), count: 0 });
      break;
    }
    i = skipWs(raw, key.end);
    if (raw[i] !== ":") {
      fields.push({ key: key.value, closed: false, kind: "pending", chars: 0, lines: 0, lastLine: "", count: 0 });
      break;
    }
    i = skipWs(raw, i + 1);
    if (i >= raw.length) {
      fields.push({ key: key.value, closed: false, kind: "pending", chars: 0, lines: 0, lastLine: "", count: 0 });
      break;
    }
    const val = scanJsonValue(raw, i);
    const entry = { key: key.value, closed: val.complete, kind: val.kind, count: val.count || 0 };
    if (val.kind === "string") {
      Object.assign(entry, measureString(val.value), { value: val.value });
    } else if (val.kind === "number" || val.kind === "literal") {
      Object.assign(entry, measureString(val.value ?? ""), { value: val.value });
    } else {
      Object.assign(entry, { chars: val.end - i, lines: 1, lastLine: "" });
    }
    fields.push(entry);
    if (!val.complete) break;
    i = skipWs(raw, val.end);
    if (raw[i] === ",") { i += 1; continue; }
    if (raw[i] === "}") { complete = true; break; }
    break;
  }
  return { fields, complete, started: true };
}

/** 文本协议（◈◈◈）尾部尚未闭合的调用 */
export function scanOpenTextCall(content) {
  const s = String(content || "");
  const at = s.lastIndexOf("◈◈◈");
  if (at < 0) return null;
  const tail = s.slice(at);
  if (tail.includes("◈◆◆")) return null;
  const m = /^◈◈◈[ \t]*(\w+)[ \t]*\r?\n?([\s\S]*)$/.exec(tail);
  if (!m) return null;
  return { name: m[1], raw: m[2] };
}

/** 原样格式（file_create / file_append）：首行路径，其后为正文 */
function scanRawBody(body) {
  const nl = body.indexOf("\n");
  if (nl < 0) {
    return { fields: [{ key: "file_path", closed: false, kind: "string", ...measureString(body.trim()), count: 0 }], complete: false, started: true };
  }
  const path = body.slice(0, nl).trim();
  const content = body.slice(nl + 1);
  return {
    fields: [
      { key: "file_path", closed: true, kind: "string", value: path, ...measureString(path), count: 0 },
      { key: "content", closed: false, kind: "string", ...measureString(content), count: 0 },
    ],
    complete: false,
    started: true,
  };
}

// ── 预览判定与文案 ────────────────────────────

function requiredKeys(name) {
  const defs = TOOLS[name]?.params || {};
  return Object.keys(defs).filter(k => defs[k]?.required);
}

/** 短参跳过：required ≤ 2 且已到达内容全无体量 → 不演（system_info 这类没必要起笔动画） */
function shouldSkipPreview(name, scan) {
  if (requiredKeys(name).length > 2) return false;
  if (!scan.fields.length) return true;
  if (scan.fields.some(f => BIG_KEYS.has(f.key) || f.kind === "array" || f.kind === "object")) return false;
  const total = scan.fields.reduce((n, f) => n + (f.chars || 0), 0);
  return total <= SKIP_TOTAL_CHARS && !scan.fields.some(f => (f.lines || 0) > 1);
}

function clip(s, max) {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

/** 单字段摘要：闭合字段显示值，未闭合字段只显示字段名与体量，绝不显示半成品正文 */
function fieldChip(field) {
  if (field.kind === "key") {
    const writing = field.key ? ` ${field.key}` : "";
    return { text: `${t("正在写")}${writing}`, open: true };
  }
  if (field.kind === "array" || field.kind === "object") {
    return {
      text: field.closed ? `${field.key} · ${t("{n} 项", { n: field.count || 0 })}` : `${field.key} · ${t("正在写")}`,
      open: !field.closed,
    };
  }
  const big = BIG_KEYS.has(field.key) || (field.chars || 0) > INLINE_CHARS || (field.lines || 0) > 1;
  const metric = big ? ` · ${t("{n} 行", { n: field.lines || 1 })} · ${t("{n} 字", { n: field.chars || 0 })}` : "";
  if (!field.closed) return { text: `${field.key}${metric}`, open: true };
  if (big) return { text: `${field.key}: ${clip(field.lastLine, LAST_LINE_CHARS)}${metric}` };
  const val = field.kind === "string" ? clip(field.value, INLINE_CHARS) : String(field.value ?? "");
  return { text: `${field.key}: ${val}` };
}

function summarize(scan) {
  const chips = [];
  for (const f of scan.fields.slice(0, MAX_FIELDS + 1)) {
    if (f.key === "skill") continue; // 技能名进标题，不占字段位
    chips.push(fieldChip(f));
  }
  return {
    chips: chips.slice(0, MAX_FIELDS),
    truncated: chips.length > MAX_FIELDS,
    complete: scan.complete,
    skill: scan.fields.find(f => f.key === "skill" && f.closed)?.value || "",
  };
}

// ── 渲染器 ────────────────────────────────────

/**
 * @param host     挂载宿主（助手气泡元素）
 * @param labelFor (name) => 一行标题
 * @param iconFor  (name) => 图标名
 */
export function createInkstream({ host, labelFor, iconFor } = {}) {
  let el = null;
  const rows = new Map();
  let argItems = [];
  const execRows = new Map();
  const consumedArgs = new Set();
  let pending = null;
  let timer = 0;
  let lastPaint = 0;
  let destroyed = false;

  function mount() {
    if (el?.isConnected) return el;
    if (!host?.isConnected) { destroy(); return null; }
    el = document.createElement("div");
    el.className = "inkstream";
    const contentEl = host.querySelector(".msg-content");
    if (contentEl?.parentNode === host) host.insertBefore(el, contentEl.nextSibling);
    else host.appendChild(el);
    return el;
  }

  function renderRow(row, item) {
    const title = item.skill ? `${labelFor(item.name)} · ${item.skill}` : labelFor(item.name);
    if (row.titleText !== title) {
      setIconText(row.line.querySelector(".inkstream-name"), iconFor(item.name), title);
      row.titleText = title;
    }
    const isExec = item.phase === "exec";
    const stateText = isExec ? t("执行中") : (item.complete ? t("落笔") : t("起笔中"));
    if (row.stateText !== stateText) {
      row.line.querySelector(".inkstream-state").textContent = stateText;
      row.line.classList.toggle("is-ready", !isExec && !!item.complete);
      row.line.classList.toggle("is-running", isExec);
      row.stateText = stateText;
    }
    const fields = row.line.querySelector(".inkstream-fields");
    const text = item.chips.map(c => c.text).join(" · ") + (item.truncated ? " …" : "");
    if (fields.dataset.sig !== text) {
      fields.textContent = text;
      fields.dataset.sig = text;
    }
  }

  function paint() {
    if (destroyed || !pending) return;
    const items = pending;
    pending = null;
    lastPaint = Date.now();
    if (el && !el.isConnected) { destroy(); return; }
    const target = mount();
    if (!target) return;
    const seen = new Set();
    for (const item of items) {
      seen.add(item.key);
      let row = rows.get(item.key);
      if (!row) {
        const line = document.createElement("div");
        line.className = "inkstream-row";
        for (const cls of ["inkstream-name", "inkstream-state", "inkstream-fields", "inkstream-caret"]) {
          const span = document.createElement("span");
          span.className = cls;
          line.appendChild(span);
        }
        target.appendChild(line);
        row = { line, titleText: "", stateText: "" };
        rows.set(item.key, row);
      } else if (row.line.parentNode !== target) {
        target.appendChild(row.line);
      }
      renderRow(row, item);
    }
    for (const [key, row] of [...rows]) {
      if (seen.has(key)) continue;
      row.line.remove();
      rows.delete(key);
    }
    if (!rows.size) { target.remove(); el = null; }
  }

  function build(items) {
    const out = [];
    for (const item of items) {
      const scan = item.scan;
      if (!scan?.started || !scan.fields.length) continue;
      if (shouldSkipPreview(item.name, scan)) continue;
      out.push({ phase: "args", key: item.key, name: item.name, ...summarize(scan) });
    }
    return out;
  }

  function execItems() {
    const out = [];
    for (const [key, row] of execRows) {
      const bits = [];
      if (row.progress) bits.push(row.progress);
      if (row.note) bits.push(row.note);
      if (row.lines) bits.push(t("{n} 行", { n: row.lines }));
      else if (row.chars) bits.push(t("{n} 字", { n: row.chars }));
      if (row.tail) bits.push(row.tail);
      out.push({ phase: "exec", key, name: row.name, skill: row.skill, chips: bits.map(text => ({ text })) });
    }
    return out;
  }

  function refresh() {
    const hidden = new Set(consumedArgs);
    for (const r of execRows.values()) if (r.hide) hidden.add(r.hide);
    pending = (hidden.size ? argItems.filter(i => !hidden.has(i.key)) : argItems).concat(execItems());
    const wait = PAINT_THROTTLE_MS - (Date.now() - lastPaint);
    if (wait <= 0) { paint(); return; }
    if (timer) return;
    timer = setTimeout(() => { timer = 0; paint(); }, wait);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (timer) { clearTimeout(timer); timer = 0; }
    execRows.clear();
    rows.clear();
    el?.remove();
  }

  return {
    get destroyed() { return destroyed; },
    /** 宿主气泡被整表重渲染替换：改挂新节点，行节点随下一次 paint 迁过去 */
    rehost(next) {
      if (destroyed || next === host) return;
      host = next;
      if (el?.isConnected) return;
      el = null;
      refresh();
    },
    /** 原生协议：api.js onToolCall 回传的累积调用 */
    onCalls(calls) {
      argItems = build((calls || []).filter(c => c?.name).map(c => ({
        key: `n${c.index ?? 0}`, name: c.name, scan: scanArgs(c.arguments || ""),
      })));
      refresh();
    },
    /** 文本协议：◈◈◈ 尚未闭合的尾部块 */
    onTextContent(content) {
      const open = scanOpenTextCall(content);
      if (!open) { argItems = []; refresh(); return; }
      const scan = FILE_RAW_TOOLS.has(open.name) ? scanRawBody(open.raw) : scanArgs(open.raw);
      argItems = build([{ key: "t0", name: open.name, scan }]);
      refresh();
    },
    /** 执行期：该笔已交给后端，hide 为对应的参数期行键 */
    onExecStart({ key, name, skill = "", hide = "" } = {}) {
      if (!key || destroyed) return;
      if (hide) consumedArgs.add(hide);
      execRows.set(key, { name, skill, hide, progress: "", note: "", lines: 0, chars: 0, tail: "" });
      refresh();
    },
    /** /stream 回传的 call.progress / call.output 信封 */
    onExecEvent(key, env) {
      const row = execRows.get(key);
      if (!row || !env?.type) return;
      const d = env.data || {};
      if (env.type === "call.progress") {
        if (d.progress != null && d.total != null) row.progress = `${d.progress}/${d.total}`;
        else if (d.pct != null) row.progress = `${d.pct}%`;
        if (d.message) row.note = clip(d.message, LAST_LINE_CHARS);
      } else if (env.type === "call.output") {
        const chunk = String(d.chunk || "");
        if (!chunk) return;
        row.chars += chunk.length;
        const trimmed = chunk.replace(/\s+$/, "");
        const nl = (chunk.match(/\n/g) || []).length;
        if (nl) {
          row.lines += nl;
          const last = trimmed.split("\n").pop();
          if (last) row.tail = clip(last, LAST_LINE_CHARS);
        }
      } else {
        return;
      }
      refresh();
    },
    onExecEnd(key) {
      if (!execRows.delete(key)) return;
      refresh();
    },
    destroy,
  };
}
