import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { resolveChainRefs } from '../src/pipeline/router.js';
import { SessionStore } from '../src/session/store.js';

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

describe('resolveChainRefs', () => {
  it('无 override 时原样返回规则链', () => {
    expect(resolveChainRefs(['a/x', 'b/y'], null)).toEqual(['a/x', 'b/y']);
  });

  it('override 置顶并去重', () => {
    expect(resolveChainRefs(['a/x', 'b/y', 'c/z'], 'b/y')).toEqual(['b/y', 'a/x', 'c/z']);
  });

  it('override 不在规则链中时照样置顶（钉住优先，规则链兜底）', () => {
    expect(resolveChainRefs(['a/x'], 'b/y')).toEqual(['b/y', 'a/x']);
  });
});

describe('SessionStore.unbind', () => {
  it('解除粘性绑定', () => {
    const s = new SessionStore(60);
    s.bind('session_x', 'a/x');
    s.unbind('session_x');
    expect(s.get('session_x')).toBeNull();
  });
});

function sseBody(text: string): string {
  const ev = (t: string, d: unknown) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
  return (
    ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'mock', content: [], usage: { input_tokens: 5, output_tokens: 1 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) +
    ev('message_stop', { type: 'message_stop' })
  );
}

interface MockHandle {
  url: string;
  lastModel: () => string | null;
}

function startMock(): Promise<MockHandle> {
  return new Promise((resolve) => {
    let lastModel: string | null = null;
    const s = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        lastModel = (JSON.parse(raw) as { model?: string }).model ?? null;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody('ok'));
      });
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, lastModel: () => lastModel });
    });
  });
}

const SESSION_UID = 'user_account_session_abc123';

function sendChat(app: ReturnType<typeof createApp>) {
  return app.request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ok' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8,
      stream: true,
      metadata: { user_id: SESSION_UID },
      messages: [{ role: 'user', content: '第一句话作为标题' }],
    }),
  });
}

describe('会话 override 路由', () => {
  it('无 override 走规则链；写入 override 后同会话切到钉住 ref', async () => {
    const p1 = await startMock();
    const p2 = await startMock();
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-ovr-'));
    const dbPath = join(dir, 'r.db').replace(/\\/g, '/');
    writeFileSync(
      join(dir, 'config.yaml'),
      `
server: { port: 0 }
accessKeys: { sk-ok: proj1 }
providers:
  p1:
    baseUrl: ${p1.url}
    apiKey: k1
    authHeader: bearer
    userAgent: ua
    models: { m: { upstream: p1-upstream, contextWindow: 262144 } }
  p2:
    baseUrl: ${p2.url}
    apiKey: k2
    authHeader: bearer
    userAgent: ua
    models: { m: { upstream: p2-upstream, contextWindow: 262144 } }
routing:
  rules:
    "*": [p1/m, p2/m]
compact: { target: p2/m }
storage: { sqlitePath: ${dbPath}, jsonlDir: ${join(dir, 'logs').replace(/\\/g, '/')} }
`,
      'utf8',
    );
    const app = createApp(join(dir, 'config.yaml'));

    // 第一次请求：规则链首选 p1
    let res = await sendChat(app);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100)); // 等流尾日志
    expect(p1.lastModel()).toBe('p1-upstream');
    expect(p2.lastModel()).toBeNull();

    // 直接写库设置 override（Admin API 属 Task 3，这里绕开页面测路由行为）
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE sessions SET override_ref = 'p2/m' WHERE session_id = 'session_abc123'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'session_abc123'").get())
      .toEqual({ n: 1 }); // touchSession 已建行，且标题/项目已记录
    db.close();

    // 第二次同会话请求：钉住 p2
    res = await sendChat(app);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(p2.lastModel()).toBe('p2-upstream');
  });
});
