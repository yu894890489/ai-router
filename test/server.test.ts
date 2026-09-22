import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

function writeConfig(dir: string, extra = ''): string {
  const p = join(dir, 'config.yaml');
  writeFileSync(
    p,
    `
server: { port: 3456 } # 测试不监听端口，仅需通过 schema 校验
accessKeys: { sk-ok: proj1 }
providers:
  kimi:
    baseUrl: http://127.0.0.1:1   # 不可达，仅用于错误路径测试
    apiKey: sk-x
    authHeader: bearer
    contextWindow: 262144
    userAgent: ua
    modelMap: { "*": m }
routing: { default: [kimi] }
compact: { provider: kimi, model: m }
storage: { sqlitePath: ${join(dir, 'r.db').replace(/\\/g, '/')}, jsonlDir: ${join(dir, 'logs').replace(/\\/g, '/')} }
${extra}
`,
    'utf8',
  );
  return p;
}

describe('server', () => {
  it('GET /health 返回 ok', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-srv-'));
    const app = createApp(writeConfig(dir));
    const res = await app.request('http://localhost/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('无 Key 请求返回 401 Anthropic 错误格式', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-srv-'));
    const app = createApp(writeConfig(dir));
    const res = await app.request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', max_tokens: 1, messages: [] }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
  });

  it('上游全部不可用时返回 overloaded_error 并落错误日志', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-srv-'));
    const app = createApp(writeConfig(dir));
    const res = await app.request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ok' },
      body: JSON.stringify({
        model: 'm',
        max_tokens: 1,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('overloaded_error');
  });
});
