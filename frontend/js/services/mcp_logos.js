/**
 * 外部 MCP Server → 品牌 mark。
 *
 * 设置页里这台 Server 叫什么完全是用户手输的（"GitHub" / "mcp-github" /
 * "api.githubcopilot.com" / "@modelcontextprotocol/server-github"），所以匹配要同时
 * 看名称和 URL，并且只认整词或足够长的品牌串：宁可落回 MCP 官方 mark，也不能把
 * Notion 的服务器画成 GitHub——画错品牌比没品牌更糟。
 *
 * 图形本体在 mcp_icons.js（由 frontend/images/mcp/*.svg 生成），这里只有别名表。
 */
import { MCP_ICON_LABELS } from "./mcp_icons.js?v=20261017-001";

/** 别名 → 图标键。别名一律小写；短别名（<5 字符）只做整词匹配。 */
const ALIAS = {
  github: "mcp-github", gh: "mcp-github", octokit: "mcp-github", octocat: "mcp-github",
  notion: "mcp-notion",
  figma: "mcp-figma",
  brave: "mcp-brave",
  exa: "mcp-exa",
  tavily: "mcp-tavily",
  jina: "mcp-jina",
  firecrawl: "mcp-firecrawl",
  cloudflare: "mcp-cloudflare", cf: "mcp-cloudflare",
  vercel: "mcp-vercel",
  n8n: "mcp-n8n",
  huggingface: "mcp-huggingface", hugging: "mcp-huggingface", hf: "mcp-huggingface",
  obsidian: "mcp-obsidian",
  snowflake: "mcp-snowflake",
  browserless: "mcp-browserless",
  google: "mcp-google", gmail: "mcp-google", gcal: "mcp-google", gdrive: "mcp-google",
  gmaps: "mcp-google", bigquery: "mcp-google",
  bailian: "mcp-bailian", dashscope: "mcp-bailian", tongyi: "mcp-bailian",
  coze: "mcp-coze",
  dify: "mcp-dify",
  bilibili: "mcp-bilibili",
  mcpso: "mcp-mcpso",
};

/** 认不出品牌时的兜底：MCP 官方 mark（同时也是"这确实是台 MCP Server"的说明） */
export const MCP_FALLBACK_ICON = "mcp";

// 长别名优先：githubcopilot 要比 gh 先命中，否则"gh"会把一切带 gh 的名字抢走
const ALIASES = Object.keys(ALIAS).sort((a, b) => b.length - a.length);

/**
 * 名称/URL 里的主机名一起看：`https://mcp.notion.com/sse` 与 "Notion MCP" 应当同图。
 * 参数可传任意个字符串，逐个归一后取第一个命中的别名。
 */
export function mcpIconKey(...parts) {
  for (const raw of parts) {
    const text = String(raw || "").toLowerCase();
    if (!text) continue;
    const words = text.replace(/[^a-z0-9]+/g, " ").trim();
    const compact = words.replace(/ /g, "");
    if (!compact) continue;
    for (const alias of ALIASES) {
      // 短别名只做整词：gh / cf / hf 撞进别人的词里就是画错品牌
      const hit = alias.length >= 5
        ? compact.includes(alias) || new RegExp(`(^| )${alias}( |$)`).test(words)
        : new RegExp(`(^| )${alias}( |$)`).test(words);
      if (hit) return ALIAS[alias];
    }
  }
  return MCP_FALLBACK_ICON;
}

/** 品牌名（tooltip / aria 用），兜底说"外部 MCP Server" */
export function mcpIconLabel(key) {
  return MCP_ICON_LABELS[key] || (key === MCP_FALLBACK_ICON ? "MCP" : "");
}

/**
 * 工具名 mcp__<serverId>__<tool> → 品牌 mark。
 * serverId 是后端自增号（1、2…），光看它一个词什么也认不出来，必须回到 Server 的
 * 名称与 URL 上；remoteTools 就是 /api/skills 带回来的那份对照表。
 */
export function mcpIconKeyFromTool(fullName, remoteTools) {
  const text = String(fullName || "");
  const m = /^mcp__([^_]+)__(.+)$/.exec(text);
  if (!m) return mcpIconKey(text);
  const [, sid] = m;
  const hit = (Array.isArray(remoteTools) ? remoteTools : []).find(t =>
    String(t?.serverId ?? t?.server_id ?? "") === sid || String(t?.server ?? "") === sid);
  // 名字先、URL 后：名字是用户自己的叫法，URL 是主机方的事实
  return mcpIconKey(hit?.server, hit?.url, sid, m[2]);
}
