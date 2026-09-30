import { describe, it, expect } from 'vitest';
import { createSqliteStorage } from '../src/storage/sqlite.js';

function makeStorage() {
  return createSqliteStorage(':memory:');
}

describe('SessionDirectory', () => {
  it('touchSession 首次写入 title/project，再次调用只更新 lastTokens/lastSeen', () => {
    const s = makeStorage();
    s.sessions.touchSession({ sessionId: 'session_a', project: 'p1', title: '标题一', tokens: 100 });
    s.sessions.touchSession({ sessionId: 'session_a', project: 'pX', title: '不应覆盖', tokens: 200 });
    const info = s.sessions.getSession('session_a');
    expect(info?.title).toBe('标题一');
    expect(info?.project).toBe('p1');
    expect(info?.lastTokens).toBe(200);
    s.close();
  });

  it('旧噪声标题（标签开头/占位符/空）被后续有效标题覆盖', () => {
    const s = makeStorage();
    s.sessions.touchSession({
      sessionId: 'session_n1',
      project: 'p1',
      title: '<system-reminder>SessionStart hook additional context...</system-reminder>',
      tokens: 1,
    });
    s.sessions.touchSession({ sessionId: 'session_n1', project: 'p1', title: '真实的用户问题', tokens: 2 });
    expect(s.sessions.getSession('session_n1')?.title).toBe('真实的用户问题');

    s.sessions.touchSession({ sessionId: 'session_n2', project: 'p1', title: '（无标题）', tokens: 1 });
    s.sessions.touchSession({ sessionId: 'session_n2', project: 'p1', title: '第二个问题', tokens: 2 });
    expect(s.sessions.getSession('session_n2')?.title).toBe('第二个问题');
    s.close();
  });

  it('有效标题不被噪声新值覆盖', () => {
    const s = makeStorage();
    s.sessions.touchSession({ sessionId: 'session_g', project: 'p1', title: '好标题', tokens: 1 });
    s.sessions.touchSession({ sessionId: 'session_g', project: 'p1', title: '（无标题）', tokens: 2 });
    expect(s.sessions.getSession('session_g')?.title).toBe('好标题');
    s.close();
  });

  it('setOverride/getOverride 往返，null 清除', () => {
    const s = makeStorage();
    s.sessions.touchSession({ sessionId: 'session_b', project: 'p1', title: 't', tokens: 1 });
    expect(s.sessions.getOverride('session_b')).toBeNull();
    s.sessions.setOverride('session_b', 'kimi/k3-1m');
    expect(s.sessions.getOverride('session_b')).toBe('kimi/k3-1m');
    s.sessions.setOverride('session_b', null);
    expect(s.sessions.getOverride('session_b')).toBeNull();
    s.close();
  });

  it('getOverride/getSession 对未知会话返回 null', () => {
    const s = makeStorage();
    expect(s.sessions.getOverride('session_none')).toBeNull();
    expect(s.sessions.getSession('session_none')).toBeNull();
    s.close();
  });

  it('listRecent 按 lastSeen 倒序并遵守 limit', async () => {
    const s = makeStorage();
    s.sessions.touchSession({ sessionId: 'session_1', project: 'p', title: '一', tokens: 1 });
    await new Promise((r) => setTimeout(r, 5));
    s.sessions.touchSession({ sessionId: 'session_2', project: 'p', title: '二', tokens: 1 });
    await new Promise((r) => setTimeout(r, 5));
    s.sessions.touchSession({ sessionId: 'session_3', project: 'p', title: '三', tokens: 1 });
    const all = s.sessions.listRecent(5);
    expect(all.map((x) => x.sessionId)).toEqual(['session_3', 'session_2', 'session_1']);
    expect(s.sessions.listRecent(2)).toHaveLength(2);
    s.close();
  });
});
