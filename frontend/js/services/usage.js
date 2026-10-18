/**
 * SLATE 用量数字工具：token 格式化与趣味等价换算
 * 供聊天用量条悬浮弹窗与设置页用量统计共用
 */

import { t } from "./i18n.js?v=20261017-001";

// 等价物阶梯（token 数为约值）：中文按 1.5 字约 1 token 粗估
// base 为不带量词的名称，拼接格式统一为 "一{unit}{base}" / "{count} {unit}{base}"
const EQUIV_LADDER = [
  { tokens: 40, base: "《静夜思》", unit: "首" },
  { tokens: 150, base: "微博", unit: "条" },
  { tokens: 800, base: "中学作文", unit: "字" },
  { tokens: 3000, base: "深度长文", unit: "篇" },
  { tokens: 23000, base: "《老人与海》", unit: "本" },
  { tokens: 150000, base: "《三体》", unit: "本" },
  { tokens: 500000, base: "《红楼梦》", unit: "本" },
];

/** token 数格式化：1234 -> 1.2K，百万级 -> 1.5M */
function fmtTokens(n) {
  n = Math.max(0, Math.round(n || 0));
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toLocaleString();
}

/** 趣味等价换算；不足一个参照物时返回短提示，由调用方展示 */
function tokenEquivalence(n) {
  if (!n || n <= 0) return "";
  let ref = null;
  for (const item of EQUIV_LADDER) {
    if (n >= item.tokens) ref = item;
    else break;
  }
  if (!ref) return t("不到一首《静夜思》");
  const ratio = n / ref.tokens;
  if (ratio < 1.5) return t("约相当于一{unit}{name}", { unit: t(ref.unit), name: t(ref.base) });
  const count = ratio >= 10 ? Math.round(ratio) : Number(ratio.toFixed(1));
  return t("约相当于 {n} {unit}{name}", { n: count, unit: t(ref.unit), name: t(ref.base) });
}

export { fmtTokens, tokenEquivalence };
