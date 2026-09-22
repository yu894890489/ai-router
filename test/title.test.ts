import { describe, it, expect } from 'vitest';
import { extractTitle } from '../src/pipeline/title.js';

describe('extractTitle', () => {
  it('取第一条 user 消息的字符串内容', () => {
    expect(
      extractTitle([
        { role: 'assistant', content: '先开口' },
        { role: 'user', content: '帮我看看这个 bug' },
      ]),
    ).toBe('帮我看看这个 bug');
  });

  it('content 为数组时拼接 text 块', () => {
    expect(
      extractTitle([
        {
          role: 'user',
          content: [
            { type: 'text', text: '第一段' },
            { type: 'image' },
            { type: 'text', text: '第二段' },
          ],
        },
      ]),
    ).toBe('第一段 第二段');
  });

  it('折叠连续空白并截断到 200 字符', () => {
    const long = 'a'.repeat(150) + ' \n\t ' + 'b'.repeat(150);
    const t = extractTitle([{ role: 'user', content: long }]);
    expect(t).not.toMatch(/\s{2,}/);
    expect(t.length).toBeLessThanOrEqual(200);
  });

  it('无 user 消息或空白内容时返回（无标题）', () => {
    expect(extractTitle([{ role: 'assistant', content: 'x' }])).toBe('（无标题）');
    expect(extractTitle([{ role: 'user', content: '  \n ' }])).toBe('（无标题）');
  });
});
