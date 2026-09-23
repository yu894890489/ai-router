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

// LIKE 兜底：trigram 分词下不足 3 字符（码点数）的词 FTS 静默返回空，转 LIKE 逐词 AND
function seedLike(s: ReturnType<typeof createSqliteStorage>) {
  s.sessions.touchSession({ sessionId: 'session_s1', project: 'proj-a', title: 'ta', tokens: 1 });
  s.sessions.touchSession({ sessionId: 'session_s2', project: 'proj-b', title: 'tb', tokens: 1 });
  s.turns.addTurn({ sessionId: 'session_s1', requestId: 'r1', userText: '这个递归函数老是 timeout', assistantText: '加一层缓存就行' });
  s.turns.addTurn({ sessionId: 'session_s1', requestId: 'r2', userText: 'go 语言的递归例子', assistantText: '这是 golang 示例' });
  s.turns.addTurn({ sessionId: 'session_s2', requestId: 'r3', userText: '讲讲递归', assistantText: '只含递归一词' });
}

describe('短查询 LIKE 兜底', () => {
  it('「递归」（2 字 CJK）经兜底命中，snippet 来自命中字段且无【】标记', () => {
    const s = createSqliteStorage(':memory:');
    seedLike(s);
    const hits = s.turns.search.search('递归');
    expect(hits.length).toBeGreaterThanOrEqual(3);
    const h = hits.find((x) => x.requestId === 'r3')!;
    expect(h.sessionId).toBe('session_s2');
    expect(h.snippet).toContain('递归'); // 命中的是 user_text
    expect(h.snippet).not.toContain('【'); // LIKE 路径纯截断，无 FTS 高亮标记
    s.close();
  });

  it('"go"（2 字英文）命中；子串语义下 "golang" 也被命中属可接受', () => {
    const s = createSqliteStorage(':memory:');
    seedLike(s);
    const hits = s.turns.search.search('go');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    // LIKE 是子串匹配："go" 同时命中独立词 "go" 与 "golang" 的前缀，两者都算命中
    expect(hits.some((h) => h.requestId === 'r2')).toBe(true);
    s.close();
  });

  it('混合查询「递归 timeout」逐词 AND：同时含两词才命中', () => {
    const s = createSqliteStorage(':memory:');
    seedLike(s);
    const hits = s.turns.search.search('递归 timeout');
    expect(hits).toHaveLength(1);
    expect(hits[0].requestId).toBe('r1'); // r2/r3 只含「递归」不含「timeout」，不命中
    s.close();
  });

  it('查询含 % / _ 不产生通配符误匹配', () => {
    const s = createSqliteStorage(':memory:');
    seedLike(s);
    expect(s.turns.search.search('%')).toHaveLength(0); // 数据中没有字面 %
    expect(s.turns.search.search('1_0')).toHaveLength(0); // _ 不应匹配任意字符
    s.close();
  });

  it('≥3 字符查询仍走 FTS 路径（snippet 带【】标记）', () => {
    const s = createSqliteStorage(':memory:');
    seed(s);
    const hits = s.turns.search.search('空指针');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].snippet).toContain('【'); // 兜底没有吞掉正常 FTS 路径
    s.close();
  });

  it('兜底路径下 filter.sessionId / filter.project 仍生效', () => {
    const s = createSqliteStorage(':memory:');
    seedLike(s);
    const bySession = s.turns.search.search('递归', { sessionId: 'session_s2' });
    expect(bySession).toHaveLength(1);
    expect(bySession[0].requestId).toBe('r3');
    expect(s.turns.search.search('递归', { project: 'proj-b' })).toHaveLength(1);
    expect(s.turns.search.search('递归', { project: 'proj-x' })).toHaveLength(0);
    s.close();
  });
});
