import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { ADMIN_HTML } from '../src/admin-page.js';

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

async function sendFailingChat(
  app: ReturnType<typeof createApp>,
  uid: string = UID,
  title: string = 'admin 测试标题',
) {
  // 上游不可达会 5xx，但 prepare 已执行，touchSession 落行
  await app.request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ok' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1,
      stream: true,
      metadata: { user_id: uid },
      messages: [{ role: 'user', content: title }],
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

describe('admin 安全与输入健壮性（task-3 评审修复）', () => {
  const H = { 'x-api-key': 'sk-ok' };

  it('API 原样保留含 HTML 元字符/引号的 title 与 sessionId（转义在渲染层）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-adm-'));
    const app = createApp(writeConfig(dir));
    const evilTitle = '<script>alert(1)</script>';
    // extractSessionId 对 user_id 只做切片，引号原样进入 sessionId
    await sendFailingChat(app, "user_session_a'b\"c", evilTitle);

    const list = await (
      await app.request('http://localhost/admin/api/sessions', { headers: H })
    ).json();
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0].title).toBe(evilTitle);
    expect(list.sessions[0].sessionId).toBe("session_a'b\"c");
  });

  it('管理页渲染路径：用户可控字段走 textContent/dataset，无内联拼接', () => {
    // 负向断言：不存在把可控字符串插进 HTML/内联事件的模式
    expect(ADMIN_HTML).not.toContain('onchange="switchModel(');
    expect(ADMIN_HTML).not.toContain('+ it.title');
    expect(ADMIN_HTML).not.toContain('+ it.sessionId');
    expect(ADMIN_HTML).not.toContain('+ it.project');
    // 正向断言：渲染使用 DOM API（textContent 赋值 + dataset 传 sessionId + addEventListener 绑定）
    expect(ADMIN_HTML).toContain('.textContent = it.title');
    expect(ADMIN_HTML).toContain('.textContent = it.sessionId');
    expect(ADMIN_HTML).toContain("cell('', it.project)"); // cell() 内部用 textContent 赋值
    expect(ADMIN_HTML).toContain('dataset.sid');
    expect(ADMIN_HTML).toContain("addEventListener('change'");
    // 剩余 innerHTML 只允许静态字面量（清空与空态提示），不得拼接变量
    for (const m of ADMIN_HTML.matchAll(/innerHTML\s*=\s*([^;]+);/g)) {
      expect(m[1].trim()).toMatch(/^(''|'[^']*'|`[^`]*`)$/);
    }
  });

  it('POST 非法 JSON body 返回 400 而非 500', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-adm-'));
    const app = createApp(writeConfig(dir));
    await sendFailingChat(app);

    const res = await app.request('http://localhost/admin/api/sessions/session_admin1/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...H },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '请求体非法' });
  });

  it('limit 取整：?limit=2.5 按 2 处理，不再静默返回空列表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-adm-'));
    const app = createApp(writeConfig(dir));
    await sendFailingChat(app, 'user_session_l1', '标题一');
    await sendFailingChat(app, 'user_session_l2', '标题二');
    await sendFailingChat(app, 'user_session_l3', '标题三');

    const res = await app.request('http://localhost/admin/api/sessions?limit=2.5', { headers: H });
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list.sessions).toHaveLength(2); // Math.floor(2.5) = 2
  });
});
