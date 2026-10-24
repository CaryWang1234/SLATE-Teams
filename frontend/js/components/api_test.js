/**
 * 设置页 API 测试：拿一条最短指令打一次真实链路，看密钥/端点/模型 ID 是否可用。
 *
 * 只走 services/api.js 的 streamChat，与对话、压缩、白板用的是同一条路，
 * 因此这里成功而对话失败，才说明问题不在鉴权与端点配置上。
 * 首字延迟单独计时：连接通但迟迟不出字，多半是上游排队或被中间层吞了流。
 */

import { state, subscribe, getModelKey } from "../store.js?v=20261024-001";
import { streamChat, REASONING_PREFIX } from "../services/api.js?v=20261024-001";
import { t } from "../services/i18n.js?v=20261024-001";

const TEST_MAX_TOKENS = 64;
const PREVIEW_MAX = 400;

let sel, promptEl, btnRun, btnStop, statusEl, resultEl;
let controller = null;

function allModels() {
  const all = [];
  for (const models of Object.values(state.modelRegistry || {})) all.push(...models);
  all.push(...(state.customModels || []));
  return all;
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = `api-test-status${kind ? ` is-${kind}` : ""}`;
}

function setRunning(running) {
  btnRun.disabled = running;
  btnRun.classList.toggle("hidden", running);
  btnStop.classList.toggle("hidden", !running);
  sel.disabled = running;
}

/** 模型下拉：未配密钥的标出来，省得测完才发现是 Key 没填 */
export function refreshApiTestModels() {
  if (!sel) return;
  const models = allModels();
  const prev = sel.value || state.currentModel?.id || "";
  sel.textContent = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = getModelKey(m.id) ? (m.name || m.id) : `${m.name || m.id} · ${t("未配密钥")}`;
    sel.appendChild(opt);
  }
  if (models.some(m => m.id === prev)) sel.value = prev;
}

function metric(key, value) {
  const row = document.createElement("div");
  row.className = "at-metric";
  const k = document.createElement("span");
  k.className = "at-metric-key";
  k.textContent = key;
  const v = document.createElement("b");
  v.textContent = value;
  row.append(k, v);
  return row;
}

function renderResult(data) {
  resultEl.textContent = "";
  resultEl.classList.remove("hidden");
  resultEl.classList.toggle("is-failed", !data.ok && !data.stopped);

  const head = document.createElement("div");
  head.className = "at-result-head";
  head.textContent = `${data.label}${data.provider ? ` · ${data.provider}` : ""}`;
  resultEl.append(head);

  const grid = document.createElement("div");
  grid.className = "at-metrics";
  grid.append(metric(t("状态"), data.ok ? t("通过") : (data.stopped ? t("已停止") : t("失败"))));
  if (data.ttft != null) grid.append(metric(t("首字延迟"), fmtMs(data.ttft)));
  grid.append(metric(t("总耗时"), fmtMs(data.total)));
  if (data.chars) grid.append(metric(t("输出字符"), String(data.chars)));
  if (data.reasoningChars) grid.append(metric(t("思考字符"), String(data.reasoningChars)));
  if (data.finishReason) grid.append(metric(t("结束原因"), data.finishReason));
  resultEl.append(grid);

  const body = document.createElement("pre");
  body.className = "at-body";
  body.textContent = data.ok || data.reply ? (data.reply || t("（空回复）")) : (data.error || t("未知错误"));
  resultEl.append(body);
}

async function runTest() {
  const modelId = sel.value;
  if (!modelId) { setStatus(t("请先选择模型"), "err"); return; }
  const model = allModels().find(m => m.id === modelId);
  const prompt = (promptEl.value || "").trim() || t("只回复四个字：链路正常");

  controller = new AbortController();
  setRunning(true);
  setStatus(t("测试中…"), "run");
  resultEl.classList.add("hidden");

  const startedAt = performance.now();
  let firstTokenAt = 0;
  let reply = "";
  let reasoningChars = 0;
  const meta = {};

  try {
    for await (const chunk of streamChat({
      model: modelId,
      provider: model?.provider || state.currentModel?.provider,
      messages: [{ role: "user", content: prompt }],
      api_key: getModelKey(modelId),
      base_url: model?.base_url || undefined,
      temperature: 0,
      max_tokens: TEST_MAX_TOKENS,
      use_responses: state.useResponses === true,
      stream: true,
      signal: controller.signal,
      meta,
    })) {
      if (!firstTokenAt) firstTokenAt = performance.now();
      if (chunk.startsWith(REASONING_PREFIX)) reasoningChars += chunk.length - REASONING_PREFIX.length;
      else reply += chunk;
    }
    const total = performance.now() - startedAt;
    const text = reply.trim();
    renderResult({
      ok: !!text,
      label: model?.name || modelId,
      provider: model?.provider,
      ttft: firstTokenAt ? firstTokenAt - startedAt : null,
      total,
      chars: text.length,
      reasoningChars,
      finishReason: meta.finishReason,
      reply: text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + "…" : text,
      error: t("连接正常，但没有返回任何可显示文本。"),
    });
    setStatus(text ? t("通过") : t("无内容"), text ? "ok" : "err");
  } catch (err) {
    const stopped = err?.name === "AbortError";
    renderResult({
      ok: false,
      stopped,
      label: model?.name || modelId,
      provider: model?.provider,
      ttft: firstTokenAt ? firstTokenAt - startedAt : null,
      total: performance.now() - startedAt,
      chars: reply.trim().length,
      reasoningChars,
      reply,
      error: String(err?.message || err),
    });
    setStatus(stopped ? t("已停止") : t("失败"), stopped ? "" : "err");
  } finally {
    controller = null;
    setRunning(false);
  }
}

export function initApiTest() {
  sel = document.getElementById("api-test-model");
  promptEl = document.getElementById("api-test-prompt");
  btnRun = document.getElementById("btn-api-test");
  btnStop = document.getElementById("btn-api-test-stop");
  statusEl = document.getElementById("api-test-status");
  resultEl = document.getElementById("api-test-result");
  if (!sel || !btnRun) return;

  refreshApiTestModels();
  subscribe("modelRegistry", refreshApiTestModels);
  subscribe("customModels", refreshApiTestModels);
  subscribe("modelKeys", refreshApiTestModels);
  btnRun.addEventListener("click", runTest);
  btnStop.addEventListener("click", () => controller?.abort());
}
