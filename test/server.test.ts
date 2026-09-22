import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, diffUnbanTargets, applyConfigReload, type AppState } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { CircuitBreaker } from '../src/session/store.js';
import { createProviders } from '../src/providers/index.js';
import type { RouterConfig } from '../src/config.js';

function writeConfig(dir: string, extra = '', apiKey = 'sk-x'): string {
  const p = join(dir, 'config.yaml');
  writeFileSync(
    p,
    `
server: { port: 3456 } # 测试不监听端口，仅需通过 schema 校验
accessKeys: { sk-ok: proj1 }
providers:
  kimi:
    baseUrl: http://127.0.0.1:1   # 不可达，仅用于错误路径测试
    apiKey: ${apiKey}
    authHeader: bearer
    userAgent: ua
    models:
      m: { upstream: m-upstream, contextWindow: 262144 }
routing:
  rules:
    "*": [kimi/m]
compact: { target: kimi/m }
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

describe('diffUnbanTargets', () => {
  function cfgWith(apiKeys: Record<string, string>): RouterConfig {
    const providers: Record<string, unknown> = {};
    for (const [name, apiKey] of Object.entries(apiKeys)) {
      providers[name] = { apiKey };
    }
    return { providers } as unknown as RouterConfig;
  }

  it('apiKey 变化的厂商被列入 unban 目标', () => {
    const oldCfg = cfgWith({ kimi: 'sk-old', volc: 'sk-v1' });
    const newCfg = cfgWith({ kimi: 'sk-new', volc: 'sk-v1' });
    expect(diffUnbanTargets(oldCfg, newCfg)).toEqual(['kimi']);
  });

  it('apiKey 未变化、新增/删除厂商均不触发 unban', () => {
    const oldCfg = cfgWith({ kimi: 'sk-x', removed: 'sk-r' });
    const newCfg = cfgWith({ kimi: 'sk-x', added: 'sk-a' });
    expect(diffUnbanTargets(oldCfg, newCfg)).toEqual([]);
  });
});

// 热重载接线：直接调用 applyConfigReload（与 watch 回调同一入口），不真实监听文件
describe('applyConfigReload', () => {
  function makeState(config: RouterConfig, breaker: CircuitBreaker): AppState {
    return {
      config,
      providers: createProviders(config),
      storage: null as unknown as AppState['storage'],
      breaker,
      sessions: null as unknown as AppState['sessions'],
    };
  }

  it('apiKey 变化的厂商解封其全部 ref，替换 config/providers，breaker 保留', () => {
    const oldCfg = loadConfig(writeConfig(mkdtempSync(join(tmpdir(), 'ai-router-srv-'))));
    const newCfg = loadConfig(
      writeConfig(mkdtempSync(join(tmpdir(), 'ai-router-srv-')), '', 'sk-y'),
    );
    const breaker = new CircuitBreaker(3, 60);
    breaker.ban('kimi/m');

    const next = applyConfigReload(makeState(oldCfg, breaker), newCfg);

    expect(breaker.canUse('kimi/m')).toBe(true); // 封禁解除
    expect(next.config).toBe(newCfg); // 配置已替换
    expect(next.providers.get('kimi')).toBeDefined(); // providers 已重建
    expect(next.breaker).toBe(breaker); // breaker 跨重载保留
  });

  it('apiKey 未变化时封禁保持', () => {
    const cfg = loadConfig(writeConfig(mkdtempSync(join(tmpdir(), 'ai-router-srv-'))));
    const sameKeyCfg = loadConfig(
      writeConfig(mkdtempSync(join(tmpdir(), 'ai-router-srv-'))),
    );
    const breaker = new CircuitBreaker(3, 60);
    breaker.ban('kimi/m');

    applyConfigReload(makeState(cfg, breaker), sameKeyCfg);

    expect(breaker.canUse('kimi/m')).toBe(false); // 未触发 unban
  });
});
