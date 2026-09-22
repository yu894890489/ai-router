import { parseModelRef, type RouterConfig } from '../config.js';
import type { Candidate } from '../pipeline/router.js';
import type { Provider } from '../providers/base.js';
import type { Summarizer } from './compactor.js';

export function buildSummarizer(
  config: RouterConfig,
  providers: Map<string, Provider>,
  target: Candidate,
): Summarizer {
  const timeout = config.failover.requestTimeoutMs;
  // sendSync 传别名，别名→上游名映射在 Provider 内部完成
  const make =
    (p: Provider, alias: string): Summarizer =>
    (text: string) =>
      p.sendSync(
        { model: alias, max_tokens: 2048, messages: [{ role: 'user', content: text }] },
        timeout,
      );

  // 首选：compact.target（"厂商/别名" ref）。解析失败或厂商不存在时走兜底
  let primaryFn: Summarizer | null = null;
  try {
    const { provider, alias } = parseModelRef(config.compact.target);
    const p = providers.get(provider);
    if (p) primaryFn = make(p, alias);
  } catch {
    primaryFn = null;
  }

  // 兜底：当前转发目标（厂商 + 别名）
  const fallbackFn = config.compact.fallbackToTarget
    ? make(target.provider, target.alias)
    : null;

  return async (text: string): Promise<string> => {
    if (primaryFn) {
      try {
        return await primaryFn(text);
      } catch (e) {
        if (!fallbackFn) throw e;
        console.warn('[compact] 首选压缩模型失败，切换目标厂商兜底:', e);
      }
    }
    if (fallbackFn) return fallbackFn(text);
    throw new Error('无可用压缩模型');
  };
}
