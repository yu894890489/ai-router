import { getEncoding } from 'js-tiktoken';
import type { AnthropicRequest, ContentBlock, Message } from '../types.js';

const enc = getEncoding('o200k_base');

function blockText(block: ContentBlock): string {
  if (typeof block.text === 'string') return block.text;
  return JSON.stringify(block);
}

export function countText(text: string): number {
  if (text.length === 0) return 0;
  return enc.encode(text).length;
}

export function countMessages(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // 每条消息的结构开销近似
    total +=
      typeof m.content === 'string'
        ? countText(m.content)
        : m.content.reduce((sum, b) => sum + countText(blockText(b)), 0);
  }
  return total;
}

export function countSystem(system: AnthropicRequest['system']): number {
  if (!system) return 0;
  if (typeof system === 'string') return countText(system);
  return system.reduce((sum, b) => sum + countText(blockText(b)), 0);
}
