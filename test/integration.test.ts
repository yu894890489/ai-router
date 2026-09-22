import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

function sseBody(text: string): string {
  const ev = (t: string, d: unknown) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
  return (
    ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'mock', content: [], usage: { input_tokens: 42, output_tokens: 1 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }) +
    ev('message_stop', { type: 'message_stop' })
  );
}

interface MockHandle {
  url: string;
  lastRequest: () => Record<string, unknown> | null;
}

function startMock(mode: 'ok' | 'fail500'): Promise<MockHandle> {
  return new Promise((resolve) => {
    let last: Record<string, unknown> | null = null;
    const s = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        last = JSON.parse(raw) as Record<string, unknown>;
        if (mode === 'fail500') {
          res.writeHead(500).end('boom');
          return;
        }
        if (last.stream === false) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ content: [{ type: 'text', text: '压缩摘要内容' }] }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody('来自mock的回答'));
      });
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
        lastRequest: () => last,
      });
    });
  });
}

async function setup(opts: { p1: 'ok' | 'fail500'; contextWindow?: number; p2ContextWindow?: number }) {
  const p1 = await startMock(opts.p1);
  const p2 = await startMock('ok');
  const dir = mkdtempSync(join(tmpdir(), 'ai-router-e2e-'));
  const dbPath = join(dir, 'r.db').replace(/\\/g, '/');
  const cfgPath = join(dir, 'config.yaml');
  writeFileSync(
    cfgPath,
    `
server: { port: 0 }
accessKeys:
  sk-proj-a: project-a
  sk-auto: null
providers:
  p1:
    baseUrl: ${p1.url}
    apiKey: k1
    authHeader: bearer
    userAgent: ua
    models:
      main: { upstream: p1-model, contextWindow: ${opts.contextWindow ?? 262144} }
  p2:
    baseUrl: ${p2.url}
    apiKey: k2
    authHeader: bearer
    userAgent: ua
    models:
      main: { upstream: p2-model, contextWindow: ${opts.p2ContextWindow ?? 262144} }
routing:
  rules:
    "*": [p1/main, p2/main]
compact: { target: p2/main, keepRecentTurns: 2, chunkTokens: 500 }
failover: { requestTimeoutMs: 5000 }
storage: { sqlitePath: ${dbPath}, jsonlDir: ${join(dir, 'logs').replace(/\\/g, '/')} }
`,
    'utf8',
  );
  return { app: createApp(cfgPath), dbPath, p1, p2 };
}

function post(app: ReturnType<typeof createApp>, key: string, body: Record<string, unknown>) {
  return app.request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  });
}

const CHAT = {
  model: 'claude-sonnet-4-6',
  max_tokens: 100,
  stream: true,
  messages: [{ role: 'user', content: '你好' }],
};

describe('集成：正常转发', () => {
  it('SSE 透传 + 模型名映射 + 日志成功落库', async () => {
    const { app, dbPath, p1 } = await setup({ p1: 'ok' });
    const res = await post(app, 'sk-proj-a', CHAT);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('来自mock的回答');
    // 模型名已映射为上游模型，且带 Claude Code 伪装
    const upstream = p1.lastRequest()!;
    expect(upstream.model).toBe('p1-model');
    expect((upstream.system as Array<{ text: string }>)[0].text).toMatch(/^You are Claude Code/);
    // 等 usage 落库
    await new Promise((r) => setTimeout(r, 200));
    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 1').get() as Record<string, unknown>;
    expect(row.project).toBe('project-a');
    expect(row.provider).toBe('p1');
    expect(row.status).toBe('success');
    expect(row.input_tokens).toBe(42);
    expect(row.output_tokens).toBe(7);
    expect(row.failovered).toBe(0);
    db.close();
  });
});

describe('集成：failover', () => {
  it('p1 返回 500 时切到 p2，日志标记 failovered', async () => {
    const { app, dbPath, p2 } = await setup({ p1: 'fail500' });
    const res = await post(app, 'sk-proj-a', CHAT);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('来自mock的回答');
    expect(p2.lastRequest()).not.toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 1').get() as Record<string, unknown>;
    expect(row.provider).toBe('p2');
    expect(row.failovered).toBe(1);
    db.close();
  });
});

describe('集成：上下文压缩', () => {
  it('窗口超阈值时上游收到 <context-summary>，日志标记 compacted', async () => {
    const { app, dbPath, p1 } = await setup({ p1: 'ok', contextWindow: 100 });
    const messages = [];
    for (let i = 0; i < 6; i++) {
      messages.push(
        { role: 'user', content: `问题${i} ${'很长的内容'.repeat(50)}` },
        { role: 'assistant', content: `回答${i}` },
      );
    }
    const res = await post(app, 'sk-proj-a', { ...CHAT, messages });
    expect(res.status).toBe(200);
    const upstream = p1.lastRequest()!;
    const firstMsg = (upstream.messages as Array<{ content: string }>)[0];
    expect(firstMsg.content).toContain('<context-summary>');
    expect(firstMsg.content).toContain('压缩摘要内容');
    await new Promise((r) => setTimeout(r, 200));
    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 1').get() as Record<string, unknown>;
    expect(row.compacted).toBe(1);
    expect(row.compact_before).toBeGreaterThan(row.compact_after as number);
    db.close();
  });
});

describe('集成：项目归属兜底', () => {
  it('默认 Key 从 system 的 cwd 推断项目标签', async () => {
    const { app, dbPath } = await setup({ p1: 'ok' });
    const body = {
      ...CHAT,
      system: [{ type: 'text', text: 'You are Claude Code\ncwd: D:\\work\\inferred-proj' }],
    };
    const res = await post(app, 'sk-auto', body);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 1').get() as Record<string, unknown>;
    expect(row.project).toBe('D:\\work\\inferred-proj');
    db.close();
  });
});

describe('集成：非流式聚合响应', () => {
  it('stream:false 返回聚合 JSON 而非 SSE，usage 落库', async () => {
    const { app, dbPath, p1 } = await setup({ p1: 'ok' });
    const res = await post(app, 'sk-proj-a', { ...CHAT, stream: false });
    expect(res.status).toBe(200);
    // ① 聚合 JSON：不是 SSE
    expect(res.headers.get('content-type') ?? '').not.toContain('event-stream');
    const body = (await res.json()) as {
      role: string;
      content: Array<{ type: string; text?: string }>;
    };
    expect(body.role).toBe('assistant');
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content[0].type).toBe('text');
    expect(body.content[0].text).toContain('来自mock的回答');
    // 上游仍按 stream:true 请求（路由内部始终走流式再聚合）
    expect(p1.lastRequest()!.stream).toBe(true);
    // ② 等落库：usage 来自 mock SSE 的 message_start(input=42) + message_delta(output=7)
    await new Promise((r) => setTimeout(r, 200));
    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 1').get() as Record<string, unknown>;
    expect(row.status).toBe('success');
    expect(row.input_tokens).toBe(42);
    expect(row.output_tokens).toBe(7);
    db.close();
  });
});

describe('集成：failover 后 compactInfo 不残留', () => {  it('p1 压缩成功但发送失败，failover 到不压缩的 p2 后日志 compacted=0', async () => {
    const { app, dbPath, p1, p2 } = await setup({ p1: 'fail500', contextWindow: 100, p2ContextWindow: 262144 });
    const messages = [];
    for (let i = 0; i < 6; i++) {
      messages.push(
        { role: 'user', content: `问题${i} ${'很长的内容'.repeat(50)}` },
        { role: 'assistant', content: `回答${i}` },
      );
    }
    const res = await post(app, 'sk-proj-a', { ...CHAT, messages });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('来自mock的回答');
    // p1 触发了压缩（收到 <context-summary>）但 500 失败；p2 兜底成功且未压缩
    const p1Req = p1.lastRequest()!;
    expect((p1Req.messages as Array<{ content: string }>)[0].content).toContain('<context-summary>');
    const p2Req = p2.lastRequest()!;
    expect((p2Req.messages as Array<{ content: string }>)[0].content).not.toContain('<context-summary>');
    await new Promise((r) => setTimeout(r, 200));
    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 1').get() as Record<string, unknown>;
    expect(row.provider).toBe('p2');
    expect(row.failovered).toBe(1);
    expect(row.compacted).toBe(0);
    db.close();
  });
});
