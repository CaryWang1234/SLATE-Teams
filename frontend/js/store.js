/**
 * SLATE 全局状态管理 v3
 * 管理主题、模型（per-model API key）、对话历史、用量统计、黑板卡片
 */

import { makeId } from "./services/utils.js?v=20261017-001";
import { FLAG_KINDS, normalizeTaskFlags, normalizeTaskListSort } from "./services/task_list.js?v=20261017-001";

const API_ORIGIN = typeof window !== "undefined" && window.location?.origin
  ? window.location.origin
  : "http://127.0.0.1:8130";
const API_BASE = `${API_ORIGIN}/api`;

// 目标模式的轮数上限：一次真实交付常要"读→改→跑→再跑验证"好几轮，50 经常在验证之前就用完。
// 放宽同时要把话说在前头：上限是止损线，不是预算——干完活该由模型自己调 exit_target_mode 收口。
export const HARNESS_MAX_ROUNDS = 80;

// ── 自定义主题：用户只填四个源色，其余配色令牌由它们推导（services/theme_custom.js）──
// 默认值抄 style.css 的浅色主题：没开启自定义时，这份状态不该改动任何一个像素。
export const CUSTOM_THEME_DEFAULT_COLORS = { bg: "#F1F1EF", panel: "#E6E6E3", text: "#191A1C", accent: "#97342A" };
const HEX6_RE = /^#[0-9A-Fa-f]{6}$/;

function normalizeThemeHex(value, fallback) {
  const s = String(value || "").trim();
  return HEX6_RE.test(s) ? s.toUpperCase() : fallback;
}

// 脏值（手改 localStorage、手机同步来的半截对象）逐字段回落默认，而不是整份丢弃：
// 主题只管观感，认不出的字段按默认渲染比"偷偷关掉自定义"更可预期。
function normalizeCustomTheme(value) {
  const src = value && typeof value === "object" ? value : {};
  const c = src.colors && typeof src.colors === "object" ? src.colors : {};
  const f = src.fonts && typeof src.fonts === "object" ? src.fonts : {};
  const b = src.background && typeof src.background === "object" ? src.background : {};
  const o = src.opacity && typeof src.opacity === "object" ? src.opacity : {};
  return {
    enabled: src.enabled === true,
    preset: typeof src.preset === "string" ? src.preset : "",
    colors: {
      bg: normalizeThemeHex(c.bg, CUSTOM_THEME_DEFAULT_COLORS.bg),
      panel: normalizeThemeHex(c.panel, CUSTOM_THEME_DEFAULT_COLORS.panel),
      text: normalizeThemeHex(c.text, CUSTOM_THEME_DEFAULT_COLORS.text),
      accent: normalizeThemeHex(c.accent, CUSTOM_THEME_DEFAULT_COLORS.accent),
    },
    // 空串 = 跟随 style.css 的系统字体栈；这里不校验字体名，可选集合由控件本身限定。
    // imported 是"导入过哪些字体"的账，文件在不在本机由 theme_custom.js 现问后端。
    fonts: {
      main: typeof f.main === "string" ? f.main : "",
      code: typeof f.code === "string" ? f.code : "",
      imported: normalizeImportedFonts(f.imported),
    },
    background: {
      enabled: b.enabled === true,
      // 遮罩浓度：底色压在背景图上的不透明度（%）。低于 40 正文就会直接骑在图上，
      // 高于 95 等于没有图，所以两端都收死。
      veil: normalizeCountInt(b.veil, 40, 95, 72),
    },
    opacity: {
      // 板块不透明度（%）：面板/卡片/输入框/助手气泡这一族底色。100 = 完全不透明（旧行为）。
      // 下限 55：再低就只剩一圈边框线在撑着层级，正文会读成"浮在纸上"。
      panel: normalizeCountInt(o.panel, 55, 100, 100),
    },
  };
}

// 导入字体的 id 形状：后端 _font_id() 生成（f + 内容哈希 10 位）。
// 状态会从另一台设备同步过来，id 又会被拼进 @font-face 的家庭名与 url()，所以这里必须先验形状。
// 导出的那份给 theme_custom.js 用——两处必须同一个形状，否则这边收下的 id 那边拼不出样式。
export const IMPORTED_FONT_ID_RE = /^f[0-9a-f]{10}$/;

function normalizeImportedFonts(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const it = item && typeof item === "object" ? item : {};
    const id = String(it.id || "");
    if (!IMPORTED_FONT_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    // 标签只做显示（textContent），永远不进 CSS：家庭名由 id 拼，见 theme_custom.js
    const label = String(it.label || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 64);
    out.push({ id, label: label || id });
    if (out.length >= 24) break;   // 一次导入 24 个字体已经远超实际需要
  }
  return out;
}

// 审批四档取值域：ask 手动 / auto 自动 / full 完全访问 / night 夜间模式。
// full 这个名字历史上指的是"全托管"，这一版把它改判给「完全访问」（命令与联网不问，
// 缺条件时仍会弹选择题）；「夜间模式」改用新键 night。老存档里的 full 由
// migratePermissionModes 一次性搬到 night，靠 permissionModeSchema 认版本，见那里的注释。
// 这两个常量放在 state 之前：state 的默认值要用它，声明在后会踩 TDZ。
const PERMISSION_MODE_IDS = ["ask", "auto", "full", "night"];
const PERMISSION_MODE_SCHEMA = 2;

// ── 回复模式注册表：输入栏那个选择器认的取值 ──────────────────
// 内置四模式由这张表定义，输入栏浮层与扩展页都从这里取（一处改、两处同）。
// 字段含义：
//   id      稳定标识；也是自定义模式的键与"每场覆盖"的键
//   label   显示名（i18n 键由 id 拼，见 i18n_dict）
//   icon    services/icons.js 里的图标名
//   color   胶囊主色（CSS 变量或 hex）
//   prompt  追加到系统提示词末尾的一段（空 = 不加）
//   tools   null=全部工具；"none"=一个都不给；数组=白名单（收口的 exit_* 始终保留，见 tools.js）
//   effort  ""=沿用输入栏选的推理强度；low/medium/high=这一档强制覆盖（后端仍按模型能力映射）
//   rounds  0=沿用全局轮数上限；否则覆盖这一场目标模式的轮数上限
//   model   ""=沿用当前模型；否则覆盖（内置一律不带，避免切模式时悄悄换模型）
// 前两个就是旧的 chatMode 两值：smart≈agent，chat≈chat，所以老存档零迁移。
const MODE_TOOLS_NONE = "none";
// 经济模式只给"读"的工具：看得到项目与技能目录，写不了盘、跑不了命令、花不了生成额度。
// 收口工具（exit_target_mode / exit_autopilot）由 tools.js 的白名单过滤无条件保留。
const MODE_READONLY_TOOLS = [
  "project_info", "project_files", "project_read_file", "project_find_file",
  "code_search", "skill_search", "board_read", "knowledge_search",
  "actions_list", "actions_read", "system_info", "chat_context",
  "todo_manage", "user_ask",
];
// 输入栏浮层最多同时显示几个（内置四个常驻，剩下的位子留给最近建的自定义模式）。
const MODE_POPOVER_MAX = 7;

const BUILTIN_MODES = [
  { id: "smart", label: "智能", icon: "tool", color: "var(--text)", prompt: "", tools: null, effort: "", rounds: 0, model: "" },
  { id: "chat", label: "对话", icon: "message-circle", color: "#2fd4c4", prompt: "", tools: MODE_TOOLS_NONE, effort: "", rounds: 1, model: "" },
  {
    id: "eco", label: "经济", icon: "leaf", color: "#3fb950",
    prompt: "用最少步骤和最少 token 完成任务，能直接回答就直接回答，不要为了交代过程而绕远。",
    tools: MODE_READONLY_TOOLS, effort: "low", rounds: 12, model: "",
  },
  {
    id: "turbo", label: "狂暴", icon: "flame", color: "#ff7a45",
    prompt: "尽快把任务做完，必要时多轮并行调用工具，中途不要停下来等确认；只有确实缺关键条件时才提问。",
    tools: null, effort: "high", rounds: 40, model: "",
  },
];
const BUILTIN_MODE_IDS = BUILTIN_MODES.map(m => m.id);

const state = {
  // 主题
  theme: "light",
  customTheme: normalizeCustomTheme(null),

  // 通用 UI 模式：classic（默认，完整布局）| codex（极简 Codex 风格）
  uiMode: "classic",

  // 当前选中的模型
  currentModel: null,

  // 每个模型的 API Key（modelId → key）
  modelKeys: {},

  // 自定义模型（用户手动添加的）
  customModels: [],

  // 每模型的上下文预算（modelId → token 数；缺省或 0 = 自动）
  // 预算决定两件事：上下文条算到哪儿算满、自动压缩在第几轮触发。两者必须同一个数。
  modelContextCaps: {},
  // 探测到的真实窗口覆盖（modelId → token 数）：本地/自定义端点的窗口注册表里猜不准，
  // 探测成功后存在这里，不动用户自己填的 customModels 条目，也不污染内置注册表。
  modelContextWindows: {},

  // 用量统计（当前对话）
  usage: {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    messageCount: 0,
  },

  // 每个对话的用量统计（convId → usage）
  conversationUsage: {},

  // 最近一次上下文分桶结果（由 services/context_meter.js 写入，不持久化）
  contextSnapshot: null,

  // 每个对话的 TODOLIST（convId → items），目标六阶段闭环的任务清单
  conversationTodos: {},

  // 侧栏任务徽标（convId → {kind: done|needs|error, at, seen}）：记的是"上一场怎么结束的"。
  // 刻意只存本机 —— "已完成未查看"说的是这块屏幕有没有看过，跨设备同步只会把另一台
  // 机器的阅读进度盖过来。进行中没有这一项：它由实时生成权判定，落库就会留下僵尸态。
  taskFlags: {},

  // 侧栏任务列表的排序偏好（recent|project|status|created|usage，见 services/task_list.js）
  taskListSort: "recent",

  // 消息区右侧 TODOLIST 栏：false = 用户主动收起（有清单也不占位）。
  // 与 taskFlags 同理只存本机——"这一栏占不占我的屏幕"是这台设备的事，
  // 手机遥控同步过去只会把桌面的布局偏好盖到一块根本不长这样的屏上。
  todoPanelOpen: true,

  // 后台任务面板是否展开。刻意不落盘：这一栏是"有任务才出现"的，跨重启记住"上次收起了"
  // 只会让新任务静悄悄地被藏起来
  bgPanelOpen: true,

  // 模型列表
  modelRegistry: {},

  // 对话
  currentConversationId: null,
  conversations: [],
  messages: [],

  // 黑板
  boardCards: [],
  boardNotes: [],
  boardStrokes: [],

  // 宪法
  constitution: null,

  // 内置工具 + 自进化工具（data/evolved/）+ SKILL.md 技能 + 远程 MCP 工具
  skills: { mcp: {}, evolved: {}, skills: {}, remote: {} },

  // Actions（data/actions/*.yml 流程说明书）：内存快照，磁盘才是真源，故不落 localStorage
  actions: [],
  actionsBroken: [],

  // 项目
  project: null,        // { path, name, config, constitution, project_id } —— 当前视野那一项的展开
  projectFileTree: [],  // 当前浏览的目录内容

  // 在册项目清单（后端 data/projects.json 的只读快照，见 services/project.js）。
  // 刻意不落 localStorage：真源在服务端，本地再存一份就会出现"清单比服务端新"的窗口，
  // 切换器点下去打到一条已经不存在的记录上。
  projects: [],
  activeProjectId: "",

  // 记忆
  memories: [],

  // 用户资料
  userProfile: {},

  // 提示词素材
  promptSnippets: [],

  // 自动推进审阅（短回复停顿 + 长回复只陈述计划不行动）
  autoReview: {
    enabled: true,
    modelId: "",
    minChars: 120,
    reviewLongStall: true, // 默认积极审查长回复停顿，避免需要用户反复发送“继续”
  },

  // 输出控制：单次输出上限与“输出文件不限量”开关
  maxTokens: 64000,

  outputSettings: {
    maxTokens: 16384,
    unlimitedFileOutput: true,
  },

  // 文件写入：自动确认创建/修改（默认开；关闭后回到预览手动接受）
  fileOutput: {
    autoApply: true,
  },

  // 目标自主执行：模型自主多轮调用工具直至任务完成
  harness: {
    enabled: false,
    maxRounds: HARNESS_MAX_ROUNDS,
  },

  // Continue Autopilot：自主推进跑到轮数上限时，若任务还没干完，提醒模型继续并
  // 有界地追加轮数预算——把"用户手动再发一遍继续"换成系统自己开口。
  // 只存本机：这条偏好只有桌面循环兑现得了（移动端 m-chat 的 policy 没有末轮续跑），
  // 同步到手机只会显示"已开启"却不做事。
  continueAutopilot: true,

  // 任务完成通知：音效 + 系统通知
  notifications: {
    soundEnabled: true,
    systemNotifEnabled: false,
  },

  knowledgeSettings: {
    enabled: true,
    topK: 5,
  },
  knowledgeContext: [],

  // 专家包：当前对话激活的专家（注入 persona + rules）
  activeExpertId: "",
  activeExpert: null,

  // Responses API 模式（可选，仅部分模型支持）
  useResponses: false,

  // 首次启动引导：跨 localStorage / 桌面共享配置保存，避免 WebView profile 波动后反复弹出
  onboardingSeen: false,

  // 默认审批模式（设置页那四档改的是它）：ask=手动审批（执行命令/访问网络都问）
  // auto=自动审批（只在命中高危规则时问）full=完全访问（命令、联网直接放行，缺条件时仍会问一句）
  // night=夜间模式/全托管（命令、联网、提问都不问；灾难级命令始终由后端硬拦）
  permissionMode: "ask",
  // 审批档存档版本：见 migratePermissionModes。本版是 2，老存档没有这个键。
  permissionModeSchema: PERMISSION_MODE_SCHEMA,

  // 每一场对话自己的审批档（convId → 档）：没单独选过的场沿用上面那个默认档。
  // 键 "" 是"还没建起来的这一场"——发送时会搬给新建的会话（adoptConversationPermissionMode）。
  // 刻意不跨设备同步：审批档是"这台屏幕上谁替我点批准"，手机同步过来只会把桌面的信任档盖到别处。
  permissionModeByConversation: {},

  // 夜间模式跑任务时把电脑钉着别睡（services/keepawake.js 拿去向后端续租电源需求）。
  // 只存本机：这是"这台机器现在该不该醒着"，同步到手机只会多一个显示已开启却不兑现的开关
  // （与 continueAutopilot 同一条理由）。
  keepAwakeOnNightRun: true,

  // 旧 chatMode 键：现在只是"这一场是不是对话模式"的二值投影（由 activeModeId 推出，
  // 见 legacyChatModeOf）。存档里留着它是为了让老版本/老读取点照旧工作；
  // 读模式请用 activeModeFor / activeModeIdFor。
  chatMode: "agent",

  // 推理强度：auto=沿用模型默认（不下发字段）| off=关 | low/medium/high=档位递增
  // 实际下发字段由后端按模型 reasoning 能力映射；能力为 none 的模型一律不下发
  reasoningEffort: "auto",

  // 回复模式注册表：内置四模式固定在 store.js 的 BUILTIN_MODES，这里只放用户/模型自建的。
  // 每个条目是 normalizeModeSpec 归一后的形状（id/label/icon/color/prompt/tools/effort/rounds/model）。
  customModes: [],
  // 全局默认模式（设置页/扩展页改的是它）：没单独挑过的场跟着走。与 permissionMode 同层。
  activeModeId: "smart",
  // 每一场对话自己的回复模式（convId → modeId）：没单独选过的场沿用上面那个默认档。
  // 键 "" 是"还没建起来的这一场"——发送时会搬给新建的会话（adoptConversationMode）。
  // 刻意不跨设备同步：与 permissionModeByConversation 同一条理由，模式还牵着这一场用哪些工具。
  modeByConversation: {},

  // 联网搜索配置：engine=auto（Bing+DDG 合并）/ bing / ddg；renderJs=auto（正文过短自动渲染）/ on / off
  webSearch: { engine: "auto", renderJs: "auto" },

  // 后台终端任务（services/bg_tasks.js 轮询写入；任务本体活在后端进程里，这里只是快照）
  bgTasks: [],
  // 后端送来但还没被消费的事件（模型唤醒用；消费即清空）
  bgTaskEvents: [],
  // 认得出但不属于当前会话的消息（多半是别的项目里的任务跑完了）：先进信箱，
  // 等用户回到那场会话再搬回上面的池子。不落库——后端已经 ack 过，重启后只剩徽标。
  bgInbox: [],
  // 空闲自动续跑：任务还在跑、模型已经收工时，允许系统自己把话头接回去（每对话有次数上限）
  bgAutoResume: true,
  // 每对话已用掉几次自动续跑（convId → 次数），防"活一直干不完"时无限自转
  bgResumeUsed: {},

  // 并行运行（services/run_registry.js 是唯一真源，这里只是给订阅者看的快照）
  // 刻意不落盘：run 带着 AbortController 和内存里的气泡引用，刷新后复活成
  // "看着在跑其实早死了"的假象比不复活更糟。
  runs: [],
  // 跨项目同时最多几场（1 = 退回串行）
  maxParallelRuns: 2,
  // 同一个项目内同时最多几场。默认 1：同项目并行 = 两个 run 同时改同一批文件，
  // 坏了都查不出是谁干的；要同项目并行先开 worktree 隔离（P3）。
  maxConcurrentRunsPerProject: 1,
  // 关掉就回到 P2 之前的语义：切换会话即中断当前生成
  backgroundRuns: true,

  // 媒体生成配置：未配置 model / api_key 时对应工具（image_gen / video_gen）不可用
  imageGen: { model: "", base_url: "https://api.openai.com/v1", api_key: "" },
  videoGen: { model: "", base_url: "https://api.openai.com/v1", api_key: "" },

  // AI 辅助功能（对话/团队对话/提示词工厂以外那些会自己找模型要结果的）：
  // 功能 id → { enabled, modelId }，登记表在 services/ai_features.js。
  // 空对象 = 全用默认值（开 + 跟随主模型），所以老状态文件没这个键也一切照旧。
  aiHelpers: {},
};

// ── 订阅者 ──────────────────────────────────

const listeners = {};

function subscribe(key, fn) {
  if (!listeners[key]) listeners[key] = [];
  listeners[key].push(fn);
}

function notify(key, data) {
  (listeners[key] || []).forEach(fn => fn(data));
}

// ── 持久化 ──────────────────────────────────

function buildPersistentData() {
  return {
    theme: normalizeTheme(state.theme),
    customTheme: normalizeCustomTheme(state.customTheme),
    uiMode: state.uiMode === "codex" ? "codex" : "classic",
    modelKeys: state.modelKeys,
    customModels: state.customModels,
    currentModelId: state.currentModel?.id || state._pendingModelId || null,
    boardCards: state.boardCards,
    boardNotes: state.boardNotes,
    boardStrokes: state.boardStrokes,
    memories: state.memories,
    userProfile: state.userProfile,
    promptSnippets: state.promptSnippets,
    // 工作区记宿主目录：记当前根的话，下次启动会被当成普通单目录项目重新打开，工作区身份就丢了
    lastProjectPath: state.project?.workspace_dir || state.project?.path || null,
    conversationUsage: state.conversationUsage,
    conversationTodos: state.conversationTodos,
    taskFlags: state.taskFlags,
    taskListSort: normalizeTaskListSort(state.taskListSort),
    todoPanelOpen: state.todoPanelOpen !== false,
    maxTokens: state.maxTokens,
    modelContextCaps: state.modelContextCaps,
    modelContextWindows: state.modelContextWindows,
    autoReview: state.autoReview,
    outputSettings: state.outputSettings,
    fileOutput: state.fileOutput,
    harness: state.harness,
    // 只存本机：下面 getSharedPersistentData 刻意不收它——末轮续跑只有桌面循环实现，
    // 同步到手机只会多一个"显示已开启却不兑现"的开关
    continueAutopilot: state.continueAutopilot !== false,
    notifications: state.notifications,
    knowledgeSettings: state.knowledgeSettings,
    activeExpertId: state.activeExpertId,
    useResponses: state.useResponses,
    onboardingSeen: state.onboardingSeen === true,
    permissionMode: normalizePermissionMode(state.permissionMode),
    permissionModeSchema: PERMISSION_MODE_SCHEMA,
    permissionModeByConversation: normalizePermissionModeMap(state.permissionModeByConversation),
    keepAwakeOnNightRun: state.keepAwakeOnNightRun !== false,
    chatMode: normalizeChatMode(state.chatMode),
    reasoningEffort: state.reasoningEffort,
    customModes: normalizeCustomModes(state.customModes),
    activeModeId: normalizeModeId(state.activeModeId),
    modeByConversation: normalizeModeMap(state.modeByConversation),
    webSearch: normalizeWebSearch(state.webSearch),
    imageGen: normalizeGenConfig(state.imageGen),
    videoGen: normalizeGenConfig(state.videoGen),
    aiHelpers: normalizeAiHelpers(state.aiHelpers),
    // 后台任务本身与事件不落盘：任务活在后端进程里，重启后这些快照全无意义
    // （日志文件仍在 data/bg_tasks/）。开关与"已续跑几次"是用户偏好/配额，要跨重启。
    bgAutoResume: state.bgAutoResume !== false,
    bgResumeUsed: normalizeCountMap(state.bgResumeUsed),
    // 并行运行的三个偏好只存本机（与 continueAutopilot 同一条理由）：
    // 并行只在桌面循环里实现，同步到手机只会多几个"显示已开启却不兑现"的开关。
    maxParallelRuns: normalizeCountInt(state.maxParallelRuns, 1, 4, 2),
    maxConcurrentRunsPerProject: normalizeCountInt(state.maxConcurrentRunsPerProject, 1, 3, 1),
    backgroundRuns: state.backgroundRuns !== false,
  };
}

// 计数型偏好取值域收窄：脏值（0、负数、"abc"）回落默认，而不是拿去做除数/上限
function normalizeCountInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

function normalizePermissionMode(value) {
  return PERMISSION_MODE_IDS.includes(value) ? value : "ask";
}

// 每场的审批档：脏值（手改 localStorage、旧版本残留）整条丢掉，让它回落到默认档，
// 而不是拿一个不认识的档位去做审批判定——判定分支认不出的值必须等于"最严的那档"。
function normalizePermissionModeMap(value) {
  const src = value && typeof value === "object" ? value : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (PERMISSION_MODE_IDS.includes(v)) out[String(k)] = v;
  }
  return out;
}

// 回复模式取值域：只认 agent / chat，历史脏值一律回落智能体（旧版本行为）
function normalizeChatMode(value) {
  return ["agent", "chat"].includes(value) ? value : "agent";
}

// 推理强度取值域：auto=不下发；off/low/medium/high=后端按模型能力映射成厂商字段
function normalizeReasoningEffort(value) {
  return ["auto", "off", "low", "medium", "high"].includes(value) ? value : "auto";
}

// 模式 → 旧 chatMode 二值投影：只有「对话」模式是单轮直答，其余都按智能体跑。
// 旧的 chatMode 键在存档里留着（老版本读到它也照旧工作），但写只写这个投影，读以模式为准。
function legacyChatModeOf(modeId) {
  return modeId === "chat" ? "chat" : "agent";
}

// 模式色：只接受 hex 或 var(--x)，别的一律回落中性灰——它要直接进 CSS，脏字符串不能进。
function normalizeModeColor(value) {
  const v = String(value || "").trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
  if (/^var\(--[a-z0-9-]+\)$/.test(v)) return v;
  return "#8b949e";
}

// 自定义模式条目归一：脏字段丢干净；id 与内置冲突或为空一律判废（返回 null）。
function normalizeModeSpec(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const text = (v, n) => String(v || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
  const id = text(src.id, 40).replace(/[^\w-]/g, "");
  if (!id || BUILTIN_MODE_IDS.includes(id)) return null;
  let tools = src.tools;
  if (tools !== null && tools !== MODE_TOOLS_NONE) {
    tools = Array.isArray(tools) ? tools.map(x => text(x, 40)).filter(Boolean).slice(0, 80) : null;
  }
  return {
    id,
    label: text(src.label, 24) || id,
    icon: text(src.icon, 32) || "tool",
    color: normalizeModeColor(src.color),
    prompt: text(src.prompt, 2000),
    tools,
    effort: ["low", "medium", "high"].includes(src.effort) ? src.effort : "",
    rounds: Math.min(200, Math.max(0, Math.round(Number(src.rounds) || 0))),
    model: text(src.model, 80),
  };
}

/** 自定义模式表：逐条归一、按 id 去重、上限 60（再多选择器也放不下，还会拖慢每次读） */
function normalizeCustomModes(value) {
  const src = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const raw of src) {
    const spec = normalizeModeSpec(raw);
    if (!spec || seen.has(spec.id)) continue;
    seen.add(spec.id);
    out.push(spec);
    if (out.length >= 60) break;
  }
  return out;
}

/** 模式 id 值域：认不出的（手改存档、旧版本残留）一律回落 smart。 */
function normalizeModeId(value) {
  const id = String(value || "").trim();
  if (!id) return "smart";
  if (BUILTIN_MODE_IDS.includes(id)) return id;
  return (state.customModes || []).some(m => m.id === id) ? id : "smart";
}

// 每场的模式选择：这里刻意宽松（只要是非空字符串就留着），因为加载时自定义模式可能还没到位；
// 真正认不出的 id 由 activeModeIdFor 读的时候回落 smart，不会拿脏值去查表白名单。
function normalizeModeMap(value) {
  const src = value && typeof value === "object" ? value : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const id = String(v || "").trim();
    if (id) out[String(k)] = id;
  }
  return out;
}

// ── 模型能力 → 可选推理强度档位 ──────────────────────────────
// 桌面输入框与移动端设置页共用这一张表，两边各写一份迟早出现"移动端能选到无效档"。
// 能力取值与后端 backend/routers/proxy.py 的 REASONING_MAP 一一对应：
//   openai / effort / effort_forced = reasoning_effort（三家词表不同，见后端注释）
//   anthropic = output_config.effort / gemini = thinking_level
//   binary / adaptive = 只有 thinking.type 开关 / toggle = 布尔 enable_thinking
//   none = 一律不下发
const REASONING_LEVELS_BY_CAP = {
  openai: ["auto", "off", "low", "medium", "high"],
  effort: ["auto", "off", "low", "medium", "high"], // GLM-5.2 / 豆包 / Ollama：off 写作 none
  effort_forced: ["auto", "low", "medium", "high"], // Kimi K3 / GLM-5.3 强制思考，没有"关"
  anthropic: ["auto", "low", "medium", "high"], // 新版只有 effort 档位，没有"关"
  gemini: ["auto", "off", "low", "medium", "high"],
  binary: ["auto", "off", "low", "medium", "high"], // 低/中/高在后端收敛为"开"
  adaptive: ["auto", "off", "low", "medium", "high"], // MiniMax 同上，开档名为 adaptive
  toggle: ["auto", "off", "low", "medium", "high"], // 通义/文心只有开关
  none: ["auto"],
};

// 端点域名 → 能力。与后端 REASONING_HOST_CAPS 同源（守卫逐条比对字符串集合），
// 前端多了它只是把档位选择器打开，真正下发什么仍由后端决定。
const REASONING_CAP_BY_HOST = [
  ["https://api.openai.com", "openai"],
  ["https://api.deepseek.com", "binary"],
  ["https://api.moonshot.cn", "effort_forced"],
  ["https://api.kimi.com", "effort_forced"],
  ["https://dashscope.aliyuncs.com", "toggle"],
  ["https://open.bigmodel.cn", "effort"],
  ["https://ark.cn-beijing.volces.com", "effort"],
  ["https://api.minimax.cn", "adaptive"],
  ["https://api.minimax.io", "adaptive"],
  ["https://qianfan.baidubce.com", "toggle"],
  ["http://localhost:11434", "effort"],
  ["http://127.0.0.1:11434", "effort"],
];

// 注册表自带 reasoning 字段；自定义模型按 provider + 端点回落，未知端点一律 none（宁可不发，不可发错）
// 该回落规则与后端 _reasoning_capability 同源，由 scripts/check_reasoning_effort.mjs 锁定
function reasoningCapabilityOf(model) {
  if (!model) return "none";
  if (REASONING_LEVELS_BY_CAP[model.reasoning]) return model.reasoning;
  if (model.provider === "anthropic") return "anthropic";
  if (model.provider === "google") return "gemini";
  const url = String(model.base_url || "").trim().toLowerCase();
  for (const [prefix, cap] of REASONING_CAP_BY_HOST) {
    if (url.startsWith(prefix)) return cap;
  }
  return "none";
}

/** 该模型可选的推理强度档位；能力未知时只剩 auto。 */
function reasoningLevelsOf(model) {
  return REASONING_LEVELS_BY_CAP[reasoningCapabilityOf(model)] || REASONING_LEVELS_BY_CAP.none;
}

// 上游只有开/关两值的能力：低、中、高会被收敛成同一个值，UI 要如实说明而不是让用户以为没生效
const REASONING_COLLAPSED_CAPS = new Set(["binary", "adaptive", "toggle"]);

function normalizeWebSearch(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    engine: ["auto", "bing", "ddg"].includes(v.engine) ? v.engine : "auto",
    renderJs: ["auto", "on", "off"].includes(v.renderJs) ? v.renderJs : "auto",
  };
}

function normalizeGenConfig(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    model: typeof v.model === "string" ? v.model : "",
    base_url: typeof v.base_url === "string" && v.base_url.trim() ? v.base_url.trim() : "https://api.openai.com/v1",
    api_key: typeof v.api_key === "string" ? v.api_key : "",
  };
}

// AI 辅助功能：功能 id → { enabled, modelId }（登记表在 services/ai_features.js）。
// 刻意不按登记表过滤未知 id：登记表在下游模块，这里 import 会成环，而且多留几个键
// 无害、少留一个就等于把用户在另一台机器上的偏好悄悄丢了。
function normalizeAiHelpers(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, raw] of Object.entries(value)) {
    if (!key || !raw || typeof raw !== "object") continue;
    out[key] = {
      enabled: raw.enabled !== false,
      modelId: typeof raw.modelId === "string" ? raw.modelId : "",
    };
  }
  return out;
}

/** 计数表（convId → 非负整数）：坏值一律丢掉，别让脏数据把配额算成负数 */
function normalizeCountMap(value) {
  const v = value && typeof value === "object" ? value : {};
  const out = {};
  for (const [k, n] of Object.entries(v)) {
    const num = Number(n);
    if (k && Number.isFinite(num) && num > 0) out[k] = Math.floor(num);
  }
  return out;
}

function saveLocalPersistent(data = buildPersistentData()) {
  try { localStorage.setItem("slate_state", JSON.stringify(data)); } catch (e) {}
}

function savePersistent() {
  const data = buildPersistentData();
  saveLocalPersistent(data);
  saveSharedPersistent(data);
}

function getSharedPersistentData(data = buildPersistentData()) {
  return {
    theme: normalizeTheme(data.theme),
    // 自定义主题跟着同步：配色与字体是一台设备的偏好，手机上也该看到同一套；
    // 背景图文件只存在本机 data/theme/，手机端拿到的是"要不要用图"这个开关，取不到图时组件会自己退回无图模式。
    customTheme: normalizeCustomTheme(data.customTheme),
    uiMode: data.uiMode === "codex" ? "codex" : "classic",
    modelKeys: data.modelKeys || {},
    customModels: data.customModels || [],
    currentModelId: data.currentModelId || null,
    maxTokens: data.maxTokens || 64000,
    modelContextCaps: normalizeContextCaps(data.modelContextCaps),
    modelContextWindows: normalizeContextWindows(data.modelContextWindows),
    autoReview: data.autoReview || {},
    outputSettings: data.outputSettings || {},
    fileOutput: data.fileOutput || {},
    harness: data.harness || {},
    notifications: data.notifications || {},
    knowledgeSettings: data.knowledgeSettings || {},
    activeExpertId: data.activeExpertId || "",
    useResponses: data.useResponses === true,
    onboardingSeen: data.onboardingSeen === true,
    permissionMode: normalizePermissionMode(data.permissionMode),
    permissionModeSchema: PERMISSION_MODE_SCHEMA,
    chatMode: normalizeChatMode(data.chatMode),
    reasoningEffort: normalizeReasoningEffort(data.reasoningEffort),
    // 模式注册表与全局默认档跟着同步：内置四模式在每个设备都一样，自定义模式与"默认挑哪个"
    // 是账号级偏好，手机上该看到同一套（这一场挑的模式不同步，见 state.modeByConversation）。
    customModes: normalizeCustomModes(data.customModes),
    activeModeId: normalizeModeId(data.activeModeId),
    // 排序偏好同步；taskFlags 不同步（未读是本机概念），所以这里刻意没有它
    taskListSort: normalizeTaskListSort(data.taskListSort),
    webSearch: normalizeWebSearch(data.webSearch),
    imageGen: normalizeGenConfig(data.imageGen),
    videoGen: normalizeGenConfig(data.videoGen),
    aiHelpers: normalizeAiHelpers(data.aiHelpers),
  };
}

function saveSharedPersistent(data) {
  try {
    fetch(`${API_BASE}/settings/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: getSharedPersistentData(data) }),
    }).catch(() => {});
  } catch (e) {}
}

// 审批档的一次性搬迁：老版本把 full 当"夜间模式"，这一版 full 改判给「完全访问」。
// 为什么不能只看值：升级后用户主动挑「完全访问」存的也是 full，纯按值搬会在下次加载
// 又把它搬成 night。所以搬迁只认来源数据自己声明的 schema——老存档没有 permissionModeSchema，
// 搬一次并写上 2，此后 full 就是用户真选的完全访问。
function migratePermissionModes(source) {
  const data = source && typeof source === "object" ? source : {};
  const rawMap = data.permissionModeByConversation && typeof data.permissionModeByConversation === "object"
    ? data.permissionModeByConversation : {};
  if (Number(data.permissionModeSchema) === PERMISSION_MODE_SCHEMA) {
    return { mode: data.permissionMode, map: rawMap, migrated: false };
  }
  const move = (v) => (v === "full" ? "night" : v);
  const map = {};
  for (const [k, v] of Object.entries(rawMap)) map[k] = move(v);
  return { mode: move(data.permissionMode), map, migrated: true };
}

// 注册表中的 id 同时是 API Key 与「当前模型」的存储键，改名后必须把旧键的值搬到新键，
// 否则用户凭据会静默失联。旧键保留，便于回滚到旧版本。
const MODEL_ID_RENAMES = {
  "deepseek-chat": "deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "minimax-m3": "MiniMax-M3",
};

function migrateModelIds() {
  let changed = false;
  for (const [oldId, newId] of Object.entries(MODEL_ID_RENAMES)) {
    if (state.modelKeys[oldId] && !state.modelKeys[newId]) {
      state.modelKeys[newId] = state.modelKeys[oldId];
      changed = true;
    }
    if (state._pendingModelId === oldId) {
      state._pendingModelId = newId;
      changed = true;
    }
    if (state.autoReview?.modelId === oldId) {
      state.autoReview.modelId = newId;
      changed = true;
    }
  }
  if (changed) savePersistent();
}

function loadPersistent() {
  try {
    const raw = localStorage.getItem("slate_state");
    if (!raw) return;
    const data = JSON.parse(raw);
    const perm = migratePermissionModes(data);
    state.theme = normalizeTheme(data.theme);
    state.customTheme = normalizeCustomTheme(data.customTheme);
    state.uiMode = data.uiMode === "codex" ? "codex" : "classic";
    state.modelKeys = data.modelKeys || {};
    state.customModels = data.customModels || [];
    state.boardCards = data.boardCards || [];
    state.boardNotes = Array.isArray(data.boardNotes) ? data.boardNotes : [];
    state.boardStrokes = Array.isArray(data.boardStrokes) ? data.boardStrokes : [];
    state.memories = data.memories || [];
    state.userProfile = data.userProfile || {};
    state.promptSnippets = data.promptSnippets || [];
    state._pendingModelId = data.currentModelId;
    state._lastProjectPath = data.lastProjectPath || null;
    state.conversationUsage = data.conversationUsage || {};
    state.conversationTodos = data.conversationTodos || {};
    state.taskFlags = normalizeTaskFlags(data.taskFlags);
    state.taskListSort = normalizeTaskListSort(data.taskListSort);
    state.todoPanelOpen = data.todoPanelOpen !== false;
    state.bgAutoResume = data.bgAutoResume !== false;
    state.bgResumeUsed = normalizeCountMap(data.bgResumeUsed);
    state.maxParallelRuns = normalizeCountInt(data.maxParallelRuns, 1, 4, 2);
    state.maxConcurrentRunsPerProject = normalizeCountInt(data.maxConcurrentRunsPerProject, 1, 3, 1);
    state.backgroundRuns = data.backgroundRuns !== false;
    state.maxTokens = Math.max(1000, parseInt(data.maxTokens) || 64000);
    state.modelContextCaps = normalizeContextCaps(data.modelContextCaps);
    state.modelContextWindows = normalizeContextWindows(data.modelContextWindows);
    state.autoReview = {
      ...state.autoReview,
      ...(data.autoReview || {}),
    };
    state.outputSettings = {
      ...state.outputSettings,
      ...(data.outputSettings || {}),
    };
    state.fileOutput = {
      ...state.fileOutput,
      ...(data.fileOutput || {}),
    };
    state.harness = {
      ...state.harness,
      ...(data.harness || {}),
    };
    // 旧版本持久化的 maxRounds=20/50 统一提到当前上限：上限只放宽不收紧，
    // 收到低于上限的值就等于把"多给的预算"又悄悄拿走了
    if ((state.harness.maxRounds || 0) < HARNESS_MAX_ROUNDS) state.harness.maxRounds = HARNESS_MAX_ROUNDS;
    // 老状态文件没这个键：读成 undefined 时按默认值（开启）走
    state.continueAutopilot = data.continueAutopilot !== false;
    state.notifications = {
      ...state.notifications,
      ...(data.notifications || {}),
    };
    state.knowledgeSettings = {
      ...state.knowledgeSettings,
      ...(data.knowledgeSettings || {}),
    };
    state.activeExpertId = data.activeExpertId || "";
    state.useResponses = data.useResponses === true;
    state.onboardingSeen = data.onboardingSeen === true;
    state.permissionMode = normalizePermissionMode(perm.mode);
    state.permissionModeByConversation = normalizePermissionModeMap(perm.map);
    state.permissionModeSchema = PERMISSION_MODE_SCHEMA;
    // 老状态文件没这个键：读成 undefined 时按默认值（开启）走，与 continueAutopilot 同一口径
    state.keepAwakeOnNightRun = data.keepAwakeOnNightRun !== false;
    state.customModes = normalizeCustomModes(data.customModes);
    if (Object.prototype.hasOwnProperty.call(data, "activeModeId")) {
      state.activeModeId = normalizeModeId(data.activeModeId);
      state.chatMode = legacyChatModeOf(state.activeModeId);
    } else {
      // 更老的本地快照只有 chatMode 两值：按 agent/chat 落到 smart/chat
      state.chatMode = normalizeChatMode(data.chatMode);
      state.activeModeId = state.chatMode === "chat" ? "chat" : "smart";
    }
    state.modeByConversation = normalizeModeMap(data.modeByConversation);
    state.reasoningEffort = normalizeReasoningEffort(data.reasoningEffort);
    state.webSearch = normalizeWebSearch(data.webSearch);
    state.imageGen = normalizeGenConfig(data.imageGen);
    state.videoGen = normalizeGenConfig(data.videoGen);
    state.aiHelpers = normalizeAiHelpers(data.aiHelpers);
    migrateModelIds();
    // 搬迁过审批档就立刻落盘一次（放在末尾：此刻 state 已经整份读完，写回去的不是半成品）
    if (perm.migrated) savePersistent();
  } catch (e) {}
}

async function loadSharedPersistent() {
  try {
    const resp = await fetch(`${API_BASE}/settings/state`, { cache: "no-store" });
    if (!resp.ok) return;
    const res = await resp.json();
    const data = res?.data || {};
    state.modelKeys = { ...(data.modelKeys || {}), ...state.modelKeys };
    if (Array.isArray(data.customModels) && data.customModels.length > 0) {
      const merged = [...state.customModels];
      for (const model of data.customModels) {
        if (model?.id && !merged.some(item => item.id === model.id)) merged.push(model);
      }
      state.customModels = merged;
    }
    if (!state._pendingModelId && data.currentModelId) {
      state._pendingModelId = data.currentModelId;
    }
    if (Object.prototype.hasOwnProperty.call(data, "theme")) {
      state.theme = normalizeTheme(data.theme);
    }
    if (Object.prototype.hasOwnProperty.call(data, "customTheme")) {
      state.customTheme = normalizeCustomTheme(data.customTheme);
    }
    if (Object.prototype.hasOwnProperty.call(data, "uiMode")) {
      state.uiMode = data.uiMode === "codex" ? "codex" : "classic";
    }
    if (Object.prototype.hasOwnProperty.call(data, "maxTokens")) {
      state.maxTokens = Math.max(1000, parseInt(data.maxTokens) || 64000);
    }
    if (data.modelContextCaps && typeof data.modelContextCaps === "object") {
      state.modelContextCaps = normalizeContextCaps(data.modelContextCaps);
    }
    if (data.modelContextWindows && typeof data.modelContextWindows === "object") {
      state.modelContextWindows = normalizeContextWindows(data.modelContextWindows);
    }
    state.autoReview = {
      ...state.autoReview,
      ...(data.autoReview || {}),
    };
    state.outputSettings = {
      ...state.outputSettings,
      ...(data.outputSettings || {}),
    };
    state.fileOutput = {
      ...state.fileOutput,
      ...(data.fileOutput || {}),
    };
    state.harness = {
      ...state.harness,
      ...(data.harness || {}),
    };
    if ((state.harness.maxRounds || 0) < HARNESS_MAX_ROUNDS) state.harness.maxRounds = HARNESS_MAX_ROUNDS;
    state.notifications = {
      ...state.notifications,
      ...(data.notifications || {}),
    };
    state.knowledgeSettings = {
      ...state.knowledgeSettings,
      ...(data.knowledgeSettings || {}),
    };
    if (Object.prototype.hasOwnProperty.call(data, "activeExpertId")) {
      state.activeExpertId = data.activeExpertId || "";
    }
    if (Object.prototype.hasOwnProperty.call(data, "useResponses")) {
      state.useResponses = data.useResponses === true;
    }
    if (Object.prototype.hasOwnProperty.call(data, "onboardingSeen")) {
      state.onboardingSeen = data.onboardingSeen === true;
    }
    if (Object.prototype.hasOwnProperty.call(data, "permissionMode")) {
      state.permissionMode = normalizePermissionMode(migratePermissionModes(data).mode);
      state.permissionModeSchema = PERMISSION_MODE_SCHEMA;
    }
    if (Array.isArray(data.customModes)) {
      state.customModes = normalizeCustomModes(data.customModes);
    }
    if (Object.prototype.hasOwnProperty.call(data, "activeModeId")) {
      // 有新模式键就以它为准（自定义模式此刻已装配好，normalizeModeId 能查到它们）
      state.activeModeId = normalizeModeId(data.activeModeId);
      state.chatMode = legacyChatModeOf(state.activeModeId);
    } else if (Object.prototype.hasOwnProperty.call(data, "chatMode")) {
      // 老存档没有 activeModeId：按旧 chatMode 两值落到 smart/chat，零迁移
      state.chatMode = normalizeChatMode(data.chatMode);
      state.activeModeId = state.chatMode === "chat" ? "chat" : "smart";
    }
    if (Object.prototype.hasOwnProperty.call(data, "reasoningEffort")) {
      state.reasoningEffort = normalizeReasoningEffort(data.reasoningEffort);
    }
    if (Object.prototype.hasOwnProperty.call(data, "taskListSort")) {
      state.taskListSort = normalizeTaskListSort(data.taskListSort);
    }
    if (Object.prototype.hasOwnProperty.call(data, "webSearch")) {
      state.webSearch = normalizeWebSearch(data.webSearch);
    }
    if (Object.prototype.hasOwnProperty.call(data, "imageGen")) {
      state.imageGen = normalizeGenConfig(data.imageGen);
    }
    if (Object.prototype.hasOwnProperty.call(data, "videoGen")) {
      state.videoGen = normalizeGenConfig(data.videoGen);
    }
    if (Object.prototype.hasOwnProperty.call(data, "aiHelpers")) {
      state.aiHelpers = normalizeAiHelpers(data.aiHelpers);
    }
    migrateModelIds();
    saveLocalPersistent();
  } catch (e) {}
}

// ── 状态修改 ────────────────────────────────

function setActiveExpertId(id, detail = null) {
  state.activeExpertId = id || "";
  state.activeExpert = detail || null;
  savePersistent();
  notify("activeExpert", state.activeExpert);
}

// ── 审批模式：这一场生效哪一档 ────────────────────────────────
// 四档语义（riskguard 是唯一执行处）：ask 命令/联网都问，auto 只问高危，
// full 完全访问命令/联网不问，night 夜间模式在完全访问之上连"问你一句"也不问。
// 单独选过的场记住自己的档，没选过的跟着设置页那个默认档走。

/** 这一场生效的审批档。convId 传空 = 还没建起来的这一场（键 ""）。 */
function permissionModeFor(convId = state.currentConversationId) {
  const picked = state.permissionModeByConversation[String(convId || "")];
  if (PERMISSION_MODE_IDS.includes(picked)) return picked;
  return normalizePermissionMode(state.permissionMode);
}

/** 只给这一场挑一档；不传 convId 就是给"屏幕上这一场"挑。 */
function setPermissionModeFor(convId, mode) {
  const key = String(convId || "");
  const next = normalizePermissionMode(mode);
  if (state.permissionModeByConversation[key] === next) return;
  state.permissionModeByConversation = { ...state.permissionModeByConversation, [key]: next };
  savePersistent();
  notify("permissionMode", permissionModeFor(key));
}

/** 设置页改的是默认档：没单独选过的场跟着变，所以订阅者要重画。 */
function setDefaultPermissionMode(mode) {
  const next = normalizePermissionMode(mode);
  if (normalizePermissionMode(state.permissionMode) === next) return;
  state.permissionMode = next;
  savePersistent();
  notify("permissionMode", permissionModeFor(state.currentConversationId));
}

/** 夜间模式跑任务时要不要钉住系统别让电脑睡。值没变就不写盘也不通知。 */
function setKeepAwakeOnNightRun(enabled) {
  const next = enabled !== false;
  if ((state.keepAwakeOnNightRun !== false) === next) return;
  state.keepAwakeOnNightRun = next;
  savePersistent();
  notify("keepAwakeOnNightRun", next);
}

/**
 * 发送途中才建出会话：把"还没建起来的这一场"选的档搬给它。
 * 刻意是搬走而不是复制——下一次新对话该从默认档重新开始，
 * 否则一次"这轮放开跑"会悄悄一直生效到以后每一场新对话。
 */
function adoptConversationPermissionMode(convId) {
  const key = String(convId || "");
  if (!key || !Object.prototype.hasOwnProperty.call(state.permissionModeByConversation, "")) return;
  const pending = state.permissionModeByConversation[""];
  const rest = { ...state.permissionModeByConversation };
  delete rest[""];
  state.permissionModeByConversation = { ...rest, [key]: pending };
  savePersistent();
  notify("permissionMode", permissionModeFor(key));
}

/** 会话删掉了，它那份审批档跟着清掉（不然残留键会一直躺在状态文件里）。 */
function forgetConversationPermissionMode(convId) {
  const key = String(convId || "");
  if (!Object.prototype.hasOwnProperty.call(state.permissionModeByConversation, key)) return;
  const rest = { ...state.permissionModeByConversation };
  delete rest[key];
  state.permissionModeByConversation = rest;
  savePersistent();
}

// ── 回复模式：注册表与这一场生效哪一个 ────────────────────────
// 内置四模式不可删改（语义来自用户指定）；自定义模式可增删改。每场可各挑一个，
// 没挑过的场沿用全局默认 activeModeId；新会话从默认档重新开始（搬走不复制，与审批档同）。

/** 全部模式的只读视图：内置四个在前，自定义在后（新建的在前，浮层先看到最新的）。 */
function modeRegistry() {
  return [...BUILTIN_MODES.map(m => ({ ...m })), ...(state.customModes || []).map(m => ({ ...m }))];
}

/** 按 id 取模式；认不出的 id 回落 smart，绝不返回 undefined 让调用点自己防。 */
function modeById(id) {
  const key = String(id || "");
  return modeRegistry().find(m => m.id === key) || { ...BUILTIN_MODES[0] };
}

/** 这一场生效的模式 id。convId 传空 = 还没建起来的这一场（键 ""）。 */
function activeModeIdFor(convId = state.currentConversationId) {
  const picked = state.modeByConversation[String(convId || "")];
  if (picked && modeRegistry().some(m => m.id === picked)) return picked;
  const def = String(state.activeModeId || "");
  return modeRegistry().some(m => m.id === def) ? def : "smart";
}

/** 这一场生效的模式对象（含 prompt / tools / effort / rounds / model）。 */
function activeModeFor(convId = state.currentConversationId) {
  return modeById(activeModeIdFor(convId));
}

/** 只给这一场挑一个模式；不传 convId 就是给"屏幕上这一场"挑。 */
function setModeFor(convId, id) {
  const key = String(convId || "");
  const next = String(id || "");
  if (!modeRegistry().some(m => m.id === next)) return;
  if (state.modeByConversation[key] === next) return;
  state.modeByConversation = { ...state.modeByConversation, [key]: next };
  savePersistent();
  notify("mode", activeModeIdFor(key));
}

/** 扩展页/浮层改的是全局默认模式：没单独挑过的场跟着变，所以订阅者要重画。 */
function setDefaultMode(id) {
  const next = modeRegistry().some(m => m.id === String(id)) ? String(id) : "smart";
  if (state.activeModeId === next) return;
  state.activeModeId = next;
  state.chatMode = legacyChatModeOf(next);
  savePersistent();
  notify("mode", activeModeIdFor(state.currentConversationId));
  notify("chatMode", state.chatMode);
}

/**
 * 发送途中才建出会话：把"还没建起来的这一场"选的模式搬给它。
 * 与审批档同理——搬走而非复制，否则一次"这轮用狂暴跑"会悄悄生效到以后每一场新对话。
 */
function adoptConversationMode(convId) {
  const key = String(convId || "");
  if (!key || !Object.prototype.hasOwnProperty.call(state.modeByConversation, "")) return;
  const pending = state.modeByConversation[""];
  const rest = { ...state.modeByConversation };
  delete rest[""];
  state.modeByConversation = { ...rest, [key]: pending };
  savePersistent();
  notify("mode", activeModeIdFor(key));
}

/** 会话删掉了，它那份模式选择跟着清掉（不然残留键会一直躺在状态文件里）。 */
function forgetConversationMode(convId) {
  const key = String(convId || "");
  if (!Object.prototype.hasOwnProperty.call(state.modeByConversation, key)) return;
  const rest = { ...state.modeByConversation };
  delete rest[key];
  state.modeByConversation = rest;
  savePersistent();
}

/** 新建自定义模式（扩展页手写或模型自建都走这里）。id 重复或与内置冲突则判废返回 null。 */
function addMode(spec) {
  const clean = normalizeModeSpec(spec);
  if (!clean) return null;
  if ((state.customModes || []).some(m => m.id === clean.id)) return null;
  state.customModes = [clean, ...(state.customModes || [])].slice(0, 60);
  savePersistent();
  notify("modes", modeRegistry());
  notify("mode", activeModeIdFor(state.currentConversationId));
  return clean;
}

/** 改一个自定义模式：只补进来的字段，id 不可改（它同时是别人选中它的键）。 */
function updateMode(id, patch) {
  const key = String(id || "");
  const idx = (state.customModes || []).findIndex(m => m.id === key);
  if (idx < 0) return null;
  const merged = normalizeModeSpec({ ...state.customModes[idx], ...(patch || {}), id: key });
  if (!merged) return null;
  const next = [...state.customModes];
  next[idx] = merged;
  state.customModes = next;
  savePersistent();
  notify("modes", modeRegistry());
  notify("mode", activeModeIdFor(state.currentConversationId));
  return merged;
}

/** 删一个自定义模式：谁正选着它就回落默认档，不然会留下指向不存在模式的悬空选择。 */
function removeMode(id) {
  const key = String(id || "");
  if (!(state.customModes || []).some(m => m.id === key)) return false;
  state.customModes = state.customModes.filter(m => m.id !== key);
  const rest = {};
  for (const [k, v] of Object.entries(state.modeByConversation)) if (v !== key) rest[k] = v;
  state.modeByConversation = rest;
  if (state.activeModeId === key) {
    state.activeModeId = "smart";
    state.chatMode = legacyChatModeOf("smart");
    notify("chatMode", state.chatMode);
  }
  savePersistent();
  notify("modes", modeRegistry());
  notify("mode", activeModeIdFor(state.currentConversationId));
  return true;
}

// 旧的二值入口（agent/chat）保留为薄封装：内部就是 setDefaultMode(smart|chat)，
// 单一真源不让两套写法各自跑偏。新代码请直接用 setDefaultMode / setModeFor。
function setChatMode(mode) {
  setDefaultMode(normalizeChatMode(mode) === "chat" ? "chat" : "smart");
}

function setReasoningEffort(level) {
  const next = normalizeReasoningEffort(level);
  if (state.reasoningEffort === next) return;
  state.reasoningEffort = next;
  savePersistent();
  notify("reasoningEffort", state.reasoningEffort);
}

// 目标模式开关的唯一写入口：菜单里的手动切换与 exit_target_mode 都走这里。
// 各写各的 → 工具关了模式，「＋」菜单的开关和待机条还停在"已开启"。
function setHarnessEnabled(on) {
  state.harness = state.harness || { enabled: false, maxRounds: HARNESS_MAX_ROUNDS };
  const next = on === true;
  if (state.harness.enabled === next) return false;
  state.harness.enabled = next;
  savePersistent();
  notify("harness", state.harness.enabled);
  return true;
}

// ── 模型显式收口 ─────────────────────────────────────────
// exit_target_mode / exit_autopilot 把请求写在这里，工具循环在轮末取走一次并作废。
// 刻意不进 buildPersistentData：它只属于当前这一场运行，换会话或重启都不该带着走。
let loopExit = null;

function requestLoopExit({ mode = "", reason = "" } = {}) {
  loopExit = { mode, reason: String(reason || "").trim() };
  return loopExit;
}

function takeLoopExit() {
  const v = loopExit;
  loopExit = null;
  return v;
}

function customThemeActive() {
  return state.customTheme?.enabled === true;
}

function setTheme(t) {
  // 自定义主题生效时锁住明暗：整套令牌是从那四个源色推导的，再切一次明暗底版只会两套色互相矛盾。
  // 这里只负责"不生效"，怎么把原因说给用户由各个入口（顶栏按钮 / Ctrl+D / 手机版）自己决定——
  // 启动时也会调一次 setTheme 回灌已存主题，那种调用不该弹出"被锁了"的提示。
  if (customThemeActive()) return false;
  state.theme = normalizeTheme(t);
  document.documentElement.setAttribute("data-theme", state.theme);
  savePersistent();
  notify("theme", state.theme);
  return true;
}

function toggleTheme() {
  return setTheme(state.theme === "light" ? "dark" : "light");
}

// 打补丁式改自定义主题：colors/fonts/background/opacity 四组各自浅合并，调用方只写要动的那一格，
// 少传一格就把它冲回默认的做法在这里挡掉（合并完再过一遍 normalize，脏值照样回落）。
function setCustomTheme(patch) {
  const cur = normalizeCustomTheme(state.customTheme);
  const p = patch && typeof patch === "object" ? patch : {};
  state.customTheme = normalizeCustomTheme({
    ...cur,
    ...p,
    colors: { ...cur.colors, ...(p.colors || {}) },
    fonts: { ...cur.fonts, ...(p.fonts || {}) },
    background: { ...cur.background, ...(p.background || {}) },
    opacity: { ...cur.opacity, ...(p.opacity || {}) },
  });
  savePersistent();
  notify("customTheme", state.customTheme);
  return state.customTheme;
}

function setCurrentModel(model) {
  state.currentModel = model;
  savePersistent();
  notify("model", model);
}

function setModelKey(modelId, key) {
  if (key) {
    state.modelKeys[modelId] = key;
  } else {
    delete state.modelKeys[modelId];
  }
  savePersistent();
  notify("modelKeys", state.modelKeys);
}

function getModelKey(modelId) {
  return state.modelKeys[modelId] || "";
}

function hasModelKey(modelId) {
  return !!state.modelKeys[modelId];
}

// ── 每模型上下文预算 ───────────────────────────────────
// 余量放在最前面：上下文塞到刚好等于窗口，第一条回复就没地方写了。
const CONTEXT_HEADROOM_RATIO = 0.8;
const CONTEXT_CAP_MIN = 1024;
const CONTEXT_CAP_MAX = 4000000;
// 滑杆的粗档（大模型常用区间）与细档（本地/自定义的小窗口）。窗口只有 8K 的模型
// 只能在 100K 起跳的粗档里选，等于没得选，所以档位要按这个模型的窗口生成。
const CONTEXT_CAP_STOPS = [0, 100000, 200000, 400000, 600000, 800000, 1000000];
const CONTEXT_CAP_FINE_STOPS = [4096, 8192, 16384, 24576, 32768, 49152, 65536, 131072, 262144, 524288];
const CONTEXT_CAP_FALLBACK = 64000;

function normalizeContextCap(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 手输保留精确值：131072 这种"模型窗口本来就是那个数"不该被吸附成 100000 少掉三万。
  // 只夹到区间内，防手滑填 0 或几千万把分母弄没。
  return Math.min(CONTEXT_CAP_MAX, Math.max(CONTEXT_CAP_MIN, n));
}

function normalizeContextCaps(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [modelId, value] of Object.entries(raw)) {
    const cap = normalizeContextCap(value);
    if (cap > 0 && typeof modelId === "string" && modelId) out[modelId] = cap;
  }
  return out;
}

// 探测到的窗口独立一套：它是"这个端点实际能吃多少"，不是"我给这个模型留多少预算"。
const CONTEXT_WINDOW_MIN = 512;
const CONTEXT_WINDOW_MAX = 8000000;

function normalizeContextWindow(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < CONTEXT_WINDOW_MIN || n > CONTEXT_WINDOW_MAX) return 0;
  return n;
}

function normalizeContextWindows(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [modelId, value] of Object.entries(raw)) {
    const win = normalizeContextWindow(value);
    if (win > 0 && typeof modelId === "string" && modelId) out[modelId] = win;
  }
  return out;
}

function getModelDefinition(modelId) {
  if (!modelId) return null;
  for (const group of Object.values(state.modelRegistry || {})) {
    const hit = (group || []).find(m => m?.id === modelId);
    if (hit) return hit;
  }
  return state.customModels.find(m => m?.id === modelId) || null;
}

function getContextCap(modelId) {
  return normalizeContextCap(state.modelContextCaps?.[modelId] ?? 0);
}

function setModelContextCap(modelId, tokens) {
  if (!modelId) return;
  const cap = normalizeContextCap(tokens);
  if (cap > 0) state.modelContextCaps[modelId] = cap;
  else delete state.modelContextCaps[modelId];
  savePersistent();
  notify("modelContextCaps", state.modelContextCaps);
}

// 生效预算：这一条同时喂给上下文条与自动压缩阈值，两边不再是两个数。
// 用户显式设过的值优先，但不得超过该模型标称窗口；没设过就用它自己的默认上限。
// 只有标称窗口缺失的模型（极少数）才沿用全局「上下文 Token 上限」。
function contextBudgetOf(modelId) {
  const declared = declaredContextWindow(modelId);
  const manual = getContextCap(modelId);
  if (manual) return declared > 0 ? Math.min(manual, declared) : manual;
  const perModel = defaultContextCap(modelId);
  if (perModel) return perModel;
  return parseInt(state.maxTokens, 10) > 0 ? parseInt(state.maxTokens, 10) : CONTEXT_CAP_FALLBACK;
}

// 每模型默认上限：标称窗口 × 0.8，不吸附到滑杆档位。
// 吸附会把不同模型压成同一个数（200K/256K/128K 全变 200K），更要命的是小窗口模型
// 凑不满最低一档只能返回 0，于是"自动"对本地/自定义等于全额占用窗口、没留输出余量。
function defaultContextCap(modelId) {
  const declared = declaredContextWindow(modelId);
  if (!(declared > 0)) return 0;
  const room = Math.floor(declared * CONTEXT_HEADROOM_RATIO);
  return Math.max(Math.min(CONTEXT_CAP_MIN, declared), room);
}

// 这个模型的滑杆档位：自动(0) + 落在它窗口内的所有档 + 与"自动"等价的哪一下。
// 窗口未知时全档都给（用户自己知道端点能吃多大），标称值本身不进档位表——它没有余量。
function contextCapStops(modelId) {
  const declared = declaredContextWindow(modelId);
  const all = [...CONTEXT_CAP_STOPS.slice(1), ...CONTEXT_CAP_FINE_STOPS].sort((a, b) => a - b);
  const stops = [0, ...all.filter(n => !(declared > 0) || n <= declared)];
  const auto = defaultContextCap(modelId);
  if (auto > 0 && !stops.includes(auto)) stops.push(auto);
  return stops.sort((a, b) => a - b);
}

// 手输的精确值多半不在档位里，滑杆落在最近的一档上（数字框仍显示精确值）
function contextCapStopIndex(modelId, cap) {
  const stops = contextCapStops(modelId);
  if (!(cap > 0)) return 0;
  let best = 0;
  let bestDist = Infinity;
  stops.forEach((stop, i) => {
    if (!stop) return;
    const dist = Math.abs(stop - cap);
    if (dist < bestDist) { bestDist = dist; best = i; }
  });
  return best;
}

// 模型标称窗口：先看探测覆盖，再看注册表/自定义里填的值。
// 只做展示与封顶（预算小于它时，界面要告诉用户模型本身能吃多少）。
function declaredContextWindow(modelId) {
  const probed = getContextWindow(modelId);
  if (probed) return probed;
  return parseInt(getModelDefinition(modelId)?.context_window, 10) || 0;
}

function getContextWindow(modelId) {
  return normalizeContextWindow(state.modelContextWindows?.[modelId] ?? 0);
}

function setModelContextWindow(modelId, tokens) {
  if (!modelId) return;
  const width = normalizeContextWindow(tokens);
  if (width > 0) state.modelContextWindows[modelId] = width;
  else delete state.modelContextWindows[modelId];
  savePersistent();
  notify("modelContextWindows", state.modelContextWindows);
}

// 窗口数是从哪来的，界面要说实话：探测覆盖 / 端点自带 / 完全不知道
function contextWindowSource(modelId) {
  if (getContextWindow(modelId)) return "probed";
  if (parseInt(getModelDefinition(modelId)?.context_window, 10) > 0) return "declared";
  return "unknown";
}

// 预算是否来自用户显式设置（用于界面区分"自动"与"手动"）
function isContextCapManual(modelId) {
  return getContextCap(modelId) > 0;
}

function fmtContextTokens(n) {
  const v = parseInt(n, 10) || 0;
  if (!v) return "0";
  if (v >= 1000000) return `${(v / 1000000).toFixed(v % 1000000 ? 1 : 0)}M`;
  // 本地/自定义模型的窗口常是 6553 这类非整千值，四舍五入成 "7K" 看着像随口给的数
  if (v >= 1000) return `${v % 1000 ? (v / 1000).toFixed(1) : v / 1000}K`;
  return String(v);
}

function addCustomModel(model) {
  if (!state.customModels.find(m => m.id === model.id)) {
    state.customModels.push(model);
    savePersistent();
    notify("customModels", state.customModels);
  }
}

function updateCustomModel(originalId, model) {
  const idx = state.customModels.findIndex(m => m.id === originalId);
  if (idx < 0) return false;
  state.customModels[idx] = model;
  if (originalId !== model.id && state.modelKeys[originalId] && !state.modelKeys[model.id]) {
    state.modelKeys[model.id] = state.modelKeys[originalId];
    delete state.modelKeys[originalId];
  }
  if (state.currentModel?.id === originalId) {
    state.currentModel = model;
    notify("model", model);
  }
  savePersistent();
  notify("customModels", state.customModels);
  notify("modelKeys", state.modelKeys);
  return true;
}

function removeCustomModel(modelId) {
  const idx = state.customModels.findIndex(m => m.id === modelId);
  if (idx < 0) return false;
  state.customModels.splice(idx, 1);
  delete state.modelKeys[modelId];
  if (state.currentModel?.id === modelId) {
    state.currentModel = null;
    notify("model", null);
  }
  savePersistent();
  notify("customModels", state.customModels);
  notify("modelKeys", state.modelKeys);
  return true;
}

function resetUsage() {
  // 保存当前对话的用量
  if (state.currentConversationId) {
    state.conversationUsage[state.currentConversationId] = { ...state.usage };
  }
  state.usage = { totalTokens: 0, promptTokens: 0, completionTokens: 0, messageCount: 0 };
  notify("usage", state.usage);
}

function restoreUsageForConversation(convId) {
  const saved = state.conversationUsage[convId];
  if (saved) {
    state.usage = { ...saved };
  } else {
    state.usage = { totalTokens: 0, promptTokens: 0, completionTokens: 0, messageCount: 0 };
  }
  notify("usage", state.usage);
}

function setConversationUsage(convId, usage) {
  state.conversationUsage[convId] = { ...usage };
}

// ── TODOLIST（按对话隔离，目标任务清单） ────────

function getConversationTodos(convId) {
  return state.conversationTodos[convId || "_scratch"] || [];
}

function setConversationTodos(convId, items) {
  const key = convId || "_scratch";
  const clean = Array.isArray(items) ? items.filter(t => t && t.content) : [];
  if (!clean.length) delete state.conversationTodos[key];
  else state.conversationTodos[key] = clean;
  savePersistent();
  notify("todos", getConversationTodos(key));
}

// ── 侧栏任务状态与排序（徽标数据源，见 services/task_list.js） ────────

// 只记"上一场怎么结束的"。进行中不在这里：它由实时生成权判定，落库就会在重启后
// 留下永远转不完的僵尸态。seen 支撑"已完成未查看"，切进该会话即清。
function recordTaskFlag(convId, { kind = "", seen = false } = {}) {
  const key = convId || "";
  if (!key || !FLAG_KINDS.includes(kind)) return false;
  state.taskFlags = normalizeTaskFlags({
    ...state.taskFlags,
    [key]: { kind, at: Date.now(), seen: seen === true },
  });
  savePersistent();
  notify("taskFlags", state.taskFlags);
  return true;
}

function markTaskSeen(convId) {
  const flag = state.taskFlags?.[convId || ""];
  if (!flag || flag.seen) return false;   // 已看过就别再写盘：列表每秒重绘时这里是热路径
  flag.seen = true;
  savePersistent();
  notify("taskFlags", state.taskFlags);
  return true;
}

// 会话被删（含批量管理）后残项要跟着走：只在成功取到全量列表时剪，空列表 = 真删光
function pruneTaskFlags(existingIds) {
  const live = new Set((Array.isArray(existingIds) ? existingIds : []).filter(Boolean));
  const before = state.taskFlags || {};
  const kept = Object.fromEntries(Object.entries(before).filter(([id]) => live.has(id)));
  if (Object.keys(kept).length === Object.keys(before).length) return false;
  state.taskFlags = kept;
  savePersistent();
  notify("taskFlags", state.taskFlags);
  return true;
}

function setTaskListSort(mode) {
  const next = normalizeTaskListSort(mode);
  if (state.taskListSort === next) return false;
  state.taskListSort = next;
  savePersistent();
  notify("taskListSort", next);
  return true;
}

// 右栏 TODOLIST 折叠：值只有 true/false，undefined 一律当"展开"（老状态文件没这个键）
function setTodoPanelOpen(open) {
  const next = open !== false;
  if ((state.todoPanelOpen !== false) === next) return false;
  state.todoPanelOpen = next;
  savePersistent();
  notify("todoPanelOpen", next);
  return true;
}

function addUsage(usage, convId = state.currentConversationId) {
  if (!usage) return;
  // 后台那场的 token 记在它自己名下：不然用户切到别的项目看用量条，读到的是
  // "我什么都没干却涨了两千"
  if (String(convId || "") !== String(state.currentConversationId || "")) {
    const key = String(convId || "");
    if (!key) return;
    const saved = state.conversationUsage[key] || { totalTokens: 0, promptTokens: 0, completionTokens: 0, messageCount: 0 };
    saved.promptTokens += usage.prompt_tokens || 0;
    saved.completionTokens += usage.completion_tokens || 0;
    saved.totalTokens = saved.promptTokens + saved.completionTokens;
    saved.messageCount += 1;
    state.conversationUsage[key] = saved;
    savePersistent();
    return;
  }
  state.usage.promptTokens += usage.prompt_tokens || 0;
  state.usage.completionTokens += usage.completion_tokens || 0;
  state.usage.totalTokens = state.usage.promptTokens + state.usage.completionTokens;
  state.usage.messageCount += 1;
  notify("usage", state.usage);
}

// ── 后台任务：空闲自动续跑开关与配额 ─────────────────────────

/** 全局开关：任务还在跑、模型已收工时，是否允许系统自己把话头接回去 */
function setBgAutoResume(enabled) {
  const next = enabled !== false;
  if ((state.bgAutoResume !== false) === next) return false;
  state.bgAutoResume = next;
  savePersistent();
  notify("bgAutoResume", next);
  return true;
}

/** 该对话已用掉几次自动续跑（配额由 services/agent_loop.js 判定） */
function bgResumeUsedOf(convId) {
  const n = Number((state.bgResumeUsed || {})[convId || ""]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function markBgResumeUsed(convId) {
  const key = convId || "";
  if (!key) return 0;
  const next = bgResumeUsedOf(key) + 1;
  state.bgResumeUsed = { ...(state.bgResumeUsed || {}), [key]: next };
  savePersistent();
  notify("bgResumeUsed", state.bgResumeUsed);
  return next;
}

// ── 并行运行：三个偏好 ──────────────────────────────────────
// 上限与开关都只写 state 并落盘，判定在 services/run_registry.js 一处做——
// 两处各判一次的话，设置页改了要等下一次 notify 才生效，队列里那条就可能超发。

function setMaxParallelRuns(value) {
  const next = normalizeCountInt(value, 1, 4, 2);
  if (state.maxParallelRuns === next) return false;
  state.maxParallelRuns = next;
  savePersistent();
  notify("maxParallelRuns", next);
  return true;
}

function setMaxConcurrentRunsPerProject(value) {
  const next = normalizeCountInt(value, 1, 3, 1);
  if (state.maxConcurrentRunsPerProject === next) return false;
  state.maxConcurrentRunsPerProject = next;
  savePersistent();
  notify("maxConcurrentRunsPerProject", next);
  return true;
}

/** true = 切走会话时生成继续跑（P2 语义）；false = 切走即停（P2 之前） */
function setBackgroundRuns(enabled) {
  const next = enabled !== false;
  if ((state.backgroundRuns !== false) === next) return false;
  state.backgroundRuns = next;
  savePersistent();
  notify("backgroundRuns", next);
  return true;
}

function estimateTokens(text) {
  if (!text) return 0;
  // 粗略估算：中英文混合约 3 字符/token
  return Math.ceil(text.length / 3);
}

// ── 会话现场（每场一份消息数组） ─────────────────────────────
// 为什么不再共用一个 state.messages：并行时后台那场 run 往共用数组里追加一条，
// 订阅者就照着"整表重渲染"把可见那一场重画成后台那场的样子——串台。
// state.messages 保留为"可见那一份的引用"，今天 30 多处读它的代码一行不用改；
// 后台 run 写的是 threads 里它自己那条数组，切回那一场时复用的还是同一个数组对象
// （run 正在写的 assistant 气泡因此不会在切回来时消失）。
const threads = new Map();

function threadKey(convId) {
  return String(convId || "_scratch");
}

function messagesOf(convId) {
  return threads.get(threadKey(convId)) || [];
}

function hasThread(convId) {
  return threads.has(threadKey(convId));
}

// 会话被删时丢掉它那份现场：内存里少留一条无主数组，也避免同名 id 复用时读到旧内容
function dropThread(convId) {
  const key = threadKey(convId);
  if (key === "_scratch") return;
  if (threads.delete(key)) notify("messages", state.messages);
}

function setMessages(msgs, convId = state.currentConversationId) {
  const list = Array.isArray(msgs) ? msgs : [];
  threads.set(threadKey(convId), list);
  if (String(convId || "") === String(state.currentConversationId || "")) {
    state.messages = list;
    notify("messages", list);
  }
  notify("thread", { convId: String(convId || ""), messages: list });
}

// 静默绑定：把可见线程指到某场会话自己的数组上，不触发重渲染。
// 切回一场还在跑的对话时用得上——它那份 DOM 一直活着（在游离节点里挂着），
// 再通知一次渲染反而把已捕获的气泡引用冲掉，流式光标与砚流条会断。
function bindVisibleThread(convId) {
  const key = threadKey(convId);
  if (!threads.has(key)) threads.set(key, []);
  state.messages = threads.get(key);
  return state.messages;
}

// 手上这只数组是不是**某一场**的桶（而不是调用方自己摆的一只本场数组）。
// 用来把两件长得一样、处置相反的事分开：指到别场的桶 = 换过会话没重绑（要让位给本场自己的桶）；
// 没有主的数组 = 调用方摆的就是本场历史——kernel 起跑前会直接给 state.messages 赋一只数组，
// 它标记的渲染抑制对象就住在那只数组里，换成别的数组等于标记永远释放不掉。
function isThreadBucket(list) {
  for (const arr of threads.values()) if (arr === list) return true;
  return false;
}

function addMessage(msg, convId = state.currentConversationId) {
  const key = threadKey(convId);
  const visible = String(convId || "") === String(state.currentConversationId || "");
  if (visible) {
    // state.messages 的契约是"可见那一份的引用"，这里当场兑现，但只对"别场的桶"让位：
    // 手上这只已被本场认领、或压根没主，就认它——把它换成别的数组，等于让 kernel 标记的渲染
    // 抑制对象永远释放不掉（未执行的调用会被画成"历史恢复"卡片），也会把调用方刚摆好的本场
    // 历史整只丢掉。反过来，手上这只其实是上一场（或 _scratch）的桶时，直接往上推会把上一场
    // 的历史当成本场发出去——2026-09 实测：新对话首轮上游只收到 system。
    if (threads.get(key) !== state.messages) {
      if (isThreadBucket(state.messages)) state.messages = bindVisibleThread(convId);
      else threads.set(key, state.messages);
    }
    state.messages.push(msg);
    notify("messages", state.messages);
    notify("thread", { convId: String(convId || ""), messages: state.messages });
    return;
  }
  // 后台那场可能从没被打开过（定时任务/手机端发来的会话），数组要先建起来
  if (!threads.has(key)) threads.set(key, []);
  threads.get(key).push(msg);
  notify("thread", { convId: String(convId || ""), messages: threads.get(key) });
}

function updateLastAssistantMessage(content, convId = state.currentConversationId) {
  const visible = String(convId || "") === String(state.currentConversationId || "");
  const list = visible ? state.messages : messagesOf(convId);
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === "assistant") {
      list[i].content = content;
      if (visible) notify("messages", list);
      notify("thread", { convId: String(convId || ""), messages: list });
      return;
    }
  }
}

function setConversations(list) {
  state.conversations = list;
  notify("conversations", list);
}

function setBoardCards(cards) {
  state.boardCards = cards;
  savePersistent();
  notify("boardCards", cards);
}

function addBoardCard(card) {
  state.boardCards.push(card);
  savePersistent();
  notify("boardCards", state.boardCards);
}

function setBoardNotes(notes) {
  state.boardNotes = Array.isArray(notes) ? notes : [];
  savePersistent();
  notify("boardNotes", state.boardNotes);
}

function setBoardStrokes(strokes) {
  state.boardStrokes = Array.isArray(strokes) ? strokes : [];
  savePersistent();
  notify("boardStrokes", state.boardStrokes);
}

function setConstitution(data) {
  state.constitution = data;
  notify("constitution", data);
}

// 全局宪法与项目宪法是两份东西，各存各的：state.constitution 永远只表示本机全局版本，
// 生效哪一份由这里现算。以前是"打开项目就把 state.constitution 换成项目的"，于是
// 关掉项目后它的规则还在给无项目的对话用，切到一个没写宪法的项目又沿用上一个项目的。
function effectiveConstitution() {
  const own = state.project?.constitution;
  return own && typeof own === "object" ? own : state.constitution;
}

/** 这份宪法改下去会落到哪儿：设置页要写清楚，不然用户以为改的是全局 */
function constitutionScope() {
  const own = state.project?.constitution;
  return own && typeof own === "object" ? "project" : "global";
}

function setSkills(data) {
  state.skills = data;
  notify("skills", data);
}

/**
 * Action 目录快照（内存态）：由 /api/actions 刷新，供系统提示注入与 actions_list 复用。
 * 刻意不落 localStorage——data/actions/*.yml 才是真源，缓存一份副本只会与磁盘不一致。
 */
function setActions(data) {
  state.actions = Array.isArray(data?.actions) ? data.actions : [];
  state.actionsBroken = Array.isArray(data?.broken) ? data.broken : [];
  notify("actions", { actions: state.actions, broken: state.actionsBroken });
}

function setProject(data) {
  state.project = data;
  // 项目的宪法留在 state.project 上，由 effectiveConstitution() 现算：
  // 这里曾经直接覆写 state.constitution，关项目/换项目时没人还原，规则会串台。
  if (data) savePersistent();
  notify("project", data);
}

function setProjectFileTree(data) {
  state.projectFileTree = data;
  notify("projectFileTree", data);
}

// ── 在册项目清单（后端 projects.json 的只读快照） ──────────────
//
// 现场（上一看在哪条会话、草稿、滚动位置）存在后端注册表的 prefs 里，不在这里：
// 设计稿原本还打算把它经 settings 的 allowlist 再同步一份到 desktop_state.json，
// 落地时发现两份都是同一个 DATA_DIR 下的本地文件，"跨设备同步"这个理由并不成立，
// 多出来的只会有一个会和真源不一致的副本。所以 prefs 单点存 projects.json，
// 这里只缓存清单本身，切换器/侧栏都从这一份读。

function setProjects(list, activeId = "") {
  state.projects = Array.isArray(list) ? list : [];
  state.activeProjectId = activeId || state.projects.find(p => p?.active)?.id || "";
  notify("projects", state.projects);
}

/** 从清单里取一条记录（按 id 或名称）；没有就回 null，调用方自己决定怎么降级。 */
function projectEntryOf(key) {
  const text = String(key || "").trim();
  if (!text) return null;
  return state.projects.find(p => p?.id === text) || state.projects.find(p => p?.name === text) || null;
}

// ── 记忆管理 ────────────────────────────────

function setMemories(list) {
  state.memories = (Array.isArray(list) ? list : []).map(mem => ({
    ...mem,
    id: mem.id || makeId(),
    category: mem.category || "general",
    content: mem.content || "",
    createdAt: mem.createdAt || (mem.created_at ? Math.round(Number(mem.created_at) * 1000) : Date.now()),
  }));
  savePersistent();
  notify("memories", state.memories);
}

function addMemory(mem) {
  const newMem = {
    ...mem,
    id: mem.id || makeId(),
    category: mem.category || "general",
    content: mem.content || "",
    createdAt: mem.createdAt || (mem.created_at ? Math.round(Number(mem.created_at) * 1000) : Date.now()),
  };
  state.memories.push(newMem);
  savePersistent();
  notify("memories", state.memories);
  return newMem;
}

function updateMemory(id, updates) {
  const idx = state.memories.findIndex(m => m.id === id);
  if (idx >= 0) {
    Object.assign(state.memories[idx], updates);
    savePersistent();
    notify("memories", state.memories);
  }
}

function removeMemory(id) {
  state.memories = state.memories.filter(m => m.id !== id);
  savePersistent();
  notify("memories", state.memories);
}

// ── 用户资料 ────────────────────────────────

function setUserProfile(profile) {
  state.userProfile = { ...state.userProfile, ...profile };
  savePersistent();
  notify("userProfile", state.userProfile);
}

function resetUserProfile() {
  state.userProfile = {};
  savePersistent();
  notify("userProfile", state.userProfile);
}

// ── 提示词素材 ──────────────────────────────

function setPromptSnippets(list) {
  state.promptSnippets = (Array.isArray(list) ? list : []).map(snip => ({
    ...snip,
    id: snip.id || makeId(),
    createdAt: snip.createdAt || (snip.created_at ? Math.round(Number(snip.created_at) * 1000) : Date.now()),
  }));
  savePersistent();
  notify("promptSnippets", state.promptSnippets);
}

function setKnowledgeContext(items) {
  state.knowledgeContext = Array.isArray(items) ? items : [];
  notify("knowledgeContext", state.knowledgeContext);
}

function addPromptSnippet(snip) {
  const newSnip = {
    id: snip.id || makeId(),
    createdAt: snip.createdAt || Date.now(),
    ...snip,
  };
  state.promptSnippets.push(newSnip);
  savePersistent();
  notify("promptSnippets", state.promptSnippets);
}

function removePromptSnippet(id) {
  state.promptSnippets = state.promptSnippets.filter(s => s.id !== id);
  savePersistent();
  notify("promptSnippets", state.promptSnippets);
}

function setModelRegistry(registry) {
  state.modelRegistry = registry;
  if (state._pendingModelId) {
    let found = null;
    for (const category of Object.values(registry)) {
      found = category.find(m => m.id === state._pendingModelId);
      if (found) break;
    }
    if (!found) {
      found = state.customModels.find(m => m.id === state._pendingModelId);
    }
    if (found) {
      setCurrentModel(found);
      delete state._pendingModelId;
    }
  }
  notify("modelRegistry", registry);
}

export {
  API_BASE, state, subscribe, notify,
  setTheme, toggleTheme, setCustomTheme, customThemeActive, setCurrentModel, setModelKey, getModelKey, hasModelKey, addCustomModel, updateCustomModel, removeCustomModel,
  CONTEXT_CAP_STOPS, CONTEXT_CAP_FINE_STOPS, CONTEXT_CAP_MIN, CONTEXT_CAP_MAX, contextCapStops, contextCapStopIndex,
  getContextCap, setModelContextCap, contextBudgetOf, declaredContextWindow, defaultContextCap, isContextCapManual, fmtContextTokens,
  getContextWindow, setModelContextWindow, contextWindowSource, normalizeContextWindow, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX,
  setActiveExpertId,
  setChatMode, setReasoningEffort, normalizeChatMode, normalizeReasoningEffort,
  // 回复模式注册表：输入栏浮层与扩展页共用的读与写（提示词/白名单/旋钮接线见 tools.js 与 adapter.js）
  BUILTIN_MODES, MODE_READONLY_TOOLS, MODE_POPOVER_MAX, MODE_TOOLS_NONE,
  modeRegistry, modeById, activeModeIdFor, activeModeFor,
  setModeFor, setDefaultMode, adoptConversationMode, forgetConversationMode,
  addMode, updateMode, removeMode,
  setHarnessEnabled, requestLoopExit, takeLoopExit,
  REASONING_LEVELS_BY_CAP, reasoningCapabilityOf, reasoningLevelsOf, REASONING_COLLAPSED_CAPS, getModelDefinition,
  resetUsage, restoreUsageForConversation, setConversationUsage, addUsage, estimateTokens,
  getConversationTodos, setConversationTodos,
  recordTaskFlag, markTaskSeen, pruneTaskFlags, setTaskListSort, setTodoPanelOpen,
  setBgAutoResume, bgResumeUsedOf, markBgResumeUsed,
  setMaxParallelRuns, setMaxConcurrentRunsPerProject, setBackgroundRuns,
  // 审批模式：这一场生效哪一档的读与写（判口在 services/riskguard.js）
  permissionModeFor, setPermissionModeFor, setDefaultPermissionMode, setKeepAwakeOnNightRun,
  adoptConversationPermissionMode, forgetConversationPermissionMode,
  loadSharedPersistent,
  setMessages, addMessage, updateLastAssistantMessage, messagesOf, hasThread, dropThread, bindVisibleThread,
  setConversations, setBoardCards, addBoardCard, setBoardNotes, setBoardStrokes,
  setConstitution, effectiveConstitution, constitutionScope, setSkills, setActions, setModelRegistry,
  setProject, setProjectFileTree, setProjects, projectEntryOf,
  setMemories, addMemory, updateMemory, removeMemory,
  setUserProfile, resetUserProfile,
  setPromptSnippets, addPromptSnippet, removePromptSnippet,
  setKnowledgeContext,
  savePersistent, loadPersistent,
};
