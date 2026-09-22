import type { AnthropicRequest } from '../types.js';
import {
  ProviderError,
  type Provider,
  type SendResult,
} from '../providers/base.js';
import type { CircuitBreaker, SessionStore } from '../session/store.js';

/** 链上的一个候选：厂商实例 + 模型别名 + ref（"厂商/别名"，熔断/粘性键） */
export interface Candidate {
  provider: Provider;
  alias: string;
  ref: string;
}

/**
 * 链元素为 ref 字符串（"厂商/别名"）。
 * session 粘性与熔断过滤的键均为 ref。
 */
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
  for (const ref of chain) {
    if (!ordered.includes(ref)) ordered.push(ref);
  }
  return ordered.filter((r) => breaker.canUse(r));
}

export interface FailoverOutcome {
  result: SendResult;
  candidate: Candidate;
  failovered: boolean;
}

export async function executeWithFailover(
  candidates: Candidate[],
  prepare: (c: Candidate) => Promise<AnthropicRequest>,
  timeoutMs: number,
  breaker: CircuitBreaker,
  sessions: SessionStore,
  sessionId: string | null,
): Promise<FailoverOutcome> {
  let lastError: unknown = new ProviderError('无可用厂商', 503, false);

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      // prepare 内设 body.model = candidate.alias（传别名，上游名映射唯一发生在 Provider 内部）
      const body = await prepare(candidate); // guardContext + spoof，按该候选窗口定制
      const result = await candidate.provider.send(body, timeoutMs);
      breaker.recordSuccess(candidate.ref);
      if (sessionId) sessions.bind(sessionId, candidate.ref);
      return { result, candidate, failovered: i > 0 };
    } catch (e) {
      lastError = e;
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) {
        breaker.ban(candidate.ref); // Key 问题：封禁而非盲切
      } else {
        breaker.recordFailure(candidate.ref);
      }
    }
  }

  throw lastError;
}
