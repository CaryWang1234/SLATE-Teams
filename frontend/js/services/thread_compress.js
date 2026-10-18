/**
 * 压缩后的线程重建。
 *
 * 上下文压缩会把"保留下来的那一段"再写回 store，而后端回传的 keep_messages 是
 * 发请求时那份**字段投影的副本**（只剩 role/content），带着它重建线程就会丢掉
 * hidden 与 model 标记——于是发给模型的 [系统警告]、[系统自动推进提醒]、工具结果
 * 投喂这些隐藏轮，在下一次重绘时变成普普通通的用户气泡，看上去就像"模型回复里
 * 冒出了系统警告"。所以保留段一律按 compress_count 从本地消息数组现取。
 *
 * 后端两个压缩路由都把保留段算成 messages[split_point:]，且 compress_count 就是
 * split_point（backend/routers/chat.py 的 /compress 与 /compress-manual），
 * 因此"本地数组切掉前 compress_count 条"与"keep_messages"是同一段。
 */
export function compressedThread(summaryMsg, localMessages, compressCount) {
  const list = Array.isArray(localMessages) ? localMessages : [];
  const n = Number(compressCount);
  const cut = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), list.length) : 0;
  return [summaryMsg, ...list.slice(cut)].filter(Boolean);
}
