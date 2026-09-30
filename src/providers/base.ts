import type { ProviderConfig } from '../config.js';
import { spoofHeaders } from '../pipeline/spoof.js';
import { collectStreamToMessage } from '../stream.js';
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
  /** 别名 → 上游模型名；未知别名抛 ProviderError（retriable: false） */
  resolveModel(alias: string): string;
  /** 别名的上下文窗口；未知别名抛 ProviderError（retriable: false） */
  contextWindowFor(alias: string): number;
  /** body.model 传别名，内部完成别名→上游名映射；SendResult.upstreamModel 为映射后的上游名 */
  send(body: AnthropicRequest, timeoutMs: number): Promise<SendResult>;
  /** 同 send，v2 契约：内部同样完成别名→上游名映射，调用方永远传别名 */
  sendSync(body: AnthropicRequest, timeoutMs: number): Promise<string>;
}

export function createAnthropicProvider(name: string, cfg: ProviderConfig): Provider {
  function resolveModel(alias: string): string {
    // Object.hasOwn 防原型链键（constructor 等）被误认为已配置别名
    if (!Object.hasOwn(cfg.models, alias)) {
      throw new ProviderError(`厂商 ${name} 未配置模型别名 "${alias}"`, undefined, false);
    }
    return cfg.models[alias]!.upstream;
  }

  function contextWindowFor(alias: string): number {
    if (!Object.hasOwn(cfg.models, alias)) {
      throw new ProviderError(`厂商 ${name} 未配置模型别名 "${alias}"`, undefined, false);
    }
    return cfg.models[alias]!.contextWindow;
  }

  /** 该厂商模型不支持关闭思考时置位（如 volcengine glm-5.3 强制思考），后续 sendSync 不再携带参数 */
  let thinkingDisableUnsupported = false;

  /** fetch 失败时 Node 把真实原因挂在 cause（ECONNRESET/ETIMEDOUT 等），必须带出否则日志无法定位 */
  function describeNetError(e: unknown): string {
    const cause = (e as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      const code = (cause as { code?: string }).code;
      return `${String(e)} (${code ? `${code}: ` : ''}${cause.message})`;
    }
    return String(e);
  }

  async function post(body: AnthropicRequest, timeoutMs: number): Promise<Response> {
    // 连接级失败（TLS 握手被掐/连接重置等，未获任何响应）自动重试 2 次（250-750ms 抖动）：
    // 上游经代理隧道时握手会瞬断，重试即可自愈。超时（AbortError，调用方预算）与
    // HTTP 状态错误（由 failover 链处理）不在此重试。
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
      }
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
        if (isTimeout || attempt === 3) {
          throw new ProviderError(
            `上游 ${name} ${isTimeout ? '请求超时' : '网络错误'}: ${describeNetError(e)}`,
            undefined,
            true,
          );
        }
        console.warn(`[provider] 上游 ${name} 连接失败，重试 ${attempt}/2: ${describeNetError(e)}`);
      } finally {
        clearTimeout(timer); // 超时只覆盖到响应头；流式 body 不设总时限
      }
    }
    throw new Error('unreachable'); // 循环内每次尝试必 return 或 throw
  }

  return {
    name,

    resolveModel,

    contextWindowFor,

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
      // v2 契约：与 send 一致，内部完成别名→上游名映射。
      // 走流式传输（与转发同路径）：coding 端点对非流式大 prompt 会挂死/重置连接
      const upstreamModel = resolveModel(body.model);
      const sendOnce = async (extra: Record<string, unknown>): Promise<string> => {
        const res = await post({ ...body, model: upstreamModel, stream: true, ...extra }, timeoutMs);
        if (!res.body) {
          throw new ProviderError(`上游 ${name} 响应无 body`, undefined, true);
        }
        // 部分上游以 200 + JSON 返回错误（如配额耗尽），不识别会被流式解析吞成"未找到 message_start"
        const ctype = res.headers.get('content-type') ?? '';
        if (!ctype.includes('text/event-stream')) {
          const text = await res.text().catch(() => '');
          throw new ProviderError(
            `上游 ${name} 返回非流式响应(${ctype || '无 content-type'}): ${text.slice(0, 300)}`,
            undefined,
            true,
          );
        }
        const message = await collectStreamToMessage(res.body as ReadableStream<Uint8Array>);
        const text = ((message.content ?? []) as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
        if (!text) throw new ProviderError(`上游 ${name} 返回空内容`, undefined, true);
        return text;
      };

      // glm 系思考模型会把输出预算耗在思考上导致正文为空：总结请求关闭思考；
      // 强制思考的模型会 400 报 not supported —— 记住该厂商实例，后续不再携带该参数
      if (!thinkingDisableUnsupported) {
        try {
          return await sendOnce({ thinking: { type: 'disabled' } });
        } catch (e) {
          const unsupported =
            e instanceof ProviderError && e.status === 400 && e.message.includes('thinking');
          if (!unsupported) throw e;
          thinkingDisableUnsupported = true;
          console.warn(`[provider] 上游 ${name} 不支持关闭思考，总结请求不再携带该参数`);
        }
      }
      return await sendOnce({});
    },
  };
}
