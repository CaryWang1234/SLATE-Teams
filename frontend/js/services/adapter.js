/**
 * SLATE 模型适配器：System Prompt 模板 + 参数映射
 * 根据不同模型特点优化提示。
 */

import { state } from "../store.js?v=20261017-001";
import { getToolsSystemPrompt } from "./tools.js?v=20261017-001";
import { catalogForScope } from "./project_scope.js?v=20261017-001";

// ── System Prompt 模板 ──────────────────────

// 提示词按"角色 / 职责 / Agent 协议与工具纪律 / 回答风格"分段拼装：
// 智能体态拼出的文本与拆分前逐字一致；对话态整段去掉工具相关内容，
// 否则末尾的 [对话模式] 声明会和"你拥有工具""必须包含工具调用块"互相打架，
// 模型照样伪造 ◈◈◈ 调用块或谎称已经读过文件、跑过命令。
const SYSTEM_ROLE = `你是 SLATE（砚），一个本地 AI 协作调度台助手，既能陪用户发散想法，也能像 Agent 一样直接推进本地项目任务。`;

const SYSTEM_DUTIES = `## 核心职责
1. 捕捉零碎想法，帮助发散、连接、命名、追问和重组。
2. 将模糊需求整理成可执行的目标、约束、风险、验收标准与下一步。
3. 维护长期记忆、用户画像和知识中心，让灵感能跨对话沉淀与复用。`;

const SYSTEM_DUTIES_AGENT = `${SYSTEM_DUTIES}
4. 当用户要求查看、修改、运行、排查、生成、提交或验证项目内容时，直接使用工具推进，不把任务停留在建议层面。`;

const SYSTEM_DUTIES_CHAT = `${SYSTEM_DUTIES}
4. 只依据用户给出的信息与常识回答，缺少事实依据时直说不知道。`;

const SYSTEM_AGENT_PROTOCOL = `## Agent 工作协议
- 默认倾向使用工具：先看当前任务是否有可用工具能提供事实或执行动作；涉及现状、事实、生成、修改、验证的内容，直接调用对应工具获取依据再继续。纯闲聊、纯观点交流可直接回答。
- Observe：缺少项目事实时优先读取目录、文件、配置、日志或命令输出；不要臆测仓库现状。
- Plan：复杂任务用 3-6 个内部步骤收束，不必把完整计划冗长输出给用户；目标/TODOLIST 开启时按清单推进。
- Act：能用工具完成的动作就发出工具调用；同一轮可批量调用互不依赖的读取/扫描工具。
- Verify：修改、生成、构建、修复后必须用读取、检查、测试或命令结果自证；验证失败继续修，不急着汇报完成。
- Report：只有在任务完成或确实受阻时才收尾；汇报要短，说明改了什么、验证了什么、剩余风险。

## 工具纪律
你拥有工具，调用格式见下方 [可用工具]。
- 当下一步需要查看、读取、搜索、确认、修改、执行或生成文件时，当前回复必须包含工具调用块。
- 禁止说“我先看看”“我需要查看”“接下来我会”后停住；这类句子后必须紧跟实际工具调用。
- 不强行调用与任务无关的工具；等待用户选择、确认、补充隐私信息或许可时不调用工具。
- 不重复完全相同的失败调用；如果工具失败，换参数、换工具或先读取更多上下文。
- 不暴露冗长思维过程；给用户看清晰结论、关键依据和下一步即可。`;

const SYSTEM_STYLE = `## 回答风格
- 中文为主，技术术语保留英文；简洁、聚焦、有启发性。
- 有实质内容时用 Markdown 结构化；简单问题直接回答，不加多余格式。
- 主动指出更稳妥的路径，但不要把主动性变成没完没了的反问。`;

const SYSTEM_BASE = `${SYSTEM_ROLE}\n\n${SYSTEM_DUTIES_AGENT}\n\n${SYSTEM_AGENT_PROTOCOL}\n\n${SYSTEM_STYLE}`;
const SYSTEM_BASE_CHAT = `${SYSTEM_ROLE}\n\n${SYSTEM_DUTIES_CHAT}\n\n${SYSTEM_STYLE}`;
const REASONING_SUFFIX = `\n\n## 深度推理模式\n先在内部充分分析目标、约束、风险和可验证路径，再给出行动或结论；不要把长推理逐字展示给用户。`;

const SYSTEM_PROMPTS = {
  default: SYSTEM_BASE,
  defaultChat: SYSTEM_BASE_CHAT,

  // 针对推理模型的系统提示
  reasoning: `${SYSTEM_BASE}${REASONING_SUFFIX}`,
  reasoningChat: `${SYSTEM_BASE_CHAT}${REASONING_SUFFIX}`,

  // 针对轻量模型的精简提示
  lightweight: `你是 SLATE 助手：中文为主，简洁、有启发性。纯闲聊、纯观点交流可直接回答；涉及项目现状、事实、生成、修改、运行、排查、提交或验证的内容，默认先调用对应工具获取依据再回答，按 [可用工具] 的 ◈◈◈ 格式直接调用工具推进。不要只说“我来看看”；等待用户选择/确认时不调用工具。`,
  lightweightChat: `你是 SLATE 助手：中文为主，简洁、有启发性。本轮没有可调用工具：涉及项目现状、文件内容、命令结果等事实时，直接说明需要用户提供信息或改用智能体模式，不要声称自己已经查看、搜索或执行过。`,
};

// ── 模型分类 ────────────────────────────────

const REASONING_MODELS = ["gpt-5.6-sol", "claude-fable-5", "claude-fable-5-1"];
const LIGHTWEIGHT_MODELS = ["gpt-5.6-luna", "gemini-3.6-flash", "gemini-3.5-flash-lite", "deepseek-flash", "kimi-k2.7-code", "doubao-seed-2-1-turbo-260628"];

/**
 * 根据模型 ID 与回复方式获取适配的系统提示。
 * chatMode=true 返回"无工具"基底：智能体协议与工具纪律整段不下发。
 */
function getSystemPrompt(modelId, chatMode = false) {
  if (REASONING_MODELS.includes(modelId)) return chatMode ? SYSTEM_PROMPTS.reasoningChat : SYSTEM_PROMPTS.reasoning;
  if (LIGHTWEIGHT_MODELS.includes(modelId)) return chatMode ? SYSTEM_PROMPTS.lightweightChat : SYSTEM_PROMPTS.lightweight;
  return chatMode ? SYSTEM_PROMPTS.defaultChat : SYSTEM_PROMPTS.default;
}

function getMemorySystemPrompt() {
  const parts = [];
  const profile = state.userProfile || {};
  const profileLines = [];
  if (profile.role) profileLines.push(`- 角色: ${profile.role}`);
  if (profile.style) profileLines.push(`- 工作风格: ${profile.style}`);
  if (profile.techStack) profileLines.push(`- 技术栈: ${profile.techStack}`);
  if (profile.habits) profileLines.push(`- 协作习惯: ${profile.habits}`);
  if (profile.custom) profileLines.push(`- 其他: ${profile.custom}`);
  if (profileLines.length) {
    parts.push("[用户画像]");
    parts.push(...profileLines);
  }

  const memories = (state.memories || []).slice(-16);
  if (memories.length) {
    parts.push("[长期记忆]");
    for (const mem of memories) {
      const category = mem.category || "general";
      const content = String(mem.content || "").slice(0, 220);
      if (content) parts.push(`- [${category}] ${content}`);
    }
  }

  if (!parts.length) return "";
  return "\n\n以下是用户画像与长期记忆，用于调整回答风格与内容贴合用户，不要向用户复述它们：\n" + parts.join("\n");
}

function getKnowledgeSystemPrompt(items = null) {
  // 并行时由调用方把自己那场检索到的片段传进来：读全局版本会把 B 项目的知识库
  // 片段塞进 A 项目的请求里（后台那场的检索比这行代码晚到或早到都不受控）。
  const list = (Array.isArray(items) ? items : (Array.isArray(state.knowledgeContext) ? state.knowledgeContext : [])).slice(0, 8);
  if (!list.length) return "";
  const lines = ["[相关知识库片段]（仅在与当前问题相关时参考，不要生硬引用）"];
  for (const item of list) {
    const title = item.title || item.source || "知识";
    const content = String(item.content || "").slice(0, 700);
    if (content) lines.push(`- ${title}: ${content}`);
  }
  return "\n\n" + lines.join("\n");
}

/** 专家包注入：当前对话激活的专家 persona + rules */
function getExpertSystemPrompt() {
  const expert = state.activeExpert;
  if (!expert) return "";
  const parts = [`[专家包· ${expert.name || "未命名"}]（本次对话完全采纳以下人格与规则，优先于默认风格）`];
  if (String(expert.persona || "").trim()) {
    parts.push("[专家人格]");
    parts.push(String(expert.persona).trim());
  }
  if (String(expert.rules || "").trim()) {
    parts.push("[专家规则]");
    parts.push(String(expert.rules).trim());
  }
  const knowledgeNames = (expert.knowledge || []).map(f => f.name).slice(0, 20);
  if (knowledgeNames.length) {
    parts.push(`[专家知识文件] ${knowledgeNames.join("、")}`);
  }
  return parts.length > 1 ? "\n\n" + parts.join("\n") : "";
}

/**
 * Actions 目录注入：只给"id + 一句话"，正文留给 actions_read 按需取。
 * 刻意收紧上限：Action 是用户写的流程，多列一条就多占一份上下文预算，
 * 而模型此刻只需要知道"有没有、叫什么、什么时候用"。
 */
const ACTIONS_CATALOG_LIMIT = 20;

function getActionsSystemPrompt(project = null) {
  // 目录按「这一场的项目」取：项目里的同名 Action 顶掉全局版本，后台那场
  // 拿的必须是它自己项目的清单，否则模型看到的是另一个项目的流程。
  const list = catalogForScope(project).actions;
  if (!list.length) return "";
  const flat = text => String(text || "").replace(/\s+/g, " ").trim();
  const lines = ["[可用 Actions]（用户事先写好的流程说明书。与用户当前要求不符时不要套用，先按用户说的做）"];
  for (const a of list.slice(0, ACTIONS_CATALOG_LIMIT)) {
    const desc = flat(a.description).slice(0, 60);
    const when = flat(a.when).slice(0, 40);
    lines.push(`- ${a.id}：${flat(a.name)}${desc ? `——${desc}` : ""}${when ? `（适用：${when}）` : ""}`);
  }
  const rest = list.length - ACTIONS_CATALOG_LIMIT;
  if (rest > 0) lines.push(`- 另有 ${rest} 个 Action 未列出，用 actions_list 查看`);
  lines.push("决定采用某个 Action 前，先用 actions_read 读完整流程，再按步骤实际执行。");
  return "\n\n" + lines.join("\n");
}

/**
 * 回复模式的追加提示：模式可以改系统提示词（工具白名单在 tools.js 过滤，三条旋钮在调用点）。
 * 载荷语言固定中文、不经 t()：这是发给模型的一段，跟着界面语言变会让同一模式的用法两样。
 * 没有 prompt 的模式（智能 / 对话）不加任何东西，保持历史提示词一字不变。
 */
function getModeSystemPrompt(mode = null) {
  const text = String(mode?.prompt || "").trim();
  if (!text) return "";
  return `\n\n[回复模式· ${mode.label || mode.id}] ${text}\n`;
}

/**
 * 组装发往模型的完整系统提示：角色定义 → 项目宪法 → 专家包/记忆/知识 → 工具目录 → 模式追加。
 * 上下文估算与实际载荷共用此函数，避免两处口径漂移。
 * opts.withTools === false：本轮没有工具（对话模式或磨墨轮），基底换成不含 Agent 协议
 * 与工具纪律的版本，也不注入工具目录（没有工具可调用时注入只会诱导模型伪造 ◈◈◈ 调用块）。
 * opts.grindTurn：withTools 为 false 时改说磨墨那套禁令（产出是墨迹与墨稿，不是"改用智能体模式"）。
 */
function buildSystemContent(modelId, constitution, opts = {}) {
  // opts.knowledge / opts.project：并行时这一场的知识库与项目现场由调用方带进来，
  // 不带的才读全局——全局版本表示的是"屏幕上那个项目"，后台那场不该共用它。
  const chatMode = opts.withTools === false;
  let systemContent = getSystemPrompt(modelId, chatMode);

  // 注入项目宪法（项目开发规则，涉及该项目的代码、方案与建议时必须遵守）
  if (constitution?.rules?.length) {
    systemContent += "\n\n[项目宪法]（涉及该项目的代码、方案与建议时必须遵守）\n";
    constitution.rules.forEach((rule, i) => {
      systemContent += `${i + 1}. ${rule}\n`;
    });
  }

  systemContent += getExpertSystemPrompt();
  systemContent += getMemorySystemPrompt();
  systemContent += getKnowledgeSystemPrompt(opts.knowledge);

  // 注入工具描述（默认使用精简 Agent 版，避免长工具目录稀释关键指令）
  // 对话模式走互斥分支：不注入目录，同时显式声明"本轮没有工具"，
  // 否则模型会照旧伪造 ◈◈◈ 块，或谎称已经读过文件、已经跑过命令。
  if (opts.withTools === false) {
    // 同为"本轮无工具"，磨墨与对话要的下一步不一样：对话态该劝用户补信息或改用智能体，
    // 磨墨轮本身就有产出（追问 / 墨迹 / 墨稿），叫它改用智能体等于把它从正确分支上推开。
    systemContent += opts.grindTurn
      ? "\n\n[磨墨模式] 本轮只研磨需求，没有任何可调用工具：不要输出 ◈◈◈ 或其它工具调用块，"
        + "不要改文件、跑命令或开始实现，也不要把“我已查看文件”“我已执行命令”当作既成事实。"
        + "产出只有追问、【墨迹】状态与（收墨时）墨稿；要动工等用户点「送入目标模式」。\n"
      : "\n\n[对话模式] 本轮没有任何可调用工具：不要输出 ◈◈◈ 或其它工具调用块，"
        + "也不要把“我已查看文件”“我已执行命令”“我搜索过”当作既成事实。"
        + "缺少事实依据时直接说明你不知道，并告诉用户怎样提供信息或改用智能体模式。\n";
  } else {
    // Actions 目录贴着工具说明注入：对话态没有 actions_read，
    // 只给目录读不到正文，反而诱导模型声称"已按流程执行"。
    systemContent += getActionsSystemPrompt(opts.project);
    // 工具目录按这一场的模式裁剪：模式没开放的工具连目录都不出现（白名单见 tools.js modeAllowsTool）
    systemContent += getToolsSystemPrompt({ compact: true, project: opts.project || null, mode: opts.mode || null });
  }

  // 模式追加放在最后：它是"这一场怎么跑"的语气与侧重，贴着最近处才不容易被长目录冲淡
  systemContent += getModeSystemPrompt(opts.mode);

  return systemContent;
}

/**
 * 构建完整的消息列表（注入系统提示 + 宪法 + 专家/记忆/知识 + 工具）。
 * 顺序：角色定义、项目宪法、专家/记忆/知识上下文、工具说明（贴近对话，降低遗忘）。
 * toolMode：native=序列化原生工具协议（assistant.tool_calls + role:"tool"）；
 *           text=剥离协议（tool 消息降为 user，便于不支持 tools 的端点消费）；
 *           none=本轮没有工具（对话模式 / 磨墨轮），既不注入工具目录也不序列化任何工具协议。
 * opts.grindTurn：none 的原因是磨墨，系统提示改说 [磨墨模式] 那段禁令。
 */
function buildMessages(userMessages, constitution, toolMode = "text", opts = {}) {
  const messages = [];

  messages.push({
    role: "system",
    content: buildSystemContent(userMessages._modelId || "", constitution, {
      withTools: toolMode !== "none",
      grindTurn: opts.grindTurn === true,
      // 一条历史数组带上自己的现场（_knowledge / _project）：并行时全局那两份属于
      // 屏幕上正在看的另一个项目，读全局等于把 B 项目的知识塞进 A 项目的请求。
      knowledge: opts.knowledge ?? (Array.isArray(userMessages._knowledge) ? userMessages._knowledge : null),
      project: opts.project || userMessages._project || null,
      // 回复模式：只带"追加提示词"用；工具白名单与三条旋钮在各自的调用点生效
      mode: opts.mode || userMessages._mode || null,
    }),
  });

  const native = toolMode === "native";
  // 历史中已存在的 tool 结果 id（原生协议要求 assistant tool_calls 后必须有匹配的 tool 消息）
  const existingToolIds = new Set();
  for (const m of userMessages) {
    if (m.role === "tool" && m.tool_call_id) existingToolIds.add(m.tool_call_id);
  }

  // 用户消息（带图片附件时装配为多模态内容，让模型真正“看见”图片）
  for (const msg of userMessages) {
    const images = (Array.isArray(msg.images) ? msg.images : []).filter(src => typeof src === "string" && src.startsWith("data:image"));
    if (msg.role === "user" && images.length) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: msg.content },
          ...images.map(src => ({ type: "image_url", image_url: { url: src } })),
        ],
      });
      continue;
    }
    if (msg.role === "tool") {
      // 原生工具结果消息；文本模式无 tool 角色，降为 user 保留结果内容
      messages.push(native
        ? { role: "tool", tool_call_id: msg.tool_call_id || "", content: String(msg.content ?? "") }
        : { role: "user", content: String(msg.content ?? "") });
      continue;
    }
    if (msg.role === "assistant" && native) {
      const tc = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
      const kept = [];
      for (const c of tc) {
        if (!c?.id || !c?.name) continue;
        if (existingToolIds.has(c.id)) {
          kept.push(c);
        } else {
          // 刷新/切会话后结果消息不在内存历史中：从 metadata.toolResults 合成；
          // 无结果可合成的调用直接丢弃，避免上游 400
          const resEntry = (Array.isArray(msg.toolResults) ? msg.toolResults : []).find(r => r?.call?.id === c.id);
          if (resEntry) {
            kept.push(c);
            messages.push({ role: "tool", tool_call_id: c.id, content: String(resEntry.result?.output ?? "") });
          }
        }
      }
      if (kept.length) {
        messages.push({
          role: "assistant",
          content: msg.content ?? "",
          tool_calls: kept.map(c => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : "{}" },
          })),
        });
      } else {
        messages.push({ role: "assistant", content: msg.content ?? "" });
      }
      continue;
    }
    messages.push({ role: msg.role, content: msg.content });
  }

  return messages;
}

/**
 * 获取模型的默认参数。
 * max_tokens 由设置页“输出控制”决定：
 * - 基础值：单次输出 Token 上限（默认 16384）
 * - 开关开启时提升到 65536：file_create 等工具调用携带完整文件内容，
 *   过小会导致输出被截断、文件内容残缺。
 */
const UNLIMITED_OUTPUT_TOKENS = 65536;

function getOutputMaxTokens() {
  const s = state.outputSettings || {};
  if (s.unlimitedFileOutput) return UNLIMITED_OUTPUT_TOKENS;
  return Math.max(1024, parseInt(s.maxTokens) || 16384);
}

function getDefaultParams(modelId) {
  const max_tokens = getOutputMaxTokens();
  if (REASONING_MODELS.includes(modelId)) {
    return { temperature: 0.6, max_tokens };
  }
  return { temperature: 0.7, max_tokens };
}

export { getSystemPrompt, buildSystemContent, buildMessages, getDefaultParams, getOutputMaxTokens, SYSTEM_PROMPTS };
