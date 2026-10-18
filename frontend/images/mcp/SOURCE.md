# MCP 品牌 mark 来源

这批 SVG 取自 LobeHub 的开源图标集，用于「设置 → MCP Server」列表与各处 `mcp__*`
工具条目的品牌标识。

- 包：`@lobehub/icons-static-svg@1.95.1`
- 仓库：https://github.com/lobehub/lobe-icons
- 许可：MIT（品牌图形权利仍归各自商标持有人，仅作识别用途）
- 取用形态：`<brand>.svg`（单色、`fill="currentColor"`、`viewBox="0 0 24 24"`），
  跟随界面文字颜色，明暗主题都可读；不含 `-color` / `-text` 变体。

重新下载（覆盖本目录）：

```bash
curl -sL -o /tmp/lobehub-icons.tgz \
  https://registry.npmmirror.com/@lobehub/icons-static-svg/-/icons-static-svg-1.95.1.tgz
tar xzf /tmp/lobehub-icons.tgz -C /tmp package/icons
for n in mcp mcpso github notion figma brave exa tavily jina firecrawl cloudflare \
         vercel n8n huggingface obsidian snowflake browserless google bailian coze \
         dify bilibili; do
  cp "/tmp/package/icons/$n.svg" frontend/images/mcp/$n.svg
done
```

改完图片后必须重新生成内联表（否则界面上不会出现新 mark）：

```bash
node scripts/gen_mcp_icons.mjs
```

一致性由 `scripts/check_mcp_logos.mjs` 把关。
