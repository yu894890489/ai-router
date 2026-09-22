import type { Message } from '../types.js';

/** 提取会话标题：第一条 user 消息的文本，折叠空白、截断 200 字符 */
export function extractTitle(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '（无标题）';
  const raw =
    typeof first.content === 'string'
      ? first.content
      : first.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join(' ');
  const t = raw.replace(/\s+/g, ' ').trim();
  return t.length === 0 ? '（无标题）' : t.slice(0, 200);
}
