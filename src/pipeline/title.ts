import type { Message } from '../types.js';

/** Claude Code 注入的噪声标签：hook 上下文、命令回显、任务通知等（成对剥除 + 截断场景下未闭合的尾部） */
const NOISE_TAGS = [
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'command-contents',
  'local-command-stdout',
  'local-command-stderr',
  'task-notification',
];

function stripNoise(text: string): string {
  let t = text;
  for (const tag of NOISE_TAGS) {
    t = t.replaceAll(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
    t = t.replaceAll(new RegExp(`<${tag}>[\\s\\S]*$`, 'g'), '');
  }
  return t.replace(/^Caveat:.*(?:\n|$)/g, '');
}

/**
 * 提取会话标题：第一条"剥噪后非空"的 user 消息文本
 * （Claude Code 首条 user 消息常是 SessionStart hook / 命令回显等注入噪声，须跳过），
 * 折叠空白、截断 200 字符。
 */
export function extractTitle(messages: Message[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const raw =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join(' ');
    const t = stripNoise(raw).replace(/\s+/g, ' ').trim();
    if (t) return t.slice(0, 200);
  }
  return '（无标题）';
}
