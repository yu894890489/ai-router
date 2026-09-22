import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

function writeConfig(dir: string): string {
  const p = join(dir, 'config.yaml');
  writeFileSync(
    p,
    `
server: { port: 3456 }
accessKeys: { sk-ok: proj1 }
providers:
  kimi:
    baseUrl: http://127.0.0.1:1
    apiKey: sk-x
    authHeader: bearer
    userAgent: ua
    models:
      k3: { upstream: k3-up, contextWindow: 1048576 }
      coding: { upstream: coding-up, contextWindow: 262144 }
routing:
  rules:
    "*": [kimi/coding]
compact: { target: kimi/coding }
storage: { sqlitePath: ${join(dir, 'r.db').replace(/\\/g, '/')}, jsonlDir: ${join(dir, 'logs').replace(/\\/g, '/')} }
`,
    'utf8',
  );
  return p;
}

const UID = 'user_account_session_admin1';

async function sendFailingChat(app: ReturnType<typeof createApp>) {
  // 上游不可达会 5xx，但 prepare 已执行，touchSession 落行
  await app.request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ok' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1,
      stream: true,
      metadata: { user_id: UID },
      messages: [{ role: 'user', content: 'admin 测试标题' }],
    }),
  });
}

describe('admin', () => {
  it('GET /admin 返回页面', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-adm-'));
    const app = createApp(writeConfig(dir));
    const res = await app.request('http://localhost/admin');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ai-router');
  });

  it('API 无 Key 401，有 Key 返回会话列表与模型清单', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-adm-'));
    const app = createApp(writeConfig(dir));

    expect((await app.request('http://localhost/admin/api/sessions')).status).toBe(401);
    expect((await app.request('http://localhost/admin/api/models')).status).toBe(401);

    await sendFailingChat(app);

    const list = await (
      await app.request('http://localhost/admin/api/sessions', { headers: { 'x-api-key': 'sk-ok' } })
    ).json();
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0].sessionId).toBe('session_admin1');
    expect(list.sessions[0].title).toBe('admin 测试标题');
    expect(list.sessions[0].overrideRef).toBeNull();

    const models = await (
      await app.request('http://localhost/admin/api/models', { headers: { 'x-api-key': 'sk-ok' } })
    ).json();
    expect(models.models.map((m: { ref: string }) => m.ref).sort()).toEqual(['kimi/coding', 'kimi/k3']);
    expect(typeof models.thresholdRatio).toBe('number');
  });

  it('POST 钉模型：成功/非法 ref/未知会话/清除', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-adm-'));
    const app = createApp(writeConfig(dir));
    await sendFailingChat(app);
    const h = { 'content-type': 'application/json', 'x-api-key': 'sk-ok' };

    const ok = await app.request('http://localhost/admin/api/sessions/session_admin1/model', {
      method: 'POST', headers: h, body: JSON.stringify({ ref: 'kimi/k3' }),
    });
    expect(ok.status).toBe(200);

    const list = await (
      await app.request('http://localhost/admin/api/sessions', { headers: { 'x-api-key': 'sk-ok' } })
    ).json();
    expect(list.sessions[0].overrideRef).toBe('kimi/k3');
    expect(list.sessions[0].currentRef).toBe('kimi/k3'); // 粘性同步

    const bad = await app.request('http://localhost/admin/api/sessions/session_admin1/model', {
      method: 'POST', headers: h, body: JSON.stringify({ ref: 'kimi/nope' }),
    });
    expect(bad.status).toBe(400);

    const ghost = await app.request('http://localhost/admin/api/sessions/session_ghost/model', {
      method: 'POST', headers: h, body: JSON.stringify({ ref: 'kimi/k3' }),
    });
    expect(ghost.status).toBe(404);

    const clear = await app.request('http://localhost/admin/api/sessions/session_admin1/model', {
      method: 'POST', headers: h, body: JSON.stringify({ ref: null }),
    });
    expect(clear.status).toBe(200);
    const after = await (
      await app.request('http://localhost/admin/api/sessions', { headers: { 'x-api-key': 'sk-ok' } })
    ).json();
    expect(after.sessions[0].overrideRef).toBeNull();
  });
});
