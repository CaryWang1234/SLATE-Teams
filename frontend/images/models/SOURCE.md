# 模型 / 推理服务品牌 mark 来源

这批 SVG 取自 LobeHub 的开源图标集，用于顶栏模型选择器、「设置 → 自定义模型」
与「密钥」列表、以及聊天气泡下方那行模型名旁的品牌标识。

- 包：`@lobehub/icons-static-svg@1.95.1`
- 仓库：https://github.com/lobehub/lobe-icons
- 许可：MIT（品牌图形权利仍归各自商标持有人，仅作识别用途）
- 取用形态：**一家品牌两份**，`gen_model_icons.mjs` 按「彩色优先、单色兜底」取用：
  - `<brand>-color.svg`——品牌自己的颜色（`fill="#…"` 或 `fill="url(#渐变)"`），任何主题下都不改色；
  - `<brand>.svg`——单色（`fill="currentColor"`、`viewBox="0 0 24 24"`），只给没有彩色版的那 11 家用，
    由界面钉一只跨主题的中性灰（`--mark-neutral`），明暗两支分开。
  - 包里**没有**彩色版的 11 家：`anthropic` `flux` `grok` `groq` `ibm` `lmstudio` `moonshot`
    `ollama` `openai` `reka` `zai`——它们继续走中性灰，不是漏抄。
  - 彩色版有 17 只带 `<linearGradient id>`。第三方 defs 直接内联会撞（同页并排两只不同品牌、
    或同一只画在两处），所以生成时统一改名成 `mi-<brand>-<原 id>`，`url(#…)` 一起改写；
    体检要求改名后每条引用都指得到本图标内的 id。
  - `-text` / `-brand` 变体不取：前者把品牌名字也画进图里，与旁边的模型名重复。

## 为什么有的键名和厂商名不一样（逐只用 SVG 内 `<title>` 与官网核过）

- `grok`：包里 `grok.svg` 与 `xai.svg` 的 `<title>` 都是 `Grok`，是同一品牌的两种画法，
  只留 `grok` 一只；xAI 的端点靠别名表指到它。
- **没有 `microsoft`**：包里 `microsoft.svg` 的 `<title>` 是 `Azure`，画的也是 Azure 四方块，
  拿它当微软标会画错品牌。微软系只留 `azure`。
- `siliconcloud`：硅基流动（SiliconFlow）的推理平台在官方文档里就叫「硅基流动 SiliconCloud」，
  端点是 `api.siliconflow.cn`，所以这只 mark 配那条别名，label 沿用包里的 `SiliconCloud`。
- `moonshot` 的 `<title>` 是 `MoonshotAI`；`kimi` 单独一只，模型名里有 Kimi 时优先用它。
- **GLM / 智谱用 `zai`（`<title>Z.ai</title>`），不再用 `zhipu`**：智谱对外品牌已换成 Z.ai，
  包里 `zai.svg` 是那只新 mark（三条斜杠组成的 Z），且**只有单色版**——所以它落在"中性灰那 11 家"里。
  `glm` / `zhipu` / `zhipuai` / `bigmodel` 四条别名都指到它；`chatglm` 仍单独一只（包里另有 `chatglm`，画的是那条线）。
- `wenxin`（文心／ERNIE）与 `baidu`（百度智能云，qianfan 端点的归属方）分列，不混用。
- `openclaw`、`cogview` 不取：当年是嫌它们带 `id`/`url(#…)` 渐变引用；现在生成器会按品牌改名 defs，
  这条理由已经不成立了，留白只是因为内置注册表里没有这两个系列要用它。

重新下载（覆盖本目录）：

```bash
curl -sL -o /tmp/lobehub-icons.tgz \
  https://registry.npmmirror.com/@lobehub/icons-static-svg/-/icons-static-svg-1.95.1.tgz
tar xzf /tmp/lobehub-icons.tgz -C /tmp package/icons
for n in openai anthropic claude gemini google deepseek kimi moonshot qwen bailian zai \
         chatglm doubao volcengine minimax hailuo wenxin baidu ollama lmstudio vllm \
         xinference azure vertexai bedrock grok mistral cohere perplexity meta gemma \
         nvidia ibm reka yi zeroone baichuan stepfun hunyuan spark longcat skywork \
         sensenova internlm modelscope openrouter siliconcloud groq together fireworks \
         huggingface aihubmix sora dalle flux kling vidu stability; do
  cp "/tmp/package/icons/$n.svg" frontend/images/models/$n.svg
  # 彩色版不是每家都有（那 11 家就没有），有就一起抄进来
  [ -f "/tmp/package/icons/$n-color.svg" ] && cp "/tmp/package/icons/$n-color.svg" frontend/images/models/$n-color.svg
done
```

改完图片后必须重新生成内联表（否则界面上不会出现新 mark）：

```bash
node scripts/gen_model_icons.mjs
```

一致性由 `scripts/check_model_logos.mjs` 把关。
