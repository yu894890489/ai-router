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

  it('unbanPrefix 解封该厂商全部 ref，不影响其他厂商', () => {
    const b = new CircuitBreaker(3, 60);
    b.ban('kimi/k3-1m');
    b.ban('kimi/k3');
    b.ban('volcengine/glm-5.3');
    b.unbanPrefix('kimi/');
    expect(b.canUse('kimi/k3-1m')).toBe(true);
    expect(b.canUse('kimi/k3')).toBe(true);
    expect(b.canUse('volcengine/glm-5.3')).toBe(false); // 其他厂商不受影响
  });

  it('unbanPrefix 只清封禁位，保留熔断冷却状态', () => {
    vi.useFakeTimers();
    const b = new CircuitBreaker(1, 60);
    b.recordFailure('kimi/k3'); // 阈值 1，立即熔断（非 ban）
    b.ban('kimi/k3-1m');
    b.unbanPrefix('kimi/');
    expect(b.canUse('kimi/k3-1m')).toBe(true); // 封禁解除
    expect(b.canUse('kimi/k3')).toBe(false); // 熔断冷却不受 unbanPrefix 影响
    vi.advanceTimersByTime(61_000);
    expect(b.canUse('kimi/k3')).toBe(true); // 冷却结束恢复
    // 无匹配键时是安全的空操作
    b.unbanPrefix('bailian/');
    expect(b.canUse('bailian/glm-5')).toBe(true);
  });
});
