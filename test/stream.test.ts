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

  it('正常流 streamError 为 null', async () => {
    const { streamError } = teeUsage(sse(EVENTS));
    await expect(streamError).resolves.toBeNull();
  });

  it('上游 SSE error 事件：捕获错误原文，字节仍原样透传', async () => {
    const events: Array<[string, unknown]> = [
      ['message_start', { type: 'message_start', message: { id: 'msg_e', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 50, output_tokens: 1 } } }],
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'The service encountered an unexpected internal error' } }],
    ];
    const { clientStream, usage, streamError } = teeUsage(sse(events));
    const raw = await new Response(clientStream).text();
    expect(raw).toContain('overloaded_error'); // 客户端能收到错误事件
    await expect(streamError).resolves.toBe('The service encountered an unexpected internal error');
    await expect(usage).resolves.toEqual({ input_tokens: 50, output_tokens: 1 });
  });

  it('error 事件无 message 时给兜底文案', async () => {
    const { streamError } = teeUsage(sse([['error', { type: 'error' }]]));
    await expect(streamError).resolves.toBe('上游返回了未携带详情的错误事件');
  });

  it('客户端中途断连：streamError 为 null，不误记为上游错误', async () => {
    const enc = new TextEncoder();
    const chunk = enc.encode(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
    );
    // 持续产出的上游流：模拟长生成中用户按 Esc
    const upstream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(chunk);
      },
    });
    const { clientStream, streamError } = teeUsage(upstream);
    const r = clientStream.getReader();
    await r.read();
    await r.cancel(); // 客户端断连
    await expect(streamError).resolves.toBeNull();
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

  it('只有上游 error 事件时抛出上游原文而非笼统的 message_start 错误', async () => {
    const events: Array<[string, unknown]> = [
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'The service encountered an unexpected internal error' } }],
    ];
    await expect(collectStreamToMessage(sse(events))).rejects.toThrow(
      'The service encountered an unexpected internal error',
    );
  });

  it('非 Anthropic 格式的错误事件（bailian Throttling：{code,message} 无 type）也抛出上游原文', async () => {
    const events: Array<[string, unknown]> = [
      ['ping', { type: 'ping' }],
      ['error', { code: 'Throttling', message: 'Request rate increased too quickly.' }],
    ];
    await expect(collectStreamToMessage(sse(events))).rejects.toThrow(
      'Throttling: Request rate increased too quickly.',
    );
  });

  it('带 type 的普通事件（如 message_delta 的 usage 对象）不会被误判为非标准错误', async () => {
    const msg = await collectStreamToMessage(sse(EVENTS));
    expect(msg.content).toHaveLength(1);
  });

  it('部分聚合后被 error 事件打断（无 message_stop）：抛上游原文，不返回残缺 message', async () => {
    const events: Array<[string, unknown]> = [
      ['message_start', { type: 'message_start', message: { id: 'msg_p', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 42, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截回答' } }],
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'The service encountered an unexpected internal error' } }],
    ];
    await expect(collectStreamToMessage(sse(events))).rejects.toThrow(
      'The service encountered an unexpected internal error',
    );
  });

  it('完整响应（有 message_stop）后尾部 error 事件不影响聚合结果', async () => {
    const events: Array<[string, unknown]> = [
      ...EVENTS,
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'late noise' } }],
    ];
    const msg = (await collectStreamToMessage(sse(events))) as { content: Array<{ text: string }> };
    expect(msg.content[0].text).toBe('你好，世界');
  });

  it('聚合 usage 合并 message_delta 的 output_tokens，保留 message_start 的 input_tokens', async () => {
    const msg = (await collectStreamToMessage(sse(EVENTS))) as {
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(msg.usage.output_tokens).toBe(8); // message_delta 的值，而非 message_start 的 1
    expect(msg.usage.input_tokens).toBe(120); // message_start 的 input_tokens 必须保留
  });

  it('聚合 tool_use 块：input_json_delta 累积后 JSON.parse 回对象', async () => {
    const events: Array<[string, unknown]> = [
      ['message_start', { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'edit_file' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"/a.ts"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_stop', { type: 'message_stop' }],
    ];
    const msg = (await collectStreamToMessage(sse(events))) as unknown as {
      content: Array<{ type: string; id: string; name: string; input: unknown }>;
    };
    expect(msg.content[0].type).toBe('tool_use');
    expect(msg.content[0].id).toBe('toolu_1');
    expect(msg.content[0].name).toBe('edit_file');
    expect(msg.content[0].input).toEqual({ path: '/a.ts' });
  });
});
