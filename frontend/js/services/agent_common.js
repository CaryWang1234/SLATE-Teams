/**
 * 三端 agent 工具循环共享的纯函数与状态标记（砚流 P0）。
 * 发给模型的字符串按平台逐字固定在这里或调用方的常量里，一律不经 t()——措辞变动会影响模型行为。
 */

// 正在工具执行循环中（尚未执行或正在执行）的 assistant 消息。
// 渲染时对这些消息不合成"历史恢复"卡片，避免把未执行的调用伪装成成功执行。
const _pendingToolMsgs = new Set();
// 并行时不能 clear()：先散场的那场会把后面那场还在跑的标记一并清掉，
// 后者的工具气泡就会被画成「历史恢复」的样子（未执行的调用被装成已执行）。
// 按一场会话的消息数组释放，才停得这一场自己的那些。
function releasePendingFor(msgs) {
  for (const m of msgs || []) _pendingToolMsgs.delete(m);
}


// 上下文压缩写回的摘要消息前缀。这个字符串就是发往模型的载荷本身，
// 渲染层只据它把摘要折起来，不许因为显示而改格式。
const HISTORY_SUMMARY_PREFIX = "[历史摘要]:";

function isHistorySummary(msg) {
  return !!msg && msg.role === "system" && typeof msg.content === "string"
    && msg.content.trimStart().startsWith(HISTORY_SUMMARY_PREFIX);
}

function toolCallSignature(call) {
  return `${call?.name || ""}:${JSON.stringify(call?.params || {})}`;
}

function dedupeToolCalls(calls) {
  const seen = new Set();
  const unique = [];
  for (const call of calls || []) {
    const sig = toolCallSignature(call);
    if (seen.has(sig)) continue;
    seen.add(sig);
    unique.push(call);
  }
  return unique;
}

/**
 * 截断守卫谓词：输出达到长度上限导致工具调用块未闭合、参数不完整。
 * file_create/file_append 截断时已输出的 content 仍是有效前缀，允许执行预览并靠后续 file_append 补齐；
 * 其余工具（尤其 file_edit 的部分编辑）执行残缺参数很危险。
 */
function isTruncatedUnexecutable(call) {
  return Boolean(call?.params?._truncated) && call.name !== "file_append" && call.name !== "file_create";
}

const DESKTOP_TOOL_RESULT_STATUS = {
  auto: "Status: written to disk (auto-confirmed by user setting; no manual acceptance needed; verify via project_read_file if necessary).",
  preview: "Status: preview only; not written to disk until the user accepts.",
  isWritten: (applied) => applied === "auto",
};

const MOBILE_TOOL_RESULT_STATUS = {
  auto: "Status: written to disk.",
  preview: "Status: preview shown to user; not written to disk until accepted.",
  isWritten: (applied) => applied === "auto" || applied === true,
};

function formatToolResultForModel(call, result, status = DESKTOP_TOOL_RESULT_STATUS) {
  const ok = result?.success !== false;
  const nextHint = ok
    ? "Next: use this result to continue the task. Do not repeat the same tool call unless new parameters are needed."
    : "Next: fix the parameters or choose a different tool. Do not repeat the identical failing call.";
  const structured = result?._structured;
  if (structured && ["file_edit", "file_create", "file_append"].includes(structured._type)) {
    const path = structured.file_path_rel || structured.file_name || structured.file || call?.params?.file_path || "";
    const errors = structured.errors?.length ? `\nWarnings: ${structured.errors.join("; ")}` : "";
    const truncNote = structured._type === "file_append" && structured.truncated
      ? "\nNote: this append was itself truncated; continue with another file_append from the new breakpoint."
      : "";
    return `[工具 ${structured._type} 结果]: ${result.output}\nTarget path: ${path}\n${status.isWritten(structured.applied) ? status.auto : status.preview}${errors}${truncNote}\n${nextHint}`;
  }
  return `[工具 ${call.name} ${ok ? "成功" : "失败"}]: ${result.output}\n${nextHint}`;
}

const DESKTOP_FAILED_LINE = (n) => `- 有 ${n} 个工具失败：请换参数、换工具或先读取更多上下文，不要重复完全相同的失败调用。`;
const MOBILE_FAILED_LINE = (n) => `- 本轮有 ${n} 个工具失败：换参数、换工具或先读取更多上下文，不要重复完全相同的失败调用。`;

function buildToolFollowupInstruction({ harnessOn = false, autopilotOn = false, round, maxRounds, results, failedLine = DESKTOP_FAILED_LINE, prefix = "" }) {
  const failed = (results || []).filter(r => r.success === false);
  const lines = [
    "",
    "[Agent Loop 指令]",
    `当前工具轮次：${round + 1}/${maxRounds}。`,
    "- 先吸收工具结果，再决定下一步；不要复述工具原文。",
    "- 若目标仍未完成，继续调用最小必要工具推进。",
    "- 若刚完成文件修改/生成，优先验证：读取文件、运行检查/测试/构建或说明无法验证原因。",
    "- 若已完成并验证，回复首行写【任务完成】，再逐项列出交付内容与验证方式；不写该标记视为仍在推进。",
  ];
  if (autopilotOn && !harnessOn) {
    lines.push("- Autopilot 模式下：不要等用户说“继续”；任务未完成就继续观察、修改或验证。");
    lines.push("- 收口按 [可用工具] 的「收口纪律」走：exit_autopilot → 下一条回复首行【任务完成】。");
  }
  if (harnessOn) {
    lines.push("- 目标模式下：如有 TODOLIST，完成一批就 todo_manage(action=update)，全部 done/blocked 后再收尾。");
    lines.push("- 收口按 [可用工具] 的「收口纪律」走：exit_target_mode（summary 写交付+验证方式+结果）→ 下一条回复首行【任务完成】；未到验证阶段不要调它。");
  }
  if (failed.length) {
    lines.push(failedLine(failed.length));
  }
  return prefix + lines.join("\n");
}

export {
  _pendingToolMsgs, releasePendingFor, toolCallSignature, dedupeToolCalls, isTruncatedUnexecutable,
  HISTORY_SUMMARY_PREFIX, isHistorySummary,
  DESKTOP_TOOL_RESULT_STATUS, MOBILE_TOOL_RESULT_STATUS, formatToolResultForModel,
  DESKTOP_FAILED_LINE, MOBILE_FAILED_LINE, buildToolFollowupInstruction,
};
