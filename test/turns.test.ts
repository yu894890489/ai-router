import { describe, it, expect } from 'vitest';
import { extractUserTurn, messageText } from '../src/pipeline/turns.js';
import type { Message } from '../src/types.js';

const u = (t: string): Message => ({ role: 'user', content: t });
const a = (t: string): Message => ({ role: 'assistant', content: t });

describe('messageText', () => {
  it('字符串 content 原样返回', () => {
    expect(messageText(u('你好'))).toBe('你好');
  });
  it('数组 content 拼接 text 块', () => {
    expect(
      messageText({ role: 'user', content: [{ type: 'text', text: '一' }, { type: 'image' }, { type: 'text', text: '二' }] }),
    ).toBe('一\n二');
  });
});

describe('extractUserTurn', () => {
  const turn1 = [u('第一个问题'), a('回答一')];

  it('prev 为 null（新会话/重启后首条）：取最后一条 user 消息', () => {
    expect(extractUserTurn(null, [...turn1, u('第二个问题')])).toBe('第二个问题');
  });

  it('正常增量：返回前缀之后的新 user 消息', () => {
    const curr = [...turn1, u('第二个问题'), a('回答二'), u('第三个问题')];
    expect(extractUserTurn(turn1, curr)).toBe('第二个问题\n第三个问题');
  });

  it('前缀被压缩打断：兜底取最后一条 user 消息', () => {
    const compacted = [u('[历史摘要] 之前讨论了订单模块'), a('好的'), u('继续')];
    expect(extractUserTurn(turn1, compacted)).toBe('继续');
  });

  it('前缀后无新 user 消息（如仅工具结果续跑）：兜底取最后一条 user', () => {
    const curr = [...turn1, a('再说一句')];
    expect(extractUserTurn(turn1, curr)).toBe('第一个问题');
  });
});
