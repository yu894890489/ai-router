import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const VALID = `
server: { port: 3456 }
accessKeys:
  sk-test-home: homepage
  sk-test-default: null
providers:
  kimi:
    baseUrl: https://api.moonshot.cn/anthropic
    apiKey: sk-x
    authHeader: bearer
    contextWindow: 262144
    userAgent: claude-cli/2.0.14 (external, cli)
    modelMap: { "*": kimi-k2-0905-preview }
routing: { default: [kimi] }
compact: { provider: kimi, model: kimi-k2-0905-preview }
failover: {}
storage: {}
`;

function writeTmp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-router-cfg-'));
  const p = join(dir, 'config.yaml');
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('loadConfig', () => {
  it('加载合法配置并填充默认值', () => {
    const cfg = loadConfig(writeTmp(VALID));
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(cfg.compact.thresholdRatio).toBe(0.85);
    expect(cfg.failover.stickyTtlSeconds).toBe(300);
    expect(cfg.providers.kimi.contextWindow).toBe(262144);
  });

  it('缺字段时报错并指出路径', () => {
    const bad = VALID.replace('apiKey: sk-x', '');
    expect(() => loadConfig(writeTmp(bad))).toThrow(/providers\.kimi\.apiKey/);
  });

  it('routing 引用未定义厂商时报错', () => {
    const bad = VALID.replace('default: [kimi]', 'default: [ghost]');
    expect(() => loadConfig(writeTmp(bad))).toThrow(/ghost/);
  });

  it('compact.provider 引用未定义厂商时报错', () => {
    const bad = VALID.replace('provider: kimi', 'provider: ghost');
    expect(() => loadConfig(writeTmp(bad))).toThrow(/ghost/);
  });
});
