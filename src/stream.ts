import type { Usage } from './types.js';

function* parseSseEvents(buffer: { text: string }): Generator<Record<string, unknown>> {
  const events = buffer.text.split('\n\n');
  buffer.text = events.pop() ?? '';
  for (const ev of events) {
    const dataLine = ev.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    try {
      yield JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
    } catch {
      // 忽略不完整/非 JSON 行
    }
  }
}

export function teeUsage(stream: ReadableStream<Uint8Array>): {
  clientStream: ReadableStream<Uint8Array>;
  usage: Promise<Usage | null>;
} {
  let resolveUsage!: (u: Usage | null) => void;
  const usage = new Promise<Usage | null>((r) => {
    resolveUsage = r;
  });
  const decoder = new TextDecoder();
  const buffer = { text: '' };
  let input = 0;
  let output = 0;
  let saw = false;

  // 注意：不能用 stream.pipeThrough(transform)——若客户端不消费 clientStream，
  // 背压会阻止 transform/flush 执行，usage 永远不会 resolve。
  // 这里用后台泵主动读取上游：字节原样透传 + 旁路解析，源结束即 resolve usage。
  let clientController!: ReadableStreamDefaultController<Uint8Array>;
  const clientStream = new ReadableStream<Uint8Array>({
    start(controller) {
      clientController = controller;
    },
  });

  const handleChunk = (chunk: Uint8Array): void => {
    buffer.text += decoder.decode(chunk, { stream: true });
    for (const json of parseSseEvents(buffer)) {
      if (json.type === 'message_start') {
        const u = (json.message as { usage?: Usage } | undefined)?.usage;
        if (u) {
          input = u.input_tokens ?? 0;
          output = u.output_tokens ?? 0;
          saw = true;
        }
      } else if (json.type === 'message_delta') {
        const u = json.usage as Usage | undefined;
        if (u) output = u.output_tokens ?? output;
      }
    }
  };

  void (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clientController.enqueue(value); // 字节原样透传
        handleChunk(value);
      }
      clientController.close();
      resolveUsage(saw ? { input_tokens: input, output_tokens: output } : null);
    } catch (err) {
      clientController.error(err);
      resolveUsage(saw ? { input_tokens: input, output_tokens: output } : null);
    }
  })();

  return { clientStream, usage };
}

interface AggregateMessage {
  content: Array<{ type: string; text: string }>;
  [key: string]: unknown;
}

export async function collectStreamToMessage(
  stream: ReadableStream<Uint8Array>,
): Promise<AggregateMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const buffer = { text: '' };
  let message: AggregateMessage | null = null;
  const blocks: Array<{ type: string; text: string }> = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer.text += decoder.decode(value, { stream: true });
    for (const json of parseSseEvents(buffer)) {
      if (json.type === 'message_start') {
        message = { ...(json.message as AggregateMessage), content: [] };
      } else if (json.type === 'content_block_start') {
        const i = json.index as number;
        const b = json.content_block as { type?: string } | undefined;
        blocks[i] = { type: b?.type ?? 'text', text: '' };
      } else if (json.type === 'content_block_delta') {
        const i = json.index as number;
        const delta = json.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === 'text_delta' && blocks[i]) blocks[i].text += delta.text ?? '';
      } else if (json.type === 'message_delta' && message) {
        Object.assign(message, json.delta as Record<string, unknown>);
      }
    }
  }

  if (!message) throw new Error('上游流中未找到 message_start');
  return { ...message, content: blocks.filter(Boolean) };
}
