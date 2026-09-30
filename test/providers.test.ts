import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAnthropicProvider, ProviderError } from '../src/providers/base.js';
import { createKimiProvider, createVolcengineProvider, createBailianProvider } from '../src/providers/index.js';
import type { ProviderConfig } from '../src/config.js';

let server: Server | null = null;
afterEach(() => server?.close());

type MockReply = { status: number; body: string; sse?: boolean };

function startMock(handler: (body: string) => MockReply | Promise<never>) {
  return new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const r = await handler(raw);
        res.writeHead(r.status, {
          'content-type': r.sse ? 'text/event-stream' : 'application/json',
        });
        res.end(r.body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
    });
  });
}

function cfg(baseUrl: string): ProviderConfig {
  return {
    baseUrl,
    apiKey: 'sk-test',
    authHeader: 'bearer',
    userAgent: 'claude-cli/test',
    extraHeaders: {},
    models: {
      'alias-a': { upstream: 'vendor-sonnet', contextWindow: 262144 },
    },
  };
}

// 调用方永远传模型别名；Provider 内部完成 别名 → 上游名 映射
const BODY = { model: 'alias-a', max_tokens: 10, messages: [{ role: 'user' as const, content: 'hi' }] };

/** 返回一段完整 SSE 文本回复（message_start → text delta → message_stop） */
function sseSummary(text: string): string {
  const ev = (t: string, d: unknown) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
  return (
    ev('message_start', { type: 'message_start', message: { role: 'assistant' } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    ev('message_stop', { type: 'message_stop' })
  );
}

describe('providers/base', () => {
  it('resolveModel: 已知别名返回上游模型名', async () => {
    const base = await startMock(() => ({ status: 200, body: '{}' }));
    const p = createAnthropicProvider('t', cfg(base));
    expect(p.resolveModel('alias-a')).toBe('vendor-sonnet');
  });

  it('resolveModel: 未知别名抛 ProviderError（retriable=false），点名厂商与别名', async () => {
    const base = await startMock(() => ({ status: 200, body: '{}' }));
    const p = createAnthropicProvider('kimi', cfg(base));
    try {
      p.resolveModel('no-such-alias');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      const err = e as ProviderError;
      expect(err.retriable).toBe(false);
      expect(err.message).toContain('kimi');
      expect(err.message).toContain('no-such-alias');
    }
  });

  it('contextWindowFor: 已知别名返回上下文窗口', async () => {
    const base = await startMock(() => ({ status: 200, body: '{}' }));
    const p = createAnthropicProvider('t', cfg(base));
    expect(p.contextWindowFor('alias-a')).toBe(262144);
  });

  it('contextWindowFor: 未知别名抛 ProviderError（retriable=false），点名厂商与别名', async () => {
    const base = await startMock(() => ({ status: 200, body: '{}' }));
    const p = createAnthropicProvider('volcengine', cfg(base));
    try {
      p.contextWindowFor('no-such-alias');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      const err = e as ProviderError;
      expect(err.retriable).toBe(false);
      expect(err.message).toContain('volcengine');
      expect(err.message).toContain('no-such-alias');
    }
  });

  it('send: 2xx 返回 SSE 流；内部把别名映射为上游名（mock 收到的 model 与 upstreamModel 均为上游名）', async () => {
    let seen = '';
    const base = await startMock((raw) => {
      seen = raw;
      return { status: 200, sse: true, body: 'event: message_stop\ndata: {"type":"message_stop"}\n\n' };
    });
    const p = createAnthropicProvider('kimi', cfg(base));
    const r = await p.send(BODY, 5000);
    expect(r.upstreamModel).toBe('vendor-sonnet');
    const sent = JSON.parse(seen);
    expect(sent.stream).toBe(true);
    expect(sent.model).toBe('vendor-sonnet');
    const text = await new Response(r.stream).text();
    expect(text).toContain('message_stop');
  });

  it('send: 500 抛可重试 ProviderError，401 抛不可重试', async () => {
    const base500 = await startMock(() => ({ status: 500, body: 'boom' }));
    const p = createAnthropicProvider('x', cfg(base500));
    await expect(p.send(BODY, 5000)).rejects.toMatchObject({ status: 500, retriable: true });
    server?.close();
    const base401 = await startMock(() => ({ status: 401, body: 'bad key' }));
    const p2 = createAnthropicProvider('x', cfg(base401));
    await expect(p2.send(BODY, 5000)).rejects.toMatchObject({ status: 401, retriable: false });
  });

  it('send: 超时抛可重试 ProviderError', async () => {
    const base = await startMock(
      () => new Promise(() => {}) as never, // 永不响应
    );
    const p = createAnthropicProvider('x', cfg(base));
    await expect(p.send(BODY, 100)).rejects.toBeInstanceOf(ProviderError);
  });

  it('sendSync: 走流式传输并聚合 text 块返回字符串（与转发同路径，规避非流式挂死）', async () => {
    let seen = '';
    const base = await startMock((raw) => {
      seen = raw;
      return {
        status: 200,
        sse: true,
        body:
          'event: message_start\ndata: {"type":"message_start","message":{"role":"assistant"}}\n\n' +
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"摘要"}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      };
    });
    const p = createAnthropicProvider('x', cfg(base));
    await expect(p.sendSync(BODY, 5000)).resolves.toBe('摘要');
    const sent = JSON.parse(seen);
    expect(sent.model).toBe('vendor-sonnet'); // v2 契约：sendSync 也映射别名
    expect(sent.stream).toBe(true); // 压缩总结与转发同为流式，避免 coding 端点非流式大 prompt 挂死/重置
  });

  it('sendSync: 200 但返回 JSON（非 SSE）时抛带上游错误详情的 ProviderError', async () => {
    const base = await startMock(() => ({
      status: 200,
      body: JSON.stringify({
        error: { message: '您已达到本计费周期的用量上限' },
      }),
    }));
    const p = createAnthropicProvider('x', cfg(base));
    await expect(p.sendSync(BODY, 5000)).rejects.toMatchObject({
      message: expect.stringContaining('您已达到本计费周期的用量上限'),
    });
  });

  it('sendSync: 默认携带 thinking disabled（glm 系思考模型不再吃光输出预算）', async () => {
    let seen: Record<string, unknown> | null = null;
    const base = await startMock((raw) => {
      seen = JSON.parse(raw) as Record<string, unknown>;
      return { status: 200, sse: true, body: sseSummary('摘要') };
    });
    const p = createAnthropicProvider('x', cfg(base));
    await expect(p.sendSync(BODY, 5000)).resolves.toBe('摘要');
    expect((seen as unknown as Record<string, unknown>).thinking).toEqual({ type: 'disabled' });
  });

  it('sendSync: 上游 400 报 thinking 不支持时，自适应去掉参数重试并记住', async () => {
    let n = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const base = await startMock((raw) => {
      n++;
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      if (bodies.at(-1)?.thinking !== undefined) {
        return {
          status: 400,
          body: JSON.stringify({
            error: { code: 'InvalidParameter', message: "thinking.type `disabled` is not supported by this model" },
          }),
        };
      }
      return { status: 200, sse: true, body: sseSummary('摘要') };
    });
    const p = createAnthropicProvider('x', cfg(base));
    // 第一次：带参数被 400 → 去参数重试成功
    await expect(p.sendSync(BODY, 5000)).resolves.toBe('摘要');
    expect(n).toBe(2);
    expect(bodies[0].thinking).toEqual({ type: 'disabled' });
    expect(bodies[1].thinking).toBeUndefined();
    // 第二次调用：直接不带参数，只发一次
    await expect(p.sendSync(BODY, 5000)).resolves.toBe('摘要');
    expect(n).toBe(3);
  }, 15000);

  it('sendSync: 上游限流(Throttling)时等待后原样重试一次', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const base = await startMock(() => {
        n++;
        if (n === 1) {
          return {
            status: 200,
            sse: true,
            body: 'event:error\ndata: {"code":"Throttling","message":"Request rate increased too quickly."}\n\n',
          };
        }
        return { status: 200, sse: true, body: sseSummary('摘要') };
      });
      const p = createAnthropicProvider('x', cfg(base));
      let settled = false;
      const promise = p.sendSync(BODY, 30000).finally(() => {
        settled = true;
      });
      // 循环推进虚拟时钟越过限流退避（fetch 完成时机与虚拟时钟解耦，须推进到 promise 落定）
      for (let i = 0; i < 50 && !settled; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      await expect(promise).resolves.toBe('摘要');
      expect(n).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

  it('sendSync: 限流重试后仍限流则抛错(不无限重试)', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const base = await startMock(() => {
        n++;
        return {
          status: 200,
          sse: true,
          body: 'event:error\ndata: {"code":"Throttling","message":"Request rate increased too quickly."}\n\n',
        };
      });
      const p = createAnthropicProvider('x', cfg(base));
      let settled = false;
      const promise = p.sendSync(BODY, 60000).finally(() => {
        settled = true;
      });
      for (let i = 0; i < 50 && !settled; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      await expect(promise).rejects.toThrow('Throttling');
      expect(n).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

  it('sendSync: 上游 400 但与 thinking 无关时不做自适应重试', async () => {
    let n = 0;
    const base = await startMock(() => {
      n++;
      return { status: 400, body: JSON.stringify({ error: { message: '模型名非法' } }) };
    });
    const p = createAnthropicProvider('x', cfg(base));
    await expect(p.sendSync(BODY, 5000)).rejects.toMatchObject({ status: 400 });
    expect(n).toBe(1);
  });

  it('sendSync: SSE error 事件抛 ProviderError', async () => {
    const base = await startMock(() => ({
      status: 200,
      sse: true,
      body: 'event: error\ndata: {"type":"error","error":{"message":"上游过载"}}\n\n',
    }));
    const p = createAnthropicProvider('x', cfg(base));
    await expect(p.sendSync(BODY, 5000)).rejects.toMatchObject({
      message: expect.stringContaining('上游过载'),
    });
  });

  it('网络错误：ProviderError 带底层 cause（如 ECONNRESET），不再是裸 fetch failed', async () => {
    // 模拟连接被对端重置：收到请求后直接销毁 socket，不回任何响应
    const base = await new Promise<string>((resolve) => {
      server = createServer((req) => {
        req.socket.destroy();
      });
      server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
      });
    });
    const p = createAnthropicProvider('x', cfg(base));
    const err = (await p.sendSync(BODY, 5000).then(
      () => null,
      (e) => e,
    )) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('网络错误');
    expect(err.message).toMatch(/closed|ECONNRESET|reset/i); // 底层 cause 可见
  });

  it('连接级失败自动重试：第一次连接被重置，重试后成功', async () => {
    let n = 0;
    const base = await new Promise<string>((resolve) => {
      server = createServer((req, res) => {
        n++;
        if (n === 1) {
          req.socket.destroy();
          return;
        }
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(sseSummary('摘要'));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
      });
    });
    const p = createAnthropicProvider('x', cfg(base));
    await expect(p.sendSync(BODY, 5000)).resolves.toBe('摘要');
    expect(n).toBe(2);
  }, 15000);

  it('连接级失败重试上限 3 次：持续重置最终抛 ProviderError', async () => {
    let n = 0;
    const base = await new Promise<string>((resolve) => {
      server = createServer((req) => {
        n++;
        req.socket.destroy();
      });
      server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
      });
    });
    const p = createAnthropicProvider('x', cfg(base));
    await expect(p.sendSync(BODY, 5000)).rejects.toBeInstanceOf(ProviderError);
    expect(n).toBe(3);
  }, 15000);

  it('超时（AbortError）不重试：重试只针对连接级瞬断', async () => {
    let n = 0;
    const base = await new Promise<string>((resolve) => {
      server = createServer(() => {
        n++; // 收到请求但永不响应
      });
      server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
      });
    });
    const p = createAnthropicProvider('x', cfg(base));
    await expect(p.sendSync(BODY, 200)).rejects.toMatchObject({
      message: expect.stringContaining('请求超时'),
    });
    expect(n).toBe(1);
  }, 15000);

  it('sendSync: 未知别名不发请求直接抛 ProviderError（retriable=false）', async () => {
    let called = false;
    const base = await startMock(() => {
      called = true;
      return { status: 200, body: '{}' };
    });
    const p = createAnthropicProvider('x', cfg(base));
    await expect(p.sendSync({ ...BODY, model: 'ghost' }, 5000)).rejects.toMatchObject({
      retriable: false,
    });
    expect(called).toBe(false);
  });
});

describe('具名厂商工厂', () => {
  it('三家工厂产出的 Provider 带正确名字', () => {
    expect(createKimiProvider(cfg('http://x')).name).toBe('kimi');
    expect(createVolcengineProvider(cfg('http://x')).name).toBe('volcengine');
    expect(createBailianProvider(cfg('http://x')).name).toBe('bailian');
  });
});
