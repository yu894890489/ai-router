import { parseModelRef, type RouterConfig } from '../config.js';
import type { Candidate } from '../pipeline/router.js';
import { ProviderError, type Provider } from '../providers/base.js';
import type { CircuitBreaker } from '../session/store.js';
import type { Summarizer } from './compactor.js';

interface ChainEntry {
  provider: Provider;
  alias: string;
  /** ref 原文（"厂商/别名"），日志用 */
  ref: string;
  /** 厂商名：一家失败后链内跳过该厂商全部模型 */
  vendor: string;
}

export function buildSummarizer(
  config: RouterConfig,
  providers: Map<string, Provider>,
  target: Candidate,
  compactBreaker?: CircuitBreaker,
): Summarizer {
  const timeout = config.compact.timeoutMs;
  // sendSync 传别名，别名→上游名映射在 Provider 内部完成；
  // max_tokens 给强制思考的模型留足空间（思考耗尽预算会导致正文为空）
  const make =
    (p: Provider, alias: string): Summarizer =>
    (text: string) =>
      p.sendSync(
        { model: alias, max_tokens: 16384, messages: [{ role: 'user', content: text }] },
        timeout,
      );

  // 压缩链：compact.target（单个或按优先级列表）在前，转发目标兜底在尾；按 ref 去重
  const refs: string[] = [
    ...(Array.isArray(config.compact.target)
      ? config.compact.target
      : [config.compact.target]),
  ];
  const chain: ChainEntry[] = [];
  const push = (ref: string, resolved?: Provider) => {
    if (chain.some((c) => c.ref === ref)) return;
    try {
      const { provider, alias } = parseModelRef(ref);
      // 兜底项用 Candidate 携带的 provider 实例；链上项按厂商名查表
      const p = resolved ?? providers.get(provider);
      if (p) chain.push({ provider: p, alias, ref, vendor: provider });
    } catch {
      // 非法 ref 跳过（loadConfig 已校验，这里防御）
    }
  };
  for (const ref of refs) push(ref);
  if (config.compact.fallbackToTarget) push(target.ref, target.provider);

  // 链式降级：一家失败即标记该厂商，当前分块与后续分块直接用链上下一个不同厂商，
  // 不再重试同厂商的任何模型。compactBreaker 提供跨请求的厂商级熔断（可选）。
  const downVendors = new Set<string>();
  return async (text: string): Promise<string> => {
    let lastErr: unknown = null;
    for (;;) {
      const cur = chain.find(
        (c) => !downVendors.has(c.vendor) && (!compactBreaker || compactBreaker.canUse(c.vendor)),
      );
      if (!cur) {
        throw new Error(
          `无可用压缩模型${lastErr instanceof Error ? `（最后错误: ${lastErr.message}）` : ''}`,
          lastErr !== null ? { cause: lastErr } : undefined,
        );
      }
      try {
        const out = await make(cur.provider, cur.alias)(text);
        compactBreaker?.recordSuccess(cur.vendor);
        return out;
      } catch (e) {
        lastErr = e;
        downVendors.add(cur.vendor);
        if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) {
          compactBreaker?.ban(cur.vendor);
        } else {
          compactBreaker?.recordFailure(cur.vendor);
        }
        console.warn(`[compact] 压缩模型 ${cur.ref} 失败，改用链上其他厂商模型:`, e);
      }
    }
  };
}
