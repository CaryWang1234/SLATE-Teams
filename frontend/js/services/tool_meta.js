/**
 * 工具元信息投影：卡片标题与参数摘要从一处事实源派生。
 *
 * 白板原先另养了一份 14 条工具描述表和一条硬编码参数挑选链，聊天卡片又另养了一份
 * TOOL_LABELS，同一笔调用在两个界面叫法不同（系统信息 / 系统元认知）。这里并成一处：
 * 短标签表 + TOOLS schema，两个投影都只认这里。
 *
 * 图标投影同样收在这里：terminal 只报「执行命令」看不出跑了什么，故解析命令行首程序
 * （git / node / curl…）挑对应品牌图标，命令行 / 文件 / 工具三类行共用这套识别链。
 */

import { TOOLS } from "./tools.js?v=20261024-001";
import { t } from "./i18n.js?v=20261024-001";
import { state } from "../store.js?v=20261024-001";
import { mcpIconKeyFromTool } from "./mcp_logos.js?v=20261024-001";

const SUMMARY_MAX = 60;

// 既覆盖前端注册工具，也覆盖 skill_run 下的内置技能名
const TOOL_LABELS = {
  file_create: "创建文件",
  file_edit: "编辑文件",
  file_append: "追加文件",
  file_tree: "查看目录",
  file_peek: "查看文件",
  terminal: "执行命令",
  skill_run: "技能",
  project_info: "项目信息",
  project_files: "文件列表",
  project_read_file: "读取文件",
  project_find_file: "查找文件",
  code_search: "代码搜索",
  web_search: "联网搜索",
  web_fetch: "抓取网页",
  image_gen: "生成图片",
  video_gen: "生成视频",
  chart_create: "生成图表",
  qrcode_create: "生成二维码",
  html_render: "渲染 HTML",
  css_color: "CSS 配色",
  doc_write: "生成文档",
  ppt_create: "生成演示文稿",
  word_create: "生成 Word",
  text_summarize: "文本摘要",
  json_tool: "JSON 处理",
  regex_test: "正则测试",
  repo_stats: "项目统计",
  todo_scan: "待办扫描",
  todo_manage: "任务清单",
  git_tool: "Git 操作",
  code_scan: "代码扫描",
  doc_scan: "文档扫描",
  excel_tool: "表格处理",
  pdf_tool: "PDF 处理",
  browser_automation: "浏览器自动化",
  computer_use: "桌面自动化",
  mcp_factory: "工具工厂",
  screenshot_to_code: "截图转码",
  user_ask: "询问用户",
  exit_target_mode: "退出目标模式",
  exit_autopilot: "退出自主推进",
  skill_search: "技能搜索",
  subagent_run: "并行子代理",
  system_info: "系统信息",
  board_add: "添加卡片",
  board_read: "读取黑板",
  board_update: "更新卡片",
  board_batch: "批量操作",
  board_clear: "清空黑板",
  knowledge_search: "知识检索",
  knowledge_add: "知识添加",
  prompt_gen: "提示词生成",
  chat_context: "对话上下文",
};

/**
 * 工具中文名，已过 i18n：短标签表 → skill_run 的子技能名 → TOOLS schema → 裸英文名。
 * 裸英文名原样返回，调用处可据此判断「无名」。
 */
export function toolLabel(name, args) {
  if (name === "skill_run") {
    const skill = args?.skill;
    if (skill && TOOL_LABELS[skill]) return t(TOOL_LABELS[skill]);
    return skill ? t("技能 · {name}", { name: skill }) : t("技能");
  }
  if (name && TOOL_LABELS[name]) return t(TOOL_LABELS[name]);
  const known = TOOLS?.[name]?.name;
  return known ? t(known) : name || "";
}

function isScalar(v) {
  return typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.trim() !== "");
}

/** 参数摘要：schema 里 required 的标量优先，其次按声明序取第一个标量 */
export function toolArgsSummary(args, toolName = "") {
  const schema = TOOLS?.[toolName]?.params;
  const keys = Object.keys({ ...(schema || {}), ...(args || {}) });
  const scalars = keys.filter(k => isScalar(args?.[k]));
  const pick = scalars.find(k => schema?.[k]?.required) || scalars[0];
  if (!pick) return "";
  const text = String(args[pick]).trim().replace(/\s+/g, " ");
  return `${pick}=${text.slice(0, SUMMARY_MAX)}${text.length > SUMMARY_MAX ? "…" : ""}`;
}

/* ── 图标投影 ─────────────────────────────── */

const TOOL_ICONS = {
  file_create: "file-plus",
  file_edit: "edit-2",
  file_append: "edit-3",
  file_tree: "folder",
  file_peek: "file-text",
  terminal: "terminal",
  project_info: "info",
  project_files: "folder-open",
  project_read_file: "file-text",
  project_find_file: "search",
  code_search: "search",
  web_search: "globe",
  web_fetch: "link",
  image_gen: "image",
  video_gen: "video",
  chart_create: "bar-chart",
  qrcode_create: "qr",
  html_render: "code",
  html_bundle: "code",
  css_color: "palette",
  doc_write: "file-text",
  ppt_create: "presentation",
  word_create: "file-text",
  text_summarize: "scissors",
  json_tool: "braces",
  regex_test: "code",
  repo_stats: "bar-chart",
  todo_scan: "clipboard",
  todo_manage: "clipboard",
  git_tool: "git",
  code_scan: "eye",
  doc_scan: "book",
  excel_tool: "table",
  pdf_tool: "file-text",
  browser_automation: "monitor",
  computer_use: "mouse-pointer",
  mcp_factory: "factory",
  screenshot_to_code: "image",
  user_ask: "message-circle",
  exit_target_mode: "check",
  exit_autopilot: "check",
  skill_search: "search",
  subagent_run: "bot",
  system_info: "info",
  board_add: "scroll",
  board_read: "scroll",
  board_update: "scroll",
  board_batch: "scroll",
  board_clear: "scroll",
  knowledge_search: "database",
  knowledge_add: "database",
  prompt_gen: "pen-tool",
  python_api_extract: "python",
  chat_context: "message-circle",
  skill_run: "sparkles",
};

const PROGRAM_ICONS = {
  git: "git",
  gh: "git",
  node: "node",
  deno: "node",
  bun: "node",
  npm: "package",
  pnpm: "package",
  yarn: "package",
  npx: "package",
  pip: "package",
  pip3: "package",
  uv: "package",
  jest: "package",
  vitest: "package",
  tar: "package",
  zip: "package",
  unzip: "package",
  python: "python",
  python3: "python",
  pytest: "python",
  curl: "curl",
  wget: "curl",
  docker: "docker",
  podman: "docker",
  "docker-compose": "docker",
  kubectl: "kubectl",
  k: "kubectl",
  helm: "kubectl",
  cargo: "settings",
  rustc: "settings",
  go: "code",
  make: "tool",
  cmake: "tool",
  psql: "database",
  mysql: "database",
  sqlite3: "database",
  "redis-cli": "database",
  mongo: "database",
  mongosh: "database",
  ssh: "key",
  scp: "key",
  openssl: "key",
  chmod: "key",
  chown: "key",
  ls: "folder",
  tree: "folder",
  mkdir: "folder",
  find: "search",
  rg: "search",
  grep: "search",
  fd: "search",
  cat: "file-text",
  head: "file-text",
  tail: "file-text",
  less: "file-text",
  touch: "file-plus",
  cp: "file-plus",
  mv: "file-plus",
  rm: "trash-2",
  jq: "braces",
  sed: "code",
  awk: "code",
  ps: "activity",
  top: "activity",
  tasklist: "activity",
  kill: "ban",
  taskkill: "ban",
  aws: "cloud",
  gcloud: "cloud",
  az: "cloud",
};

const SUBCOMMAND_TOOLS = new Set([
  "git", "gh", "npm", "pnpm", "yarn", "bun", "docker", "docker-compose",
  "cargo", "kubectl", "helm", "pip", "pip3", "uv", "go", "dotnet", "brew", "conda",
  "make", "cmake",
]);

// 只负责转发命令、本身不代表做什么
const WRAPPERS = new Set(["sudo", "doas", "command", "time", "env", "nohup", "nice", "setsid"]);

// 目录切换、环境变量设置等噪声，单独成行没有信息量
const NOISE_PROGRAMS = new Set(["cd", "pushd", "popd", "export", "set", "source", "echo", "pwd", "clear"]);

const FILE_ICONS = {
  js: "code", mjs: "code", cjs: "code", jsx: "code", ts: "code", tsx: "code",
  vue: "code", svelte: "code", html: "code", htm: "code", xml: "code",
  go: "code", rs: "code", java: "code", c: "code", h: "code", cpp: "code",
  cs: "code", php: "code", rb: "code", swift: "code", kt: "code", lua: "code",
  py: "python", pyw: "python",
  md: "hash", markdown: "hash", yml: "hash", yaml: "hash", toml: "hash", ini: "hash", conf: "hash",
  json: "braces", jsonc: "braces", json5: "braces",
  css: "palette", scss: "palette", less: "palette",
  csv: "table", xlsx: "table", xls: "table",
  png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image", webp: "image", ico: "image",
  mp4: "video", mov: "video", webm: "video",
  pdf: "file-text", doc: "file-text", docx: "file-text", txt: "file-text", log: "file-text",
  ppt: "presentation", pptx: "presentation",
  sh: "terminal", bash: "terminal", ps1: "terminal", bat: "terminal", cmd: "terminal",
  env: "key", key: "key", pem: "key",
  zip: "package", tar: "package", gz: "package", tgz: "package", rar: "package",
  exe: "package", dll: "package", so: "package", whl: "package",
};

/** 逐字符切词：引号内的空格与 && | ; 都不算分隔符 */
function splitCommandLine(text) {
  const segments = [[]];
  let cur = "";
  let quoted = null;
  const pushToken = () => {
    if (cur) segments[segments.length - 1].push(cur);
    cur = "";
  };
  const pushSegment = () => {
    pushToken();
    if (segments[segments.length - 1].length) segments.push([]);
  };
  for (const ch of String(text || "")) {
    if (quoted) {
      if (ch === quoted) quoted = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quoted = ch; continue; }
    if (/\s/.test(ch)) { pushToken(); continue; }
    if (ch === ";" || ch === "\n" || ch === "&" || ch === "|") { pushSegment(); continue; }
    cur += ch;
  }
  pushToken();
  return segments.filter(s => s.length);
}

function normalizeProgram(token) {
  const p = String(token || "").replace(/^['"`]+|['"`;)]+$/g, "");
  const base = p.split(/[\\/]/).pop() || p;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/** 解析一行 shell 命令，返回 [{label, program, icon}]，噪声与纯环境变量段被丢掉 */
export function commandSegments(command) {
  const out = [];
  for (const tokens of splitCommandLine(command)) {
    let i = 0;
    while (i < tokens.length) {
      const tk = tokens[i];
      if (/^[A-Za-z_][\w-]*=/.test(tk) || tk.startsWith("-")) { i++; continue; }
      const prog = normalizeProgram(tk);
      i++;
      if (WRAPPERS.has(prog)) continue;
      if (NOISE_PROGRAMS.has(prog)) break;
      const next = String(tokens[i] || "").replace(/^['"`]+|['"`;)]+$/g, "");
      const useSub = SUBCOMMAND_TOOLS.has(prog) && /^[A-Za-z][\w-]*$/.test(next);
      out.push({
        label: useSub ? `${prog} ${next.toLowerCase()}` : prog,
        program: prog,
        icon: PROGRAM_ICONS[prog] || "terminal",
      });
      break;
    }
  }
  const seen = new Set();
  return out.filter(s => !seen.has(s.label) && seen.add(s.label)).slice(0, 6);
}

/**
 * terminal / git_tool 的语义投影：一句「执行命令」看不出跑了什么，这里还原成
 * git commit、npm test 这样的行，并给出对应品牌图标。非命令类工具返回 null。
 */
export function commandOf(name, params) {
  if (name === "git_tool") {
    const action = String(params?.action || "").trim().split(/\s+/)[0];
    const label = action ? `git ${action}` : "git";
    return { label, icon: "git", command: label, segments: [{ label, program: "git", icon: "git" }] };
  }
  if (name !== "terminal") return null;
  const command = String(params?.command || "").trim();
  if (!command) return null;
  const segments = commandSegments(command);
  const fallback = { label: "shell", program: "shell", icon: "terminal" };
  const head = segments[0] || fallback;
  return { ...head, command, segments: segments.length ? segments : [fallback] };
}

/** 工具图标：技能名优先，远程 MCP 认品牌 mark（认不出落 MCP 官方 mark），未知用通用工具图标 */
export function toolIcon(name, args) {
  const key = name === "skill_run" ? String(args?.skill || "") : String(name || "");
  if (!key) return "tool";
  if (TOOL_ICONS[key]) return TOOL_ICONS[key];
  // 远程工具的名号是 mcp__<serverId>__<tool>：id 认不出品牌，得回到 Server 的名称与 URL
  if (key.startsWith("mcp__")) return mcpIconKeyFromTool(key, state.skills?.remoteTools);
  return "tool";
}

/** 文件图标：按扩展名派生，无扩展名时按目录/文件区分 */
export function fileIcon(path) {
  const base = String(path || "").split(/[\\/]/).filter(Boolean).pop() || "";
  if (!base) return "folder";
  if (/^\.env/i.test(base) || /^(dockerfile|makefile|readme)/i.test(base)) {
    if (/^dockerfile/i.test(base)) return "docker";
    if (/^makefile/i.test(base)) return "tool";
    if (/^\.env/i.test(base)) return "key";
    return "file-text";
  }
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "file";
  return FILE_ICONS[base.slice(dot + 1).toLowerCase()] || "file";
}
