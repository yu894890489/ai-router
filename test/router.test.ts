import { describe, it, expect } from 'vitest';
import { executeWithFailover, selectChain } from '../src/pipeline/router.js';
import { buildSummarizer } from '../src/compact/summarizer.js';
import { ProviderError, type Provider, type SendResult } from '../src/providers/base.js';
import { CircuitBreaker, SessionStore } from '../src/session/store.js';
import type { AnthropicRequest } from '../src/types.js';

function fakeProvider(name: string, behavior: 'ok' | 'fail500' | 'fail401' | 'text'): Provider {
  return {
    name,
    contextWindow: 262144,
    resolveModel: (m) => `${name}-${m}`,
    async send(body: AnthropicRequest): Promise<SendResult> {
      if (behavior === 'fail500') throw new ProviderError(`${name} 500`, 500, true);
      if (behavior === 'fail401') throw new ProviderError(`${name} 401`, 401, false);
      return {
        stream: new Response(`data: {"from":"${name}"}\n\n`).body!,
        upstreamModel: body.model,
      };
    },
    async sendSync(body: AnthropicRequest): Promise<string> {
      if (behavior === 'fail500') throw new ProviderError(`${name} 500`, 500, true);
      return `${name}摘要:${String((body.messages[0] as { content: string }).content).slice(0, 6)}`;
    },
  };
}

const PREPARE = async (p: Provider): Promise<AnthropicRequest> => ({
  model: p.resolveModel('claude-sonnet-4-6'),
  max_tokens: 10,
  messages: [{ role: 'user', content: 'hi' }],
});

describe('selectChain', () => {
  it('session 粘性优先于配置顺序', () => {
    const sessions = new SessionStore(300);
    sessions.bind('s1', 'volcengine');
    const chain = selectChain(['kimi', 'volcengine', 'bailian'], new CircuitBreaker(3, 60), sessions, 's1');
    expect(chain[0]).toBe('volcengine');
    expect(chain).toEqual(['volcengine', 'kimi', 'bailian']);
  });

  it('过滤熔断厂商；无 sessionId 时按配置顺序', () => {
    const breaker = new CircuitBreaker(1, 60);
    breaker.recordFailure('kimi'); // 阈值 1，立即熔断
    const chain = selectChain(['kimi', 'bailian'], breaker, new SessionStore(300), null);
    expect(chain).toEqual(['bailian']);
  });
});

describe('executeWithFailover', () => {
  it('第一家成功：不 failover，绑定 session', async () => {
    const breaker = new CircuitBreaker(3, 60);
    const sessions = new SessionStore(300);
    const r = await executeWithFailover([fakeProvider('kimi', 'ok')], PREPARE, 5000, breaker, sessions, 's1');
    expect(r.failovered).toBe(false);
    expect(r.provider.name).toBe('kimi');
    expect(sessions.get('s1')).toBe('kimi');
  });

  it('第一家 500：failover 到第二家，粘性绑定到第二家', async () => {
    const breaker = new CircuitBreaker(3, 60);
    const sessions = new SessionStore(300);
    const r = await executeWithFailover(
      [fakeProvider('kimi', 'fail500'), fakeProvider('volcengine', 'ok')],
      PREPARE, 5000, breaker, sessions, 's1',
    );
    expect(r.failovered).toBe(true);
    expect(r.provider.name).toBe('volcengine');
    expect(sessions.get('s1')).toBe('volcengine');
  });

  it('401 封禁该厂商，后续 selectChain 不再包含它', async () => {
    const breaker = new CircuitBreaker(99, 60); // 高阈值，排除熔断干扰
    const sessions = new SessionStore(300);
    await executeWithFailover(
      [fakeProvider('kimi', 'fail401'), fakeProvider('volcengine', 'ok')],
      PREPARE, 5000, breaker, sessions, null,
    );
    expect(breaker.canUse('kimi')).toBe(false);
  });

  it('全部失败：抛最后一个错误', async () => {
    const breaker = new CircuitBreaker(99, 60);
    await expect(
      executeWithFailover(
        [fakeProvider('a', 'fail500'), fakeProvider('b', 'fail500')],
        PREPARE, 5000, breaker, new SessionStore(300), null,
      ),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('prepare 抛错（如压缩失败）同样触发下一家', async () => {
    const breaker = new CircuitBreaker(99, 60);
    const r = await executeWithFailover(
      [fakeProvider('kimi', 'ok'), fakeProvider('volcengine', 'ok')],
      async (p) => {
        if (p.name === 'kimi') throw new Error('压缩模型不可用');
        return PREPARE(p);
      },
      5000, breaker, new SessionStore(300), null,
    );
    expect(r.provider.name).toBe('volcengine');
  });
});

describe('buildSummarizer', () => {
  const config = {
    compact: {
      thresholdRatio: 0.85, targetRatio: 0.7, keepRecentTurns: 6, chunkTokens: 40000,
      provider: 'kimi', model: 'kimi-small', fallbackToTarget: true,
    },
    failover: { stickyTtlSeconds: 300, failureThreshold: 3, cooldownSeconds: 60, requestTimeoutMs: 5000 },
  } as never;

  it('首选压缩模型成功时直接用', async () => {
    const providers = new Map([['kimi', fakeProvider('kimi', 'text')]]);
    const s = buildSummarizer(config, providers, fakeProvider('bailian', 'text'));
    await expect(s('一段历史')).resolves.toContain('kimi摘要');
  });

  it('首选失败时兜底目标厂商', async () => {
    const providers = new Map([['kimi', fakeProvider('kimi', 'fail500')]]);
    const s = buildSummarizer(config, providers, fakeProvider('bailian', 'text'));
    await expect(s('一段历史')).resolves.toContain('bailian摘要');
  });

  it('fallbackToTarget=false 且首选失败时抛错', async () => {
    const cfg = JSON.parse(JSON.stringify(config)) as typeof config;
    (cfg as { compact: { fallbackToTarget: boolean } }).compact.fallbackToTarget = false;
    const providers = new Map([['kimi', fakeProvider('kimi', 'fail500')]]);
    const s = buildSummarizer(cfg, providers, fakeProvider('bailian', 'text'));
    await expect(s('一段历史')).rejects.toThrow();
  });
});
