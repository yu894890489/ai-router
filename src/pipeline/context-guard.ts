import type { CompactConfig } from '../config.js';
import { CompactError, compactMessages, type Summarizer } from '../compact/compactor.js';
import { countMessages, countSystem } from '../compact/tokenizer.js';
import type { AnthropicRequest } from '../types.js';

export interface GuardResult {
  req: AnthropicRequest;
  compacted: boolean;
  before: number;
  after: number;
}

export async function guardContext(
  req: AnthropicRequest,
  windowTokens: number,
  cfg: CompactConfig,
  summarizer: Summarizer,
  prevWindowTokens?: number | null,
): Promise<GuardResult> {
  const sysTokens = countSystem(req.system);
  const msgTokens = countMessages(req.messages);
  const total = sysTokens + msgTokens;

  // 大窗口候选不做路由侧压缩（1M 模型由客户端自行压缩，降级到小窗口时才需要）
  if (windowTokens >= cfg.skipIfWindowGte) {
    return { req, compacted: false, before: total, after: total };
  }
  // 会话一直跑在小窗口（256k 原生）：客户端的压缩节奏与该窗口匹配，路由侧不用管
  if (prevWindowTokens != null && prevWindowTokens < cfg.skipIfWindowGte) {
    return { req, compacted: false, before: total, after: total };
  }
  // 剩下两种情况按阈值压缩：会话曾用大窗口现在落到小窗口（1M 切 256k 降级），
  // 或 prevWindow 未知（重启后首个请求，保守压缩）

  if (total <= windowTokens * cfg.thresholdRatio) {
    return { req, compacted: false, before: total, after: total };
  }

  const target = Math.max(Math.floor(windowTokens * cfg.targetRatio) - sysTokens, 1000);
  let res;
  try {
    res = await compactMessages(req.messages, {
      keepRecentTurns: cfg.keepRecentTurns,
      targetTokens: target,
      chunkTokens: cfg.chunkTokens,
      summarizer,
      count: countMessages,
      concurrency: cfg.concurrency,
      chunkIntervalMs: cfg.chunkIntervalMs,
    });
  } catch (e) {
    throw new CompactError(
      `上下文压缩失败: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }

  return {
    req: { ...req, messages: res.messages },
    compacted: res.compacted,
    before: total,
    after: res.after + sysTokens,
  };
}
