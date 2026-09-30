import type { AnthropicRequest } from '../types.js';
import { CompactError } from '../compact/compactor.js';
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

/** 规则链叠加会话覆盖：override 置顶并去重；null 原样返回 */
export function resolveChainRefs(ruleRefs: string[], overrideRef: string | null): string[] {
  if (!overrideRef) return ruleRefs;
  return [overrideRef, ...ruleRefs.filter((r) => r !== overrideRef)];
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
  let lastError: unknown = new ProviderError('无可用目标', 503, false);

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
        console.warn(`[failover] 上游 ${candidate.ref} 鉴权失败（${e.status}）: ${e.message}`);
        breaker.ban(candidate.ref); // Key 问题：封禁而非盲切
      } else if (e instanceof CompactError) {
        // 压缩失败不计入转发熔断（详见 CompactError 注释），但请求仍失败并继续 failover
      } else {
        // 失败原因必须可见：熔断日志只有 ref，没有它就无法回答"为什么熔断"
        console.warn(
          `[failover] 上游 ${candidate.ref} 请求失败:`,
          e instanceof Error ? e.message : String(e),
        );
        breaker.recordFailure(candidate.ref);
      }
    }
  }

  throw lastError;
}
