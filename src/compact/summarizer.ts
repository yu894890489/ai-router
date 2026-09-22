import type { RouterConfig } from '../config.js';
import type { Provider } from '../providers/base.js';
import type { Summarizer } from './compactor.js';

export function buildSummarizer(
  config: RouterConfig,
  providers: Map<string, Provider>,
  target: Provider,
): Summarizer {
  const timeout = config.failover.requestTimeoutMs;
  const make =
    (p: Provider, model: string): Summarizer =>
    (text: string) =>
      p.sendSync(
        { model, max_tokens: 2048, messages: [{ role: 'user', content: text }] },
        timeout,
      );

  const primary = providers.get(config.compact.provider);
  const primaryFn = primary ? make(primary, config.compact.model) : null;
  // 目标厂商兜底：模型名经其 modelMap 映射（通常命中 "*"）
  const fallbackFn = config.compact.fallbackToTarget
    ? make(target, target.resolveModel(config.compact.model))
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
