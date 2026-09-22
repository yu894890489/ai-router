export class SessionStore {
  private bindings = new Map<string, { provider: string; expiresAt: number }>();

  constructor(private ttlSeconds: number) {}

  get(sessionId: string): string | null {
    const b = this.bindings.get(sessionId);
    if (!b) return null;
    if (Date.now() > b.expiresAt) {
      this.bindings.delete(sessionId);
      return null;
    }
    return b.provider;
  }

  bind(sessionId: string, provider: string): void {
    this.bindings.set(sessionId, {
      provider,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    });
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
      console.warn(`[failover] 厂商 ${name} 连续失败 ${this.threshold} 次，熔断 ${this.cooldownSeconds}s`);
    }
  }

  ban(name: string): void {
    this.state(name).banned = true;
    console.warn(`[failover] 厂商 ${name} 鉴权失败（401/403），已标记不可用直至重启`);
  }
}
