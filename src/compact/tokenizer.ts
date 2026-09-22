import { get_encoding } from '@dqbd/tiktoken';
import type { Tiktoken } from '@dqbd/tiktoken';
import type { AnthropicRequest, ContentBlock, Message } from '../types.js';

// @dqbd/tiktoken 是 WASM 版 tiktoken，对 CJK 大文本的编码速度比 js-tiktoken
// 快几个数量级。encoding 实例持有 WASM 内存，必须 .free() 释放：
// 这里做成进程级单例，懒创建、复用，进程退出时释放。
let enc: Tiktoken | null = null;

function getEnc(): Tiktoken {
  if (!enc) {
    enc = get_encoding('o200k_base');
  }
  return enc;
}

/** 释放 WASM 内存；仅供进程收尾或测试调用，释放后会重新懒加载。 */
export function disposeTokenizer(): void {
  // finally 保证 free() 抛错时引用仍被清空，不会残留已释放对象
  try {
    enc?.free();
  } finally {
    enc = null;
  }
}

// exit 处理器全局只注册一次：dispose/重载循环不会累积监听器
process.once('exit', disposeTokenizer);

function blockText(block: ContentBlock): string {
  if (typeof block.text === 'string') return block.text;
  return JSON.stringify(block);
}

export function countText(text: string): number {
  if (text.length === 0) return 0;
  return getEnc().encode(text).length;
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
