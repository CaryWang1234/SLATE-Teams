/**
 * 会话总结栏（左栏第三页签）：把当前会话用到的命令、工具、SKILL.md 技能、远程 MCP、
 * 改动过的文件、访问过的网页投影成一份可滚动的清单。
 *
 * 数据源只认 state.messages 上的 toolResults：事件账本按 run 活在内存里，后端又只有写入口，
 * 刷新或切会话就拿不回来；toolResults 随消息落库，是唯一能重载后复原的事实源。
 * 历史恢复出来的卡片（result.historical）不是本次会话真实发生的调用，一律跳过。
 *
 * terminal / git_tool 不进「工具」组：一句「执行命令」看不出跑了什么，改由 commandOf
 * 还原成 git commit、npm test 这样的行，单独成组并带品牌图标。
 */

import { state, subscribe } from "../store.js?v=20261017-001";
import { t } from "../services/i18n.js?v=20261017-001";
import { toolLabel, toolArgsSummary, toolIcon, fileIcon, commandOf } from "../services/tool_meta.js?v=20261017-001";
import { iconSvg } from "../services/icons.js?v=20261017-001";

const FILE_WRITE_OPS = ["file_edit", "file_create", "file_append"];
const FILE_READ_ACTIONS = ["view", "read"];
// 名字不带 file_，但确实往磁盘产出文件的技能，一并计入「修改的文件」
const FILE_OUTPUT_SKILLS = new Set([
  "ppt_create", "word_create", "excel_tool", "html_bundle", "chart_create",
  "qrcode_create", "python_api_extract", "mcp_factory", "image_gen", "video_gen",
]);
const RENAME_MAX = 48;
const DETAIL_MAX = 52;

const GROUPS = [
  { key: "commands", icon: "terminal", title: () => t("执行的命令") },
  { key: "tools", icon: "tool", title: () => t("工具") },
  { key: "skills", icon: "sparkles", title: () => t("技能") },
  { key: "mcp", icon: "plug", title: () => t("MCP 工具") },
  { key: "files", icon: "file-plus", title: () => t("修改的文件") },
  { key: "web", icon: "globe", title: () => t("访问的网页") },
];

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function clip(text, max = RENAME_MAX) {
  const s = String(text ?? "").trim().replace(/\s+/g, " ");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function isHttp(value) {
  return /^https?:\/\//i.test(String(value ?? "").trim());
}

/** skill_run 包一层：真正的调用对象是 params.skill + params.params */
function innerOf(call) {
  const params = call?.params || {};
  if (call?.name === "skill_run") {
    return { name: String(params.skill || ""), params: params.params || {} };
  }
  return { name: String(call?.name || ""), params };
}

/** 工具输出：内置技能走 skill_run 时是 JSON 字符串，能解析才拿来用 */
function parseOutput(result) {
  const out = result?.output;
  if (typeof out !== "string") return null;
  const s = out.trim();
  if (!s.startsWith("{")) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

function filePathOf(name, params, result, out) {
  const st = result?._structured;
  const reading = !!params?.action && FILE_READ_ACTIONS.includes(params.action);
  if (!reading) {
    if (st && FILE_WRITE_OPS.includes(st._type)) {
      return String(st.file_path_rel || st.file || st.file_path || params.file_path || params.path || params.relative_path || "");
    }
    if (FILE_WRITE_OPS.includes(name)) {
      return String(params.file_path || params.path || params.relative_path || "");
    }
  }
  if (FILE_OUTPUT_SKILLS.has(name)) return String(out?.file_path || "");
  return "";
}

function webUrlsOf(name, params, out) {
  if (name === "web_fetch") return [out?.url || params?.url];
  if (name === "web_search") return params?.mode === "fetch" ? [params.query] : [];
  if (name === "browser_automation") return [params?.url];
  return [];
}

/** 项目内路径收敛成相对路径，长路径只剩文件名可读 */
function displayPath(raw) {
  const s = String(raw || "").trim().replace(/\\/g, "/");
  const proj = String(state.project?.path || "").replace(/\\/g, "/");
  if (proj && s.toLowerCase().startsWith(proj.toLowerCase())) {
    const rel = s.slice(proj.length).replace(/^\/+/, "");
    if (rel) return rel;
  }
  return s;
}

function groupKeyFor(name) {
  if (name.startsWith("mcp__")) return "mcp";
  if (state.skills?.skills && name in state.skills.skills) return "skills";
  return "tools";
}

function collect() {
  const buckets = {
    commands: new Map(), tools: new Map(), skills: new Map(),
    mcp: new Map(), files: new Map(), web: new Map(),
  };
  const stats = { calls: 0, failed: 0, commandCalls: 0 };

  const add = (kind, key, build, touch) => {
    if (!key) return;
    const cur = buckets[kind].get(key);
    if (cur) { cur.count += 1; if (touch) touch(cur); return; }
    const item = build(key);
    if (item) buckets[kind].set(key, item);
  };

  for (const msg of state.messages || []) {
    const rows = Array.isArray(msg?.toolResults) ? msg.toolResults
      : Array.isArray(msg?.metadata?.toolResults) ? msg.metadata.toolResults : [];
    for (const row of rows) {
      const call = row?.call, result = row?.result;
      if (!call || result?.historical) continue;
      const { name, params } = innerOf(call);
      if (!name) continue;
      const failed = result?.success === false;
      const out = parseOutput(result);
      stats.calls += 1;
      if (failed) stats.failed += 1;

      const cmd = commandOf(name, params);
      if (cmd) {
        stats.commandCalls += 1;
        const detail = clip(cmd.command, DETAIL_MAX);
        for (const seg of cmd.segments) {
          add("commands", seg.label, () => ({
            label: seg.label, detail, title: cmd.command, icon: seg.icon, count: 1, failed,
          }), (cur) => { cur.failed = failed; cur.detail = detail; cur.title = cmd.command; });
        }
      } else {
        add(groupKeyFor(name), name, (key) => {
          const detail = clip(toolArgsSummary(params, key), DETAIL_MAX);
          if (key.startsWith("mcp__")) {
            const parts = key.split("__");
            const label = clip(parts[parts.length - 1] || key, 28);
            const server = clip(parts[1] || "mcp", 24);
            return { label, detail: server === label ? "" : server, title: key, icon: "plug", count: 1, failed };
          }
          return {
            label: toolLabel(key, { skill: key }) || key,
            detail, title: key, icon: toolIcon(key, { skill: key }), count: 1, failed,
          };
        }, (cur) => {
          cur.failed = failed;
          if (!cur.title.startsWith("mcp__")) {
            cur.detail = clip(toolArgsSummary(params, cur.title), DETAIL_MAX) || cur.detail;
          }
        });
      }

      const path = filePathOf(name, params, result, out);
      if (path) {
        const rel = displayPath(path);
        const idx = rel.lastIndexOf("/");
        add("files", rel.toLowerCase(), (key) => ({
          label: idx >= 0 ? rel.slice(idx + 1) : rel,
          detail: idx > 0 ? rel.slice(0, idx) : "",
          title: rel, icon: fileIcon(rel), count: 1, failed,
        }), (cur) => { cur.failed = failed; });
      }

      for (const url of webUrlsOf(name, params, out)) {
        if (!isHttp(url)) continue;
        let host = "", urlPath = "";
        try {
          const u = new URL(url); host = u.hostname; urlPath = (u.pathname + u.search).replace(/\/$/, "");
        } catch (e) { continue; }
        add("web", url, () => ({
          label: clip(host, 28), detail: clip(urlPath, 40), title: url, icon: "globe", count: 1, failed,
        }), (cur) => { cur.failed = failed; });
      }
    }
  }
  return { buckets, stats };
}

function rowOf(item) {
  const row = el("div", "ss-item" + (item.failed ? " is-failed" : ""));
  row.title = item.title || item.label;
  const icon = el("span", "ss-item-icon");
  icon.innerHTML = iconSvg(item.icon || "tool");
  row.append(icon);
  const main = el("span", "ss-item-main");
  main.append(el("span", "ss-item-name", item.label));
  if (item.detail) main.append(el("span", "ss-item-detail", item.detail));
  row.append(main);
  if (item.count > 1) row.append(el("span", "ss-item-count", `×${item.count}`));
  return row;
}

function overviewOf(stats, buckets) {
  const box = el("div", "ss-overview");
  box.append(el("div", "ss-overview-title", t("会话总览")));
  const grid = el("div", "ss-stats");
  const kinds = buckets.tools.size + buckets.skills.size + buckets.mcp.size;
  const cells = [
    { label: t("调用次数"), value: stats.calls },
    { label: t("工具种类"), value: kinds },
    { label: t("命令条数"), value: stats.commandCalls },
    { label: t("改动文件"), value: buckets.files.size },
  ];
  for (const c of cells) {
    const cell = el("div", "ss-stat");
    cell.append(el("span", "ss-stat-num", String(c.value)));
    cell.append(el("span", "ss-stat-label", c.label));
    grid.append(cell);
  }
  box.append(grid);
  if (stats.failed) box.append(el("div", "ss-overview-warn", t("{n} 项调用失败", { n: stats.failed })));
  return box;
}

let root = null;
let timer = 0;
let pending = false;

/** 页签未激活、边栏收起或 Codex 模式整栏隐藏时，offsetParent 为 null */
function isShown() {
  return !!root && root.offsetParent !== null;
}

export function renderSessionSummary() {
  if (!root) return;
  const { buckets, stats } = collect();
  root.textContent = "";
  const used = GROUPS.reduce((sum, g) => sum + buckets[g.key].size, 0);
  if (!used) {
    root.append(el("div", "ss-empty", t("本次会话还没有工具调用")));
    return;
  }
  root.append(overviewOf(stats, buckets));
  for (const g of GROUPS) {
    const items = buckets[g.key];
    if (!items.size) continue;
    const sec = el("div", "ss-group ss-group-" + g.key);
    const head = el("div", "ss-group-header");
    const headIcon = el("span", "ss-group-icon");
    headIcon.innerHTML = iconSvg(g.icon);
    head.append(headIcon, el("span", "ss-group-title", g.title()));
    head.append(el("span", "ss-group-count", String(items.size)));
    sec.append(head);
    for (const item of items.values()) sec.append(rowOf(item));
    root.append(sec);
  }
}

function scheduleRender() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = 0;
    if (isShown()) renderSessionSummary();
    else pending = true;
  }, 200);
}

export function initSessionSummary() {
  root = document.getElementById("session-summary");
  if (!root) return;
  // 流式输出每块都会 notify("messages")，必须防抖，否则边说边重排整栏
  subscribe("messages", scheduleRender);
  subscribe("skills", scheduleRender);
  subscribe("project", scheduleRender);
  window.addEventListener("slate:left-pane", () => {
    if (pending && isShown()) { pending = false; renderSessionSummary(); }
  });
  renderSessionSummary();
}
