export class SessionStore {
  // 值为 ref 字符串（"厂商/别名"），与熔断/粘性键一致
  private bindings = new Map<string, { ref: string; expiresAt: number }>();

  constructor(private ttlSeconds: number) {}

  get(sessionId: string): string | null {
    const b = this.bindings.get(sessionId);
    if (!b) return null;
    if (Date.now() > b.expiresAt) {
      this.bindings.delete(sessionId);
      return null;
    }
    return b.ref;
  }

  bind(sessionId: string, ref: string): void {
    this.bindings.set(sessionId, {
      ref,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    });
  }

  unbind(sessionId: string): void {
    this.bindings.delete(sessionId);
  }
}

interface BreakerState {
  failures: number;
  openUntil: number;
  banned: boolean;
}

export class CircuitBreaker {
  private states = new Map<string, BreakerState>();

  constructor(
    private threshold: number,
    private cooldownSeconds: number,
  ) {}

  private state(name: string): BreakerState {
    let s = this.states.get(name);
    if (!s) {
      s = { failures: 0, openUntil: 0, banned: false };
      this.states.set(name, s);
    }
    return s;
  }

  canUse(name: string): boolean {
    const s = this.state(name);
    if (s.banned) return false;
    return Date.now() >= s.openUntil;
  }

  recordSuccess(name: string): void {
    const s = this.state(name);
    s.failures = 0;
    s.openUntil = 0;
  }

  recordFailure(name: string): void {
    const s = this.state(name);
    s.failures += 1;
    if (s.failures >= this.threshold) {
      s.failures = 0;
      s.openUntil = Date.now() + this.cooldownSeconds * 1000;
      console.warn(`[failover] 目标 ${name} 连续失败 ${this.threshold} 次，熔断 ${this.cooldownSeconds}s`);
    }
  }

  ban(name: string): void {
    this.state(name).banned = true;
    console.warn(`[failover] 目标 ${name} 鉴权失败（401/403），已标记不可用直至重启或配置更换 apiKey`);
  }

  unban(name: string): void {
    const s = this.states.get(name);
    if (!s || !s.banned) return;
    s.banned = false; // 只清封禁位，保留熔断计数与冷却状态
    console.warn(`[failover] 目标 ${name} 已解除封禁（apiKey 已更新）`);
  }

  /**
   * 解封所有键以 prefix 开头的目标（键为 "厂商/别名" ref）。
   * 如 unbanPrefix('kimi/') 解封 kimi 厂商全部模型 ref，供热重载换 Key 时调用。
   */
  unbanPrefix(prefix: string): void {
    for (const [key, s] of this.states) {
      if (!key.startsWith(prefix) || !s.banned) continue;
      s.banned = false; // 与 unban 一致：只清封禁位，保留熔断计数与冷却状态
      console.warn(`[failover] 目标 ${key} 已解除封禁（apiKey 已更新）`);
    }
  }
}
