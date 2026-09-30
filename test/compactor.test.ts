import { describe, it, expect } from 'vitest';
import {
  compactMessages,
  serializeMessage,
  splitTurns,
} from '../src/compact/compactor.js';
import { guardContext } from '../src/pipeline/context-guard.js';
import { countMessages } from '../src/compact/tokenizer.js';
import type { Message } from '../src/types.js';

const TURNS: Message[] = [
  { role: 'user', content: '第1轮问题' },
  { role: 'assistant', content: '第1轮回答' },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '文件内容' }] },
  { role: 'assistant', content: '继续回答' },
  { role: 'user', content: '第2轮问题' },
  { role: 'assistant', content: '第2轮回答' },
  { role: 'user', content: '第3轮问题' },
  { role: 'assistant', content: '第3轮回答' },
];

describe('splitTurns', () => {
  it('tool_result 的 user 消息不开启新轮', () => {
    expect(splitTurns(TURNS)).toHaveLength(3);
  });
});

describe('serializeMessage', () => {
  it('序列化 text 与非 text 块', () => {
    expect(serializeMessage({ role: 'user', content: '你好' })).toContain('你好');
    const s = serializeMessage({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }],
    });
    expect(s).toContain('tool_use');
  });
});

describe('compactMessages', () => {
  const bigHistory: Message[] = [];
  for (let i = 0; i < 20; i++) {
    bigHistory.push(
      { role: 'user', content: `问题${i} ${'长文本'.repeat(200)}` },
      { role: 'assistant', content: `回答${i} ${'长文本'.repeat(200)}` },
    );
  }

  it('低于目标不压缩', async () => {
    const res = await compactMessages(TURNS, {
      keepRecentTurns: 6,
      targetTokens: 10_000_000,
      chunkTokens: 1000,
      summarizer: async () => '摘要',
      count: countMessages,
    });
    expect(res.compacted).toBe(false);
    expect(res.messages).toBe(TURNS);
  });

  it('超限时压缩：保留尾部轮次，前段变 <context-summary>', async () => {
    const res = await compactMessages(bigHistory, {
      keepRecentTurns: 4,
      targetTokens: 1, // 强制触发
      chunkTokens: 2000,
      summarizer: async (text) => `摘要(${text.length}字)`,
      count: countMessages,
    });
    expect(res.compacted).toBe(true);
    expect(res.messages[0].role).toBe('user');
    expect(String(res.messages[0].content)).toContain('<context-summary>');
    expect(String(res.messages[0].content)).toContain('摘要(');
    // 尾部轮次原样保留
    const tail = res.messages.slice(-2);
    expect(String(tail[1].content)).toContain('回答19');
  });

  it('历史内容中的 $& / $1 等替换模式原样传给 summarizer', async () => {
    const received: string[] = [];
    const history: Message[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(
        { role: 'user', content: `q${i} ${'字'.repeat(100)}` },
        { role: 'assistant', content: `a${i}` },
      );
    }
    // 被压缩的中段包含 $ 替换模式；若 replace 用字符串替换，$& 会变成 '%s' 前缀内容、$1 变空
    history[2] = { role: 'user', content: '正则细节 $& 与 $1 必须原样保留' };
    await compactMessages(history, {
      keepRecentTurns: 2,
      targetTokens: 1,
      chunkTokens: 2000,
      summarizer: async (text) => {
        received.push(text);
        return '摘要';
      },
      count: countMessages,
    });
    const joined = received.join('\n');
    expect(joined).toContain('$&');
    expect(joined).toContain('$1');
  });

  it('summarizer 抛错时向上传播（不静默丢上下文）', async () => {
    await expect(
      compactMessages(bigHistory, {
        keepRecentTurns: 4,
        targetTokens: 1,
        chunkTokens: 2000,
        summarizer: async () => {
          throw new Error('压缩模型不可用');
        },
        count: countMessages,
      }),
    ).rejects.toThrow('压缩模型不可用');
  });

  it('分块并行总结：并发度受限、摘要顺序保持', async () => {
    let running = 0;
    let peak = 0;
    const res = await compactMessages(bigHistory, {
      keepRecentTurns: 4,
      targetTokens: 1,
      chunkTokens: 2000, // 中段会切成多块
      concurrency: 2,
      summarizer: async (text) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        // 用块内容特征标记顺序（首条问题的编号）
        const m = /问题(\d+)/.exec(text);
        return `摘要${m ? m[1] : '?'}`;
      },
      count: countMessages,
    });
    expect(res.compacted).toBe(true);
    expect(peak).toBe(2); // 确实发生了并行，且没超并发上限
    const summary = String(res.messages[0].content);
    // 全部「摘要N」按出现位置的编号必须单调递增（并行完成顺序乱不影响拼接顺序）
    const order = [...summary.matchAll(/摘要(\d+)/g)].map((m) => Number(m[1]));
    expect(order.length).toBeGreaterThan(1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('并行中某块失败：错误向上传播，不产出残缺摘要', async () => {
    let n = 0;
    let started = 0;
    await expect(
      compactMessages(bigHistory, {
        keepRecentTurns: 4,
        targetTokens: 1,
        chunkTokens: 2000,
        concurrency: 2,
        summarizer: async () => {
          n++;
          started = n;
          await new Promise((r) => setTimeout(r, 5));
          if (n === 2) throw new Error('第二块超时');
          return '摘要';
        },
        count: countMessages,
      }),
    ).rejects.toThrow('第二块超时');
    // 首错后不再领取新任务：调用数不超过出错时已启动的任务数
    expect(n).toBeLessThanOrEqual(started);
    expect(n).toBeLessThanOrEqual(2 + 1); // 并发 2：至多 1 个在飞任务收尾
  });

  it('mapPool 非法并发度直接抛错，不静默返回空结果', async () => {
    await expect(
      compactMessages(bigHistory, {
        keepRecentTurns: 4,
        targetTokens: 1,
        chunkTokens: 2000,
        concurrency: 0,
        summarizer: async () => '摘要',
        count: countMessages,
      }),
    ).rejects.toThrow('非法并发度');
  });
});

describe('guardContext', () => {
  const cfg = {
    thresholdRatio: 0.85,
    targetRatio: 0.7,
    keepRecentTurns: 3,
    chunkTokens: 2000,
    target: 'kimi/m',
    fallbackToTarget: true,
    timeoutMs: 180000,
    concurrency: 2,
    skipIfWindowGte: 1_000_000,
  };

  const overThresholdMessages = (): Message[] => {
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(
        { role: 'user', content: `q${i} ${'字'.repeat(100)}` },
        { role: 'assistant', content: `a${i}` },
      );
    }
    return messages;
  };

  it('未超阈值时原样返回', async () => {
    const req = {
      model: 'm',
      max_tokens: 10,
      system: 'sys',
      messages: [{ role: 'user' as const, content: '短' }],
    };
    const res = await guardContext(req, 1_000_000, cfg, async () => '摘要');
    expect(res.compacted).toBe(false);
    expect(res.req.messages).toBe(req.messages);
  });

  it('超阈值时压缩并保留 system', async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(
        { role: 'user', content: `q${i} ${'字'.repeat(100)}` },
        { role: 'assistant', content: `a${i}` },
      );
    }
    const req = { model: 'm', max_tokens: 10, system: 'sys', messages };
    // 窗口设得很小，强制触发
    const res = await guardContext(req, 100, cfg, async () => '很短');
    expect(res.compacted).toBe(true);
    expect(res.req.system).toBe('sys');
    expect(res.before).toBeGreaterThan(res.after);
  });

  it('压缩失败包装为 CompactError：原始错误保留在 cause', async () => {
    const messages = overThresholdMessages();
    const req = { model: 'm', max_tokens: 10, system: 'sys', messages };
    const err: unknown = await guardContext(req, 100, cfg, async () => {
      throw new Error('上游 bailian 请求超时');
    }).then(
      () => null,
      (e) => e,
    );
    expect((err as Error).name).toBe('CompactError');
    expect((err as { cause: unknown }).cause).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('上游 bailian 请求超时');
  });

  it('窗口 >= skipIfWindowGte 时跳过压缩（即使超阈值，1M 模型由客户端自行压缩）', async () => {
    const cfgSkip = { ...cfg, skipIfWindowGte: 100 };
    const messages = overThresholdMessages();
    const req = { model: 'm', max_tokens: 10, system: 'sys', messages };
    let called = 0;
    const res = await guardContext(req, 100, cfgSkip, async () => {
      called++;
      return '摘要';
    });
    expect(res.compacted).toBe(false);
    expect(res.req.messages).toBe(req.messages);
    expect(called).toBe(0);
  });

  it('会话一直用小窗口（prevWindow < skipIfWindowGte）时不压缩，由客户端自行管理', async () => {
    const messages = overThresholdMessages();
    const req = { model: 'm', max_tokens: 10, system: 'sys', messages };
    let called = 0;
    const res = await guardContext(req, 100, cfg, async () => {
      called++;
      return '摘要';
    }, 100); // 该会话上次成功候选的窗口也是 100（256k 原生）
    expect(res.compacted).toBe(false);
    expect(res.req.messages).toBe(req.messages);
    expect(called).toBe(0);
  });

  it('会话曾用 >= skipIfWindowGte 的大窗口、现在落到小窗口时压缩（1M 切 256k 降级）', async () => {
    const messages = overThresholdMessages();
    const req = { model: 'm', max_tokens: 10, system: 'sys', messages };
    let called = 0;
    const res = await guardContext(req, 100, cfg, async () => {
      called++;
      return '摘要';
    }, 1_000_000); // 上次成功候选是 1M 窗口
    expect(res.compacted).toBe(true);
    expect(called).toBeGreaterThan(0);
  });

  it('prevWindow 未知（重启后首个请求）时保守按阈值压缩', async () => {
    const messages = overThresholdMessages();
    const req = { model: 'm', max_tokens: 10, system: 'sys', messages };
    let called = 0;
    const res = await guardContext(req, 100, cfg, async () => {
      called++;
      return '摘要';
    }, null);
    expect(res.compacted).toBe(true);
    expect(called).toBeGreaterThan(0);
  });
});
