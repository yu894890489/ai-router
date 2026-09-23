import { describe, it, expect } from 'vitest';
import { createSqliteStorage } from '../src/storage/sqlite.js';

function seed(s: ReturnType<typeof createSqliteStorage>) {
  s.sessions.touchSession({ sessionId: 'session_s1', project: 'proj-a', title: 't', tokens: 1 });
  s.turns.addTurn({ sessionId: 'session_s1', requestId: 'r1', userText: '帮我看看 getUserById 的空指针', assistantText: '问题在第三行没判空' });
  s.turns.addTurn({ sessionId: 'session_s1', requestId: 'r2', userText: '顺便优化一下深度学习的例子', assistantText: '已改成中文示例' });
}

describe('turns + search', () => {
  it('addTurn 自动生成 id/seq/createdAt，listTurns 按 seq 升序', () => {
    const s = createSqliteStorage(':memory:');
    seed(s);
    const turns = s.turns.listTurns('session_s1');
    expect(turns).toHaveLength(2);
    expect(turns[0].seq).toBe(1);
    expect(turns[1].seq).toBe(2);
    expect(turns[0].requestId).toBe('r1');
    expect(turns[0].createdAt).toBeTruthy();
    s.close();
  });

  it('全文搜索命中中文与标识符，snippet 带【】标记', () => {
    const s = createSqliteStorage(':memory:');
    seed(s);
    const hits = s.turns.search.search('空指针');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].sessionId).toBe('session_s1');
    expect(hits[0].sessionTitle).toBe('t'); // 联表 sessions.title
    expect(hits[0].snippet).toContain('【');
    const hits2 = s.turns.search.search('getUserById');
    expect(hits2.length).toBeGreaterThanOrEqual(1);
    s.close();
  });

  it('多词查询为 AND 语义；filter 按 session/project 过滤', () => {
    const s = createSqliteStorage(':memory:');
    seed(s);
    expect(s.turns.search.search('深度学习 空指针')).toHaveLength(0); // 两轮各含一词，不同行不同命中
    expect(s.turns.search.search('空指针', { sessionId: 'session_other' })).toHaveLength(0);
    expect(s.turns.search.search('空指针', { project: 'proj-a' }).length).toBeGreaterThanOrEqual(1);
    expect(s.turns.search.search('空指针', { project: 'proj-x' })).toHaveLength(0);
    s.close();
  });

  it('特殊字符查询不报错（引号/通配符被清理）', () => {
    const s = createSqliteStorage(':memory:');
    seed(s);
    expect(() => s.turns.search.search('" OR *')).not.toThrow();
    s.close();
  });
});
