import { describe, it, expect } from 'vitest';
import { countText, countMessages, countSystem, disposeTokenizer } from '../src/compact/tokenizer.js';

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

  it('dispose 后可重新懒加载并继续计数', () => {
    const before = countText('你好，世界');
    disposeTokenizer();
    expect(countText('你好，世界')).toBe(before);
  });

  it('性能回归：50 万字符 CJK 文本计数 < 2s（WASM，同量级 js-tiktoken 需数十秒）', () => {
    const text = '人工智能助手正在处理一段较长的中文上下文，包含标点、数字 12345 和 English 混排。'.repeat(10500);
    expect(text.length).toBeGreaterThanOrEqual(500000);
    const t0 = performance.now();
    const n = countText(text);
    const ms = performance.now() - t0;
    expect(n).toBeGreaterThan(0);
    expect(ms).toBeLessThan(2000); // WASM 实测 ~200ms，仍留 ~10x 余量防 CI 抖动
  });
});
