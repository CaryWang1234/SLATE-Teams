/**
 * SLATE 文件图标：基于 vscode-icons 图标库（MIT，https://github.com/vscode-icons/vscode-icons）
 * 图标 SVG 已本地化到 frontend/icons/vscode/，零运行时依赖、桌面版离线可用
 * 文件夹与未识别类型用手写 SVG 兜底；供项目文件树、文件预览标题、聊天附件 chip 共用
 */

// ── 兜底图形（文件夹 / 未知类型，颜色随 CSS currentColor 统一） ─

function doc(color) {
  return `<svg class="file-type-icon file-icon-fallback" width="__SIZE__" height="__SIZE__" viewBox="0 0 16 16" fill="none" aria-hidden="true">` +
    `<path d="M3.5 1.5h5.8l3.2 3.2V13a1.5 1.5 0 0 1-1.5 1.5H3.5A1.5 1.5 0 0 1 2 13V3a1.5 1.5 0 0 1 1.5-1.5z" ` +
    `fill="none" stroke="currentColor" stroke-width="1.1"/>` +
    `<path d="M9.3 1.5v3.2h3.2" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>`;
}

function folder(size) {
  return `<svg class="file-type-icon file-icon-fallback" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true">` +
    `<path d="M1.5 3.2c0-.7.5-1.2 1.2-1.2h3.1l1.6 1.7h5.9c.7 0 1.2.5 1.2 1.2v7.9c0 .7-.5 1.2-1.2 1.2H2.7c-.7 0-1.2-.5-1.2-1.2V3.2z" fill="currentColor"/>` +
    `<path d="M1.5 5.5h13" stroke="rgba(0,0,0,0.18)" stroke-width="1"/></svg>`;
}

// ── 类型映射（vscode-icons 图标文件名） ───────

const ICON_BY_EXT = {
  js: "file_type_js", mjs: "file_type_js", cjs: "file_type_js",
  jsx: "file_type_reactjs",
  ts: "file_type_typescript", tsx: "file_type_reactts",
  py: "file_type_python",
  html: "file_type_html", htm: "file_type_html",
  css: "file_type_css", scss: "file_type_scss", less: "file_type_less",
  json: "file_type_json",
  md: "file_type_markdown", markdown: "file_type_markdown",
  yml: "file_type_yaml", yaml: "file_type_yaml",
  toml: "file_type_toml", ini: "file_type_ini",
  conf: "file_type_config", env: "file_type_dotenv",
  sh: "file_type_shell", bash: "file_type_shell", zsh: "file_type_shell",
  bat: "file_type_bat", cmd: "file_type_bat",
  ps1: "file_type_powershell",
  png: "file_type_image", jpg: "file_type_image", jpeg: "file_type_image",
  gif: "file_type_image", webp: "file_type_image", bmp: "file_type_image", ico: "file_type_image",
  svg: "file_type_svg",
  pdf: "file_type_pdf",
  zip: "file_type_zip", rar: "file_type_zip", "7z": "file_type_zip",
  tar: "file_type_zip", gz: "file_type_zip",
  sql: "file_type_sql",
  c: "file_type_c", h: "file_type_cheader",
  cpp: "file_type_cpp", cc: "file_type_cpp", cxx: "file_type_cpp", hpp: "file_type_cppheader",
  java: "file_type_java", go: "file_type_go", rs: "file_type_rust",
  rb: "file_type_ruby", php: "file_type_php",
  txt: "file_type_text", log: "file_type_log", csv: "file_type_excel",
  xml: "file_type_xml",
};

// 按完整文件名匹配（无扩展名的特殊文件）
const ICON_BY_NAME = {
  ".gitignore": "file_type_git",
  ".gitattributes": "file_type_git",
  "license": "file_type_license",
  "dockerfile": "file_type_docker",
};

const LANG_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", html: "xml", htm: "xml", xml: "xml",
  css: "css", scss: "scss", less: "less",
  json: "json", md: "markdown", markdown: "markdown",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini",
  sh: "bash", bash: "bash", zsh: "bash", bat: "dos", cmd: "dos", ps1: "powershell",
  sql: "sql", c: "c", h: "c", cpp: "cpp", java: "java", go: "go",
  rs: "rust", rb: "ruby", php: "php", dockerfile: "dockerfile",
  txt: "plaintext", log: "plaintext", csv: "plaintext", env: "plaintext",
};

// ── 对外接口 ──────────────────────────────

function splitName(name) {
  const lower = String(name || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return { lower, ext: dot > 0 ? lower.slice(dot + 1) : "" };
}

/**
 * 返回文件的图标 HTML 字符串（vscode-icons SVG 以 img 引入，避免多实例 id 冲突）
 * @param {string} name 文件名
 * @param {object} opts { dir: boolean, size: number }
 */
function fileTypeIcon(name, { dir = false, size = 14 } = {}) {
  if (dir) return folder(size);
  const { lower, ext } = splitName(name);
  const icon = ICON_BY_NAME[lower] || ICON_BY_EXT[ext];
  if (icon) {
    return `<img class="file-type-icon" src="icons/vscode/${icon}.svg" width="${size}" height="${size}" alt="" draggable="false">`;
  }
  return doc("#8A8A8A").replace(/__SIZE__/g, String(size));
}

/** 扩展名 → highlight.js 语言标识（无法识别返回 ""） */
function extToLang(name) {
  const { lower, ext } = splitName(name);
  return LANG_BY_EXT[lower] || LANG_BY_EXT[ext] || "";
}

export { fileTypeIcon, extToLang };
