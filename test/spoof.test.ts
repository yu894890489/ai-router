import { describe, it, expect } from 'vitest';
import { applySpoof, spoofHeaders } from '../src/pipeline/spoof.js';
import type { ProviderConfig } from '../src/config.js';
import type { AnthropicRequest } from '../src/types.js';

const CFG: ProviderConfig = {
  baseUrl: 'https://example.com/anthropic',
  apiKey: 'sk-vendor-key',
  authHeader: 'bearer',
  contextWindow: 262144,
  userAgent: 'claude-cli/2.0.14 (external, cli)',
  extraHeaders: { 'x-custom': 'yes' },
  modelMap: { '*': 'vendor-model' },
};

const REQ: AnthropicRequest = {
  model: 'claude-sonnet-4-6',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
  system: [{ type: 'text', text: 'You are Claude Code, Anthropic official CLI.' }],
};

describe('spoofHeaders', () => {
  it('bearer 鉴权 + Claude Code 特征头', () => {
    const h = spoofHeaders(CFG);
    expect(h['authorization']).toBe('Bearer sk-vendor-key');
    expect(h['user-agent']).toContain('claude-cli');
    expect(h['x-app']).toBe('cli');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['x-custom']).toBe('yes');
  });

  it('x-api-key 鉴权', () => {
    const h = spoofHeaders({ ...CFG, authHeader: 'x-api-key' });
    expect(h['x-api-key']).toBe('sk-vendor-key');
    expect(h['authorization']).toBeUndefined();
  });
});

describe('applySpoof', () => {
  it('替换模型名为上游模型', () => {
    const out = applySpoof(REQ, 'vendor-model');
    expect(out.model).toBe('vendor-model');
  });

  it('system 首块不以 Claude Code 开头时前置标准开头', () => {
    const req: AnthropicRequest = { ...REQ, system: [{ type: 'text', text: '自定义系统提示' }] };
    const out = applySpoof(req, 'm');
    const blocks = out.system as Array<{ text?: string }>;
    expect(blocks[0].text).toMatch(/^You are Claude Code/);
    expect(blocks).toHaveLength(2);
  });

  it('system 缺省时补齐', () => {
    const req: AnthropicRequest = { ...REQ };
    delete req.system;
    const out = applySpoof(req, 'm');
    expect((out.system as Array<{ text?: string }>)[0].text).toMatch(/^You are Claude Code/);
  });

  it('metadata.user_id 缺省时按 Claude Code 格式补齐', () => {
    const out = applySpoof(REQ, 'm');
    expect(out.metadata?.user_id).toMatch(/^user_[0-9a-f]{32}_account__session_[0-9a-f-]{36}$/);
  });

  it('已有 user_id 时保留', () => {
    const req: AnthropicRequest = { ...REQ, metadata: { user_id: 'user_x_account__session_keep' } };
    expect(applySpoof(req, 'm').metadata?.user_id).toBe('user_x_account__session_keep');
  });

  it('不修改原请求对象', () => {
    const req: AnthropicRequest = { ...REQ };
    delete req.system;
    applySpoof(req, 'm');
    expect(req.system).toBeUndefined();
  });
});
