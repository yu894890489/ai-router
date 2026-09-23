import type { Message } from '../types.js';

export type Summarizer = (text: string) => Promise<string>;

export interface CompactOptions {
  keepRecentTurns: number;
  targetTokens: number;
  chunkTokens: number;
  summarizer: Summarizer;
  count: (messages: Message[]) => number;
  /** 分块总结并行度，默认 1（串行） */
  concurrency?: number;
}

export interface CompactResult {
  messages: Message[];
  compacted: boolean;
  before: number;
  after: number;
}

function isTurnStart(m: Message): boolean {
  if (m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  return !m.content.every((b) => b.type === 'tool_result');
}

export function splitTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  for (const m of messages) {
    if (isTurnStart(m) || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1].push(m);
  }
  return turns;
}

export function serializeMessage(m: Message): string {
  const body =
    typeof m.content === 'string'
      ? m.content
      : m.content
          .map((b) =>
            typeof b.text === 'string'
              ? b.text
              : `[${b.type}] ${JSON.stringify(b).slice(0, 2000)}`,
          )
          .join('\n');
  return `<${m.role}>\n${body}\n</${m.role}>`;
}

const SUMMARY_PROMPT = `你正在压缩一段较长的 AI 编程助手对话历史，使其适配更小的上下文窗口。请总结 <conversation> 中的对话片段，必须保留：
1. 已完成的操作及其结果
2. 关键文件路径
3. 重要决策及原因
4. 未解决的 TODO / 待办问题
输出简洁的纯文本摘要，不超过 800 字。

<conversation>
%s
</conversation>`;

/**
 * 有界并发 map：结果按入参顺序落位；首个错误后停止领取新任务，
 * 等已在飞的任务收束后抛出该错误（不产生 unhandled rejection，不静默丢上下文）
 */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;
  let firstErr: unknown = null;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (idx < items.length && firstErr === null) {
        const i = idx++;
        try {
          results[i] = await fn(items[i]);
        } catch (e) {
          firstErr ??= e;
        }
      }
    },
  );
  await Promise.all(workers);
  if (firstErr !== null) throw firstErr;
  return results;
}

export async function compactMessages(
  messages: Message[],
  opts: CompactOptions,
): Promise<CompactResult> {
  const before = opts.count(messages);
  if (before <= opts.targetTokens) {
    return { messages, compacted: false, before, after: before };
  }

  let keepTurns = opts.keepRecentTurns;
  let best: CompactResult | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const turns = splitTurns(messages);
    if (turns.length <= keepTurns) break; // 没有可压缩的历史

    const kept = turns.slice(-keepTurns).flat();
    const middle = turns.slice(0, -keepTurns).flat();

    // 中段按 chunkTokens 切块
    const chunks: string[] = [];
    let buf: string[] = [];
    let bufTokens = 0;
    for (const m of middle) {
      const t = opts.count([m]);
      if (bufTokens + t > opts.chunkTokens && buf.length > 0) {
        chunks.push(buf.join('\n'));
        buf = [];
        bufTokens = 0;
      }
      buf.push(serializeMessage(m));
      bufTokens += t;
    }
    if (buf.length > 0) chunks.push(buf.join('\n'));

    // 分块并行总结；summarizer 抛错时向上传播（禁止静默丢上下文）
    const summaries = await mapPool(chunks, opts.concurrency ?? 1, (chunk) =>
      // 函数式替换：chunk 中的 $&、$1 等不被解释为替换模式，原样进入提示词
      opts.summarizer(SUMMARY_PROMPT.replace('%s', () => chunk)),
    );

    const summaryText = `<context-summary>\n以下是此前 ${turns.length - keepTurns} 轮对话的压缩摘要（原消息已移除）：\n\n${summaries.join('\n\n---\n\n')}\n</context-summary>`;
    const rebuilt: Message[] = [
      { role: 'user', content: summaryText },
      { role: 'assistant', content: '已了解此前的对话摘要，将基于该上下文继续。' },
      ...kept,
    ];
    const after = opts.count(rebuilt);
    const result: CompactResult = { messages: rebuilt, compacted: true, before, after };
    if (after <= opts.targetTokens) return result;
    best = result;
    keepTurns = Math.max(2, Math.floor(keepTurns / 2)); // 仍超限：压缩更多近期轮次
  }

  if (best) return best; // 受保护的尾部本身超限，返回最优努力结果
  return { messages, compacted: false, before, after: before };
}
