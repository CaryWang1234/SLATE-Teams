/**
 * 自定义主题：用户只填四个源色（底色 / 面板 / 正文 / 强调）+ 两个不透明度，
 * 其余配色令牌由这里推导，拼成一段只在 html[data-custom-theme="1"] 作用域里生效的 CSS 注入 <head>。
 *
 * 为什么是"推导"而不是"每个令牌都能改"：style.css 里颜色令牌有三十几个，逐个开放会把
 * 设置页变成一张表格，而且用户改一个 --text-secondary 很容易改出对比度不足的四不像。
 * 源色只有四个，剩下的按亮度与对比度算出来，既保证成套又保证正文层级读得清。
 *
 * 关掉自定义主题时这里会把整段样式和两个 data 属性一起摘掉，一个像素都不留——
 * 明暗切换（setTheme）在生效期间被 store.js 挡住，两套色不会同时说话。
 */
import { API_BASE, IMPORTED_FONT_ID_RE } from "../store.js?v=20261017-001";
import { get, post, del } from "./api.js?v=20261017-001";

const STYLE_ID = "slate-custom-theme";

// ── 颜色工具 ────────────────────────────────

function hexToRgb(hex) {
  const s = String(hex || "").trim().replace("#", "");
  if (s.length !== 6 || /[^0-9A-Fa-f]/.test(s)) return [0, 0, 0];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function channel(v) {
  const toHex = Math.max(0, Math.min(255, Math.round(v))).toString(16);
  return toHex.length === 1 ? `0${toHex}` : toHex;
}

function rgbToHex(rgb) {
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`.toUpperCase();
}

/** 按权重 wb 把 b 混进 a（wb=0 得到 a，wb=1 得到 b） */
function mix(a, b, wb) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex([A[0] + (B[0] - A[0]) * wb, A[1] + (B[1] - A[1]) * wb, A[2] + (B[2] - A[2]) * wb]);
}

function channelLum(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** 相对亮度（WCAG 定义），0 最暗 1 最亮 */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
}

/** 两色的对比度（1..21） */
export function contrastRatio(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 把文字色按 alpha 压在底色上，算出实际看到的那个色 */
function blended(ink, bg, alpha) {
  return mix(bg, ink, alpha);
}

/** 从 start 这个透明度起步，不够读就往不透明方向加，直到达到 minRatio */
function alphaFor(ink, bg, start, minRatio) {
  let a = start;
  while (a < 1 && contrastRatio(blended(ink, bg, a), bg) < minRatio) a = Math.min(1, Math.round((a + 0.04) * 100) / 100);
  return Math.round(a * 100) / 100;
}

/**
 * 强调色要能当正文用（链接、金色标题、选中态都读它），对比不足就往远离底色的方向压。
 * "远离"要按底色算，不能按强调色自己算：拿 #FFFFFF 配浅底时，比亮度得到的方向是"往白里混"，
 * 混 twelve 次还是白，对比度卡在 1.05 出不来——浅底上的纯白强调色就是这么糊掉的。
 */
function accentFor(accent, bg, minRatio) {
  let c = accent;
  const toward = contrastRatio("#000000", bg) >= contrastRatio("#FFFFFF", bg) ? "#000000" : "#FFFFFF";
  for (let i = 0; i < 12 && contrastRatio(c, bg) < minRatio; i++) c = mix(c, toward, 0.12);
  return c;
}

/**
 * 给定一个填充色，选近黑还是近白当上面的文字。
 * 按实测对比度挑，不靠"亮度过半就换"这种阈值——中亮度那一带（比如 #58A6D8 这种蓝）
 * 用白字对比只有 2.6，肉眼就是"选中态看不清"。
 */
function inkOrPaper(color) {
  const dark = "#1A1A1A", light = "#FFFFFF";
  return contrastRatio(dark, color) >= contrastRatio(light, color) ? dark : light;
}

/** 色相与饱和度（HSV 口径），只用来把文件图标的滤镜对准用户挑的强调色 */
function hsvOf(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const sat = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { hue: (h * 60 + 360) % 360, sat };
}

/**
 * 项目栏那批 vscode 图标是多色 <img>，不能靠 currentColor 换色，只能用滤镜压。
 * 先把它们去色，再用 sepia 起一个底色、hue-rotate 转到强调色的色相上——sepia 的基准色相
 * 约 40°，所以旋转量要减掉它，否则每种强调色都会偏成同一个暖黄。
 * 饱和度跟着用户挑的色走：近灰的强调色（石墨那种）只压出很淡的色，鲜艳的才明显上色。
 */
function fileIconFilter(accent, isDark) {
  const { hue, sat } = hsvOf(accent);
  const rot = Math.round((hue - 40 + 360) % 360);
  const saturate = (1 + Math.min(sat, 0.8) * 1.5).toFixed(2);
  const brightness = isDark ? 1.15 : 0.85;
  return `grayscale(1) sepia(1) saturate(${saturate}) hue-rotate(${rot}deg) brightness(${brightness})`;
}

// ── 令牌推导 ────────────────────────────────

// 深色/浅色两套语义色（危险 / 完成 / 需要操作）：跟随内置主题的做法，按底色亮度整组切换，
// 不跟着用户的强调色走——红色报错误、绿色报完成是跨主题的固定约定，换掉会让人认不出状态。
const SEMANTIC_LIGHT = { danger: "#C0392B", ok: "#2D6A3F", needs: "#9A5B12", night: "#6E4E9E" };
const SEMANTIC_DARK = { danger: "#E2725B", ok: "#6FBF9A", needs: "#E0A94A", night: "#A98BE0" };

/** 不透明度归一：只认 0..1 之间的有限数，其余（缺省、脏值、1）都按"完全不透明"走 */
function clampAlpha(value) {
  return Number.isFinite(value) && value > 0 && value < 1 ? value : 1;
}

/**
 * 四个源色 + 两个不透明度 → 整套颜色令牌。
 *
 * veil 是底色压在背景图上的不透明度（0..1），只有铺图时才 <1；panelAlpha 是"板块"
 * （面板 / 卡片 / 输入框 / 助手气泡）自己的不透明度，100% 时传 1。
 *
 * 两条规则：① --bg 只跟着 veil 走——不铺图时把 --bg 做半透明，透出来的是窗口外头，
 * 那是穿帮不是通透；② 板块取 min(veil, panelAlpha)，铺图时不会两层各降一档把面板洗没，
 * 不铺图时 veil 视作 1，于是 panelAlpha=1 与旧行为逐字节相同。
 */
export function deriveTokens(colors, veil, panelAlpha) {
  const bg = colors.bg, panel = colors.panel, ink = colors.text;
  const isDark = luminance(bg) < 0.45;
  const sem = isDark ? SEMANTIC_DARK : SEMANTIC_LIGHT;
  const accent = accentFor(colors.accent, bg, 4.5);
  const bgAlpha = clampAlpha(veil);
  const surfaceAlpha = Math.min(bgAlpha, clampAlpha(panelAlpha));
  const over = (color, a) => (a < 1 ? rgba(color, a) : color);

  // 面板/输入/卡片：浅色往白提、深色往白提一点点，保持"浮在面板上"的层次
  const inputUp = isDark ? 0.05 : 0.92;
  const cardUp = isDark ? 0.035 : 0.85;
  const bgAlt = over(panel, surfaceAlpha);
  // 代码块在任何主题下都是深底亮字：正文读的是长句，代码要一眼和正文分开
  const codeBg = isDark ? mix(bg, "#FFFFFF", 0.06) : mix(ink, "#000000", 0.12);
  const toastBg = isDark ? mix(accent, "#FFFFFF", 0.10) : ink;

  return {
    "--bg": over(bg, bgAlpha),
    "--bg-alt": bgAlt,
    "--bg-input": over(mix(panel, "#FFFFFF", inputUp), surfaceAlpha),
    "--bg-card": over(mix(panel, "#FFFFFF", cardUp), surfaceAlpha),
    "--text": ink,
    "--text-secondary": rgba(ink, alphaFor(ink, bg, isDark ? 0.74 : 0.80, 4.5)),
    "--text-muted": rgba(ink, alphaFor(ink, bg, isDark ? 0.56 : 0.68, 4.5)),
    "--text-faint": rgba(ink, alphaFor(ink, bg, isDark ? 0.30 : 0.40, 2.5)),
    "--border": rgba(ink, isDark ? 0.20 : 0.13),
    "--border-hover": isDark ? mix(accent, "#FFFFFF", 0.18) : ink,
    "--accent-bg": isDark ? accent : ink,
    // 填充上的文字永远取实色纸底：底图开着时 --bg 是半透明的，不能拿它当字色
    "--accent-fg": bg,
    "--accent": accent,
    "--gold": accent,
    "--gold-dim": rgba(colors.accent, isDark ? 0.12 : 0.08),
    "--gold-strong": isDark ? accent : mix(accent, "#000000", 0.18),
    // 项目栏文件图标（多色 <img> 与兜底描边）跟着这套调色板走，见 style.css 里那两条 filter/color
    "--file-icon-color": accent,
    "--file-icon-filter": fileIconFilter(accent, isDark),
    "--code-bg": codeBg,
    "--code-fg": mix(codeBg, "#FFFFFF", 0.82),
    "--inline-code-bg": rgba(ink, isDark ? 0.12 : 0.06),
    "--msg-user-bg": isDark ? mix(bg, "#FFFFFF", 0.09) : ink,
    "--msg-user-fg": isDark ? ink : bg,
    "--msg-asst-bg": bgAlt,
    "--selection-bg": accent,
    "--selection-fg": inkOrPaper(accent),
    "--scrollbar-thumb": rgba(ink, isDark ? 0.24 : 0.17),
    "--board-grid": isDark ? mix(bg, "#FFFFFF", 0.07) : mix(bg, "#000000", 0.06),
    "--modal-backdrop": isDark ? "rgba(0, 0, 0, 0.66)" : rgba(ink, 0.34),
    "--toast-bg": toastBg,
    "--toast-fg": inkOrPaper(toastBg),
    "--danger": sem.danger,
    "--danger-dim": rgba(sem.danger, isDark ? 0.14 : 0.08),
    "--ok": sem.ok,
    "--ok-dim": rgba(sem.ok, isDark ? 0.14 : 0.10),
    "--task-needs": sem.needs,
    "--task-needs-dim": rgba(sem.needs, isDark ? 0.16 : 0.10),
    // 夜间模式那档的夜紫：与危险色同一个待遇——跨主题的固定语义色，不跟用户的强调色走
    "--night": sem.night,
    "--night-dim": rgba(sem.night, isDark ? 0.14 : 0.10),
    // 模型品牌 mark 的取色（见 style.css 的 --mark-neutral 注释）：只管没有彩色原件的那 11 家
    // （openai / anthropic / grok / zai …，它们走 currentColor）。写死两只中性灰，只按色板推出来的明暗
    // 分叉——用户挑什么墨色/强调色都不参与，否则品牌标会被染成主题色；有彩色版的那 47 家不受影响。
    "--mark-neutral": isDark ? "#949AA4" : "#6E7480",
  };
}

// ── 字体：系统字体族 + 用户自己导入的字体文件 ──────────
//
// 内置这五/六个是"系统里已有的字体族"，只写 font-family 名字；导入的字体走 @font-face，
// 文件存在本机 data/theme/fonts/（见 backend/routers/theme.py），状态里只留 id + 标签。
// RULES.md §8 的"不引字体文件"指的是不随包带——用户自己拖进来的文件不进仓库、不进安装包，
// 所以这条边界仍然守得住。

export const THEME_FONTS_MAIN = [
  { id: "", label: "跟随系统", stack: "" },
  { id: "yahei", label: "微软雅黑", stack: '"Microsoft YaHei", "微软雅黑", sans-serif' },
  { id: "pingfang", label: "苹方", stack: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif' },
  { id: "sourcehan", label: "思源黑体", stack: '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif' },
  { id: "arial", label: "Arial", stack: 'Arial, Helvetica, "Microsoft YaHei", sans-serif' },
  { id: "georgia", label: "Georgia 衬线", stack: 'Georgia, "Times New Roman", "Songti SC", serif' },
];

export const THEME_FONTS_CODE = [
  { id: "", label: "跟随系统", stack: "" },
  { id: "consolas", label: "Consolas", stack: 'Consolas, "Courier New", monospace' },
  { id: "jbm", label: "JetBrains Mono", stack: '"JetBrains Mono", Consolas, "Courier New", monospace' },
  { id: "cascadia", label: "Cascadia Code", stack: '"Cascadia Code", Consolas, monospace' },
  { id: "menlo", label: "Menlo / Monaco", stack: 'Menlo, Monaco, Consolas, monospace' },
];

// 导入的字体排在系统字体之前，但后面必须接一段兜底：换一台没这个文件的机器时，
// 字要照样落得下来，而不是变成一个谁都没见过的家庭名。
const FONT_TAIL_MAIN = '"Microsoft YaHei", sans-serif';
const FONT_TAIL_CODE = 'Consolas, "Courier New", monospace';

/** 由校验过的 id 拼出来的家庭名。标签（用户起的文件名）永远不进这里——它可能带引号。 */
export function importedFontFamily(id) {
  return `SLATE Font ${id}`;
}

/** 这个 id 像不像"导入的字体"。形状与后端 _FONT_ID_RE 同源：f + 内容哈希 10 位。 */
export function isImportedFontId(id) {
  return IMPORTED_FONT_ID_RE.test(String(id || ""));
}

function fontStack(list, id, imported, tail) {
  const hit = list.find(item => item.id === id);
  if (hit) return hit.stack;
  const fid = String(id || "");
  if (!isImportedFontId(fid)) return "";
  // 账上没有这个 id 就不认：状态可能从另一台设备同步来一份本地从没导入过的选择
  if (!(imported || []).some(item => item?.id === fid)) return "";
  return `"${importedFontFamily(fid)}", ${tail}`;
}

// ── 预设：一套源色 + 可选字体，点一下整份填进色板 ──────────────

export const THEME_PRESETS = [
  { id: "paper", name: "簿纸", colors: { bg: "#F1F1EF", panel: "#E6E6E3", text: "#191A1C", accent: "#97342A" }, fonts: { main: "", code: "" } },
  { id: "goldnight", name: "墨夜", colors: { bg: "#17181B", panel: "#1D1E22", text: "#E4E4E6", accent: "#CC7466" }, fonts: { main: "", code: "" } },
  { id: "mistblue", name: "雾蓝", colors: { bg: "#F5F8FA", panel: "#E8F0F6", text: "#1F2A33", accent: "#2F6DA8" }, fonts: { main: "", code: "" } },
  { id: "seadeep", name: "深海", colors: { bg: "#0B1220", panel: "#131D2E", text: "#CFE0F2", accent: "#58A6D8" }, fonts: { main: "", code: "" } },
  { id: "pine", name: "松墨", colors: { bg: "#0F1512", panel: "#17211C", text: "#D6E2D9", accent: "#6FBF9A" }, fonts: { main: "", code: "" } },
  { id: "moss", name: "苔绿", colors: { bg: "#F6F7F0", panel: "#E9EDDC", text: "#26301E", accent: "#5B7A2A" }, fonts: { main: "", code: "" } },
  { id: "clay", name: "陶土", colors: { bg: "#FBF4EF", panel: "#F3E4DA", text: "#33231C", accent: "#A85A38" }, fonts: { main: "", code: "" } },
  { id: "plum", name: "暮紫", colors: { bg: "#F7F4FA", panel: "#EDE6F5", text: "#2A2233", accent: "#6E4E9E" }, fonts: { main: "", code: "" } },
  { id: "graphite", name: "石墨", colors: { bg: "#1A1C1E", panel: "#232629", text: "#DDE1E5", accent: "#B9C4CE" }, fonts: { main: "", code: "" } },
  { id: "paperprint", name: "铅字", colors: { bg: "#FFFFFF", panel: "#F1F1F1", text: "#1A1A1A", accent: "#37507A" }, fonts: { main: "georgia", code: "consolas" } },
];

export function presetOf(id) {
  return THEME_PRESETS.find(item => item.id === id) || null;
}

// ── 背景图：文件只存在本机 data/theme/，状态里只留开关与缓存串 ──

// 探测到的图（存在与否、多大、mtime 缓存串）。图不在本机时不铺那层，避免半透明底色压在空气上。
let bgImage = { exists: false, stamp: 0, bytes: 0 };

function digitsOnly(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

export function backgroundUrl(stamp) {
  return `${API_BASE}/theme/background?v=${digitsOnly(stamp || bgImage.stamp)}`;
}

export async function probeBackground() {
  try {
    const res = await get("/theme/background/status");
    const data = res?.data || {};
    bgImage = {
      exists: data.exists === true,
      stamp: Number(digitsOnly(data.stamp)) || 0,
      bytes: Number(digitsOnly(data.bytes)) || 0,
    };
  } catch {
    bgImage = { exists: false, stamp: 0, bytes: 0 };
  }
  return { ...bgImage };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读不出这个文件"));
    reader.readAsDataURL(file);
  });
}

/** 换背景图：整张图走 base64 交给后端落盘，成功后把缓存串更新到新图 */
export async function uploadBackground(file) {
  const dataUrl = await readFileAsDataUrl(file);
  if (!dataUrl) throw new Error("图片读取为空");
  const res = await post("/theme/background", { data: dataUrl });
  bgImage = {
    exists: true,
    stamp: Number(digitsOnly(res?.data?.stamp)) || Date.now(),
    bytes: Number(digitsOnly(res?.data?.bytes)) || 0,
  };
  return { bytes: bgImage.bytes, ext: res?.data?.ext || "" };
}

export async function removeBackground() {
  await del("/theme/background");
  bgImage = { exists: false, stamp: 0, bytes: 0 };
}

// ── Wallpaper Engine：把 WE 当前壁纸的预览图取过来当背景图 ──
//
// 后端只读 WE 写在自己目录里的 config.json 与同目录的 preview.*：不启动它、也不改它的设置。
// 取回来的图走的就是背景图那一条通道（同一份 data/theme/background.*、同一个缓存串、
// 同一个「铺在界面上」开关），所以这里不需要新状态——颜色面板与遮罩浓度照常作用在它上面。

export async function probeWallpaperEngine() {
  try {
    const res = await get("/theme/wallpaper-engine/status");
    const data = res?.data || {};
    return {
      installed: data.installed === true,
      reason: String(data.reason || ""),
      monitors: Array.isArray(data.monitors) ? data.monitors : [],
    };
  } catch {
    // 问不到不等于"没装"：后端起来之后还要再问一次
    return { installed: false, reason: "unreachable", monitors: [] };
  }
}

/** 取 WE 当前壁纸的预览图：成功后本机那张背景图就是它，缓存串与大小一起更新 */
export async function pullWallpaperEngineBackground() {
  const res = await post("/theme/wallpaper-engine/background", {});
  bgImage = {
    exists: true,
    stamp: Number(digitsOnly(res?.data?.stamp)) || Date.now(),
    bytes: Number(digitsOnly(res?.data?.bytes)) || 0,
  };
  // monitor 是 "Monitor1" 这种串：只留数字再进 DOM，标签里不带上后端发来的任何字母
  return { bytes: bgImage.bytes, monitor: digitsOnly(res?.data?.monitor) };
}

// ── 导入的字体：文件只存在本机 data/theme/fonts/，状态里只留 id + 标签 ──

// 字体上限与后端 theme.py 的 MAX_FONT_BYTES 同一个数
export const MAX_FONT_BYTES = 16 * 1024 * 1024;

/**
 * 本机实际存着的字体：{ ids: Set, sizes: Map<id, bytes> }；null = 还没问过后端。
 *
 * 为什么要单独问一遍：状态里的 fonts.imported 记的是"用户导入过哪些"，可能来自另一台设备，
 * 也可能是装机版重装之后 data/ 已经空了。认不出来的 id 就不发 @font-face——
 * 发了一条 src 指向 404 的 @font-face，浏览器会红在控制台里，还让人以为字体坏了。
 */
let fontIndex = null;

export function fontUrl(id) {
  return `${API_BASE}/theme/font/${id}`;
}

export async function probeFonts(force = false) {
  if (fontIndex === null || force === true) {
    try {
      const res = await get("/theme/fonts");
      const items = Array.isArray(res?.data?.items) ? res.data.items : [];
      const ids = new Set();
      const sizes = new Map();
      for (const item of items) {
        const id = String(item?.id || "");
        if (!isImportedFontId(id)) continue;
        ids.add(id);
        sizes.set(id, Math.max(0, Math.round(Number(item?.bytes) || 0)));
      }
      fontIndex = { ids, sizes };
    } catch {
      // 问不出来不当成"本机没有"存下来：下次生效主题再问一遍
      return null;
    }
  }
  return fontIndex;
}

/** 这一份主题里被选中的导入字体 id（正文 + 代码，去重、只认形状合法的） */
export function usedFontIds(theme) {
  const out = new Set();
  for (const id of [theme?.fonts?.main, theme?.fonts?.code]) {
    if (isImportedFontId(id)) out.add(String(id));
  }
  return out;
}

/** 导入一个字体文件：整份走 base64 交给后端落盘，成功后刷新本机清单 */
export async function uploadFont(file) {
  const dataUrl = await readFileAsDataUrl(file);
  if (!dataUrl) throw new Error("字体读取为空");
  const res = await post("/theme/font", { data: dataUrl, name: file?.name || "" });
  const id = String(res?.data?.id || "");
  if (!isImportedFontId(id)) throw new Error("后端没给出合法的字体 id");
  await probeFonts(true);
  return { id, label: String(res?.data?.label || ""), bytes: Math.round(Number(res?.data?.bytes) || 0) };
}

export async function removeFont(id) {
  if (!isImportedFontId(id)) return false;
  await del(`/theme/font/${id}`);
  await probeFonts(true);
  return true;
}

// ── 注入 ────────────────────────────────────

/**
 * 一条 @font-face。不写 format()：文件自己带魔数，浏览器认得出来；
 * 写错 format() 反而会让 Chrome 直接拒用这个字体，变成一个查不出原因的"字体没生效"。
 */
function fontFaceRule(id) {
  return "@font-face {\n"
    + `  font-family: "${importedFontFamily(id)}";\n`
    + `  src: url("${fontUrl(id)}");\n`
    + "  font-display: swap;\n"
    + "}\n";
}

/**
 * 生成那段 CSS。选择器要带上 data-theme 的两种取值：style.css 里
 * html[data-ui="codex"][data-theme="dark"] 这类规则的特异度是 (0,2,1)，
 * 只写 html[data-custom-theme="1"] 会在通用 UI 模式的深色下被它盖住。
 *
 * options：imageReady=本机有没有背景图；fontIds=本机实际存着的导入字体 id 集合。
 */
export function buildThemeCss(theme, options = {}) {
  const imageReady = options.imageReady === true;
  const veil = imageReady ? (theme.background.veil || 72) / 100 : 1;
  const panelAlpha = (theme.opacity?.panel || 100) / 100;
  const tokens = deriveTokens(theme.colors, veil, panelAlpha);
  const lines = Object.entries(tokens).map(([key, value]) => `  ${key}: ${value};`);

  const imported = Array.isArray(theme.fonts.imported) ? theme.fonts.imported : [];
  const mainStack = fontStack(THEME_FONTS_MAIN, theme.fonts.main, imported, FONT_TAIL_MAIN);
  const codeStack = fontStack(THEME_FONTS_CODE, theme.fonts.code, imported, FONT_TAIL_CODE);
  if (mainStack) lines.push(`  --font-main: ${mainStack};`);
  if (codeStack) {
    lines.push(`  --font-code: ${codeStack};`);
    lines.push("  --font-mono: var(--font-code);");
  }

  const selector = [
    'html[data-custom-theme="1"][data-theme="light"]',
    'html[data-custom-theme="1"][data-theme="dark"]',
    'html[data-custom-theme="1"]',
  ].join(",\n");

  // @font-face 只发"被选中且本机真有文件"的那一两条：没被选中的导入字体不该在启动时占带宽
  const onDisk = options.fontIds instanceof Set ? options.fontIds : new Set();
  let faces = "";
  for (const id of usedFontIds(theme)) {
    if (onDisk.has(id)) faces += fontFaceRule(id);
  }

  let css = `${faces}${selector} {\n${lines.join("\n")}\n}`;
  if (imageReady) {
    // 图压在 html 自己的底色之上、所有面板之下：负 z-index 的伪元素就走这个层位，
    // 面板因此要半透明才看得见它——上面的 deriveTokens 已经把 --bg 那一组换成带 alpha 的值。
    css += `\nhtml[data-custom-bg="1"]::before {\n`
      + "  content: \"\";\n"
      + "  position: fixed;\n"
      + "  inset: 0;\n"
      + "  z-index: -1;\n"
      + `  background: url("${backgroundUrl()}") center / cover no-repeat;\n`
      + "}\n";
  }
  return css;
}

function styleEl() {
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  return el;
}

function clearInjected() {
  const el = document.getElementById(STYLE_ID);
  if (el) el.remove();
  const root = document.documentElement;
  root.removeAttribute("data-custom-theme");
  root.removeAttribute("data-custom-bg");
}

/**
 * 生效一次自定义主题。返回 {active, imageReady, fontReady}：
 * imageReady 为假说明本机没有那张图（或后端没起来），这时配色照常生效但不铺底图，
 * 免得底色变成半透明压在一片空白上；fontReady 是"选中的导入字体本机都有文件"，
 * 没有时家庭名照样写进 font-family，但浏览器会落到栈后面的系统字体。
 */
export async function applyCustomTheme(theme) {
  if (!theme || theme.enabled !== true) {
    clearInjected();
    return { active: false, imageReady: false, fontReady: false };
  }
  let imageReady = false;
  if (theme.background && theme.background.enabled === true) {
    // 每次生效都重新探测：图可能被另一台设备删了，也可能刚在这台机器上换过一张
    imageReady = (await probeBackground()).exists;
  }
  // 只有真的选了导入字体才去问后端：没选时一次请求都不该多发，拖一下颜色滑块不该打网络
  const wanted = usedFontIds(theme);
  const index = wanted.size ? await probeFonts() : null;
  const fontIds = index ? index.ids : new Set();
  const fontReady = wanted.size > 0 && [...wanted].every(id => fontIds.has(id));
  styleEl().textContent = buildThemeCss(theme, { imageReady, fontIds });
  const root = document.documentElement;
  root.setAttribute("data-custom-theme", "1");
  if (imageReady) root.setAttribute("data-custom-bg", "1");
  else root.removeAttribute("data-custom-bg");
  return { active: true, imageReady, fontReady };
}

export { STYLE_ID as CUSTOM_THEME_STYLE_ID };
