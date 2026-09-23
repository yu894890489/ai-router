import type { Message } from '../types.js';

/** 消息的纯文本：字符串 content 原样；数组拼接 text 块（换行分隔） */
export function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

function lastUserText(curr: Message[]): string {
  for (let i = curr.length - 1; i >= 0; i--) {
    if (curr[i].role === 'user') return messageText(curr[i]);
  }
  return '';
}

/**
 * 增量提取本轮用户输入：与上一次请求的 messages 做最长公共前缀比对。
 * prev 为 null、前缀被打断（压缩改写历史）、或前缀后无新 user 消息时，
 * 兜底取本次最后一条 user 消息。
 */
export function extractUserTurn(prev: Message[] | null, curr: Message[]): string {
  if (!prev) return lastUserText(curr);
  let i = 0;
  while (i < prev.length && i < curr.length && JSON.stringify(prev[i]) === JSON.stringify(curr[i])) i++;
  if (i < prev.length) return lastUserText(curr); // 前缀中断（压缩等）
  const newUsers = curr
    .slice(i)
    .filter((m) => m.role === 'user')
    .map(messageText)
    .filter((t) => t.length > 0);
  if (newUsers.length === 0) return lastUserText(curr);
  return newUsers.join('\n');
}
