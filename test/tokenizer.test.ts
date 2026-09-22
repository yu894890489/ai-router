import { describe, it, expect } from 'vitest';
import { countText, countMessages, countSystem } from '../src/compact/tokenizer.js';

describe('tokenizer', () => {
  it('空字符串为 0', () => {
    expect(countText('')).toBe(0);
  });

  it('计数随文本增长单调递增', () => {
    expect(countText('hello world')).toBeGreaterThan(0);
    expect(countText('hello world '.repeat(100))).toBeGreaterThan(countText('hello world'));
  });

  it('字符串与 content block 数组都能数', () => {
    const a = countMessages([{ role: 'user', content: '你好，世界' }]);
    const b = countMessages([
      { role: 'user', content: [{ type: 'text', text: '你好，世界' }] },
    ]);
    expect(a).toBeGreaterThan(4);
    expect(b).toBeGreaterThan(4);
  });

  it('非 text 块序列化后计数（tool_use 等）', () => {
    const n = countMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: '/a.ts' } }],
      },
    ]);
    expect(n).toBeGreaterThan(10);
  });

  it('countSystem 处理 undefined / 字符串 / 数组', () => {
    expect(countSystem(undefined)).toBe(0);
    expect(countSystem('sys')).toBeGreaterThan(0);
    expect(countSystem([{ type: 'text', text: 'sys' }])).toBeGreaterThan(0);
  });
});
