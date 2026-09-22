import { createHash, randomUUID } from 'node:crypto';
import type { ProviderConfig } from '../config.js';
import type { AnthropicRequest, ContentBlock } from '../types.js';

export const CLAUDE_CODE_PREFIX = "You are Claude Code, Anthropic's official CLI.";
const CLAUDE_CODE_MARKER = 'You are Claude Code';

export function spoofHeaders(cfg: ProviderConfig): Record<string, string> {
  const auth: Record<string, string> =
    cfg.authHeader === 'bearer'
      ? { authorization: `Bearer ${cfg.apiKey}` }
      : { 'x-api-key': cfg.apiKey };
  return {
    'content-type': 'application/json',
    'user-agent': cfg.userAgent,
    'x-app': 'cli',
    'anthropic-version': '2023-06-01',
    ...cfg.extraHeaders,
    ...auth,
  };
}

export function applySpoof(req: AnthropicRequest, upstreamModel: string): AnthropicRequest {
  const out: AnthropicRequest = { ...req, model: upstreamModel };

  // system 首块必须以 Claude Code 标准开头
  const blocks: ContentBlock[] =
    typeof out.system === 'string'
      ? [{ type: 'text', text: out.system }]
      : Array.isArray(out.system)
        ? [...out.system]
        : [];
  if (!blocks[0] || !(blocks[0].text ?? '').startsWith(CLAUDE_CODE_MARKER)) {
    blocks.unshift({ type: 'text', text: CLAUDE_CODE_PREFIX });
  }
  out.system = blocks;

  // metadata.user_id 按 Claude Code 格式补齐
  const meta = { ...(out.metadata ?? {}) };
  if (typeof meta.user_id !== 'string' || meta.user_id.length === 0) {
    const seed = createHash('sha256')
      .update(JSON.stringify(out.messages[0] ?? ''))
      .digest('hex')
      .slice(0, 32);
    meta.user_id = `user_${seed}_account__session_${randomUUID()}`;
  }
  out.metadata = meta;

  return out;
}
