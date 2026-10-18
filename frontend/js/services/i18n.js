/**
 * 国际化引擎：语言在安装时选定（安装程序写入 data/language.txt），应用内不切换。
 *
 * 机制：
 * - initI18n() 启动时从后端取语言；en 时先全量翻译当前 DOM，再启动 MutationObserver
 *   捕获后续动态插入的内容（toast、弹窗、生成的面板），做到界面文字全覆盖；
 * - 词典以中文原文为键（i18n_dict.js），命中即替换，未命中保持原文；
 * - t(key, vars) 供带变量的动态字符串在调用处使用，支持{var} 占位符；
 * - 模型生成内容与用户输入不翻译（SKIP_SELECTOR / data-i18n-skip 标记）。
 */

import { EN_DICT } from "./i18n_dict.js?v=20261017-001";

let LANG = "zh";
let observer = null;
let observing = false;

// 不翻译的区域：代码块、输入框、消息正文等模型/用户内容
const SKIP_SELECTOR =
  "script, style, textarea, input, pre, code, iframe, canvas, svg, " +
  ".msg-content, .markdown-body, .prompt-result, .skill-result, .risk-command, " +
  "[data-i18n-skip]";

// 属性是界面说明（按钮的 title、输入框的 placeholder），不是用户内容：
// 只有正文容器与显式豁免才连属性一起跳过。否则 <input> 因为"是输入框"就永远不会
// 翻它的 placeholder，英文界面里满屏中文提示——而这批词典键一直是死键。
const SKIP_ATTR_SELECTOR =
  ".msg-content, .markdown-body, .prompt-result, .skill-result, .risk-command, " +
  "[data-i18n-skip]";

const TRANS_ATTRS = ["title", "placeholder", "alt", "aria-label"];

const ZH_RE = /[\u4e00-\u9fff]/;

export const getLang = () => LANG;
export const isEn = () => LANG === "en";

/** 带变量翻译：zh 原样返回；en 查词典并替换 {var} 占位符 */
export function t(key, vars) {
  let s = LANG === "en" ? (EN_DICT[key] ?? key) : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** 单段文本翻译：保留前后空白，仅替换中间命中词典的中文 */
function translateText(s) {
  const trimmed = s.trim();
  if (!trimmed || !ZH_RE.test(trimmed)) return s;
  const hit = EN_DICT[trimmed];
  return hit ? s.replace(trimmed, hit) : s;
}

function skipped(el) {
  if (!el || el.nodeType !== 1) return false;
  return el.matches(SKIP_SELECTOR) || !!el.closest(SKIP_SELECTOR);
}

function attrSkipped(el) {
  if (!el || el.nodeType !== 1) return false;
  return el.matches(SKIP_ATTR_SELECTOR) || !!el.closest(SKIP_ATTR_SELECTOR);
}

/** 只翻属性：控件的说明文字，与它里面装的是什么内容无关 */
function translateAttrs(el) {
  if (attrSkipped(el)) return;
  for (const a of TRANS_ATTRS) {
    const v = el.getAttribute(a);
    if (v && ZH_RE.test(v)) {
      const nv = translateText(v);
      if (nv !== v) el.setAttribute(a, nv);
    }
  }
}

/** 翻译元素子树：文本节点 + 可翻译属性 */
function translateNode(root) {
  if (!root) return;
  if (root.nodeType === 3) {
    if (root.parentElement && skipped(root.parentElement)) return;
    const nv = translateText(root.data);
    if (nv !== root.data) root.data = nv;
    return;
  }
  if (root.nodeType !== 1) return;
  translateAttrs(root);
  if (skipped(root)) return;

  // 文本节点
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    if (!ZH_RE.test(n.data)) continue;
    if (n.parentElement && skipped(n.parentElement)) continue;
    const nv = translateText(n.data);
    if (nv !== n.data) n.data = nv;
  }

  // 子元素属性：判的是"这段是不是用户/模型内容"，不是"这个控件会不会装用户输入"
  const els = root.querySelectorAll("[title], [placeholder], [alt], [aria-label]");
  for (const el of els) translateAttrs(el);
}

/** 启动：拉取语言配置；en 时翻译全页并监听后续 DOM 变更 */
export async function initI18n() {
  try {
    const r = await fetch("/api/i18n/lang");
    const d = await r.json();
    LANG = d?.data?.lang === "en" ? "en" : "zh";
  } catch (e) {
    LANG = "zh";
  }
  document.documentElement.classList.remove("i18n-pending");
  if (LANG !== "en") return LANG;

  document.documentElement.lang = "en";
  translateNode(document.documentElement);

  observer = new MutationObserver((mutations) => {
    if (observing) return;
    observing = true;
    try {
      for (const m of mutations) {
        for (const n of m.addedNodes) translateNode(n);
        if (m.type === "characterData" && ZH_RE.test(m.target.data || "")) {
          translateNode(m.target);
        }
        if (m.type === "attributes" && m.target.nodeType === 1) {
          if (TRANS_ATTRS.includes(m.attributeName)) translateAttrs(m.target);
        }
      }
    } finally {
      observing = false;
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANS_ATTRS,
  });
  return LANG;
}
