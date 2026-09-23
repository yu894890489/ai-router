import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseModelRef } from '../src/config.js';

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
    userAgent: claude-cli/2.0.14 (external, cli)
    models:
      k3-1m: { upstream: "kimi-k3[1m]", contextWindow: 1000000 }
      k3: { upstream: kimi-k3, contextWindow: 262144 }
      kimi-for-coding: { upstream: kimi-for-coding, contextWindow: 262144 }
  volcengine:
    baseUrl: https://ark.cn-beijing.volces.com/api/coding
    apiKey: ark-x
    authHeader: bearer
    userAgent: claude-cli/2.0.14 (external, cli)
    models:
      glm-5.3: { upstream: glm-5.3, contextWindow: 262144 }
      glm-5.3-flash: { upstream: glm-5.3-flash, contextWindow: 262144 }
  bailian:
    baseUrl: https://coding.dashscope.aliyuncs.com/apps/anthropic
    apiKey: sk-y
    authHeader: bearer
    userAgent: claude-cli/2.0.14 (external, cli)
    models:
      glm-5: { upstream: glm-5, contextWindow: 262144 }
routing:
  rules:
    claude-opus-4-6: [kimi/k3-1m, volcengine/glm-5.3, bailian/glm-5]
    claude-sonnet-4-6: [kimi/kimi-for-coding, volcengine/glm-5.3, bailian/glm-5]
    claude-haiku-4-5: [volcengine/glm-5.3-flash, bailian/glm-5]
    "*": [kimi/kimi-for-coding, volcengine/glm-5.3, bailian/glm-5]
compact: { target: bailian/glm-5 }
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
  it('加载合法 v2 配置并填充默认值', () => {
    const cfg = loadConfig(writeTmp(VALID));
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(cfg.compact.thresholdRatio).toBe(0.85);
    expect(cfg.compact.targetRatio).toBe(0.7);
    expect(cfg.compact.keepRecentTurns).toBe(6);
    expect(cfg.compact.fallbackToTarget).toBe(true);
    expect(cfg.compact.timeoutMs).toBe(180000); // 压缩总结独立超时，默认 3 分钟
    expect(cfg.compact.concurrency).toBe(2); // 分块总结默认 2 路并行
    expect(cfg.failover.stickyTtlSeconds).toBe(300);
    expect(cfg.providers.kimi.models['k3-1m'].contextWindow).toBe(1000000);
    expect(cfg.providers.kimi.models['k3-1m'].upstream).toBe('kimi-k3[1m]');
    expect(cfg.providers.kimi.extraHeaders).toEqual({});
    expect(cfg.compact.target).toBe('bailian/glm-5');
    expect(cfg.routing.rules['*']).toEqual([
      'kimi/kimi-for-coding',
      'volcengine/glm-5.3',
      'bailian/glm-5',
    ]);
  });

  it('缺字段时报错并指出路径', () => {
    const bad = VALID.replace('apiKey: sk-x', '');
    expect(() => loadConfig(writeTmp(bad))).toThrow(/providers\.kimi\.apiKey/);
  });

  it('provider 的 models 为空时报错', () => {
    const bad = VALID.replace(
      'glm-5: { upstream: glm-5, contextWindow: 262144 }',
      '',
    );
    expect(() => loadConfig(writeTmp(bad))).toThrow(/models/);
  });

  it('routing.rules 缺 "*" 兜底规则时报错', () => {
    const bad = VALID.replace('    "*": [kimi/kimi-for-coding, volcengine/glm-5.3, bailian/glm-5]\n', '');
    expect(() => loadConfig(writeTmp(bad))).toThrow(/\*/);
  });

  it('rules 引用未定义厂商时报错并点名 ref', () => {
    const bad = VALID.replace(
      'claude-opus-4-6: [kimi/k3-1m',
      'claude-opus-4-6: [ghost/k3-1m',
    );
    expect(() => loadConfig(writeTmp(bad))).toThrow(/ghost\/k3-1m/);
  });

  it('rules 引用未定义模型别名时报错并点名 ref', () => {
    const bad = VALID.replace(
      'claude-haiku-4-5: [volcengine/glm-5.3-flash',
      'claude-haiku-4-5: [volcengine/no-such-model',
    );
    expect(() => loadConfig(writeTmp(bad))).toThrow(/volcengine\/no-such-model/);
  });

  it('rules 链为空数组时报错', () => {
    const bad = VALID.replace(
      'claude-opus-4-6: [kimi/k3-1m, volcengine/glm-5.3, bailian/glm-5]',
      'claude-opus-4-6: []',
    );
    expect(() => loadConfig(writeTmp(bad))).toThrow(/claude-opus-4-6/);
  });

  it('compact.target 引用未定义厂商时报错', () => {
    const bad = VALID.replace('target: bailian/glm-5', 'target: ghost/glm-5');
    expect(() => loadConfig(writeTmp(bad))).toThrow(/ghost\/glm-5/);
  });

  it('compact.target 引用未定义别名时报错', () => {
    const bad = VALID.replace('target: bailian/glm-5', 'target: bailian/no-such-model');
    expect(() => loadConfig(writeTmp(bad))).toThrow(/bailian\/no-such-model/);
  });

  it('compact.target 缺少 / 时报错', () => {
    const bad = VALID.replace('target: bailian/glm-5', 'target: bailian');
    expect(() => loadConfig(writeTmp(bad))).toThrow(/bailian/);
  });

  it('原型链键不会被误认为已定义的厂商（Object.hasOwn 校验）', () => {
    const bad = VALID.replace(
      'claude-opus-4-6: [kimi/k3-1m',
      'claude-opus-4-6: [toString/k3-1m',
    );
    expect(() => loadConfig(writeTmp(bad))).toThrow(/未定义的厂商.*toString\/k3-1m/);
  });

  it('原型链键不会被误认为已定义的模型别名（Object.hasOwn 校验）', () => {
    const bad = VALID.replace('target: bailian/glm-5', 'target: bailian/constructor');
    expect(() => loadConfig(writeTmp(bad))).toThrow(/未定义的模型别名.*bailian\/constructor/);
  });

  it('rules 中 ref 缺 / 时报错并补充出处（哪条 rule）', () => {
    const bad = VALID.replace(
      'claude-opus-4-6: [kimi/k3-1m',
      'claude-opus-4-6: [kimi-k3-1m',
    );
    expect(() => loadConfig(writeTmp(bad))).toThrow(/routing\.rules\["claude-opus-4-6"\]/);
  });

  it('compact.target 缺 / 时报错并补充出处（compact.target）', () => {
    const bad = VALID.replace('target: bailian/glm-5', 'target: bailian');
    expect(() => loadConfig(writeTmp(bad))).toThrow(/compact\.target/);
  });
});

describe('parseModelRef', () => {
  it('按第一个 / 切分 provider 与 alias', () => {
    expect(parseModelRef('kimi/k3-1m')).toEqual({ provider: 'kimi', alias: 'k3-1m' });
  });

  it('alias 本身不含 / 时正常解析', () => {
    expect(parseModelRef('bailian/glm-5')).toEqual({ provider: 'bailian', alias: 'glm-5' });
  });

  it('alias 中含更多 / 时保留在 alias 内', () => {
    expect(parseModelRef('kimi/org/model')).toEqual({ provider: 'kimi', alias: 'org/model' });
  });

  it('无 / 时抛错', () => {
    expect(() => parseModelRef('kimi')).toThrow(/\//);
  });

  it('provider 为空时抛错', () => {
    expect(() => parseModelRef('/k3-1m')).toThrow(/provider/i);
  });

  it('alias 为空时抛错', () => {
    expect(() => parseModelRef('kimi/')).toThrow(/alias/i);
  });
});
