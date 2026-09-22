import { describe, it, expect } from 'vitest';
import { collectStreamToMessage, teeUsage } from '../src/stream.js';

function sse(events: Array<[string, unknown]>): ReadableStream<Uint8Array> {
  const text = events
    .map(([t, d]) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`)
    .join('');
  return new Response(text).body!;
}

const EVENTS: Array<[string, unknown]> = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 120, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，世界' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }],
  ['message_stop', { type: 'message_stop' }],
];

describe('teeUsage', () => {
  it('字节原样透传，旁路提取 usage', async () => {
    const { clientStream, usage } = teeUsage(sse(EVENTS));
    const text = await new Response(clientStream).text();
    expect(text).toContain('content_block_delta');
    await expect(usage).resolves.toEqual({ input_tokens: 120, output_tokens: 8 });
  });

  it('无 usage 事件时 resolve null', async () => {
    const { usage } = teeUsage(sse([['message_stop', { type: 'message_stop' }]]));
    await expect(usage).resolves.toBeNull();
  });
});

describe('collectStreamToMessage', () => {
  it('聚合 SSE 为完整 message', async () => {
    const msg = (await collectStreamToMessage(sse(EVENTS))) as {
      id: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
    };
    expect(msg.id).toBe('msg_1');
    expect(msg.content[0].text).toBe('你好，世界');
    expect(msg.stop_reason).toBe('end_turn');
  });

  it('缺少 message_start 时报错', async () => {
    await expect(collectStreamToMessage(sse([['ping', {}]]))).rejects.toThrow(/message_start/);
  });
});
