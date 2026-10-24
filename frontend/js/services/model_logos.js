/**
 * 模型 / 推理服务 → 品牌 mark。
 *
 * 为什么不能按 provider 字段着色：注册表里的 provider 是**线路协议**（openai / anthropic /
 * google），DeepSeek、Kimi、Qwen、GLM、豆包、MiniMax、ERNIE 全都写着 "openai"，只有 base_url
 * 分得开；自定义模型更是只有用户手输的三个字段。所以判据只能落在「模型叫什么」与「端点是哪家」上。
 *
 * 顺序是名字先、端点后：`deepseek-r1:1.5b` 挂在 localhost:11434 时，那颗 mark 该是 DeepSeek
 * 而不是 Ollama——用户问的是"这个模型是谁家的"，不是"谁在替我跑它"。只有名字里什么都认不出来
 * 时，才退回按端点主机认。
 *
 * 认不出品牌就什么也不画。宁可留白，也不许把 Qwen 的模型画成别人的标——画错品牌比没品牌更糟。
 *
 * 图形本体在 model_icons.js（由 frontend/images/models/*.svg 生成），这里只有别名表。
 */
import { MODEL_ICON_LABELS } from "./model_icons.js?v=20261024-001";

/** 别名 → 图标键。别名一律小写；4 字符以下只做整词匹配，免得 glm / yi / hf 撞进别人的词里。 */
const ALIAS = {
  // ── 国际一线 ──
  openai: "model-openai", chatgpt: "model-openai", gpt: "model-openai",
  azure: "model-azure",
  anthropic: "model-anthropic",
  claude: "model-claude", sonnet: "model-claude", opus: "model-claude", haiku: "model-claude",
  gemini: "model-gemini", gemma: "model-gemma",
  google: "model-google", googleapis: "model-google", generativelanguage: "model-google",
  vertex: "model-vertexai", vertexai: "model-vertexai",
  bedrock: "model-bedrock",
  grok: "model-grok", xai: "model-grok",
  mistral: "model-mistral", mixtral: "model-mistral",
  cohere: "model-cohere", command: "model-cohere",
  perplexity: "model-perplexity", sonar: "model-perplexity",
  llama: "model-meta",
  nvidia: "model-nvidia", nemotron: "model-nvidia",
  ibm: "model-ibm", granite: "model-ibm",
  reka: "model-reka",

  // ── 国内一线（模型线） ──
  deepseek: "model-deepseek", r1: "model-deepseek",
  kimi: "model-kimi", moonshot: "model-moonshot", moonshotai: "model-moonshot",
  qwen: "model-qwen", tongyi: "model-qwen", qwq: "model-qwen",
  dashscope: "model-qwen", aliyuncs: "model-qwen", bailian: "model-bailian",
  glm: "model-zai", zhipu: "model-zai", zhipuai: "model-zai", bigmodel: "model-zai",
  chatglm: "model-chatglm",
  doubao: "model-doubao", volc: "model-volcengine", volces: "model-volcengine",
  volcengine: "model-volcengine",
  minimax: "model-minimax", hailuo: "model-hailuo",
  ernie: "model-wenxin", wenxin: "model-wenxin",
  baidu: "model-baidu", baidubce: "model-baidu", qianfan: "model-baidu",
  yi: "model-yi", zeroone: "model-zeroone",
  baichuan: "model-baichuan", step: "model-stepfun", stepfun: "model-stepfun",
  hunyuan: "model-hunyuan", spark: "model-spark", iflytek: "model-spark", xfyun: "model-spark",
  longcat: "model-longcat", skywork: "model-skywork", sensenova: "model-sensenova",
  internlm: "model-internlm", internvl: "model-internlm",

  // ── 本地运行时 ──
  ollama: "model-ollama", "11434": "model-ollama",
  lmstudio: "model-lmstudio", "1234": "model-lmstudio",
  vllm: "model-vllm", xinference: "model-xinference",

  // ── 聚合网关 / 托管 ──
  openrouter: "model-openrouter",
  siliconflow: "model-siliconcloud", siliconcloud: "model-siliconcloud", silicon: "model-siliconcloud",
  groq: "model-groq", together: "model-together", fireworks: "model-fireworks",
  huggingface: "model-huggingface", hugging: "model-huggingface", hf: "model-huggingface",
  modelscope: "model-modelscope", aihubmix: "model-aihubmix",

  // ── 图片 / 视频生成（image_gen、video_gen 配的也是模型名） ──
  sora: "model-sora", dalle: "model-dalle", dall: "model-dalle",
  flux: "model-flux", kling: "model-kling", vidu: "model-vidu",
  stability: "model-stability", stable: "model-stability",
};

// 长别名优先：chatglm 要先于 glm，siliconcloud 要先于 silicon，否则短的先抢走
const ALIASES = Object.keys(ALIAS).sort((a, b) => b.length - a.length);

/**
 * 切词：非字母数字一律当分隔符，并把"品牌名粘着版本号"的写法拆开——
 * `qwen3.8-max` → qwen/3/8/max、`gpt4o` → gpt/4o、`glm-5.2` → glm/5/2，
 * 而 `r1`、`k2.7` 这种「单字母+数字」保持原样（那是型号，不是版本号粘连）。
 */
function tokenize(...parts) {
  const text = parts.filter(Boolean).join(" ").toLowerCase()
    .replace(/([a-z]{2,})(\d)/g, "$1 $2")
    .replace(/(\d)([a-z]{2,})/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ");
  return text.split(" ").filter(Boolean);
}

function hit(word, alias) {
  if (word === alias) return true;
  // 只有 4 字符以上的别名允许前缀命中：qwen3 算 Qwen，yi 不算 yimin、glm 不算 glmv-thing
  return alias.length >= 4 && word.startsWith(alias);
}

/**
 * 给一颗模型找 mark。参数可以是 {id, name, base_url}，也可以直接是模型名字符串
 * （消息气泡下方那一行只有名字）。
 */
export function modelIconKey(model) {
  if (!model) return "";
  const groups = typeof model === "string"
    ? [[model]]
    : [[model.id, model.name], [model.base_url]];
  for (const group of groups) {
    const words = tokenize(...group);
    for (const word of words) {
      for (const alias of ALIASES) {
        if (hit(word, alias)) return ALIAS[alias];
      }
    }
  }
  return "";
}

/** 品牌名（tooltip / aria 用）；认不出就没有 */
export function modelIconLabel(key) {
  return MODEL_ICON_LABELS[key] || "";
}
