import { describe, it, expect } from 'vitest';
import type { AnthropicRequest } from '../src/types.js';

describe('types', () => {
  it('AnthropicRequest 可构造', () => {
    const req: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(req.messages).toHaveLength(1);
  });
});
