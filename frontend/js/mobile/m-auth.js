/**
 * SLATE Mobile — 审批与变更确认
 * 1. mApprovalSheet：移动端的审批脸（底部 sheet），挂到 window.__slateGuardUi 上替桌面 modal
 * 2. mHandleStructured：file_edit/file_create 的 diff 预览 → 接受/拒绝（file_append 调用时即写入）
 */

import { state, getModelKey } from "../store.js?v=20261017-001";
import { post } from "../services/api.js?v=20261017-001";
import { aiModelFor, isAiFeatureOn } from "../services/ai_features.js?v=20261017-001";
import { mShowRiskSheet, mShowDiffSheet, mToast, t } from "./m-ui.js?v=20261017-001";

/** 用当前模型解释命令目的（与桌面 explainCommand 同一逻辑，失败返回兜底文案） */
async function mExplainCommand(command) {
  // 与桌面同一档：关掉就少发一趟请求，审批照常有
  if (!isAiFeatureOn("command_explain")) return t("（命令目的说明已关闭，可在桌面端设置 → AI 辅助功能打开）");
  const target = aiModelFor("command_explain", state.currentModel);
  if (!target.usable) return t("（当前未配置模型或 API Key，无法生成目的说明）");
  try {
    const res = await post("/proxy/chat", {
      model: target.id,
      api_key: target.key,
      base_url: target.base_url || "",
      provider: target.provider || "",
      stream: false,
      temperature: 0.2,
      max_tokens: 200,
      messages: [
        { role: "system", content: "你是终端命令安全分析器。用一两句话客观解释该命令的目的与潜在影响，不超过60字，不要给出执行建议" },
        { role: "user", content: command },
      ],
    });
    const text = res?.data?.choices?.[0]?.message?.content?.trim();
    return text || t("（模型未返回说明）");
  } catch (e) {
    return t("（说明生成失败: {msg}）", { msg: e.message });
  }
}

/**
 * 手机遥控的审批 UI：底部那张 sheet 替桌面那副 modal。
 * 判口（哪一档问什么）留在 riskguard.approvalNeededFor，这里只管"怎么问"——
 * 两边各存一份档位判断，迟早出现"手机问得比桌面多"或反过来。
 */
export async function mApprovalSheet(subject, risk) {
  const isCommand = subject.kind === "command";
  const highRisk = Boolean(risk?.risk);
  const explain = isCommand ? await mExplainCommand(subject.target) : null;
  return mShowRiskSheet({
    title: t(highRisk ? "高危命令确认" : isCommand ? "命令执行确认" : "联网访问确认"),
    subjectLabel: t(isCommand ? "命令" : "访问目标"),
    target: subject.target,
    reason: highRisk
      ? t("触发规则：{reason}", { reason: t(risk.reason) })
      : t("当前审批模式：{why}", { why: t(isCommand ? "手动审批下执行命令逐条确认" : "手动审批下访问网络逐条确认") }),
    explain,
    note: t(isCommand ? "批准后命令将直接执行，请确认已理解其影响" : "批准后 AI 将访问上面的地址并读取返回内容"),
  });
}

/**
 * 处理结构化工具结果（file_edit / file_create / file_append）。
 * applied === "auto" 或 file_append 已直接写入磁盘 → 直接返回 "applied"。
 * 否则弹 diff sheet：接受 → 调后端落盘；拒绝 → 仅标记不写盘。
 * 返回 "applied" | "accepted" | "rejected" | "skipped"
 */
export async function mHandleStructured(structured) {
  if (!structured || !structured._type) return "skipped";
  const type = structured._type;
  if (!["file_edit", "file_create", "file_append"].includes(type)) return "skipped";
  if (structured.applied === "auto" || structured.applied === true) return "applied";

  const path = structured.file_path_rel || structured.file_name || structured.file || "";
  const diff = structured.diff || "";
  if (!diff && structured.errors?.length) {
    mToast(structured.errors[0], 3500);
    return "rejected";
  }

  const decision = await mShowDiffSheet({ filePath: path, diff, title: t("文件变更预览 · {type}", { type: type }) });
  if (decision !== "accept") {
    if (decision === "reject") mToast(t("已拒绝写入"));
    return "rejected";
  }

  try {
    // run_id 跟着这一轮走：用户在这里点「接受」的写入，也要记进提议它的那一轮清单，
    // 否则关掉自动应用之后「本轮总结」会一件都不报。
    const runId = structured._runId || "";
    let res;
    if (type === "file_edit") {
      res = await post("/projects/apply-edit", { file_path: structured.file, content: structured.new_content, run_id: runId });
    } else if (type === "file_create") {
      res = await post("/projects/create-file", { file_path: structured.file, content: structured.content, run_id: runId });
    } else {
      res = await post("/projects/append-file", { file_path: structured.file, content: structured.content, run_id: runId });
    }
    if (res.code === 0) {
      mToast(t("已写入磁盘"));
      return "accepted";
    }
    mToast(t("写入失败: {msg}", { msg: res.message || t("未知错误") }), 3500);
    return "rejected";
  } catch (e) {
    mToast(t("写入失败: {msg}", { msg: e.message }), 3500);
    return "rejected";
  }
}

export { t };
