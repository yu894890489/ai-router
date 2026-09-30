import type { Usage } from './types.js';

/** 识别 SSE 事件中的错误并给出原文；非错误事件返回 null。
 *  支持两种形态：Anthropic 标准 {type:"error",error:{message}}，
 *  以及部分上游的非标准 {code,message}（无 type，如 bailian Throttling）。 */
function eventErrorText(json: Record<string, unknown>): string | null {
  if (json.type === 'error') {
    const e = json.error as { message?: string } | undefined;
    return e?.message ?? '上游返回了未携带详情的错误事件';
  }
  if (json.type === undefined && typeof json.code === 'string' && typeof json.message === 'string') {
    return `${json.code}: ${json.message}`;
  }
  return null;
}

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
  text: Promise<string>;
  /** 上游 SSE error 事件的错误文本（或流读取异常）；正常结束为 null */
  streamError: Promise<string | null>;
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
  let resolveText!: (t: string) => void;
  const text = new Promise<string>((r) => {
    resolveText = r;
  });
  let reply = '';
  let resolveStreamError!: (e: string | null) => void;
  const streamError = new Promise<string | null>((r) => {
    resolveStreamError = r;
  });
  let firstError: string | null = null;

  // 注意：不能用 stream.pipeThrough(transform)——若客户端不消费 clientStream，
  // 背压会阻止 transform/flush 执行，usage 永远不会 resolve。
  // 这里用后台泵主动读取上游：字节原样透传 + 旁路解析，源结束即 resolve usage。
  let clientController!: ReadableStreamDefaultController<Uint8Array>;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let clientAborted = false; // 客户端主动断连（Esc 中断等）：中立收尾，不误记为上游错误
  const clientStream = new ReadableStream<Uint8Array>({
    start(controller) {
      clientController = controller;
    },
    cancel() {
      clientAborted = true;
      reader?.cancel().catch(() => {}); // 客户端不看了，顺带停掉上游读取
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
      } else if (json.type === 'content_block_delta') {
        const d = json.delta as { type?: string; text?: string } | undefined;
        if (d?.type === 'text_delta') reply += d.text ?? '';
      } else if (json.type === 'message_delta') {
        const u = json.usage as Usage | undefined;
        if (u) output = u.output_tokens ?? output;
      } else if (firstError === null) {
        // 上游把错误混在 SSE 流里：捕获原文，字节仍原样透传给客户端
        firstError = eventErrorText(json);
      }
    }
  };

  void (async () => {
    reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clientController.enqueue(value); // 字节原样透传
        handleChunk(value);
      }
      if (!clientAborted) clientController.close();
      resolveUsage(saw ? { input_tokens: input, output_tokens: output } : null);
      resolveText(reply);
      resolveStreamError(clientAborted ? null : firstError);
    } catch (err) {
      if (!clientAborted) clientController.error(err);
      resolveUsage(saw ? { input_tokens: input, output_tokens: output } : null);
      resolveText(reply);
      resolveStreamError(
        clientAborted ? null : (firstError ?? `上游流读取异常: ${String(err)}`),
      );
    }
  })();

  return { clientStream, usage, text, streamError };
}

interface AggregateBlock {
  type: string;
  text: string;
  input?: string; // tool_use：input_json_delta 的累积字符串，最终 JSON.parse 回对象
  [key: string]: unknown;
}

interface AggregateMessage {
  content: Array<Record<string, unknown>>;
  usage?: Usage;
  [key: string]: unknown;
}

export async function collectStreamToMessage(
  stream: ReadableStream<Uint8Array>,
): Promise<AggregateMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const buffer = { text: '' };
  let message: AggregateMessage | null = null;
  const blocks: AggregateBlock[] = [];
  let firstError: string | null = null; // 上游 SSE error 事件的原文
  let sawStop = false; // 见到 message_stop 才算完整响应

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer.text += decoder.decode(value, { stream: true });
    for (const json of parseSseEvents(buffer)) {
      const errText = eventErrorText(json);
      if (errText !== null) {
        if (firstError === null) firstError = errText; // 上游 SSE error 事件的原文
      } else if (json.type === 'message_stop') {
        sawStop = true;
      } else if (json.type === 'message_start') {
        message = { ...(json.message as AggregateMessage), content: [] };
      } else if (json.type === 'content_block_start') {
        const i = json.index as number;
        const b = (json.content_block ?? {}) as Record<string, unknown>;
        if (b.type === 'tool_use') {
          // tool_use：保留 id/name，input 用字符串累积 partial_json
          blocks[i] = { ...b, text: '', input: '' } as AggregateBlock;
        } else {
          blocks[i] = { ...(b as object), type: (b.type as string) ?? 'text', text: '' } as AggregateBlock;
        }
      } else if (json.type === 'content_block_delta') {
        const i = json.index as number;
        const delta = json.delta as
          | { type?: string; text?: string; partial_json?: string }
          | undefined;
        if (!blocks[i]) continue;
        if (delta?.type === 'text_delta') blocks[i].text += delta.text ?? '';
        else if (delta?.type === 'input_json_delta')
          blocks[i].input = (blocks[i].input ?? '') + (delta.partial_json ?? '');
      } else if (json.type === 'message_delta' && message) {
        Object.assign(message, json.delta as Record<string, unknown>);
        // message_delta 的 usage 只含 output_tokens：合并而非覆盖，保留 input_tokens
        const u = json.usage as Partial<Usage> | undefined;
        if (u) {
          message.usage = {
            input_tokens: message.usage?.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? message.usage?.output_tokens ?? 0,
          };
        }
      }
    }
  }

  if (!message) throw new Error(firstError ?? '上游流中未找到 message_start');
  // 部分聚合后被 error 事件打断：不能让 7a 拿残缺 message 记 success
  if (firstError && !sawStop) throw new Error(firstError);
  const content: Array<Record<string, unknown>> = blocks.filter(Boolean).map((b) => {
    if (b.type === 'tool_use' && typeof b.input === 'string') {
      let input: unknown = b.input;
      try {
        input = JSON.parse(b.input);
      } catch {
        // 解析失败保留原字符串
      }
      const { text: _text, ...rest } = b;
      return { ...rest, input };
    }
    return b;
  });
  return { ...message, content };
}
