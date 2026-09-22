import { describe, it, expect, afterEach } from 'vitest';
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
    contextWindow: 262144,
    userAgent: 'claude-cli/test',
    extraHeaders: {},
    modelMap: { 'claude-sonnet-4-6': 'vendor-sonnet', '*': 'vendor-default' },
  };
}

const BODY = { model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user' as const, content: 'hi' }] };

describe('providers/base', () => {
  it('resolveModel: 精确映射 > * > 原名', async () => {
    const base = await startMock(() => ({ status: 200, body: '{}' }));
    const p = createAnthropicProvider('t', cfg(base));
    expect(p.resolveModel('claude-sonnet-4-6')).toBe('vendor-sonnet');
    expect(p.resolveModel('claude-haiku-4-5')).toBe('vendor-default');
    expect(createAnthropicProvider('t', { ...cfg(base), modelMap: {} }).resolveModel('x')).toBe('x');
  });

  it('send: 2xx 返回 SSE 流，请求体含 stream:true 与上游模型名', async () => {
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

  it('sendSync: 聚合 text 块返回字符串', async () => {
    const base = await startMock(() => ({
      status: 200,
      body: JSON.stringify({ content: [{ type: 'text', text: '摘要' }] }),
    }));
    const p = createAnthropicProvider('x', cfg(base));
    await expect(p.sendSync(BODY, 5000)).resolves.toBe('摘要');
  });
});

describe('具名厂商工厂', () => {
  it('三家工厂产出的 Provider 带正确名字', () => {
    expect(createKimiProvider(cfg('http://x')).name).toBe('kimi');
    expect(createVolcengineProvider(cfg('http://x')).name).toBe('volcengine');
    expect(createBailianProvider(cfg('http://x')).name).toBe('bailian');
  });
});
