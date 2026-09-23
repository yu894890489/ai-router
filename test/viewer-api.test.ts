import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

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

function startMock(reply: string): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody(reply));
      });
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
  });
}

const UID = 'user_account_session_view1';
const H = { 'x-api-key': 'sk-ok' };

async function setup() {
  const p1 = await startMock('这是AI的回答');
  const dir = mkdtempSync(join(tmpdir(), 'ai-router-view-'));
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
routing:
  rules:
    "*": [p1/m]
compact: { target: p1/m }
storage: { sqlitePath: ${join(dir, 'r.db').replace(/\\/g, '/')}, jsonlDir: ${join(dir, 'logs').replace(/\\/g, '/')} }
`,
    'utf8',
  );
  return createApp(join(dir, 'config.yaml'));
}

function chat(app: ReturnType<typeof createApp>, messages: Array<{ role: string; content: string }>) {
  return app.request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ok' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8,
      stream: true,
      metadata: { user_id: UID },
      messages,
    }),
  });
}

const t1 = [{ role: 'user', content: '第一个问题' }];
const t2 = [...t1, { role: 'assistant', content: '这是AI的回答' }, { role: 'user', content: '第二个问题' }];

describe('viewer api', () => {
  it('无 Key 401', async () => {
    const app = await setup();
    expect((await app.request('http://localhost/admin/api/sessions/session_view1/turns')).status).toBe(401);
    expect((await app.request('http://localhost/admin/api/search?q=x')).status).toBe(401);
    expect((await app.request('http://localhost/admin/api/requests/r1/body')).status).toBe(401);
  });

  it('两轮请求后 turns 按序返回，用户输入去重、AI 回复落库', async () => {
    const app = await setup();
    expect((await chat(app, t1)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect((await chat(app, t2)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));

    const res = await app.request('http://localhost/admin/api/sessions/session_view1/turns', { headers: H });
    expect(res.status).toBe(200);
    const { turns } = await res.json();
    expect(turns).toHaveLength(2);
    expect(turns[0].seq).toBe(1);
    expect(turns[0].userText).toBe('第一个问题');
    expect(turns[0].assistantText).toContain('这是AI的回答');
    expect(turns[1].seq).toBe(2);
    expect(turns[1].userText).toBe('第二个问题');
  });

  it('原始报文按 requestId 可取，未知 id 404', async () => {
    const app = await setup();
    expect((await chat(app, t1)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    const { turns } = await (
      await app.request('http://localhost/admin/api/sessions/session_view1/turns', { headers: H })
    ).json();
    const res = await app.request(`http://localhost/admin/api/requests/${turns[0].requestId}/body`, { headers: H });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request.model).toBe('claude-sonnet-4-6');
    expect((await app.request('http://localhost/admin/api/requests/nope/body', { headers: H })).status).toBe(404);
  });

  it('搜索命中并带 sessionTitle，缺 q 400', async () => {
    const app = await setup();
    expect((await chat(app, t1)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    const res = await app.request('http://localhost/admin/api/search?q=' + encodeURIComponent('第一个'), { headers: H });
    expect(res.status).toBe(200);
    const { hits } = await res.json();
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].sessionId).toBe('session_view1');
    expect(hits[0].sessionTitle).toBe('第一个问题');
    expect((await app.request('http://localhost/admin/api/search', { headers: H })).status).toBe(400);
  });

  it('未知会话 turns 404', async () => {
    const app = await setup();
    expect((await app.request('http://localhost/admin/api/sessions/session_ghost/turns', { headers: H })).status).toBe(404);
  });
});
