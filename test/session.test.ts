import { describe, it, expect, vi, afterEach } from 'vitest';
import { CircuitBreaker, SessionStore } from '../src/session/store.js';

afterEach(() => vi.useRealTimers());

describe('SessionStore', () => {
  it('bind 后 get 命中，TTL 过期后返回 null', () => {
    vi.useFakeTimers();
    const s = new SessionStore(300);
    s.bind('session_a', 'kimi');
    expect(s.get('session_a')).toBe('kimi');
    vi.advanceTimersByTime(301_000);
    expect(s.get('session_a')).toBeNull();
  });

  it('未知 session 返回 null', () => {
    expect(new SessionStore(300).get('nope')).toBeNull();
  });
});

describe('CircuitBreaker', () => {
  it('连续失败达阈值后熔断，冷却期后恢复', () => {
    vi.useFakeTimers();
    const b = new CircuitBreaker(3, 60);
    expect(b.canUse('kimi')).toBe(true);
    b.recordFailure('kimi');
    b.recordFailure('kimi');
    expect(b.canUse('kimi')).toBe(true); // 未到阈值
    b.recordFailure('kimi');
    expect(b.canUse('kimi')).toBe(false); // 熔断
    vi.advanceTimersByTime(61_000);
    expect(b.canUse('kimi')).toBe(true); // 冷却结束
  });

  it('recordSuccess 清零失败计数', () => {
    const b = new CircuitBreaker(3, 60);
    b.recordFailure('kimi');
    b.recordFailure('kimi');
    b.recordSuccess('kimi');
    b.recordFailure('kimi');
    b.recordFailure('kimi');
    expect(b.canUse('kimi')).toBe(true); // 计数已清零，未达阈值
  });

  it('ban 后永久不可用（401/403 场景）', () => {
    vi.useFakeTimers();
    const b = new CircuitBreaker(3, 60);
    b.ban('kimi');
    expect(b.canUse('kimi')).toBe(false);
    vi.advanceTimersByTime(3600_000);
    expect(b.canUse('kimi')).toBe(false);
  });

  it('unban 解除封禁但保留熔断计数', () => {
    vi.useFakeTimers();
    const b = new CircuitBreaker(3, 60);
    b.ban('kimi');
    expect(b.canUse('kimi')).toBe(false);
    b.unban('kimi');
    expect(b.canUse('kimi')).toBe(true);
    // 熔断计数保留：unban 前的失败记录不清零
    b.recordFailure('kimi');
    b.recordFailure('kimi');
    expect(b.canUse('kimi')).toBe(true); // 2 < 3，未熔断
    b.recordFailure('kimi');
    expect(b.canUse('kimi')).toBe(false); // 达阈值熔断（与 ban 无关）
    // 未 ban 的厂商 unban 是安全的空操作
    b.unban('other');
    expect(b.canUse('other')).toBe(true);
  });
});
