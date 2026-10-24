/**
 * 夜间模式跑任务时向后端续租"别让电脑睡"。
 *
 * 分工：真正碰电源 API 的是后端那条常驻线程（backend/keepawake.py），这里只回答一个问题——
 * **现在该不该钉着**。判据只有一条：存在一场真在跑的 run（不是排队等槽位），
 * 而这一场生效的审批档是夜间模式。排队中的那一场自己没在跑，钉着也没用，
 * 何况它前面总还有一场在跑、已经把需求持住了。
 *
 * 三条纪律：
 *   ① 只在期望**翻转**时发请求。run 表一变就 publish（切会话、改阶段都算），
 *      跟着每次重发会把日志刷满；续租交给心跳，不靠这些事件。
 *   ② 心跳每 HEARTBEAT_MS 续一次，后端租约 60 秒。页面刷新/崩掉/断网之后不再续租，
 *      后端到点自己放手——所以这里不需要 unload 兜底，也不能指望"显式释放"能兜住。
 *   ③ 审批档只认 store 的 permissionModeFor(convId)，别自己读那份 per-conversation 映射：
 *      没单独选过的场跟默认档，空 convId 还有"还没建起来的这一场"那个槽，自己读一定读漏。
 */

import { get, post } from "./api.js?v=20261024-001";
import { state, subscribe, permissionModeFor } from "../store.js?v=20261024-001";
import { activeRuns } from "./run_registry.js?v=20261024-001";

const HEARTBEAT_MS = 20000;      // 后端租约 60s，这里 20s 一续：网络抖一下不至于过期
const ENDPOINT = "/system/keep-awake";

let lastSent = null;             // 最近一次发给后端的期望值；null＝还没通过话
let timer = null;
let status = null;               // 后端最近一次回答（设置页那句状态读它）
const watchers = [];

// 读登记表里的**活对象**，不读 state.runs 那份快照：新会话是发送途中才建出来的，
// 那时 run 的 conv_id 会被就地改挂到新 id 上而不重发快照——照快照读就会一直拿着 "" 去问档。
function nightRunActive() {
  return activeRuns().some(r => r && r.phase !== "queued" && permissionModeFor(r.conv_id) === "night");
}

function wantActive() {
  return state.keepAwakeOnNightRun !== false && nightRunActive();
}

function publish(data) {
  if (data && typeof data === "object") {
    status = data;
    watchers.forEach(fn => { try { fn(status); } catch (e) {} });
  }
}

async function send(want, reason) {
  try {
    const res = await post(ENDPOINT, { want: Boolean(want), reason });
    publish(res && res.data);
    return res && res.data;
  } catch (e) {
    return null;   // 网络/后端没起来：租约本来就会到期，这里不该弹错误条打扰用户
  }
}

function stopHeartbeat() {
  if (timer) { clearInterval(timer); timer = null; }
}

function startHeartbeat() {
  if (timer) return;
  timer = setInterval(() => {
    if (wantActive()) send(true, "heartbeat");
    else stopHeartbeat();   // 不该发生（evaluate 会先停表），留着免得空转到永远
  }, HEARTBEAT_MS);
}

/** 期望翻成才发请求：真在跑的夜间场开个头，最后一场收掉就松手。 */
async function evaluate() {
  const next = wantActive();
  if (next === lastSent) return;
  lastSent = next;
  if (next) {
    await send(true, "night-run-start");
    startHeartbeat();
  } else {
    stopHeartbeat();
    await send(false, "night-run-end");
  }
}

/** 当前状态（含 supported）；还没通过话时返回 null，调用方按"未知"处理。 */
export function keepAwakeStatus() {
  return status;
}

export function onKeepAwakeStatus(fn) {
  if (typeof fn === "function") watchers.push(fn);
}

/** 这台机器到底钉住了没：两个条件都要——租约还在（active），且系统里真记着那位标志
 * （system_required，后端持有线程回读的）。只认后者会把"上一拍还钉着"的残值读成"正在钉着"，
 * 只认前者则等于拿我们自己按下去的勾当证据。 */
export function isHoldingAwake() {
  return Boolean(status && status.supported && status.active && status.system_required);
}

export function initKeepAwake() {
  subscribe("runs", evaluate);
  subscribe("permissionMode", evaluate);
  subscribe("keepAwakeOnNightRun", evaluate);
  // 先探一次：设置页那句"当前系统不支持"要等这个答案；探完顺带把初始期望同步过去
  get(ENDPOINT).then(res => { publish(res && res.data); evaluate(); }).catch(() => {});
}
