import type { AnthropicRequest } from '../types.js';
import {
  ProviderError,
  type Provider,
  type SendResult,
} from '../providers/base.js';
import type { CircuitBreaker, SessionStore } from '../session/store.js';

export function selectChain(
  chain: string[],
  breaker: CircuitBreaker,
  sessions: SessionStore,
  sessionId: string | null,
): string[] {
  const ordered: string[] = [];
  if (sessionId) {
    const sticky = sessions.get(sessionId);
    if (sticky && chain.includes(sticky)) ordered.push(sticky);
  }
  for (const name of chain) {
    if (!ordered.includes(name)) ordered.push(name);
  }
  return ordered.filter((n) => breaker.canUse(n));
}

export interface FailoverOutcome {
  result: SendResult;
  provider: Provider;
  failovered: boolean;
}

export async function executeWithFailover(
  candidates: Provider[],
  prepare: (p: Provider) => Promise<AnthropicRequest>,
  timeoutMs: number,
  breaker: CircuitBreaker,
  sessions: SessionStore,
  sessionId: string | null,
): Promise<FailoverOutcome> {
  let lastError: unknown = new ProviderError('无可用厂商', 503, false);

  for (let i = 0; i < candidates.length; i++) {
    const provider = candidates[i];
    try {
      const body = await prepare(provider); // guardContext + spoof，按厂商窗口定制
      const result = await provider.send(body, timeoutMs);
      breaker.recordSuccess(provider.name);
      if (sessionId) sessions.bind(sessionId, provider.name);
      return { result, provider, failovered: i > 0 };
    } catch (e) {
      lastError = e;
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) {
        breaker.ban(provider.name); // Key 问题：封禁而非盲切
      } else {
        breaker.recordFailure(provider.name);
      }
    }
  }

  throw lastError;
}
