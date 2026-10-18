/**
 * 扩展页的能力面板：内置工具列表 + SKILL.md 技能（上传/导入/删除）
 * + Actions（data/actions/*.yml 流程说明书：可编辑、试校验、删除、留底回滚）。
 */

import { state, subscribe, setSkills, setActions } from "../store.js?v=20261017-001";
import { get, post, put, del, upload } from "../services/api.js?v=20261017-001";
import { guardSkillCall } from "../services/riskguard.js?v=20261017-001";
import { dlgConfirm, dlgPrompt } from "../services/dialog.js?v=20261017-001";
import { t } from "../services/i18n.js?v=20261017-001";
import { setIconText } from "../services/icons.js?v=20261017-001";
import { forgetScopeCatalog } from "../services/project_scope.js?v=20261017-001";
import { setExtCount } from "./extensions.js?v=20261017-001";

let skillList, toolList, mcpToolList, actionList;
let btnUpload, btnImport, btnDiscover, btnGithubImport, skillModal, skillModalTitle, skillParams, skillResult, btnRunSkill;

function showToast(msg) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add("out"); el.addEventListener("animationend", () => el.remove()); }, 2200);
}

// ── 技能参数定义 ────────────────────────────

const SKILL_PARAM_DEFS = {
  file_tree: [
    { key: "directory", label: "目录路径", type: "text", placeholder: "C:\\path\\to\\project" },
    { key: "recursive", label: "递归扫描", type: "text", placeholder: "true / false" },
    { key: "depth", label: "递归深度", type: "number", placeholder: "1" },
    { key: "pattern", label: "glob 过滤", type: "text", placeholder: "*.py" },
    { key: "include_hidden", label: "包含隐藏文件", type: "text", placeholder: "false" },
  ],
  file_peek: [
    { key: "file_path", label: "文件路径", type: "text", placeholder: "C:\\path\\to\\file.txt" },
    { key: "lines", label: "行数（上限 50）", type: "number", placeholder: "30" },
    { key: "encoding", label: "编码", type: "text", placeholder: "utf-8 / gbk / gb2312" },
    { key: "auto_detect", label: "自动检测编码", type: "text", placeholder: "true / false" },
    { key: "start_line", label: "起始行号", type: "number", placeholder: "1" },
    { key: "end_line", label: "结束行号", type: "number", placeholder: "30" },
    { key: "tail", label: "读取最后 N 行", type: "text", placeholder: "true / false" },
    { key: "fast", label: "快速模式", type: "text", placeholder: "true / false" },
  ],
  terminal: [
    { key: "command", label: "命令", type: "text", placeholder: "ls -la" },
    { key: "work_dir", label: "工作目录", type: "text", placeholder: "." },
    { key: "action", label: "操作类型", type: "text", placeholder: "create / list / close / kill / 空串执行命令" },
    { key: "session_id", label: "会话 ID", type: "text", placeholder: "default" },
    { key: "timeout", label: "超时秒数", type: "number", placeholder: "30" },
  ],
  bg_task: [
    { key: "action", label: "操作类型", type: "text", placeholder: "start / status / log / stop / list" },
    { key: "command", label: "命令（action=start）", type: "text", placeholder: "python server.py" },
    { key: "label", label: "任务名（给人看）", type: "text", placeholder: "实验服务器" },
    { key: "work_dir", label: "工作目录", type: "text", placeholder: "." },
    { key: "task_id", label: "任务 ID（status/log/stop）", type: "text", placeholder: "bt_xxxxxxxx" },
    { key: "trigger", label: "触发条件（JSON）", type: "text", placeholder: '{"on":"exit"} 或 {"on":"match","pattern":"Done"}' },
    { key: "notify", label: "命中/结束时叫醒模型", type: "text", placeholder: "true / false" },
    { key: "timeout", label: "超时秒数（0=不限）", type: "number", placeholder: "0" },
    { key: "since_offset", label: "只取该偏移之后的输出", type: "number", placeholder: "0" },
    { key: "tail_lines", label: "取最后 N 行", type: "number", placeholder: "20" },
    { key: "grep", label: "按关键词过滤输出", type: "text", placeholder: "error" },
  ],
  html_render: [
    { key: "title", label: "页面标题", type: "text", placeholder: "SLATE Teams 页面" },
    { key: "body", label: "HTML 内容", type: "textarea", placeholder: "<p>Hello</p>" },
  ],
  css_color: [
    { key: "description", label: "样式描述", type: "text", placeholder: "高对比度代码编辑器风格 "},
    { key: "component", label: "组件类型", type: "text", placeholder: "page / card / button / nav / form / code" },
  ],
  doc_write: [
    { key: "title", label: "文档标题", type: "text", placeholder: "项目技术文档 "},
    { key: "doc_type", label: "文档类型", type: "text", placeholder: "technical / requirement / api / readme / changelog" },
    { key: "sections", label: "章节（逗号分隔）", type: "text", placeholder: "概述,安装,配置,API" },
    { key: "content_hint", label: "内容提示", type: "textarea", placeholder: "关键信息或要点 "},
  ],
  ppt_create: [
    { key: "title", label: "演示文稿标题", type: "text", placeholder: "Q3 项目汇报" },
    { key: "subtitle", label: "副标题", type: "text", placeholder: "进展 · 风险 · 计划" },
    { key: "outline", label: "大纲章节（逗号分隔）", type: "text", placeholder: "背景,方案,实施计划,总结" },
    { key: "theme", label: "配色", type: "text", placeholder: "slate / blue / green / wine / gray / #RRGGBB" },
  ],
  word_create: [
    { key: "title", label: "文档标题", type: "text", placeholder: "项目方案书 "},
    { key: "author", label: "作者", type: "text", placeholder: "SLATE Teams" },
    { key: "content", label: "正文（支持 # 标题 / - 列表标记）", type: "textarea", placeholder: "# 概述\n项目背景说明\n## 目标\n- 目标一" },
  ],
  file_edit: [
    { key: "file_path", label: "文件路径", type: "text", placeholder: "frontend/js/app.js" },
    { key: "action", label: "操作类型", type: "text", placeholder: "view / replace / edit / replace_range / read / insert / delete / copy / paste / cut" },
    { key: "edits", label: "编辑操作（edit 操作，JSON 数组）", type: "textarea", placeholder: '[{"old_text": "原内容", "new_text": "新内容"}]' },
    { key: "old_str", label: "精确匹配字符串（replace 操作）", type: "textarea", placeholder: "要被替换的精确文本" },
    { key: "new_str", label: "替换后内容（replace 操作）", type: "textarea", placeholder: "替换后的新文本" },
    { key: "content", label: "插入/替换内容（insert/replace_range 操作）", type: "textarea", placeholder: "要插入或替换的文本" },
    { key: "start_line", label: "起始行号（1-based）", type: "number", placeholder: "1" },
    { key: "end_line", label: "结束行号（1-based）", type: "number", placeholder: "10" },
    { key: "clipboard_name", label: "剪贴板名称", type: "text", placeholder: "default" },
  ],
  file_create: [
    { key: "file_path", label: "文件路径", type: "text", placeholder: "frontend/js/new_file.js" },
    { key: "content", label: "文件内容", type: "textarea", placeholder: "文件内容..." },
  ],
  code_search: [
    { key: "query", label: "搜索关键词/正则", type: "text", placeholder: "async function|TODO|function main" },
    { key: "scope", label: "搜索范围子目录", type: "text", placeholder: "空=全局（项目根）；如 backend/routers" },
    { key: "case_sensitive", label: "区分大小写", type: "text", placeholder: "true / false" },
    { key: "glob", label: "文件名过滤", type: "text", placeholder: "*.py" },
    { key: "limit", label: "结果上限", type: "number", placeholder: "50" },
  ],
  text_summarize: [
    { key: "text", label: "文本", type: "textarea", placeholder: "粘贴要总结的文本 "},
    { key: "max_points", label: "要点数", type: "number", placeholder: "5" },
    { key: "keyword_limit", label: "关键词数", type: "number", placeholder: "12" },
  ],
  json_tool: [
    { key: "text", label: "JSON 文本", type: "textarea", placeholder: "{\"name\":\"SLATE Teams\"}" },
    { key: "mode", label: "模式", type: "text", placeholder: "format / minify / path" },
    { key: "path", label: "路径", type: "text", placeholder: "items.0.name" },
    { key: "indent", label: "缩进", type: "number", placeholder: "2" },
  ],
  regex_test: [
    { key: "pattern", label: "正则", type: "text", placeholder: "\\bTODO\\b" },
    { key: "text", label: "测试文本", type: "textarea", placeholder: "输入用于测试的文本 "},
    { key: "flags", label: "标志", type: "text", placeholder: "i / m / s" },
    { key: "limit", label: "最大结果", type: "number", placeholder: "20" },
  ],
  repo_stats: [
    { key: "directory", label: "目录路径", type: "text", placeholder: "C:\\path\\to\\project" },
    { key: "max_files", label: "最大文件数", type: "number", placeholder: "5000" },
  ],
  todo_scan: [
    { key: "directory", label: "目录路径", type: "text", placeholder: "C:\\path\\to\\project" },
    { key: "markers", label: "标记", type: "text", placeholder: "TODO,FIXME,待办" },
    { key: "limit", label: "最大结果", type: "number", placeholder: "100" },
  ],
  web_search: [
    { key: "query", label: "搜索关键词 / URL", type: "text", placeholder: "FastAPI 最新版本号（fetch 模式填 URL）" },
    { key: "mode", label: "模式", type: "text", placeholder: "search / fetch" },
    { key: "engine", label: "搜索引擎", type: "text", placeholder: "auto（默认）/ bing / ddg" },
    { key: "max_results", label: "结果数（≤10）", type: "number", placeholder: "5" },
  ],
  web_fetch: [
    { key: "url", label: "网页 URL", type: "text", placeholder: "https://example.com/article" },
    { key: "mode", label: "模式", type: "text", placeholder: "text / html" },
    { key: "render_js", label: "JS 渲染", type: "text", placeholder: "auto（默认）/ on / off" },
    { key: "max_chars", label: "截断长度（≤60000）", type: "number", placeholder: "20000" },
  ],
  chart_create: [
    { key: "data", label: "数据（JSON 或 标签:值）", type: "textarea", placeholder: "Q1:120, Q2:90, Q3:150" },
    { key: "type", label: "图表类型", type: "text", placeholder: "bar / hbar / line / pie" },
    { key: "title", label: "图表标题", type: "text", placeholder: "季度销售额" },
    { key: "theme", label: "配色", type: "text", placeholder: "slate / blue / green / warm / gray 或逗号分隔色值 "},
  ],
  qrcode_create: [
    { key: "text", label: "二维码内容（文本/URL）", type: "textarea", placeholder: "https://github.com/CaryWang1234/SLATE-Teams" },
    { key: "size", label: "模块像素大小", type: "number", placeholder: "8" },
  ],
  python_api_extract: [
    { key: "target", label: "目标（包名或 .py 文件/目录路径）", type: "text", placeholder: "requests 或 C:/path/to/mylib" },
    { key: "depth", label: "递归深度（-1 不限）", type: "number", placeholder: "1" },
    { key: "format", label: "输出格式", type: "text", placeholder: "json / markdown" },
  ],
  html_bundle: [
    { key: "src", label: "HTML 文件路径", type: "text", placeholder: "C:/path/to/page/index.html" },
    { key: "out", label: "输出路径（可选）", type: "text", placeholder: "缺省为源同目录 <原名>.bundled.html" },
  ],
  mcp_factory: [
    { key: "tool_name", label: "工具名称（英文）", type: "text", placeholder: "my_tool" },
    { key: "description", label: "工具描述", type: "text", placeholder: "我的自定义工具功能描述" },
    { key: "params", label: "参数规格（JSON 数组）", type: "textarea", placeholder: '[{"name":"input","type":"str","required":true,"description":"输入内容"}]' },
    { key: "body", label: "核心逻辑代码", type: "textarea", placeholder: 'result = {"message": "Hello"}' },
    { key: "overwrite", label: "覆盖已有（true/false）", type: "text", placeholder: "false" },
  ],
  browser_automation: [
    { key: "action", label: "操作类型", type: "text", placeholder: "launch/navigate/screenshot/click/type/get_text/evaluate/scroll/wait/close" },
    { key: "url", label: "目标 URL", type: "text", placeholder: "https://example.com" },
    { key: "selector", label: "CSS 选择器", type: "text", placeholder: "#id 或 .class" },
    { key: "text", label: "输入文字", type: "text", placeholder: "要输入的内容" },
    { key: "expression", label: "JS 表达式", type: "text", placeholder: "document.title" },
    { key: "headless", label: "无头模式 (true/false)", type: "text", placeholder: "true" },
    { key: "full_page", label: "全页截图 (true/false)", type: "text", placeholder: "false" },
  ],
  computer_use: [
    { key: "action", label: "操作类型", type: "text", placeholder: "screenshot/click/type/press/hotkey/wait/locate/clipboard/window_list/window_focus 等" },
    { key: "x", label: "X 坐标", type: "text", placeholder: "500" },
    { key: "y", label: "Y 坐标", type: "text", placeholder: "300" },
    { key: "text", label: "输入文字", type: "text", placeholder: "Hello World" },
    { key: "keys", label: "按键（hotkey 逗号分隔 / press 单键名）", type: "text", placeholder: "ctrl,c 或 enter" },
    { key: "button", label: "鼠标按键", type: "text", placeholder: "left/right/middle" },
    { key: "region", label: "截图区域 x,y,w,h", type: "text", placeholder: "0,0,800,600" },
    { key: "fast", label: "快速模式", type: "text", placeholder: "true" },
    { key: "screenshot_format", label: "截图格式", type: "text", placeholder: "jpeg / png" },
    { key: "quality", label: "JPEG 质量", type: "number", placeholder: "80" },
    { key: "max_width", label: "截图最大宽度", type: "number", placeholder: "0" },
    { key: "max_height", label: "截图最大高度", type: "number", placeholder: "0" },
    { key: "seconds", label: "等待秒数（wait）", type: "text", placeholder: "1" },
    { key: "repeats", label: "按键次数（press）", type: "text", placeholder: "1" },
    { key: "scroll_amount", label: "滚动格数", type: "text", placeholder: "3" },
    { key: "image_path", label: "参考图片路径", type: "text", placeholder: "C:/path/to/image.png" },
    { key: "confidence", label: "匹配置信度 0-1", type: "text", placeholder: "0.8" },
    { key: "title", label: "窗口标题关键词（window_*）", type: "text", placeholder: "记事本" },
  ],
  excel_tool: [
    { key: "action", label: "操作类型", type: "text", placeholder: "create / read / convert" },
    { key: "file_path", label: "源文件路径（read/convert）", type: "text", placeholder: "C:/path/to/data.xlsx" },
    { key: "title", label: "表格标题（create 文件名）", type: "text", placeholder: "季度报表" },
    { key: "sheet", label: "工作表名", type: "text", placeholder: "Sheet1" },
    { key: "headers", label: "表头（JSON 数组或逗号分隔）", type: "text", placeholder: "姓名,部门,绩效" },
    { key: "rows", label: "数据行（JSON 二维数组）", type: "textarea", placeholder: '[["张三","研发",95],["李四","设计",88]]' },
    { key: "data", label: "CSV 文本数据（首行表头）", type: "textarea", placeholder: "姓名,部门\n张三,研发" },
    { key: "limit", label: "读取预览行数", type: "number", placeholder: "50" },
    { key: "out", label: "输出路径（convert 可选）", type: "text", placeholder: "缺省为源同目录同名换扩展名" },
  ],
  pdf_tool: [
    { key: "action", label: "操作类型", type: "text", placeholder: "info / extract / tables" },
    { key: "file_path", label: "PDF 文件路径", type: "text", placeholder: "C:/path/to/doc.pdf" },
    { key: "pages", label: "页码范围", type: "text", placeholder: "1-3,5 或 all" },
    { key: "max_chars", label: "最大提取字符数", type: "number", placeholder: "30000" },
  ],
  git_tool: [
    { key: "action", label: "操作类型", type: "text", placeholder: "status / log / diff / branches / remotes" },
    { key: "directory", label: "仓库目录路径", type: "text", placeholder: "C:/path/to/repo" },
    { key: "limit", label: "提交记录条数（log）", type: "number", placeholder: "10" },
    { key: "scope", label: "diff 范围", type: "text", placeholder: "unstaged / staged / all" },
  ],
  doc_scan: [
    { key: "directory", label: "扫描目录", type: "text", placeholder: "C:/path/to/docs" },
    { key: "file_path", label: "扫描单个文件（与目录二选一）", type: "text", placeholder: "C:/path/to/file.docx" },
    { key: "severity", label: "最低严重级别", type: "text", placeholder: "critical / high / medium / low" },
    { key: "category", label: "类别过滤", type: "text", placeholder: "身份证号 / 硬编码密码 / 手机号" },
    { key: "max_files", label: "最大扫描文件数", type: "number", placeholder: "50" },
  ],
  screenshot_to_code: [
    { key: "image_path", label: "图片路径", type: "text", placeholder: "C:/path/to/screenshot.png" },
    { key: "style", label: "风格偏好（可选）", type: "text", placeholder: "tailwind / plain css / responsive" },
  ],
  image_gen: [
    { key: "prompt", label: "图片内容描述", type: "textarea", placeholder: "一只戴礼帽的橘猫，水彩风格，浅色背景" },
    { key: "size", label: "尺寸", type: "text", placeholder: "1024x1024" },
    { key: "n", label: "数量（1-4）", type: "number", placeholder: "1" },
  ],
  video_gen: [
    { key: "prompt", label: "视频内容描述", type: "textarea", placeholder: "一只橘猫在草地上奔跑，镜头跟随" },
    { key: "duration", label: "时长秒数（1-30）", type: "number", placeholder: "5" },
  ],
};

// ── 扩展页四类列表：技能 / 内置工具 / MCP 远程工具 / Actions ──────
// 四类各占一个容器。以前四组小标题连着排在同一列里，「工具」「MCP 远程工具」
// 「技能」三个名字相近的组滚起来容易看串，用户会以为少加载了一类。

function extEmpty(host, text) {
  if (!host) return;
  const empty = document.createElement("div");
  empty.className = "ext-empty";
  empty.textContent = text;
  host.appendChild(empty);
}

function renderSkillList() {
  const skills = Object.entries(state.skills.skills || {});
  if (skillList) {
    skillList.innerHTML = "";
    for (const [name, desc] of skills) skillList.appendChild(createSkillItem(name, desc, "Skill"));
    if (!skills.length) extEmpty(skillList, t("暂无技能，可点右上「导入技能」或「新建技能」"));
  }
  setExtCount("skills", skills.length);

  const tools = Object.entries(state.skills.mcp || {});
  if (toolList) {
    toolList.innerHTML = "";
    for (const [name, desc] of tools) toolList.appendChild(createSkillItem(name, desc, "工具"));
    if (!tools.length) extEmpty(toolList, t("后端没有返回任何内置工具"));
  }
  setExtCount("tools", tools.length);

  // 远程 MCP 工具挂在 MCP 那一栏：它与上面的 Server 列表是同一件事的两半
  const remote = Object.entries(state.skills.remote || {});
  if (mcpToolList) {
    mcpToolList.innerHTML = "";
    for (const [name, desc] of remote) mcpToolList.appendChild(createSkillItem(name, desc, "MCP"));
    if (!remote.length) extEmpty(mcpToolList, t("还没有已连接的远程工具：在上方添加并连接一个 MCP Server"));
  }

  renderActionsSection();
}

// ── 自进化工具（data/evolved/，工具工厂自己生产的工具） ──────
// 这一栏存在的理由很具体：产物从源码目录搬进了用户数据目录，升级覆盖不到它，
// 但"能不能被模型用、这一版生成错了怎么退回去"必须有人在界面上说得上话。
// 停用是整条从模型目录里摘掉（不是调用时再报错），回滚与撤销都先留底。

let evolvedListEl;
let evolvedModal, evolvedModalTitle, evolvedModalMeta, evolvedSource, evolvedHistory;
let btnEvolvedHistory, btnEvolvedToggle, btnEvolvedDelete;
let evolvedCache = [];
let currentEvolvedName = "";

function evolvedItem(name) {
  return evolvedCache.find(x => x.name === name) || null;
}

/** 这一条现在是什么状态：停用 / 被内置同名顶掉 / 代码本身有问题。 */
function evolvedStates(item) {
  const out = [];
  if (item.error) out.push({ text: t("不可用：{msg}", { msg: item.error }), kind: "bad" });
  else if (item.shadowed) out.push({ text: t("与内置工具同名，已由内置接管"), kind: "warn" });
  else if (!item.enabled) out.push({ text: t("已停用"), kind: "muted" });
  return out;
}

function renderEvolvedSection() {
  if (!evolvedListEl) return;
  evolvedListEl.innerHTML = "";
  for (const item of evolvedCache) evolvedListEl.appendChild(createEvolvedItem(item));
  if (!evolvedCache.length) {
    extEmpty(evolvedListEl, t("还没有自产工具。用「工具工厂」生成一个，产物会出现在此处，可随时停用或撤销"));
  }
  setExtCount("evolved", evolvedCache.length);
}

function createEvolvedItem(item) {
  const row = document.createElement("div");
  row.className = "skill-item evolved-item" + (item.enabled && !item.error && !item.shadowed ? "" : " evolved-off");

  const info = document.createElement("div");
  const nameRow = document.createElement("div");
  nameRow.className = "skill-item-name";
  const badge = document.createElement("span");
  badge.className = "skill-kind-badge skill-kind-evolved";
  badge.textContent = t("自产");
  nameRow.appendChild(badge);
  nameRow.appendChild(document.createTextNode(" " + item.name));
  info.appendChild(nameRow);

  const descEl = document.createElement("div");
  descEl.className = "skill-item-desc";
  descEl.textContent = item.description || "";
  info.appendChild(descEl);

  for (const st of evolvedStates(item)) {
    const note = document.createElement("div");
    note.className = `evolved-state evolved-state-${st.kind}`;
    note.textContent = st.text;
    info.appendChild(note);
  }
  row.appendChild(info);

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "icon-btn evolved-toggle-btn";
  toggleBtn.textContent = item.enabled ? t("停用") : t("启用");
  toggleBtn.title = item.enabled ? t("停用后模型目录里不再出现这一项") : t("重新交给模型使用");
  toggleBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await toggleEvolved(item.name, !item.enabled);
  });
  row.appendChild(toggleBtn);

  const delBtn = document.createElement("button");
  delBtn.className = "skill-item-del";
  delBtn.title = t("撤销这个工具（删除前存入历史版本）");
  delBtn.textContent = "×";
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await deleteEvolved(item.name);
  });
  row.appendChild(delBtn);

  row.addEventListener("click", () => openEvolvedModal(item.name));
  return row;
}

async function toggleEvolved(name, enabled) {
  try {
    const res = await post(`/evolved/${encodeURIComponent(name)}/toggle`, { enabled });
    if (res.code !== 0) { showToast(t("操作失败: {msg}", { msg: res.message || t("未知错误") })); return; }
    showToast(enabled ? t("已启用 {name}", { name }) : t("已停用 {name}，已从模型目录移除", { name }));
    await refreshEvolved();
    refreshSkills();
  } catch (e) {
    showToast(t("请求失败: {msg}", { msg: e.message }));
  }
}

async function deleteEvolved(name) {
  const ok = await dlgConfirm(t("撤销自进化工具 {name}？源码会先存入历史版本，之后仍可在「历史版本」里看到。", { name }),
    { danger: true, okText: t("撤销工具"), title: t("撤销自进化工具") });
  if (!ok) return;
  try {
    const res = await del(`/evolved/${encodeURIComponent(name)}`);
    if (res.code !== 0) { showToast(t("撤销失败: {msg}", { msg: res.message || t("未知错误") })); return; }
    showToast(t("已撤销 {name}", { name }));
    if (currentEvolvedName === name) closeEvolvedModal();
    await refreshEvolved();
    refreshSkills();
  } catch (e) {
    showToast(t("请求失败: {msg}", { msg: e.message }));
  }
}

function closeEvolvedModal() {
  evolvedModal?.classList.add("hidden");
}

async function openEvolvedModal(name) {
  const item = evolvedItem(name);
  if (!item) return;
  currentEvolvedName = name;
  evolvedModalTitle.textContent = t("自进化工具: {name}", { name });
  const meta = [
    item.description || "",
    t("参数 {n} 个", { n: (item.params || []).length }),
    item.created_at ? t("创建于 {t}", { t: item.created_at }) : "",
    item.updated_at ? t("最后改动 {t}", { t: item.updated_at }) : "",
    item.bytes ? `${item.bytes} B` : "",
    item.versions ? t("保留 {n} 版", { n: item.versions }) : "",
  ].filter(Boolean).join(" · ");
  const states = evolvedStates(item).map(s => s.text).join("；");
  evolvedModalMeta.textContent = [meta, states].filter(Boolean).join(" · ");
  evolvedSource.textContent = t("读取中…");
  btnEvolvedToggle.textContent = item.enabled ? t("停用") : t("启用");
  evolvedHistory.classList.add("hidden");
  evolvedModal.classList.remove("hidden");
  try {
    const res = await get(`/evolved/${encodeURIComponent(name)}/source`);
    // 弹窗可能已经切到另一条了：迟到的旧响应不许盖掉现在这条
    if (currentEvolvedName !== name) return;
    evolvedSource.textContent = res.code === 0 ? (res.data?.content || "") : t("读取失败: {msg}", { msg: res.message });
  } catch (e) {
    if (currentEvolvedName === name) evolvedSource.textContent = t("请求失败: {msg}", { msg: e.message });
  }
}

async function renderEvolvedHistory() {
  if (!currentEvolvedName) return;
  evolvedHistory.textContent = "";
  const loading = document.createElement("div");
  loading.className = "evolved-history-empty";
  loading.textContent = t("读取中…");
  evolvedHistory.appendChild(loading);
  let rows = [];
  let keep = 5;
  try {
    const res = await get(`/evolved/${encodeURIComponent(currentEvolvedName)}/history`);
    evolvedHistory.textContent = "";
    if (res.code !== 0) {
      const err = document.createElement("div");
      err.className = "evolved-history-empty";
      err.textContent = t("读取失败: {msg}", { msg: res.message || t("未知错误") });
      evolvedHistory.appendChild(err);
      return;
    }
    rows = res.data?.versions || [];
    keep = res.data?.keep || 5;
  } catch (e) {
    evolvedHistory.textContent = "";
    const err = document.createElement("div");
    err.className = "evolved-history-empty";
    err.textContent = t("请求失败: {msg}", { msg: e.message });
    evolvedHistory.appendChild(err);
    return;
  }
  const tip = document.createElement("div");
  tip.className = "evolved-history-tip";
  tip.textContent = t("每次覆盖、撤销或回滚都会先存入历史版本，最多保留 {n} 版。", { n: keep });
  evolvedHistory.appendChild(tip);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "evolved-history-empty";
    empty.textContent = t("还没有历史版本");
    evolvedHistory.appendChild(empty);
    return;
  }
  for (const v of rows) evolvedHistory.appendChild(createEvolvedHistoryRow(v));
}

function createEvolvedHistoryRow(version) {
  const row = document.createElement("div");
  row.className = "action-history-row";

  const label = document.createElement("span");
  label.className = "action-history-ts";
  label.textContent = `${formatHistoryTs(version.ts)} · ${version.bytes} B`;
  row.appendChild(label);

  const viewBtn = document.createElement("button");
  viewBtn.className = "dlg-btn";
  viewBtn.textContent = t("查看");
  viewBtn.addEventListener("click", async () => {
    const name = currentEvolvedName;
    try {
      const res = await get(`/evolved/${encodeURIComponent(name)}/history/${encodeURIComponent(version.ts)}`);
      if (res.code !== 0) { showToast(t("读取失败: {msg}", { msg: res.message })); return; }
      if (currentEvolvedName !== name) return;
      evolvedSource.textContent = res.data?.content || "";
    } catch (e) {
      showToast(t("请求失败: {msg}", { msg: e.message }));
    }
  });
  row.appendChild(viewBtn);

  const restoreBtn = document.createElement("button");
  restoreBtn.className = "dlg-btn dlg-btn-primary";
  restoreBtn.textContent = version.has_manifest ? t("回滚") : t("只回滚代码");
  restoreBtn.title = version.has_manifest ? t("把这一版的代码与说明都盖回当前")
    : t("这一版没有留下清单，回滚后沿用现在的说明与参数");
  restoreBtn.addEventListener("click", async () => {
    const name = currentEvolvedName;
    const ok = await dlgConfirm(t("把自进化工具 {name} 回滚到 {ts}？当前内容会先存入历史版本。",
      { name, ts: formatHistoryTs(version.ts) }), { okText: t("回滚"), title: t("回滚自进化工具") });
    if (!ok) return;
    try {
      const res = await post(`/evolved/${encodeURIComponent(name)}/history/restore`, { ts: version.ts });
      if (res.code !== 0) { showToast(t("回滚失败: {msg}", { msg: res.message || t("未知错误") })); return; }
      showToast(t("已回滚到 {ts}", { ts: formatHistoryTs(version.ts) }));
      await refreshEvolved();
      refreshSkills();
      if (currentEvolvedName === name) await openEvolvedModal(name);
    } catch (e) {
      showToast(t("请求失败: {msg}", { msg: e.message }));
    }
  });
  row.appendChild(restoreBtn);
  return row;
}

function initEvolvedModal() {
  evolvedListEl = document.getElementById("ext-evolved-list");
  evolvedModal = document.getElementById("evolved-modal");
  evolvedModalTitle = document.getElementById("evolved-modal-title");
  evolvedModalMeta = document.getElementById("evolved-modal-meta");
  evolvedSource = document.getElementById("evolved-source");
  evolvedHistory = document.getElementById("evolved-history");
  btnEvolvedHistory = document.getElementById("btn-evolved-history");
  btnEvolvedToggle = document.getElementById("btn-evolved-toggle");
  btnEvolvedDelete = document.getElementById("btn-evolved-delete");
  if (!evolvedModal) return;

  btnEvolvedHistory?.addEventListener("click", async () => {
    if (!evolvedHistory.classList.contains("hidden")) {
      evolvedHistory.classList.add("hidden");
      return;
    }
    await renderEvolvedHistory();
    evolvedHistory.classList.remove("hidden");
  });
  btnEvolvedToggle?.addEventListener("click", () => {
    const item = evolvedItem(currentEvolvedName);
    if (item) toggleEvolved(item.name, !item.enabled);
  });
  btnEvolvedDelete?.addEventListener("click", () => { if (currentEvolvedName) deleteEvolved(currentEvolvedName); });
  evolvedModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", closeEvolvedModal);
  });
}

/** 自进化清单刷新：读不到就保持空态，这一栏是可选能力，不该每次开面板都弹错误。 */
async function refreshEvolved() {
  try {
    const res = await get("/evolved");
    evolvedCache = res.code === 0 && Array.isArray(res.data?.items) ? res.data.items : [];
  } catch (e) {
    evolvedCache = [];
  }
  renderEvolvedSection();
}

// ── Actions（data/actions/*.yml，可编辑的流程说明书） ──────

// 与后端 ACTION_ID_RE 同一条规则：id 就是文件名，先在这里拦住，不让垃圾 id 打到后端
const ACTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

const ACTION_TEMPLATE = [
  "name: 我的流程",
  "description: 一句话说清这份流程要做什么",
  "when: 用户说到什么场合时套用",
  "author: user",
  "inputs:",
  "  - key: topic",
  "    label: 主题",
  "    type: text",
  "    required: true",
  "steps:",
  "  - title: 第一步做什么",
  "    detail: |-",
  "      具体怎么做，可以多写几行",
  "    tool: project_read_file",
  "    check: 怎么算做完了",
  "  - title: 第二步做什么",
  "output:",
  "  format: markdown",
  "  destination: message",
  "tags:",
  "  - 常用",
  "",
].join("\n");

let actionModal, actionModalTitle, actionModalMeta, actionScopeHint, actionEditor, actionValidateMsg, actionHistory;
let btnActionSave, btnActionDelete, btnActionHistory, btnActionOverride;
let currentActionId = "";        // 编辑器当前对应的 Action（新建时也会赋值，但磁盘上还没有）
let currentActionScope = "global"; // 编辑器里这一份落在哪儿：global=本机共用，project=当前项目的覆盖版
let actionExists = false;        // 决定「删除/历史」这两个入口是否有意义
let actionValidateTimer = null;
let actionDraftSeq = 0;          // 校验是异步的：迟到的旧结果不许覆盖新输入

/*
 * 两份 Action 长得很像，改错一份的代价却不小：全局版本是所有项目共用的，
 * 项目那份只在打开这个项目时顶掉同名全局版本。所以列表上标来源，编辑器里
 * 写明"现在改的是哪一份"，保存/删除/历史也都按这一份的落点走——与分项目宪法同一套文案。
 */
function activeProjectId() {
  return String(state.project?.project_id || "");
}

/** 编辑器上方那行落点说明（没有项目视野时不提项目覆盖）。 */
function describeActionScope(scope) {
  if (scope === "project") {
    return t("正在编辑项目「{name}」的 Action：存入该项目 .slate/actions/，同名时优先于全局", { name: state.project?.name || "" });
  }
  return activeProjectId()
    ? t("正在编辑全局 Action：项目内同名 Action 优先于这一份")
    : t("正在编辑全局 Action：所有项目共用");
}

function renderActionsSection() {
  const list = Array.isArray(state.actions) ? state.actions : [];
  const broken = Array.isArray(state.actionsBroken) ? state.actionsBroken : [];
  if (!actionList) return;

  actionList.innerHTML = "";
  if (!list.length && !broken.length) {
    extEmpty(actionList, t("暂无 Action。点右上「＋ 新建 Action」写一份流程，或在 data/actions/ 放入 <id>.yml，模型即可读取调用"));
  }
  for (const action of list) actionList.appendChild(createActionItem(action));
  for (const item of broken) actionList.appendChild(createBrokenActionItem(item));
  setExtCount("actions", list.length);
}

function createActionItem(action) {
  const item = document.createElement("div");
  item.className = "skill-item";

  const info = document.createElement("div");
  const nameRow = document.createElement("div");
  nameRow.className = "skill-item-name";
  const badge = document.createElement("span");
  badge.className = "skill-kind-badge skill-kind-action";
  badge.textContent = "Action";
  nameRow.appendChild(badge);
  // 来源徽标：这一份是项目里的覆盖版还是本机共用那份，用户只能从这里看出来
  if (action.scope === "project") {
    const scopeBadge = document.createElement("span");
    scopeBadge.className = "skill-kind-badge skill-kind-scope";
    scopeBadge.textContent = t("本项目");
    scopeBadge.title = t("只在这个项目生效，同名时覆盖全局版本");
    nameRow.appendChild(scopeBadge);
  }
  // 模型代写的流程要显式标出来：它等于模型往自己的系统提示里加过料
  if (action.author === "model") {
    const modelBadge = document.createElement("span");
    modelBadge.className = "skill-kind-badge skill-kind-model";
    modelBadge.textContent = t("模型代写");
    nameRow.appendChild(modelBadge);
  }
  nameRow.appendChild(document.createTextNode(" " + (action.name || action.id)));
  const descEl = document.createElement("div");
  descEl.className = "skill-item-desc";
  descEl.textContent = [
    action.description,
    action.when ? t("适用：{when}", { when: action.when }) : "",
    t("{n} 步", { n: action.stepCount }),
  ].filter(Boolean).join(" ｜ ");
  info.appendChild(nameRow);
  info.appendChild(descEl);
  item.appendChild(info);

  item.addEventListener("click", () => openActionEditor(action.id));
  return item;
}

/** 解析失败的文件必须显式露出来：否则用户改坏一个 yml 只会看到它凭空消失。 */
function createBrokenActionItem(entry) {
  const item = document.createElement("div");
  item.className = "skill-item skill-item-broken";
  const info = document.createElement("div");
  const nameRow = document.createElement("div");
  nameRow.className = "skill-item-name";
  const badge = document.createElement("span");
  badge.className = "skill-kind-badge skill-kind-action";
  badge.textContent = "Action";
  nameRow.appendChild(badge);
  nameRow.appendChild(document.createTextNode(" " + entry.id));
  const descEl = document.createElement("div");
  descEl.className = "skill-item-desc";
  descEl.textContent = entry.error;
  info.appendChild(nameRow);
  info.appendChild(descEl);
  item.appendChild(info);
  return item;
}

// ── Action 编辑器 ────────────────────────────

function setActionNote(text, kind) {
  actionValidateMsg.textContent = text || "";
  actionValidateMsg.className = `action-validate-msg${kind ? ` action-${kind}` : ""}${text ? "" : " hidden"}`;
}

function resetActionModalChrome(id, { isNew }) {
  currentActionId = id;
  currentActionScope = "global";
  actionExists = !isNew;
  actionDraftSeq += 1; // 作废上一份草稿在途的校验响应
  actionModalTitle.textContent = isNew ? t("新建 Action {id}", { id }) : t("编辑 Action {id}", { id });
  actionHistory.classList.add("hidden");
  btnActionDelete.classList.toggle("hidden", isNew);
  btnActionHistory.classList.toggle("hidden", isNew);
  paintActionScopeHint();
  if (isNew) actionEditor.value = ACTION_TEMPLATE;
}

/** 编辑器顶部那行落点说明 + 「在本项目另存一份」的可见性：两者读的都是 currentActionScope。 */
function paintActionScopeHint() {
  if (actionScopeHint) {
    actionScopeHint.textContent = describeActionScope(currentActionScope);
    actionScopeHint.classList.toggle("action-scope-project", currentActionScope === "project");
  }
  // 覆盖版自己有覆盖版，不必再"另存"；没打开项目时更没有落点可言
  btnActionOverride?.classList.toggle("hidden", !(activeProjectId() && actionExists && currentActionScope === "global"));
}

async function handleCreateAction() {
  const raw = await dlgPrompt(t("id 即文件名（data/actions/<id>.yml）：小写字母开头，可含数字、_ 和 -，不超过 48 字"), {
    title: t("新建 Action"),
    okText: t("创建"),
    placeholder: "weekly_report",
  });
  if (raw === null) return;
  const id = String(raw).trim();
  if (!id) return;
  if (!ACTION_ID_RE.test(id)) {
    showToast(t("id 不合法：小写字母开头，只允许 a-z0-9_-，不超过 48 字"));
    return;
  }
  if ((Array.isArray(state.actions) ? state.actions : []).some(a => a.id === id)) {
    showToast(t("Action {id} 已存在，直接点开它编辑", { id }));
    openActionEditor(id);
    return;
  }
  resetActionModalChrome(id, { isNew: true });
  actionModalMeta.textContent = `data/actions/${id}.yml · ${t("尚未创建")}`;
  setActionNote(t("按 SAY-1 子集书写：缩进用空格（每层 2 格），列表用「- 」块式写法，禁止 Tab、行内 {}/[] 与首行 ---"), "muted");
  actionModal.classList.remove("hidden");
  validateActionDraft();
  actionEditor.focus();
}

async function openActionEditor(id) {
  resetActionModalChrome(id, { isNew: false });
  actionModalMeta.textContent = t("读取中…");
  setActionNote("");
  actionEditor.value = "";
  actionModal.classList.remove("hidden");

  try {
    const pid = activeProjectId();
    const res = await get(`/actions/${encodeURIComponent(id)}${pid ? `?project=${encodeURIComponent(pid)}` : ""}`);
    if (currentActionId !== id) return; // 用户已切到别的条目，不要把上一份的原文灌进来
    if (res.code !== 0) {
      actionModalMeta.textContent = t("读取失败: {msg}", { msg: res.message || t("未知错误") });
      return;
    }
    currentActionScope = res.data?.scope === "project" ? "project" : "global";
    paintActionScopeHint();
    actionEditor.value = res.data?.raw || "";
    const a = res.data?.action || {};
    actionModalMeta.textContent = [
      res.data?.path || `data/actions/${id}.yml`,
      t("作者: {a}", { a: a.author === "model" ? t("模型代写") : t("用户手写") }),
      t("流程 {n} 步", { n: a.stepCount ?? (a.steps || []).length }),
    ].join(" · ");
    validateActionDraft();
  } catch (e) {
    actionModalMeta.textContent = t("请求失败: {msg}", { msg: e.message });
  }
}

/**
 * 试校验当前编辑框内容并把结果写到编辑框下方。
 * 返回后端 data（{ok, errors, warnings, action}），网络失败返回 null。
 */
async function validateActionDraft() {
  if (!actionModal || actionModal.classList.contains("hidden")) return null;
  const text = actionEditor.value;
  const seq = ++actionDraftSeq;
  if (!text.trim()) {
    setActionNote(t("内容为空：至少要写 name、description 和一步 steps"), "muted");
    return null;
  }
  try {
    const res = await post("/actions/validate", { content: text });
    if (seq !== actionDraftSeq) return null; // 期间用户又打了字，这次结果已过时
    if (res.code !== 0) {
      setActionNote(t("校验请求失败: {msg}", { msg: res.message || t("未知错误") }), "err");
      return null;
    }
    const d = res.data || {};
    if (!d.ok) {
      setActionNote((d.errors || []).map(e => (e.line ? t("第 {n} 行：{reason}", { n: e.line, reason: e.reason }) : e.reason)).join("\n")
        || t("校验未通过"), "err");
      return d;
    }
    setActionNote((d.warnings || []).length
      ? t("格式通过。书写提醒：{msg}", { msg: d.warnings.join("；") })
      : t("格式通过：{n} 步流程", { n: d.action?.steps?.length ?? 0 }), (d.warnings || []).length ? "warn" : "ok");
    return d;
  } catch (e) {
    if (seq === actionDraftSeq) setActionNote(t("校验请求失败: {msg}", { msg: e.message }), "err");
    return null;
  }
}

async function saveAction(targetScope = "") {
  const id = currentActionId;
  if (!id) return;
  const draft = await validateActionDraft();
  if (!draft?.ok) {
    showToast(t("校验未通过，未写入"));
    return;
  }
  const scope = targetScope === "project" ? "project" : (currentActionScope || "global");
  const pid = activeProjectId();
  if (scope === "project" && !pid) {
    showToast(t("需先打开项目，才能写入项目版本"));
    return;
  }
  btnActionSave.disabled = true;
  btnActionSave.textContent = t("保存中…");
  try {
    const qs = scope === "project" ? `?project=${encodeURIComponent(pid)}` : "";
    const res = await put(`/actions/${encodeURIComponent(id)}${qs}`, { content: actionEditor.value, scope });
    if (res.code === 0) {
      const d = res.data || {};
      currentActionScope = d.scope === "project" ? "project" : "global";
      paintActionScopeHint();
      showToast(currentActionScope === "project"
        ? t("已保存到项目：Action {id}（同名时覆盖全局版本）", { id })
        : t("已保存全局 Action {id}", { id }));
      actionExists = true;
      btnActionDelete.classList.remove("hidden");
      btnActionHistory.classList.remove("hidden");
      actionModalMeta.textContent = [
        d.path || `data/actions/${id}.yml`,
        t("流程 {n} 步", { n: d.stepCount }),
        d.backedUp ? t("原内容已存入「历史版本」{ts}", { ts: formatHistoryTs(d.backedUp) }) : "",
      ].filter(Boolean).join(" · ");
      setActionNote((d.warnings || []).length
        ? t("已写入。书写提醒：{msg}", { msg: d.warnings.join("；") })
        : t("已写入"), (d.warnings || []).length ? "warn" : "ok");
      refreshActions();
      forgetScopeCatalog(pid);   // 后台那场的目录缓存跟着磁盘失效
    } else {
      setActionNote(t("写入失败: {msg}", { msg: res.message || t("未知错误") }), "err");
      showToast(t("写入失败: {msg}", { msg: res.message || t("未知错误") }));
    }
  } catch (e) {
    setActionNote(t("写入请求失败: {msg}", { msg: e.message }), "err");
  } finally {
    btnActionSave.disabled = false;
    btnActionSave.textContent = t("保存");
  }
}

/** 把编辑器里这份另存为当前项目的覆盖版（全局版本原样留着）。 */
async function saveActionAsProjectOverride() {
  await saveAction("project");
}

async function deleteAction() {
  const id = currentActionId;
  if (!id) return;
  const pid = activeProjectId();
  const inProject = currentActionScope === "project" && Boolean(pid);
  const ok = await dlgConfirm(
    inProject
      ? t("确定摘掉项目里的 Action {id}？摘掉后该项目改用全局版本。原内容会存入「历史版本」，可随时回滚。", { id })
      : t("确定删除全局 Action {id}？所有项目共用这一份，删除后各项目都不再读到。原内容会存入「历史版本」，可随时回滚。", { id }),
    { danger: true, okText: inProject ? t("摘掉覆盖") : t("删除"), title: t("删除 Action") });
  if (!ok) return;
  try {
    const qs = new URLSearchParams();
    if (pid) qs.set("project", pid);
    qs.set("scope", inProject ? "project" : "global");
    const res = await del(`/actions/${encodeURIComponent(id)}?${qs.toString()}`);
    if (res.code === 0) {
      showToast(res.message || (inProject ? t("已摘掉项目覆盖 {id}", { id }) : t("已删除 Action {id}", { id })));
      actionModal.classList.add("hidden");
      refreshActions();
      forgetScopeCatalog(pid);
    } else {
      showToast(t("删除失败: {msg}", { msg: res.message || t("未知错误") }));
    }
  } catch (e) {
    showToast(t("删除失败: {msg}", { msg: e.message }));
  }
}

/** 留底时间戳定宽，字典序即时序；这里只负责把它读得通。 */
function formatHistoryTs(ts) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:-(\d+))?$/.exec(String(ts || ""));
  if (!m) return String(ts || "");
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}${m[7] ? ` #${m[7]}` : ""}`;
}

/** 留底按落点各存一处：看历史也必须点名是哪一份，否则会把另一份的留底当成这一份的。 */
function actionScopeQuery() {
  const qs = new URLSearchParams();
  const pid = activeProjectId();
  if (pid) qs.set("project", pid);
  qs.set("scope", currentActionScope === "project" ? "project" : "global");
  return `?${qs.toString()}`;
}

async function renderActionHistory() {
  actionHistory.textContent = "";
  const loading = document.createElement("div");
  loading.className = "action-history-empty";
  loading.textContent = t("读取中…");
  actionHistory.appendChild(loading);
  try {
    const res = await get(`/actions/${encodeURIComponent(currentActionId)}/history${actionScopeQuery()}`);
    const rows = res.code === 0 ? (res.data?.versions || []) : [];
    actionHistory.textContent = "";
    if (res.code !== 0) {
      const err = document.createElement("div");
      err.className = "action-history-empty";
      err.textContent = t("读取失败: {msg}", { msg: res.message || t("未知错误") });
      actionHistory.appendChild(err);
      return;
    }
    const tip = document.createElement("div");
    tip.className = "action-history-tip";
    tip.textContent = (currentActionScope === "project" ? t("以下是项目版本的备份。") : t("以下是全局版本的备份。"))
      + t("每次覆盖或删除都会存入「历史版本」，每份最多保留 {n} 版。", { n: res.data?.keep || 5 });
    actionHistory.appendChild(tip);
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "action-history-empty";
      empty.textContent = t("还没有历史版本");
      actionHistory.appendChild(empty);
      return;
    }
    for (const v of rows) actionHistory.appendChild(createHistoryRow(v));
  } catch (e) {
    actionHistory.textContent = "";
    const err = document.createElement("div");
    err.className = "action-history-empty";
    err.textContent = t("请求失败: {msg}", { msg: e.message });
    actionHistory.appendChild(err);
  }
}

function createHistoryRow(version) {
  const row = document.createElement("div");
  row.className = "action-history-row";

  const label = document.createElement("span");
  label.className = "action-history-ts";
  label.textContent = `${formatHistoryTs(version.ts)} · ${version.bytes} B`;
  row.appendChild(label);

  const viewBtn = document.createElement("button");
  viewBtn.className = "dlg-btn";
  viewBtn.textContent = t("查看");
  viewBtn.addEventListener("click", async () => {
    try {
      const res = await get(`/actions/${encodeURIComponent(currentActionId)}/history/${encodeURIComponent(version.ts)}${actionScopeQuery()}`);
      if (res.code !== 0) { showToast(t("读取失败: {msg}", { msg: res.message })); return; }
      actionEditor.value = res.data?.content || "";
      setActionNote(t("正在查看 {ts} 的历史内容（尚未写入）。改完点「保存」即写回磁盘。", { ts: formatHistoryTs(version.ts) }), "muted");
    } catch (e) {
      showToast(t("请求失败: {msg}", { msg: e.message }));
    }
  });
  row.appendChild(viewBtn);

  const restoreBtn = document.createElement("button");
  restoreBtn.className = "dlg-btn dlg-btn-primary";
  restoreBtn.textContent = t("回滚");
  restoreBtn.addEventListener("click", async () => {
    const inProject = currentActionScope === "project";
    const ok = await dlgConfirm(t("回滚{scope} Action {id} 到 {ts}？当前内容会先存入「历史版本」。", {
      scope: inProject ? t("项目版本") : t("全局版本"), id: currentActionId, ts: formatHistoryTs(version.ts),
    }), { okText: t("回滚"), title: t("回滚 Action") });
    if (!ok) return;
    try {
      const pid = activeProjectId();
      const qs = pid ? `?project=${encodeURIComponent(pid)}` : "";
      const res = await post(`/actions/${encodeURIComponent(currentActionId)}/history/restore${qs}`,
        { ts: version.ts, scope: inProject ? "project" : "global" });
      if (res.code !== 0) { showToast(t("回滚失败: {msg}", { msg: res.message || t("未知错误") })); return; }
      showToast(t("已回滚到 {ts}", { ts: formatHistoryTs(version.ts) }));
      refreshActions();
      renderActionHistory();
      const detail = await get(`/actions/${encodeURIComponent(currentActionId)}${pid ? `?project=${encodeURIComponent(pid)}` : ""}`);
      if (detail.code === 0) actionEditor.value = detail.data?.raw || "";
    } catch (e) {
      showToast(t("请求失败: {msg}", { msg: e.message }));
    }
  });
  row.appendChild(restoreBtn);
  return row;
}

async function toggleActionHistory() {
  if (!currentActionId || !actionExists) return;
  if (!actionHistory.classList.contains("hidden")) {
    actionHistory.classList.add("hidden");
    return;
  }
  await renderActionHistory();
  actionHistory.classList.remove("hidden");
}

function onActionEditorInput() {
  clearTimeout(actionValidateTimer);
  actionValidateTimer = setTimeout(validateActionDraft, 500);
}

function initActionModal() {
  actionModal = document.getElementById("action-modal");
  actionModalTitle = document.getElementById("action-modal-title");
  actionModalMeta = document.getElementById("action-modal-meta");
  actionEditor = document.getElementById("action-editor");
  actionValidateMsg = document.getElementById("action-validate-msg");
  actionHistory = document.getElementById("action-history");
  actionScopeHint = document.getElementById("action-scope-hint");
  btnActionSave = document.getElementById("btn-action-save");
  btnActionDelete = document.getElementById("btn-action-delete");
  btnActionHistory = document.getElementById("btn-action-history");
  btnActionOverride = document.getElementById("btn-action-override");
  if (!actionModal || !actionEditor) return;

  btnActionSave.addEventListener("click", () => saveAction());
  btnActionDelete.addEventListener("click", deleteAction);
  btnActionHistory.addEventListener("click", toggleActionHistory);
  btnActionOverride?.addEventListener("click", saveActionAsProjectOverride);
  actionEditor.addEventListener("input", onActionEditorInput);
  actionModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", () => actionModal.classList.add("hidden"));
  });
}

function createSkillItem(name, desc, kind) {
  const item = document.createElement("div");
  item.className = "skill-item";

  const info = document.createElement("div");
  const nameRow = document.createElement("div");
  nameRow.className = "skill-item-name";
  const badge = document.createElement("span");
  badge.className = "skill-kind-badge" + ((kind === "工具" || kind === "MCP") ? " skill-kind-mcp" : " skill-kind-skill");
  badge.textContent = kind;
  nameRow.appendChild(badge);
  nameRow.appendChild(document.createTextNode(" " + name));
  const descEl = document.createElement("div");
  descEl.className = "skill-item-desc";
  descEl.textContent = desc;
  info.appendChild(nameRow);
  info.appendChild(descEl);
  item.appendChild(info);

  // Skill 支持删除；内置工具不可删除
  if (kind === "Skill") {

    const delBtn = document.createElement("button");
    delBtn.className = "skill-item-del";
    delBtn.title = "删除技能";
    delBtn.textContent = "×";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleDeleteSkill(name);
    });
    item.appendChild(delBtn);
  }

  item.addEventListener("click", () => {
    if (kind === "工具") openSkillModal(name, false);
    else openSkillViewer(name);
  });
  return item;
}

async function handleDeleteSkill(name) {
  if (!await dlgConfirm(t("确定删除技能 {name}？", { name }), { danger: true, okText: "删除" })) return;
  try {
    const res = await del(`/skills/${encodeURIComponent(name)}`);
    showToast(res.code === 0 ? t("已删除技能 {name}", { name }) : t("删除失败: {msg}", { msg: res.message }));
    if (res.code === 0) refreshSkills();
  } catch (e) {
    showToast(t("删除失败: {msg}", { msg: e.message }));
  }
}

// ── 工具执行弹窗 ─────────────────────────────

let currentSkillName = "";

function openSkillModal(name) {
  currentSkillName = name;
  skillModalTitle.textContent = t("执行工具: {name}", { name });
  skillParams.innerHTML = "";
  skillResult.classList.add("hidden");
  skillResult.textContent = "";
  btnRunSkill.classList.remove("hidden");

  const defs = SKILL_PARAM_DEFS[name] || [];
  for (const def of defs) {
    const label = document.createElement("label");
    label.textContent = def.label;

    let input;
    if (def.type === "textarea") {
      input = document.createElement("textarea");
      input.rows = 3;
    } else {
      input = document.createElement("input");
      input.type = def.type;
    }
    input.id = `skill-param-${def.key}`;
    input.placeholder = def.placeholder || "";
    if (def.type === "number") input.value = "30";

    skillParams.appendChild(label);
    skillParams.appendChild(input);
  }

  skillModal.classList.remove("hidden");
}

// ── SKILL.md 技能查看器（只读展示定义内容） ─────────────

async function openSkillViewer(name) {
  skillModalTitle.textContent = t("技能 {name}", { name });
  skillParams.innerHTML = "";
  btnRunSkill.classList.add("hidden");
  skillResult.classList.remove("hidden");
  skillResult.textContent = "读取中…";
  skillModal.classList.remove("hidden");

  try {
    const res = await post("/skills/execute", { skill: name, params: {} });
    if (res.code === 0 && res.data?.content) {
      skillResult.textContent = res.data.content;
    } else {
      skillResult.textContent = t("读取失败: {msg}", { msg: res.message || t("未知错误") });
    }
  } catch (e) {
    skillResult.textContent = t("请求失败: {msg}", { msg: e.message });
  }
}

async function executeSkill() {
  const params = {};

  const defs = SKILL_PARAM_DEFS[currentSkillName] || [];
  for (const def of defs) {
    const el = document.getElementById(`skill-param-${def.key}`);
    if (el) {
      params[def.key] = def.type === "number" ? parseInt(el.value) || 0 : el.value;
    }
  }

  btnRunSkill.disabled = true;
  btnRunSkill.textContent = "执行中…";

  try {
    // 审批门：面板里这条命令是用户自己填、自己点的，所以只拦高危那一类（manual）
    const verdict = await guardSkillCall(currentSkillName, params, { manual: true });
    if (!verdict.ok) {
      skillResult.classList.remove("hidden");
      skillResult.textContent = verdict.message;
      return;
    }
    const res = await post("/skills/execute", { skill: currentSkillName, params });
    skillResult.classList.remove("hidden");
    if (res.code === 0) {
      skillResult.textContent = JSON.stringify(res.data, null, 2);
      // 多模态输出：图片/视频内联预览，文档附查看链接
      if (res.data?.preview_url) {
        const url = res.data.preview_url;
        const name = (res.data.file_path || url).split(/[\\/]/).pop();
        const isImage = /\.(svg|png|jpe?g|webp|gif)$/i.test(name);
        const isVideo = /\.(mp4|webm)$/i.test(name);
        if (isImage) {
          const img = document.createElement("img");
          img.src = url;
          img.className = "skill-result-image";
          skillResult.appendChild(img);
        } else if (isVideo) {
          const video = document.createElement("video");
          video.src = url;
          video.controls = true;
          video.preload = "metadata";
          video.className = "skill-result-video";
          skillResult.appendChild(video);
        } else {
          const link = document.createElement("a");
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener";
          link.className = "skill-result-doc-link";
          setIconText(link, "file", t("查看输出文档：{name}", { name }));
          skillResult.appendChild(link);
        }
      }
    } else {
      skillResult.textContent = t("错误: {msg}", { msg: res.message });
    }
  } catch (e) {
    skillResult.classList.remove("hidden");
    skillResult.textContent = t("请求失败: {msg}", { msg: e.message });
  } finally {
    btnRunSkill.disabled = false;
    btnRunSkill.textContent = "执行";
  }
}

// ── 上传自定义技术───────────────────────────

async function handleUploadSkill() {
  const name = await dlgPrompt("技能名称（英文，如 my-skill）：", { title: "新建技能", placeholder: "my-skill" });
  if (!name || !name.trim()) return;
  const desc = (await dlgPrompt("技能描述：", { title: "新建技能", value: name.trim(), textarea: true })) || name.trim();

  // 创建文件选择器
  const input = document.createElement("input");

  input.type = "file";
  input.multiple = true;
  input.accept = ".md,.py,.js,.json,.yaml,.yml,.sh,.bat";

  input.addEventListener("change", async () => {
    if (!input.files.length) return;
    const formData = new FormData();
    for (const file of input.files) {
      formData.append("files", file);
    }
    formData.append("skill_name", name.trim());
    formData.append("skill_desc", desc.trim());

    try {
      const res = await upload(`/skills/upload?skill_name=${encodeURIComponent(name.trim())}&skill_desc=${encodeURIComponent(desc.trim())}`, formData);
      if (res.code === 0) {
        showToast(t("技能 {name} 上传成功", { name }));
        refreshSkills();
      } else {
        showToast(t("上传失败: {msg}", { msg: res.message }));
      }
    } catch (e) {
      showToast(t("上传失败: {msg}", { msg: e.message }));
    }
  });

  input.click();
}

// ── 导入 SKILL.md 技能（本地路径） ───────────────

async function handleImportSkill() {
  const path = await dlgPrompt("输入本地路径（包含 SKILL.md 的目录，或单个 .md 文件）：", { title: "导入技能", placeholder: "D:\\skills\\my-skill" });
  if (!path || !path.trim()) return;
  const name = (await dlgPrompt("技能名称（留空则自动取目录/文件名）：", { title: "导入技能" })) || "";

  try {
    const res = await post("/skills/import", { path: path.trim(), name });
    if (res.code === 0) {
      showToast(t("技能 {name} 导入成功（{n} 个文件）", { name: res.data.skill, n: res.data.files }));
      refreshSkills();
    } else {
      showToast(t("导入失败: {msg}", { msg: res.message }));
    }
  } catch (e) {
    showToast(t("导入失败: {msg}", { msg: e.message }));
  }
}

// ── 发现已安装插件（Codex/Claude 标准路径） ──────

async function handleDiscoverPlugins() {
  showToast("正在扫描标准插件目录...");
  try {
    const res = await get("/skills/sources");
    if (res.code !== 0) {
      showToast(t("扫描失败: {msg}", { msg: res.message }));
      return;
    }
    const data = res.data;
    const localSkills = data.local_skills || [];
    const codexPlugins = data.codex_plugins || [];
    const total = localSkills.length + codexPlugins.length;

    if (total === 0) {
      showToast("未发现已安装的插件");
      return;
    }

    // 显示发现结果
    let msg = `发现 ${total} 个插件：\n\n`;
    if (localSkills.length) {
      msg += `SKILL.md 技能 (${localSkills.length}):\n`;
      localSkills.forEach(s => { msg += `  - ${s.name}: ${s.description}\n`; });
    }
    if (codexPlugins.length) {
      msg += `\nCodex 插件 (${codexPlugins.length}):\n`;
      codexPlugins.forEach(p => { msg += `  - ${p.name}: ${p.description}\n`; });
    }
    msg += "\n是否导入全部？";

    if (await dlgConfirm(msg, { title: "发现插件", okText: "导入全部", cancelText: "取消" })) {
      let imported = 0;
      for (const skill of localSkills) {
        try {
          const res = await post("/skills/import-path", { path: skill.path, name: skill.name });
          if (res?.code === 0) imported++;
        } catch (e) {}
      }
      for (const plugin of codexPlugins) {
        try {
          const res = await post("/skills/import-path", { path: plugin.path, name: plugin.name });
          if (res?.code === 0) imported++;
        } catch (e) {}
      }
      showToast(`成功导入 ${imported} 个插件`);
      refreshSkills();
    }
  } catch (e) {
    showToast(t("扫描失败: {msg}", { msg: e.message }));
  }
}

// ── 从 GitHub 导入技能 ─────────────────────────

async function handleGithubImport() {
  const url = await dlgPrompt("输入 GitHub 仓库地址：", {
    title: "从 GitHub 导入",
    placeholder: "https://github.com/user/repo 或 user/repo",
  });
  if (!url || !url.trim()) return;

  const subpath = await dlgPrompt("子路径（可选，留空自动查找 SKILL.md）：", {
    title: "从 GitHub 导入",
    placeholder: "path/to/skill",
  });

  showToast("正在下载...");
  try {
    const res = await post("/skills/import-github", { url: url.trim(), subpath: (subpath || "").trim() });
    if (res.code === 0) {
      showToast(t("技能 {name} 导入成功（{n} 个文件）", { name: res.data.name, n: res.data.files }));
      refreshSkills();
    } else {
      showToast(t("导入失败: {msg}", { msg: res.message }));
    }
  } catch (e) {
    showToast(t("导入失败: {msg}", { msg: e.message }));
  }
}

// ── 刷新技能列表 ────────────────────────────

/*
 * 这两份快照按「屏幕上这个项目」的视野取：同名 Action 顶掉全局、被项目掩码关掉的
 * 服务器整个不进清单。换项目时必须重取——留着上一份等于把 A 项目的工具清单画在
 * B 项目的面板上，而面板是用户判断「这一份从哪来」的唯一依据。
 */
function activeProjectQuery() {
  const pid = String(state.project?.project_id || "");
  return pid ? `?project=${encodeURIComponent(pid)}` : "";
}

async function refreshSkills() {
  const res = await get(`/skills${activeProjectQuery()}`);
  if (res.code === 0) {
    setSkills(res.data);
  }
  // 「新功能」那一栏的数据在 /api/evolved（含停用与坏掉的），跟能力清单一起重取：
  // 分两处刷就会有一处留着上一次的样子，而这两处的数字都要对上盘上的文件。
  refreshEvolved();
}

/** Action 目录刷新：读不到就保持空态。这是可选能力，不该在每次开面板时弹错误提示。 */
async function refreshActions() {
  try {
    const res = await get(`/actions${activeProjectQuery()}`);
    if (res.code === 0) setActions(res.data);
  } catch (e) {
    /* 静默：无 Action 与读失败对用户等价，面板已有空态提示 */
  }
}

// ── 初始化 ──────────────────────────────────

function initSkillPanel() {
  skillList = document.getElementById("ext-skill-list");
  toolList = document.getElementById("ext-tool-list");
  mcpToolList = document.getElementById("ext-mcp-tool-list");
  actionList = document.getElementById("ext-action-list");
  initEvolvedModal();
  btnUpload = document.getElementById("btn-upload-skill");
  btnImport = document.getElementById("btn-import-skill");
  skillModal = document.getElementById("skill-modal");
  skillModalTitle = document.getElementById("skill-modal-title");
  skillParams = document.getElementById("skill-params");
  skillResult = document.getElementById("skill-result");
  btnRunSkill = document.getElementById("btn-run-skill");
  btnDiscover = document.getElementById("btn-discover-plugins");
  btnGithubImport = document.getElementById("btn-github-import");

  initActionModal();

  btnUpload.addEventListener("click", handleUploadSkill);
  btnImport.addEventListener("click", handleImportSkill);
  if (btnDiscover) btnDiscover.addEventListener("click", handleDiscoverPlugins);
  if (btnGithubImport) btnGithubImport.addEventListener("click", handleGithubImport);
  btnRunSkill.addEventListener("click", executeSkill);
  // 「＋ 新建 Action」现在是扩展页栏头里的静态按钮（列表容器不再自己造按钮）
  document.getElementById("btn-ext-action-new")?.addEventListener("click", handleCreateAction);
  document.getElementById("btn-ext-evolved-refresh")?.addEventListener("click", refreshEvolved);

  // 关闭弹窗
  skillModal.querySelectorAll(".modal-close, .modal-backdrop").forEach(el => {
    el.addEventListener("click", () => skillModal.classList.add("hidden"));
  });

  subscribe("skills", renderSkillList);
  subscribe("actions", renderSkillList);
  // 换项目＝换视野：这两份快照的"生效版"跟着项目走，不重取会留着上一个项目的清单
  subscribe("project", () => { refreshSkills(); refreshActions(); });

  // 加载技能列表 + Action 目录
  refreshSkills();
  refreshActions();

}

export { initSkillPanel, refreshSkills, refreshActions };
