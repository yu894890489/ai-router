import type { ProviderConfig } from '../config.js';
import { spoofHeaders } from '../pipeline/spoof.js';
import type { AnthropicRequest } from '../types.js';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retriable = true,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface SendResult {
  stream: ReadableStream<Uint8Array>;
  upstreamModel: string;
}

export interface Provider {
  readonly name: string;
  readonly contextWindow: number;
  resolveModel(clientModel: string): string;
  send(body: AnthropicRequest, timeoutMs: number): Promise<SendResult>;
  sendSync(body: AnthropicRequest, timeoutMs: number): Promise<string>;
}

export function createAnthropicProvider(name: string, cfg: ProviderConfig): Provider {
  function resolveModel(clientModel: string): string {
    return cfg.modelMap[clientModel] ?? cfg.modelMap['*'] ?? clientModel;
  }

  async function post(body: AnthropicRequest, timeoutMs: number): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: spoofHeaders(cfg),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const retriable = res.status === 429 || res.status >= 500;
        throw new ProviderError(
          `上游 ${name} 返回 ${res.status}: ${text.slice(0, 300)}`,
          res.status,
          retriable,
        );
      }
      return res;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const isTimeout = e instanceof Error && e.name === 'AbortError';
      throw new ProviderError(
        `上游 ${name} ${isTimeout ? '请求超时' : '网络错误'}: ${String(e)}`,
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer); // 超时只覆盖到响应头；流式 body 不设总时限
    }
  }

  return {
    name,
    contextWindow: cfg.contextWindow,

    resolveModel,

    async send(body: AnthropicRequest, timeoutMs: number): Promise<SendResult> {
      // 本方法返回前抛错 = 可向客户端 failover；返回后流断 = 不可 failover
      const upstreamModel = resolveModel(body.model);
      const res = await post({ ...body, model: upstreamModel, stream: true }, timeoutMs);
      if (!res.body) {
        throw new ProviderError(`上游 ${name} 响应无 body`, undefined, true);
      }
      return {
        stream: res.body as ReadableStream<Uint8Array>,
        upstreamModel,
      };
    },

    async sendSync(body: AnthropicRequest, timeoutMs: number): Promise<string> {
      const res = await post({ ...body, stream: false }, timeoutMs);
      const json = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = (json.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      if (!text) throw new ProviderError(`上游 ${name} 返回空内容`, undefined, true);
      return text;
    },
  };
}
