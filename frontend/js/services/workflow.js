/**
 * SLATE 工作流引擎：DAG 并行执行、节点状态机、产物入库
 * - 依赖后端 /workflows 读取定义、/proxy/chat 调用模型、/skills/execute 复用技能链路
 * - 执行完成后通过 /knowledge/docs 复用现有知识库写入逻辑
 * - 支持并行节点：无依赖关系的节点同时执行
 * - 支持 AbortController 中断
 */

import { get, post } from "./api.js?v=20261024-001";
import { state, getModelKey } from "../store.js?v=20261024-001";
import { aiModelFor, isAiFeatureOn } from "./ai_features.js?v=20261024-001";
import { guardSkillCall } from "./riskguard.js?v=20261024-001";
import { t } from "./i18n.js?v=20261024-001";
import { makeId } from "./utils.js?v=20261024-001";

const STATUS = { WAITING: "waiting", RUNNING: "running", SUCCESS: "success", FAILED: "failed", SKIPPED: "skipped" };

// ── 中断控制 ────────────────────────────────

let _workflowAbort = null;

function stopWorkflow() {
  if (_workflowAbort) {
    _workflowAbort.abort();
    _workflowAbort = null;
  }
}

// ── 定义读取 ────────────────────────────────

async function loadWorkflows() {
  const res = await get("/workflows");
  if (res.code !== 0) throw new Error(res.message || "工作流列表加载失败");
  return res.data || [];
}

async function getWorkflow(id) {
  const res = await get(`/workflows/${encodeURIComponent(id)}`);
  if (res.code !== 0) throw new Error(res.message || "工作流加载失败");
  return res.data;
}

// ── DAG 工具 ────────────────────────────────

/** 合并显式 edges 与 inputs 隐式引用（$node_id），构建前置依赖表 */
function buildDeps(wf) {
  const ids = new Set((wf.nodes || []).map(n => n.id));
  const preds = new Map([...ids].map(id => [id, new Set()]));
  const addEdge = (from, to) => {
    if (!ids.has(from) || !ids.has(to) || from === to) return;
    preds.get(to).add(from);
  };
  for (const e of wf.edges || []) addEdge(e.from, e.to);
  for (const n of wf.nodes || []) {
    for (const v of Object.values(n.inputs || {})) {
      if (typeof v === "string" && v.startsWith("$") && v !== "$input" && ids.has(v.slice(1))) {
        addEdge(v.slice(1), n.id);
      }
    }
  }
  return preds;
}

/** Kahn 拓扑排序；有环时返回 error */
function topoSort(wf) {
  const preds = buildDeps(wf);
  const indeg = new Map([...preds].map(([id, s]) => [id, s.size]));
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const [other, s] of preds) {
      if (s.has(id)) {
        indeg.set(other, indeg.get(other) - 1);
        if (indeg.get(other) === 0) queue.push(other);
      }
    }
  }
  if (order.length < preds.size) {
    const cyclic = [...preds.keys()].filter(id => !order.includes(id));
    return { order: [], error: t("DAG 存在环，涉及节点: {nodes}", { nodes: cyclic.join(", ") }) };
  }
  return { order, error: null };
}

/** 计算每个节点的层级（用于并行分组） */
function computeLevels(wf) {
  const preds = buildDeps(wf);
  const levels = new Map();
  const compute = (id) => {
    if (levels.has(id)) return levels.get(id);
    const p = preds.get(id);
    if (!p || p.size === 0) { levels.set(id, 0); return 0; }
    const lv = Math.max(...[...p].map(pid => compute(pid))) + 1;
    levels.set(id, lv);
    return lv;
  };
  for (const id of preds.keys()) compute(id);
  return levels;
}

// ── 变量解析 ────────────────────────────────

/** $input = 用户输入，$node_id = 上游节点输出；其余视为字面量 */
function resolveVar(value, userInput, outputs) {
  if (typeof value !== "string") return value == null ? "" : String(value);
  if (value === "$input") return userInput;
  if (value.startsWith("$")) {
    const refId = value.slice(1);
    if (refId in outputs) return outputs[refId];
  }
  return value;
}

function resolveInputs(node, userInput, outputs) {
  const vars = {};
  for (const [key, value] of Object.entries(node.inputs || {})) {
    vars[key] = resolveVar(value, userInput, outputs);
  }
  return vars;
}

function fillTemplate(tpl, vars) {
  return String(tpl || "").replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (match, key) =>
    key in vars ? String(vars[key]) : match
  );
}

function truncate(text, max = 300) {
  const s = String(text || "");
  return s.length > max ? s.slice(0, max) + "..." : s;
}

// ── 节点绑定解析 ────────────────────────────

function findModelName(modelId) {
  if (!modelId) return "";
  for (const models of Object.values(state.modelRegistry || {})) {
    const found = models.find(m => m.id === modelId);
    if (found) return found.name;
  }
  const custom = (state.customModels || []).find(m => m.id === modelId);
  return custom?.name || modelId;
}

/** 优先级：role 绑定团队成员（沿用其模型与人设） > node.model > 「AI 辅助功能」指定档 > 当前模型 */
function resolveBinding(node, members) {
  let member = null;
  if (node.role) {
    member = (members || []).find(m => m.role === node.role || m.name === node.role) || null;
  }
  const target = aiModelFor("workflow_dag", state.currentModel);
  const modelId = member?.modelId || node.model || target.id || "";
  return {
    member, modelId,
    modelLabel: findModelName(modelId), persona: member?.persona || "",
    // 只有落在默认档上时才带 Key 兜底：绑定的人/节点自己指定的模型该由它自己的 Key 说话
    key: modelId && modelId === target.id ? target.key : "",
  };
}

// ── 单节点执行 ────────────────────────────

async function executeNode(node, userInput, outputs, members, rec) {
  rec.status = STATUS.RUNNING;
  rec.startedAt = Date.now();

  const vars = resolveInputs(node, userInput, outputs);
  rec.inputPreview = Object.entries(node.inputs || {})
    .map(([key, raw]) => `{{${key}}} = ${raw} => ${truncate(vars[key], 120)}`)
    .join("\n");

  let output;
  if (node.skill) {
    rec.modelLabel = `[技能] ${node.skill}`;
    const params = {};
    for (const [key, raw] of Object.entries(node.inputs || {})) params[key] = vars[key] ?? raw;
    // 工作流跑在屏幕上这一场：命令/联网要不要逐条问，按这一场的审批档
    const verdict = await guardSkillCall(node.skill, params);
    if (!verdict.ok) throw new Error(verdict.message);
    const res = await post("/skills/execute", { skill: node.skill, params });
    if (res.code !== 0) throw new Error(res.message || t("技能 {name} 执行失败", { name: node.skill }));
    output = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
  } else {
    const binding = resolveBinding(node, members);
    rec.modelLabel = binding.modelLabel || binding.modelId;
    if (!binding.modelId) throw new Error(t("节点未绑定可用模型（role/model 均为空且无当前模型）"));
    // 绑定/节点自己指定的模型仍按 modelKeys 取 Key；落在默认档上时用解析器给的 Key
    //（本地模型没有 Key 也能跑，所以这里不能只认 modelKeys 那一份）
    const apiKey = getModelKey(binding.modelId) || binding.key || "";
    if (!apiKey) throw new Error(t("模型 {name} 未配置 API Key，请先在设置页配置", { name: rec.modelLabel }));

    const systemPrompt = binding.persona || "你是 SLATE 工作流的执行成员：认真完成分配的任务，紧扣任务要求作答，只输出结果本身，不要寒暄与前言后语。";
    const userPrompt = fillTemplate(node.prompt || "", vars);
    const res = await post("/proxy/chat", {
      model: binding.modelId,
      api_key: apiKey,
      stream: false,
      temperature: node.temperature ?? 0.5,
      max_tokens: node.max_tokens || 1200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    if (res.code !== 0) throw new Error(res.message || "模型请求失败");
    output = res.data?.choices?.[0]?.message?.content ?? "";
    if (!String(output).trim()) throw new Error("模型返回内容为空");
  }

  rec.status = STATUS.SUCCESS;
  rec.output = String(output);
  rec.finishedAt = Date.now();
  return output;
}

// ── 并行执行引擎 ────────────────────────────

function makeRunId() {
  return makeId();
}

/**
 * 并行执行工作流：无依赖关系的节点同时运行
 * hooks: { onNode(record), onDone(result) }
 */
async function runWorkflow(wf, userInput, members, hooks = {}) {
  // 整条链一步模型都要发，所以关在这里判：抛错让面板把这次运行标红，而不是默默产出空结果
  if (!isAiFeatureOn("workflow_dag")) throw new Error(t("团队工作流已在「设置 → AI 辅助功能」中关闭"));
  const { order, error } = topoSort(wf);
  if (error) throw new Error(error);

  // 设置中断控制器
  _workflowAbort = new AbortController();
  const signal = _workflowAbort.signal;

  const nodeMap = new Map((wf.nodes || []).map(n => [n.id, n]));
  const preds = buildDeps(wf);
  const records = {};
  const outputs = {};
  for (const n of wf.nodes || []) {
    records[n.id] = {
      id: n.id, name: n.name, status: STATUS.WAITING,
      skill: n.skill || "", outputKey: n.output_key || n.id,
      modelLabel: "", inputPreview: "", output: "", error: "",
      startedAt: 0, finishedAt: 0,
    };
  }

  const result = {
    runId: makeRunId(), workflowId: wf.id, workflowName: wf.name,
    startedAt: Date.now(), finishedAt: 0, order, records, outputs,
    parallel: true,
  };

  try {
    // 并行调度：反复找"所有依赖已满足"的节点批量执行
    const done = new Set();     // 已完成的节点 ID
    const failed = new Set();   // 失败的节点 ID
    const skipped = new Set();  // 跳过的节点 ID

    while (done.size + failed.size + skipped.size < order.length) {
      // 检查中断
      if (signal.aborted) {
        // 将所有 waiting 节点标记为 skipped
        for (const id of order) {
          if (records[id].status === STATUS.WAITING) {
            records[id].status = STATUS.SKIPPED;
            records[id].error = t("工作流已被手动停止");
            records[id].finishedAt = Date.now();
            hooks.onNode?.(records[id]);
          }
        }
        break;
      }

      // 找所有 ready 节点（依赖全部 done）
      const ready = [];
      for (const id of order) {
        if (records[id].status !== STATUS.WAITING) continue;
        const deps = preds.get(id) || new Set();
        const allDone = [...deps].every(d => done.has(d));
        if (allDone) ready.push(id);
      }

      // 找所有 blocked 节点（有依赖 failed/skipped）
      for (const id of order) {
        if (records[id].status !== STATUS.WAITING) continue;
        const deps = preds.get(id) || new Set();
        const blocked = [...deps].some(d => failed.has(d) || skipped.has(d));
        if (blocked) {
          const blockedBy = [...deps].filter(pid =>
            records[pid].status === STATUS.FAILED || records[pid].status === STATUS.SKIPPED
          );
          records[id].status = STATUS.SKIPPED;
          records[id].error = t("上游节点未成功（{names}），自动跳过", { names: blockedBy.map(pid => records[pid].name).join("、") });
          records[id].finishedAt = Date.now();
          skipped.add(id);
          hooks.onNode?.(records[id]);
        }
      }

      if (ready.length === 0) {
        // 没有 ready 也没有 blocked，可能是全部完成或死锁
        break;
      }

      // 并行执行所有 ready 节点
      if (ready.length === 1) {
        // 单节点直接执行
        const id = ready[0];
        const node = nodeMap.get(id);
        const rec = records[id];
        hooks.onNode?.({ ...rec, status: STATUS.RUNNING });
        try {
          const output = await executeNode(node, userInput, outputs, members, rec);
          outputs[id] = output;
          done.add(id);
        } catch (e) {
          rec.status = STATUS.FAILED;
          rec.error = e.message || String(e);
          rec.finishedAt = Date.now();
          failed.add(id);
        }
        hooks.onNode?.(rec);
      } else {
        // 多节点并行执行
        const promises = ready.map(async (id) => {
          const node = nodeMap.get(id);
          const rec = records[id];
          hooks.onNode?.({ ...rec, status: STATUS.RUNNING });
          try {
            const output = await executeNode(node, userInput, outputs, members, rec);
            outputs[id] = output;
            done.add(id);
          } catch (e) {
            rec.status = STATUS.FAILED;
            rec.error = e.message || String(e);
            rec.finishedAt = Date.now();
            failed.add(id);
          }
          hooks.onNode?.(rec);
          return rec;
        });
        await Promise.all(promises);
      }
    }
  } catch (e) {
    // 全局异常：标记所有 waiting 为 skipped
    for (const id of order) {
      if (records[id].status === STATUS.WAITING || records[id].status === STATUS.RUNNING) {
        records[id].status = STATUS.SKIPPED;
        records[id].error = e.message || String(e);
        records[id].finishedAt = Date.now();
        hooks.onNode?.(records[id]);
      }
    }
  }

  // 清理中断控制器
  _workflowAbort = null;
  result.finishedAt = Date.now();
  hooks.onDone?.(result);
  return result;
}

// ── 产物写入 knowledge（复用现有 /knowledge/docs 链路） ──

async function saveRunToKnowledge(wf, result) {
  const statusMark = { success: "成功", failed: "失败", skipped: "跳过", waiting: "等待", running: "运行中" };
  const recs = result.order.map(id => result.records[id]);
  const okCount = recs.filter(r => r.status === STATUS.SUCCESS).length;
  const finalNodeId = [...result.order].reverse().find(id => result.records[id].status === STATUS.SUCCESS);
  const finalOutput = finalNodeId ? result.records[finalNodeId].output : "（无成功节点产出）";

  let content = `# 工作流产物 · ${wf.name}\n\n`;
  content += `- 工作流 ID: \`${wf.id}\`\n`;
  content += `- 运行 ID: \`${result.runId}\`\n`;
  content += `- 运行时间: ${new Date(result.startedAt).toLocaleString()}\n`;
  content += `- 节点结果: ${okCount}/${recs.length} 成功\n`;
  content += `- 并行执行: ${result.parallel ? "是" : "否"}\n\n`;
  content += `## 节点摘要\n\n`;
  for (const r of recs) {
    content += `### ${statusMark[r.status] || ""} ${r.name}（${r.outputKey}）\n`;
    content += `绑定: ${r.modelLabel || "无"} · 状态: ${r.status}`;
    if (r.startedAt && r.finishedAt) content += ` · 耗时 ${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s`;
    content += "\n\n";
    if (r.error) content += `> 错误: ${r.error}\n\n`;
    if (r.output) content += truncate(r.output, 800) + "\n\n";
  }
  content += `## 最终结果\n\n${finalOutput}\n`;

  const res = await post("/knowledge/docs", {
    title: `工作流产物 · ${wf.name}`,
    source: "workflow",
    kind: "workflow",
    content,
    metadata: {
      workflow_id: wf.id,
      run_id: result.runId,
      workflow_name: wf.name,
      node_count: recs.length,
      success_count: okCount,
      parallel: result.parallel,
      started_at: result.startedAt,
      finished_at: result.finishedAt,
    },
  });
  if (res.code !== 0) throw new Error(res.message || t("写入知识库失败"));
  return res.data?.id;
}

export { STATUS, loadWorkflows, getWorkflow, topoSort, computeLevels, runWorkflow, stopWorkflow, saveRunToKnowledge };
