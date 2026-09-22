import type { CompactConfig } from '../config.js';
import { compactMessages, type Summarizer } from '../compact/compactor.js';
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
): Promise<GuardResult> {
  const sysTokens = countSystem(req.system);
  const msgTokens = countMessages(req.messages);
  const total = sysTokens + msgTokens;

  if (total <= windowTokens * cfg.thresholdRatio) {
    return { req, compacted: false, before: total, after: total };
  }

  const target = Math.max(Math.floor(windowTokens * cfg.targetRatio) - sysTokens, 1000);
  const res = await compactMessages(req.messages, {
    keepRecentTurns: cfg.keepRecentTurns,
    targetTokens: target,
    chunkTokens: cfg.chunkTokens,
    summarizer,
    count: countMessages,
  });

  return {
    req: { ...req, messages: res.messages },
    compacted: res.compacted,
    before: total,
    after: res.after + sysTokens,
  };
}
