/**
 * SLATE Agent 循环 kernel：桌面与移动共用的工具循环骨架
 *
 * kernel 只持有"骨架"：轮次与预算、abort/会话切换守卫、去重指纹与空转计数、
 * 工具标记剥离与落库时序、结果回灌的槽位、退出清理。
 * 平台差异全部经三个注入面对象交回调用方：
 *   io      —— 与后端/存储打交道的动作（探测调用、执行、落库、续写一轮）
 *   view    —— 与 DOM 打交道的动作（气泡重锚定、渲染、进度条、步骤卡、砚流进度）
 *   policy  —— 与产品策略打交道的决策（空轮如何推进、回灌文案、轮末是否退出、触顶是否续跑）
 *
 * 预算归 kernel 管，但上限可以被 policy 推后：emptyRound / atCap 返回 extend>0 时，kernel
 * 抬高 run.maxRounds（emptyRound 的 nudge 话术照常注入，atCap 只放宽轮数、不另塞消息）。
 * 追加几次、追加多少由 policy 自己计数封顶——止损线可以推后，不能在 kernel 这边被抹掉。
 *
 * 事件账本同样在 kernel 里落：policy.openRun(run) 返回一个 ledger（agent_ledger.js 的实例，
 * mode 这类平台标签由 policy 决定），kernel 在轮次与调用的各节点 emit。
 * 于是聊天工具卡片与白板步骤卡是同一份账的投影，三端不必各落一遍。
 * io.execute 的 ctx 另带 ledger 与 callIdFor(i)：派生型工具（subagent_run）据此把
 * "谁派生了谁"记进同一份账，星图才画得出真边。
 *
 * 约定：policy 返回的模型可见字符串不被 t() 包裹（t() 只包用户可见文本）。
 */

import { state, addMessage } from "../store.js?v=20261024-001";
import { stripToolCalls } from "./tools.js?v=20261024-001";
import { _pendingToolMsgs, releasePendingFor } from "./agent_common.js?v=20261024-001";

export function createAgentLoop({ policy = {}, view = {}, io }) {
  const reasonOf = (key) => policy.exitReasons?.[key] ?? "";

  return async function runAgentLoop(opts) {
    const { signal = null, maxRounds, genConvId = null } = opts;
    const run = {
      opts, signal, maxRounds, genConvId,
      bubble: opts.bubble,
      round: 0, lastMsg: null, calls: [], results: [], cards: null, turn: null,
      prevCallsSig: "", dupRounds: 0, stallStreak: 0,
      nudged: false, successfulTool: false, exitReason: "",
      // exitKind 由 policy 在决定退出时标注："done"=走完完成通道，"stopped"=其余一切。
      // 上层据此区分"干完了"和"停下了"，不再把后者报成前者。
      exitKind: "",
      // exitStatus 由 kernel 在 finally 里落：error/cancelled/switched/completed。
      // 侧栏徽标要它才知道"这一场是炸了还是被停的"，policy 自己看不到 failure。
      exitStatus: "",
      extra: policy.beginRun ? policy.beginRun(opts) : {},
    };
    // 每场会话一份自己的消息数组：并行时后台那场的队尾不在 state.messages 上，
    // 读错数组等于"照着别的项目的对话往下续写"。宿主没给 messages 时回落 state.messages
    // （移动端与旧的单场语义都是这个形状）。
    const thread = () => (typeof opts.messages === "function" ? opts.messages() : state.messages);
    // 切走会话要不要散场：backgroundRuns 关掉（或移动端）才是"切走即停"。
    // 开着并行时这一项为 false——后台那场照样按它自己的会话与项目往下跑。
    const stopOnSwitch = opts.stopOnSwitch !== false;
    const switched = () => stopOnSwitch && genConvId !== null && state.currentConversationId !== genConvId;
    run.ledger = policy.openRun?.(run) ?? null;
    const ledger = run.ledger;
    const settledIds = new Set();
    const startedAt = new Map();

    const runEvent = (type, data) => {
      if (!ledger) return;
      ledger.emit(type, { messageId: run.lastMsg?.id || "", round: run.round, data });
    };
    const callEvent = (index, type, data) => {
      if (!ledger) return;
      const callId = ledger.callId(run.round, index);
      if (type === "call.finished") settledIds.add(callId);
      ledger.emit(type, {
        callId,
        tool: run.calls[index]?.name || "",
        messageId: run.lastMsg?.id || "",
        round: run.round,
        data,
      });
    };

    const readyCalls = [];
    runEvent("run.started", { budget: maxRounds });
    policy.onStart?.(run);
    let failure = null;
    try {
      // 预算读 run.maxRounds 而不是入参：policy 在末轮可以给续跑追加轮数（Continue Autopilot），
      // 追加只放宽不收紧，且每次追加都由 policy 自己计数封顶。
      for (let round = 0; round < run.maxRounds; round++) {
        run.round = round;
        if (signal?.aborted) { run.exitReason = reasonOf("aborted"); break; }
        if (switched()) { run.exitReason = reasonOf("switched"); break; }

        const msgs = thread();
        const lastMsg = msgs[msgs.length - 1];
        if (!lastMsg || lastMsg.role !== "assistant") {
          // 队尾不是待处理的回复（异常收尾、被外部改写）：如实留痕，
          // 否则 finish() 会把它当成"轮数用尽"报给上层
          run.exitReason = reasonOf("noReply");
          break;
        }
        run.lastMsg = lastMsg;
        _pendingToolMsgs.add(lastMsg);
        runEvent("round.started");
        try {
          // 整表重渲染会让捕获的气泡脱离文档：重新锚定到活节点，本轮 DOM 写入才不落空
          const live = view.reanchorBubble?.(run.bubble, thread().length - 1);
          if (live) run.bubble = live;

          run.calls = io.detectCalls(lastMsg);
          run.nudged = false;
          for (let i = 0; i < run.calls.length; i++) callEvent(i, "call.planned", { args: run.calls[i].params });

          // 相同调用去重：与上一轮完全一致时不重复执行（避免无效副作用与空转耗尽轮数）
          if (run.calls.length > 0) {
            run.stallStreak = 0;
            const sig = JSON.stringify(run.calls.map(c => [c.name, c.params]));
            if (sig === run.prevCallsSig) {
              run.dupRounds++;
              const r = policy.dedupRound?.(run) ?? null;
              runEvent("notice", { kind: "dedup", dupRounds: run.dupRounds, text: r?.hiddenMsg?.content || r?.exitReason || "" });
              if (!r || r.action === "break") {
                if (r?.exitReason !== undefined) run.exitReason = r.exitReason;
                break;
              }
              if (r.hiddenMsg) addMessage(r.hiddenMsg, genConvId);
              if (r.progressText !== undefined) view.setProgress?.(r.progressText, run);
              run.nudged = true;
            } else {
              run.dupRounds = 0;
            }
            run.prevCallsSig = sig;
          }

          if (run.calls.length === 0) {
            const r = policy.emptyRound?.(run) ?? { action: "break" };
            if (r.action === "break") {
              if (r.exitReason !== undefined) run.exitReason = r.exitReason;
              runEvent("notice", { kind: "round_exit", text: r.exitReason || "" });
              break;
            }
            runEvent("notice", { kind: r.kind || "nudge", text: r.hiddenMsg?.content || "" });
            // policy 可以带着 nudge 追加轮数（Continue Autopilot）：先把上限抬高再注入提醒，
            // 顺序反了的话 for 条件仍读旧上限，这条催办就成了没人执行的空话
            if (Number(r.extend) > 0) run.maxRounds += Number(r.extend);
            if (r.hiddenMsg) addMessage(r.hiddenMsg, genConvId);
            if (r.progressText !== undefined) view.setProgress?.(r.progressText, run);
            run.nudged = true;
            run.stallStreak++;
          }

          const progressText = policy.progressForRound?.(run);
          if (progressText !== undefined) view.setProgress?.(progressText, run);

          // 剥离工具标记后回显（模型标记不进正文）
          const cleanContent = stripToolCalls(run.lastMsg.content);
          run.lastMsg.content = cleanContent;
          view.renderBubble?.(run.bubble, cleanContent);

          if (!run.nudged) {
            policy.markActivity?.(run);
            for (let i = 0; i < run.calls.length; i++) {
              if (ledger) readyCalls.push({ callId: ledger.callId(run.round, i), round: run.round, tool: run.calls[i].name });
              callEvent(i, "call.ready");
            }
            run.cards = view.toolCards?.begin?.(run) ?? null;
            const progress = view.execProgress?.(run.bubble) ?? null;
            run.results = await io.execute(run.calls, {
              signal,
              // 归属会话：后台任务这类"结果晚于本轮到达"的副作用要记在起它的那个会话名下
              // （徽标按会话亮）。宿主没给 genConvId 时回落当前会话。
              convId: genConvId || state.currentConversationId || "",
              // 归属项目：后台那场要按它自己的项目根落文件/开终端（见 services/tools.js callProject）
              project: opts.project || null,
              // 回复模式的工具白名单：宿主（输入框那条链路）显式带进来才生效，
              // 团队 / 子代理这些自己起循环的路径没有这一项＝不限制工具
              mode: opts.mode || null,
              // 账本 callId 交给执行器透传：派生型工具（subagent_run）据此把 spawn 边
              // 挂到自己的那一行上，星图才认得出谁派生了谁
              callIdFor: (i) => (ledger ? ledger.callId(run.round, i) : ""),
              ledger,
              onCallStart: (call, i) => {
                if (ledger) startedAt.set(ledger.callId(run.round, i), Date.now());
                callEvent(i, "call.started");
                progress?.onCallStart?.(call, i);
              },
              onEvent: (env, call, i) => progress?.onEvent?.(env, call, i),
              onCallEnd: (call, i, result) => {
                const callId = ledger ? ledger.callId(run.round, i) : "";
                const t0 = startedAt.get(callId) || Date.now();
                callEvent(i, "call.finished", {
                  call: run.calls[i],
                  // 与 executeToolCalls 落库的合并体同形，投影出来才和今天的 toolResults 一致
                  result: result === undefined ? undefined : { ...run.calls[i], ...result },
                  status: result === undefined ? "failed" : result.success === false ? "error" : "done",
                  durationMs: Math.max(0, Date.now() - t0),
                });
                progress?.onCallEnd?.(call, i, result);
              },
            });
            progress?.endAll?.(run.calls);
            if (run.results.some(result => result.success !== false)) run.successfulTool = true;
            policy.markActivity?.(run);
            if (signal?.aborted) { run.exitReason = reasonOf("aborted"); break; }
            if (switched()) { run.exitReason = reasonOf("switched"); break; }

            await policy.postExec?.(run);
            await io.commitResults(run);
            view.toolCards?.finish?.(run);

            for (const msg of policy.buildFeeds(run) || []) addMessage(msg, genConvId);
          }

          // 新建 assistant 气泡并流式续写（若期间已切换会话，则不向新会话注入幻影气泡）
          if (switched()) { run.exitReason = reasonOf("switched"); break; }
          run.turn = await io.streamTurn(run);
          if (run.turn?.bubble) run.bubble = run.turn.bubble;
          // 轮内 await 点（如上下文刷新）可能观测到 kernel 看不见的中止
          if (run.turn?.stop !== undefined) { run.exitReason = run.turn.stop; break; }
          if (signal?.aborted) { run.exitReason = reasonOf("aborted"); break; }

          const r = await policy.endTurn?.(run);
          if (r?.bubble) run.bubble = r.bubble;
          if (r?.action === "break") {
            if (r.exitReason !== undefined) run.exitReason = r.exitReason;
            break;
          }

          // 末轮兜底：预算就在这一轮用完了，可"用完"不等于"干完"——本轮的工具结果刚回灌、
          // 模型续写的那句"接下来我要……"还没轮到执行，循环就散了（用户看到的正是活没干完就断）。
          // 续不续、给几轮由 policy 定（它看得到清单与用户偏好），kernel 只在恰好触顶时问一次。
          // 这条路径刻意不注入提醒消息：本轮结尾已经续写出新的 assistant 回复，再塞一条 user 消息
          // 会让下一轮开头的"队尾必须是待处理回复"守卫直接散场。模型下一步想干什么就写在它那句
          // 回复里，把上限放宽就能真的被执行；若它停笔不说话，下一轮走 emptyRound，那里才有催办话术。
          if (round === run.maxRounds - 1) {
            const c = policy.atCap?.(run) ?? null;
            const grant = Number(c?.extend) || 0;
            if (grant > 0) {
              run.maxRounds += grant;
              runEvent("notice", { kind: c.kind || "cap_extend", text: c.progressText || "" });
              if (c.progressText !== undefined) view.setProgress?.(c.progressText, run);
            }
          }
        } finally {
          runEvent("round.finished", {
            calls: run.calls.length,
            executedTotal: run.results.length,
            nudged: run.nudged,
            stopped: Boolean(run.exitReason),
          });
          ledger?.flush();
        }
      }
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      // 报到过 ready 却没跑完的调用（中止、异常、轮数耗尽）留痕为取消，账本里不留悬空步骤
      const by = signal?.aborted ? "user" : failure ? "error" : "run-end";
      if (ledger) {
        for (const c of readyCalls) {
          if (!settledIds.has(c.callId)) ledger.emit("call.cancelled", { callId: c.callId, tool: c.tool, round: c.round, messageId: run.lastMsg?.id || "", data: { by } });
        }
      }
      const exitStatus = failure ? "error" : signal?.aborted ? "cancelled" : switched() ? "switched" : "completed";
      // 退场方式写给 policy 收尾用（侧栏徽标要说"上一场怎么结束的"），账本与它同一口径
      run.exitStatus = exitStatus;
      ledger?.finish({
        status: exitStatus,
        stops: run.exitReason || (failure ? String(failure?.message || failure) : ""),
      });
      try {
        policy.finish?.(run);
      } finally {
        // 无论以何种方式退出（abort / 去重拦截 / 会话切换 / 轮数上限 / 抛异常），
        // 都要解除渲染抑制，防止残留标记被渲染成伪造的"历史恢复"卡片。
        // 必须在 policy.finish 之后：其重渲染依赖抑制标记仍然生效
        releasePendingFor(thread());
      }
    }
    return run;
  };
}
