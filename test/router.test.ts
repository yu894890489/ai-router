import { describe, it, expect, vi } from 'vitest';
import { executeWithFailover, selectChain, type Candidate } from '../src/pipeline/router.js';
import { buildSummarizer } from '../src/compact/summarizer.js';
import { CompactError } from '../src/compact/compactor.js';
import type { RouterConfig } from '../src/config.js';
import { ProviderError, type Provider, type SendResult } from '../src/providers/base.js';
import { CircuitBreaker, SessionStore } from '../src/session/store.js';
import type { AnthropicRequest } from '../src/types.js';

function fakeProvider(name: string, behavior: 'ok' | 'fail500' | 'fail401' | 'text'): Provider {
  return {
    name,
    resolveModel: (alias) => `${name}-${alias}`,
    contextWindowFor: () => 262144,
    async send(body: AnthropicRequest): Promise<SendResult> {
      if (behavior === 'fail500') throw new ProviderError(`${name} 500`, 500, true);
      if (behavior === 'fail401') throw new ProviderError(`${name} 401`, 401, false);
      // v2 契约：send 内部把别名映射为上游名，upstreamModel 为映射结果
      return {
        stream: new Response(`data: {"from":"${name}"}\n\n`).body!,
        upstreamModel: `${name}-${body.model}`,
      };
    },
    async sendSync(body: AnthropicRequest): Promise<string> {
      if (behavior === 'fail500') throw new ProviderError(`${name} 500`, 500, true);
      return `${name}摘要:${String((body.messages[0] as { content: string }).content).slice(0, 6)}`;
    },
  };
}

function cand(name: string, alias: string, behavior: 'ok' | 'fail500' | 'fail401' | 'text' = 'ok'): Candidate {
  return { provider: fakeProvider(name, behavior), alias, ref: `${name}/${alias}` };
}

// v2 契约：prepare 内设 body.model = 别名，上游名映射在 Provider 内部完成
const PREPARE = async (c: Candidate): Promise<AnthropicRequest> => ({
  model: c.alias,
  max_tokens: 10,
  messages: [{ role: 'user', content: 'hi' }],
});

describe('selectChain', () => {
  it('session 粘性优先于配置顺序', () => {
    const sessions = new SessionStore(300);
    sessions.bind('s1', 'volcengine/glm-5.3');
    const chain = selectChain(
      ['kimi/k3', 'volcengine/glm-5.3', 'bailian/glm-5'],
      new CircuitBreaker(3, 60), sessions, 's1',
    );
    expect(chain[0]).toBe('volcengine/glm-5.3');
    expect(chain).toEqual(['volcengine/glm-5.3', 'kimi/k3', 'bailian/glm-5']);
  });

  it('过滤熔断 ref；无 sessionId 时按配置顺序', () => {
    const breaker = new CircuitBreaker(1, 60);
    breaker.recordFailure('kimi/k3'); // 阈值 1，立即熔断
    const chain = selectChain(['kimi/k3', 'bailian/glm-5'], breaker, new SessionStore(300), null);
    expect(chain).toEqual(['bailian/glm-5']);
  });
});

describe('executeWithFailover', () => {
  it('第一家成功：不 failover，绑定 session 到 ref', async () => {
    const breaker = new CircuitBreaker(3, 60);
    const sessions = new SessionStore(300);
    const r = await executeWithFailover([cand('kimi', 'k3')], PREPARE, 5000, breaker, sessions, 's1');
    expect(r.failovered).toBe(false);
    expect(r.candidate.ref).toBe('kimi/k3');
    expect(r.candidate.provider.name).toBe('kimi');
    expect(sessions.get('s1')).toBe('kimi/k3');
  });

  it('第一家 500：failover 到第二家，粘性绑定到第二家 ref', async () => {
    const breaker = new CircuitBreaker(3, 60);
    const sessions = new SessionStore(300);
    const r = await executeWithFailover(
      [cand('kimi', 'k3', 'fail500'), cand('volcengine', 'glm-5.3')],
      PREPARE, 5000, breaker, sessions, 's1',
    );
    expect(r.failovered).toBe(true);
    expect(r.candidate.ref).toBe('volcengine/glm-5.3');
    expect(sessions.get('s1')).toBe('volcengine/glm-5.3');
  });

  it('401 封禁该 ref，后续 selectChain 不再包含它', async () => {
    const breaker = new CircuitBreaker(99, 60); // 高阈值，排除熔断干扰
    const sessions = new SessionStore(300);
    await executeWithFailover(
      [cand('kimi', 'k3', 'fail401'), cand('volcengine', 'glm-5.3')],
      PREPARE, 5000, breaker, sessions, null,
    );
    expect(breaker.canUse('kimi/k3')).toBe(false);
  });

  it('全部失败：抛最后一个错误', async () => {
    const breaker = new CircuitBreaker(99, 60);
    await expect(
      executeWithFailover(
        [cand('a', 'm1', 'fail500'), cand('b', 'm2', 'fail500')],
        PREPARE, 5000, breaker, new SessionStore(300), null,
      ),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('prepare 抛普通错误同样触发下一家', async () => {
    const breaker = new CircuitBreaker(99, 60);
    const r = await executeWithFailover(
      [cand('kimi', 'k3'), cand('volcengine', 'glm-5.3')],
      async (c) => {
        if (c.provider.name === 'kimi') throw new Error('压缩模型不可用');
        return PREPARE(c);
      },
      5000, breaker, new SessionStore(300), null,
    );
    expect(r.candidate.ref).toBe('volcengine/glm-5.3');
  });

  it('prepare 抛普通错误计入熔断（阈值 1 立即打开）', async () => {
    const breaker = new CircuitBreaker(1, 60);
    await executeWithFailover(
      [cand('kimi', 'k3'), cand('volcengine', 'glm-5.3')],
      async (c) => {
        if (c.provider.name === 'kimi') throw new Error('上游网络错误');
        return PREPARE(c);
      },
      5000, breaker, new SessionStore(300), null,
    );
    expect(breaker.canUse('kimi/k3')).toBe(false);
  });

  it('转发失败计入熔断时输出失败原因日志（熔断可溯源）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await executeWithFailover(
        [cand('kimi', 'k3', 'fail500'), cand('volcengine', 'glm-5.3')],
        PREPARE, 5000, new CircuitBreaker(99, 60), new SessionStore(300), null,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('kimi/k3'),
        expect.stringContaining('kimi 500'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('prepare 抛 CompactError 不计入熔断，仍 failover 到下一家', async () => {
    const breaker = new CircuitBreaker(1, 60); // 阈值 1：任何 recordFailure 都会立即熔断
    const r = await executeWithFailover(
      [cand('kimi', 'k3'), cand('volcengine', 'glm-5.3')],
      async (c) => {
        if (c.provider.name === 'kimi') {
          throw new CompactError('上下文压缩失败: 上游超时', { cause: new Error('上游超时') });
        }
        return PREPARE(c);
      },
      5000, breaker, new SessionStore(300), null,
    );
    expect(r.candidate.ref).toBe('volcengine/glm-5.3'); // 仍 failover
    expect(breaker.canUse('kimi/k3')).toBe(true); // 压缩失败不污染转发熔断
  });
});

describe('buildSummarizer', () => {
  const config = {
    compact: {
      thresholdRatio: 0.85, targetRatio: 0.7, keepRecentTurns: 6, chunkTokens: 40000,
      target: 'kimi/small', fallbackToTarget: true, timeoutMs: 5000, concurrency: 2,
      skipIfWindowGte: 1_000_000,
    },
    failover: { stickyTtlSeconds: 300, failureThreshold: 3, cooldownSeconds: 60, requestTimeoutMs: 5000 },
  } as unknown as RouterConfig;

  it('首选压缩模型成功时直接用，总结请求 max_tokens 给强制思考的模型留足空间', async () => {
    let seenMaxTokens: unknown;
    const spy: Provider = {
      name: 'kimi',
      resolveModel: (a) => `kimi-${a}`,
      contextWindowFor: () => 262144,
      async send(): Promise<SendResult> {
        throw new Error('未使用');
      },
      async sendSync(body) {
        seenMaxTokens = body.max_tokens;
        return 'kimi摘要';
      },
    };
    const providers = new Map([['kimi', spy]]);
    const s = buildSummarizer(config, providers, cand('bailian', 'glm-5', 'text'));
    await expect(s('一段历史')).resolves.toContain('kimi摘要');
    expect(seenMaxTokens).toBe(16384);
  });

  it('首选失败时兜底目标厂商', async () => {
    const providers = new Map([['kimi', fakeProvider('kimi', 'fail500')]]);
    const s = buildSummarizer(config, providers, cand('bailian', 'glm-5', 'text'));
    await expect(s('一段历史')).resolves.toContain('bailian摘要');
  });

  it('compact.target 无法解析时直接用目标厂商兜底', async () => {
    const cfg = JSON.parse(JSON.stringify(config)) as typeof config;
    (cfg as { compact: { target: string } }).compact.target = 'no-slash-ref';
    const providers = new Map([['kimi', fakeProvider('kimi', 'text')]]);
    const s = buildSummarizer(cfg, providers, cand('bailian', 'glm-5', 'text'));
    await expect(s('一段历史')).resolves.toContain('bailian摘要');
  });

  it('fallbackToTarget=false 且首选失败时抛错', async () => {
    const cfg = JSON.parse(JSON.stringify(config)) as typeof config;
    (cfg as { compact: { fallbackToTarget: boolean } }).compact.fallbackToTarget = false;
    const providers = new Map([['kimi', fakeProvider('kimi', 'fail500')]]);
    const s = buildSummarizer(cfg, providers, cand('bailian', 'glm-5', 'text'));
    await expect(s('一段历史')).rejects.toThrow();
  });

  it('链上模型失败时输出 warn（含 ref）并继续降级', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const providers = new Map([['kimi', fakeProvider('kimi', 'fail500')]]);
      const s = buildSummarizer(config, providers, cand('bailian', 'glm-5', 'fail500'));
      const err = (await s('一段历史').then(
        () => null,
        (e) => e,
      )) as Error;
      expect(err.message).toContain('无可用压缩模型');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('kimi/small 失败'), expect.anything());
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('bailian/glm-5 失败'), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('链上全部厂商失败：抛无可用压缩模型并带最后错误', async () => {
    const cfg = JSON.parse(JSON.stringify(config)) as typeof config;
    cfg.compact.target = ['kimi/small', 'volcengine/mid'];
    cfg.compact.fallbackToTarget = false;
    const providers = new Map([
      ['kimi', fakeProvider('kimi', 'fail500')],
      ['volcengine', fakeProvider('volcengine', 'fail500')],
    ]);
    const s = buildSummarizer(cfg, providers, cand('bailian', 'glm-5', 'text'));
    const err = (await s('一段历史').then(
      () => null,
      (e) => e,
    )) as Error & { cause?: unknown };
    expect(err.message).toContain('无可用压缩模型');
    expect(err.message).toContain('volcengine'); // 最后一家失败的信息
    expect(err.cause).toBeInstanceOf(ProviderError);
  });

  it('压缩链：target 列表首选失败后切下一项', async () => {
    const cfg = JSON.parse(JSON.stringify(config)) as typeof config;
    cfg.compact.target = ['kimi/small', 'volcengine/mid'];
    cfg.compact.fallbackToTarget = false;
    const providers = new Map([
      ['kimi', fakeProvider('kimi', 'fail500')],
      ['volcengine', fakeProvider('volcengine', 'text')],
    ]);
    const s = buildSummarizer(cfg, providers, cand('bailian', 'glm-5', 'text'));
    await expect(s('一段历史')).resolves.toContain('volcengine摘要');
  });

  it('一家失败后跳过该厂商全部模型，不重试同厂商', async () => {
    const cfg = JSON.parse(JSON.stringify(config)) as typeof config;
    cfg.compact.target = ['bailian/a1', 'bailian/a2', 'kimi/b1'];
    cfg.compact.fallbackToTarget = false;
    let a2Calls = 0;
    let b1Calls = 0;
    const bailian: Provider = {
      name: 'bailian',
      resolveModel: (a) => `bailian-${a}`,
      contextWindowFor: () => 262144,
      async send(): Promise<SendResult> {
        throw new Error('未使用');
      },
      async sendSync(body) {
        if (body.model === 'a1') throw new ProviderError('bailian/a1 超时', undefined, true);
        a2Calls++;
        return 'bailian-a2摘要';
      },
    };
    const kimi: Provider = {
      name: 'kimi',
      resolveModel: (a) => `kimi-${a}`,
      contextWindowFor: () => 262144,
      async send(): Promise<SendResult> {
        throw new Error('未使用');
      },
      async sendSync() {
        b1Calls++;
        return 'kimi-b1摘要';
      },
    };
    const providers = new Map([['bailian', bailian], ['kimi', kimi]]);
    const s = buildSummarizer(cfg, providers, cand('volcengine', 'glm-5.3'));
    await expect(s('一块')).resolves.toBe('kimi-b1摘要');
    expect(a2Calls).toBe(0); // 同厂商的 a2 直接跳过，不再重试 bailian
    expect(b1Calls).toBe(1);
  });

  it('压缩厂商级熔断：跨请求直接跳过已熔断厂商', async () => {
    let kimiCalls = 0;
    const kimi: Provider = {
      name: 'kimi',
      resolveModel: (a) => `kimi-${a}`,
      contextWindowFor: () => 262144,
      async send(): Promise<SendResult> {
        throw new Error('未使用');
      },
      async sendSync() {
        kimiCalls++;
        throw new ProviderError('kimi 超时', undefined, true);
      },
    };
    const providers = new Map([['kimi', kimi], ['bailian', fakeProvider('bailian', 'text')]]);
    const breaker = new CircuitBreaker(1, 60);
    const mk = () => buildSummarizer(config, providers, cand('bailian', 'glm-5', 'text'), breaker);
    await expect(mk()('块')).resolves.toContain('bailian摘要'); // 首次：kimi 失败 → bailian 兜底
    expect(kimiCalls).toBe(1);
    await expect(mk()('块')).resolves.toContain('bailian摘要'); // 再次请求：kimi 已熔断，直接 bailian
    expect(kimiCalls).toBe(1); // 不再重试已熔断厂商
  });

  it('单次压缩内首选失败一次即降级：后续调用直接走兜底，不再重复踩首选', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const counting = (name: string, fail: boolean, onCall: () => void): Provider => ({
      name,
      resolveModel: (a) => `${name}-${a}`,
      contextWindowFor: () => 262144,
      async send(): Promise<SendResult> {
        throw new Error('未使用');
      },
      async sendSync(): Promise<string> {
        onCall();
        if (fail) throw new ProviderError(`${name} 超时`, undefined, true);
        return `${name}摘要`;
      },
    });
    const providers = new Map([['kimi', counting('kimi', true, () => primaryCalls++)]]);
    const fb = counting('bailian', false, () => fallbackCalls++);
    const s = buildSummarizer(config, providers, { provider: fb, alias: 'glm-5', ref: 'bailian/glm-5' });
    // 模拟一次压缩的 3 个分块
    await expect(s('块一')).resolves.toBe('bailian摘要');
    await expect(s('块二')).resolves.toBe('bailian摘要');
    await expect(s('块三')).resolves.toBe('bailian摘要');
    expect(primaryCalls).toBe(1); // 首选只踩一次
    expect(fallbackCalls).toBe(3);
  });
});
