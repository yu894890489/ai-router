import { describe, it, expect } from 'vitest';
import { createSqliteStorage } from '../src/storage/sqlite.js';

/** 造一条请求日志:start + finish */
function seed(
  s: ReturnType<typeof createSqliteStorage>,
  o: {
    project: string;
    sessionId: string | null;
    clientModel?: string;
    provider?: string;
    upstreamModel?: string;
    status?: 'success' | 'error';
    inputTokens?: number;
    outputTokens?: number;
    failovered?: boolean;
  },
): void {
  const id = s.start({
    project: o.project,
    sessionId: o.sessionId,
    clientModel: o.clientModel ?? 'claude-sonnet-4-6',
  });
  s.finish(id, {
    provider: o.provider,
    upstreamModel: o.upstreamModel,
    status: o.status ?? 'success',
    inputTokens: o.inputTokens,
    outputTokens: o.outputTokens,
    failovered: o.failovered,
  });
}

describe('usage stats 聚合', () => {
  it('按厂商/模型/项目聚合 tokens、请求数与错误数;失败请求 tokens 记 0;未达厂商的请求只计入 totals', () => {
    const s = createSqliteStorage(':memory:');
    seed(s, { project: 'p1', sessionId: 's1', provider: 'kimi', upstreamModel: 'kimi-k3', inputTokens: 100, outputTokens: 20 });
    seed(s, { project: 'p1', sessionId: 's1', provider: 'kimi', upstreamModel: 'kimi-k3', inputTokens: 50, outputTokens: 10 });
    seed(s, { project: 'p2', sessionId: 's2', provider: 'volcengine', upstreamModel: 'glm-5.3', inputTokens: 200, outputTokens: 80 });
    seed(s, { project: 'p2', sessionId: 's2', provider: 'volcengine', upstreamModel: 'glm-5.3', status: 'error', failovered: true });
    // 全部候选失败/未达厂商：provider 为空
    seed(s, { project: 'p3', sessionId: null, status: 'error' });

    const st = s.stats.aggregate(0);
    expect(st.totals).toEqual({ requests: 5, errors: 2, inputTokens: 350, outputTokens: 110 });
    expect(st.byProvider).toEqual([
      { key: 'volcengine', requests: 2, errors: 1, inputTokens: 200, outputTokens: 80 },
      { key: 'kimi', requests: 2, errors: 0, inputTokens: 150, outputTokens: 30 },
    ]);
    expect(st.byModel).toEqual([
      { key: 'glm-5.3', requests: 2, errors: 1, inputTokens: 200, outputTokens: 80 },
      { key: 'kimi-k3', requests: 2, errors: 0, inputTokens: 150, outputTokens: 30 },
    ]);
    expect(st.byProject).toEqual([
      { key: 'p2', requests: 2, errors: 1, inputTokens: 200, outputTokens: 80 },
      { key: 'p1', requests: 2, errors: 0, inputTokens: 150, outputTokens: 30 },
      { key: 'p3', requests: 1, errors: 1, inputTokens: 0, outputTokens: 0 },
    ]);
    s.close();
  });

  it('按会话聚合并联会话标题,按总 tokens 降序,无会话行标题为 null', () => {
    const s = createSqliteStorage(':memory:');
    s.sessions.touchSession({ sessionId: 's1', project: 'p1', title: '会话甲', tokens: 1 });
    s.sessions.touchSession({ sessionId: 's2', project: 'p2', title: '会话乙', tokens: 1 });
    seed(s, { project: 'p1', sessionId: 's1', provider: 'kimi', upstreamModel: 'kimi-k3', inputTokens: 100, outputTokens: 20 });
    seed(s, { project: 'p1', sessionId: 's1', provider: 'kimi', upstreamModel: 'kimi-k3', inputTokens: 50, outputTokens: 10 });
    seed(s, { project: 'p2', sessionId: 's2', provider: 'volcengine', upstreamModel: 'glm-5.3', inputTokens: 200, outputTokens: 80 });
    seed(s, { project: 'p2', sessionId: 's_ghost', provider: 'kimi', upstreamModel: 'kimi-k3', inputTokens: 5, outputTokens: 1 });

    const st = s.stats.aggregate(0);
    expect(st.bySession).toEqual([
      { sessionId: 's2', title: '会话乙', project: 'p2', requests: 1, errors: 0, inputTokens: 200, outputTokens: 80 },
      { sessionId: 's1', title: '会话甲', project: 'p1', requests: 2, errors: 0, inputTokens: 150, outputTokens: 30 },
      { sessionId: 's_ghost', title: null, project: null, requests: 1, errors: 0, inputTokens: 5, outputTokens: 1 },
    ]);
    s.close();
  });

  it('每日聚合使用本地时区日期并按日期升序', () => {
    const s = createSqliteStorage(':memory:');
    seed(s, { project: 'p1', sessionId: 's1', provider: 'kimi', upstreamModel: 'kimi-k3', inputTokens: 100, outputTokens: 20 });
    const st = s.stats.aggregate(0);
    expect(st.daily).toHaveLength(1);
    expect(st.daily[0].date).toBe(new Date().toLocaleDateString('sv-SE')); // 本地 YYYY-MM-DD
    expect(st.daily[0]).toMatchObject({ requests: 1, inputTokens: 100, outputTokens: 20 });
    s.close();
  });

  it('days=7 与 days=0 都包含今天的请求;空库返回全零结构', () => {
    const s = createSqliteStorage(':memory:');
    expect(s.stats.aggregate(30).totals).toEqual({ requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 });
    seed(s, { project: 'p1', sessionId: 's1', provider: 'kimi', upstreamModel: 'kimi-k3', inputTokens: 10, outputTokens: 2 });
    expect(s.stats.aggregate(7).totals.requests).toBe(1);
    expect(s.stats.aggregate(0).totals.requests).toBe(1);
    s.close();
  });
});
