import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuthError,
  extractApiKey,
  extractSessionId,
  parseCwdFromSystem,
  resolveProject,
} from '../src/pipeline/auth.js';
import type { AnthropicRequest } from '../src/types.js';

const YAML = `
accessKeys:
  sk-home: homepage
  sk-auto: null
providers:
  kimi:
    baseUrl: https://api.moonshot.cn/anthropic
    apiKey: sk-x
    authHeader: bearer
    contextWindow: 262144
    userAgent: ua
    modelMap: { "*": m }
routing: { default: [kimi] }
compact: { provider: kimi, model: m }
`;

function makeConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-router-auth-'));
  const p = join(dir, 'c.yaml');
  writeFileSync(p, YAML, 'utf8');
  return loadConfig(p);
}

const REQ: AnthropicRequest = {
  model: 'claude-sonnet-4-6',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
  system: [{ type: 'text', text: 'You are Claude Code\ncwd: D:\\code\\homepage' }],
};

describe('auth', () => {
  it('extractApiKey: x-api-key 优先，其次 Bearer', () => {
    expect(extractApiKey({ 'x-api-key': 'k1', authorization: 'Bearer k2' })).toBe('k1');
    expect(extractApiKey({ authorization: 'Bearer k2' })).toBe('k2');
    expect(extractApiKey({})).toBeNull();
  });

  it('Key 命中映射时返回项目标签', () => {
    expect(resolveProject(makeConfig(), 'sk-home', REQ)).toBe('homepage');
  });

  it('Key 映射为 null 时用 cwd 推断', () => {
    expect(resolveProject(makeConfig(), 'sk-auto', REQ)).toBe('D:\\code\\homepage');
  });

  it('Key 映射为 null 且无 cwd 时归 _default', () => {
    const req = { ...REQ, system: [{ type: 'text', text: 'You are Claude Code' }] };
    expect(resolveProject(makeConfig(), 'sk-auto', req)).toBe('_default');
  });

  it('未知 Key 抛 AuthError', () => {
    expect(() => resolveProject(makeConfig(), 'sk-nope', REQ)).toThrow(AuthError);
    expect(() => resolveProject(makeConfig(), null, REQ)).toThrow(AuthError);
  });

  it('parseCwdFromSystem 支持字符串 system 与 Working directory 写法', () => {
    expect(parseCwdFromSystem('Working directory: /home/u/proj')).toBe('/home/u/proj');
    expect(parseCwdFromSystem('no info here')).toBeNull();
  });

  it('extractSessionId 从 Claude Code user_id 提取', () => {
    const req: AnthropicRequest = {
      ...REQ,
      metadata: { user_id: 'user_ab12_account__session_9f8e7d6c' },
    };
    expect(extractSessionId(req)).toBe('session_9f8e7d6c');
    expect(extractSessionId(REQ)).toBeNull();
  });
});
