import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { watch } from 'node:fs';
import { buildSummarizer } from './compact/summarizer.js';
import { loadConfig, type RouterConfig } from './config.js';
import { AuthError, extractApiKey, extractSessionId, resolveProject } from './pipeline/auth.js';
import { guardContext } from './pipeline/context-guard.js';
import { executeWithFailover, selectChain } from './pipeline/router.js';
import { applySpoof } from './pipeline/spoof.js';
import { ProviderError, type Provider } from './providers/base.js';
import { createProviders } from './providers/index.js';
import { CircuitBreaker, SessionStore } from './session/store.js';
import { createStorage, type LogStorage } from './storage/index.js';
import { collectStreamToMessage, teeUsage } from './stream.js';
import type { AnthropicRequest, Usage } from './types.js';

interface AppState {
  config: RouterConfig;
  providers: Map<string, Provider>;
  storage: LogStorage;
  breaker: CircuitBreaker;
  sessions: SessionStore;
}

function anthropicError(type: string, message: string) {
  return { type: 'error', error: { type, message } };
}

function buildState(config: RouterConfig): AppState {
  return {
    config,
    providers: createProviders(config),
    storage: createStorage(config.storage),
    breaker: new CircuitBreaker(config.failover.failureThreshold, config.failover.cooldownSeconds),
    sessions: new SessionStore(config.failover.stickyTtlSeconds),
  };
}

// 热重载时对比新旧配置：apiKey 发生变化的厂商需要解除 401/403 封禁
export function diffUnbanTargets(oldCfg: RouterConfig, newCfg: RouterConfig): string[] {
  const targets: string[] = [];
  for (const [name, p] of Object.entries(newCfg.providers)) {
    const old = oldCfg.providers[name];
    if (old && old.apiKey !== p.apiKey) targets.push(name);
  }
  return targets;
}

export function createApp(configPath: string): Hono {
  let state = buildState(loadConfig(configPath));

  // 配置热重载：替换 config 与 providers；breaker/sessions/storage 保留（会话粘性不丢）
  watch(configPath, () => {
    try {
      const config = loadConfig(configPath);
      // apiKey 变化的厂商解除 401/403 封禁（熔断计数保留）
      for (const name of diffUnbanTargets(state.config, config)) {
        state.breaker.unban(name);
      }
      state = { ...state, config, providers: createProviders(config) };
      console.log('[config] 已热重载');
    } catch (e) {
      console.warn('[config] 热重载失败，沿用旧配置:', e);
    }
  });

  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/v1/messages', async (c) => {
    const startedAt = Date.now();
    const { config, providers, storage, breaker, sessions } = state;
    const body = (await c.req.json()) as AnthropicRequest;

    // 1. 鉴权 + 项目归属
    let project: string;
    try {
      const apiKey = extractApiKey({
        'x-api-key': c.req.header('x-api-key'),
        authorization: c.req.header('authorization'),
      });
      project = resolveProject(config, apiKey, body);
    } catch (e) {
      if (e instanceof AuthError) {
        return c.json(anthropicError('authentication_error', e.message), 401);
      }
      throw e;
    }

    // 2. 日志开始
    const sessionId = extractSessionId(body);
    const logId = storage.start({ project, sessionId, clientModel: body.model });
    storage.writeBody(logId, 'request', body);

    let compactInfo: { before: number; after: number } | null = null;

    try {
      // 3. 厂商链选择（session 粘性 > 配置顺序，过滤熔断/封禁）
      const chain = selectChain(config.routing.default, breaker, sessions, sessionId);
      const candidates = chain
        .map((n) => providers.get(n))
        .filter((p): p is Provider => Boolean(p));
      if (candidates.length === 0) {
        throw new ProviderError('所有厂商均不可用（熔断或封禁中）', 503, false);
      }

      // 4-6. 每次尝试：context-guard（按该厂商窗口）→ spoof → send
      // 注意：spoof 传 body.model（客户端原名），模型映射唯一发生在 Provider.send 内部，
      // 避免对含精确映射 + "*" 的 modelMap 二次映射错配；映射后名字取 result.upstreamModel。
      const { result, provider, failovered } = await executeWithFailover(
        candidates,
        async (p) => {
          // 每次尝试开头重置，避免前一厂商的压缩结果残留到未触发压缩的厂商
          compactInfo = null;
          const summarizer = buildSummarizer(config, providers, p);
          const guarded = await guardContext(body, p.contextWindow, config.compact, summarizer);
          if (guarded.compacted) {
            compactInfo = { before: guarded.before, after: guarded.after };
          }
          return applySpoof(guarded.req, body.model);
        },
        config.failover.requestTimeoutMs,
        breaker,
        sessions,
        sessionId,
      );

      // compactInfo 在回调闭包内赋值，TS 控制流会把它窄化为 null，这里显式还原声明类型
      const compact = compactInfo as { before: number; after: number } | null;
      const baseLog = {
        provider: provider.name,
        upstreamModel: result.upstreamModel,
        compacted: compact !== null,
        compactBefore: compact?.before,
        compactAfter: compact?.after,
        failovered,
      };

      // 7a. 客户端要非流式：聚合后一次性返回
      if (body.stream === false) {
        const message = (await collectStreamToMessage(result.stream)) as { usage?: Usage };
        storage.writeBody(logId, 'response', message);
        storage.finish(logId, {
          ...baseLog,
          status: 'success',
          inputTokens: message.usage?.input_tokens,
          outputTokens: message.usage?.output_tokens,
          durationMs: Date.now() - startedAt,
        });
        return c.json(message);
      }

      // 7b. 流式透传：旁路提取 usage，流结束后完成日志
      const { clientStream, usage } = teeUsage(result.stream);
      void usage
        .then((u) => {
          storage.writeBody(logId, 'response', { streamed: true, usage: u });
          storage.finish(logId, {
            ...baseLog,
            status: 'success',
            inputTokens: u?.input_tokens,
            outputTokens: u?.output_tokens,
            durationMs: Date.now() - startedAt,
          });
        })
        .catch((e) => console.warn('[log] 流尾日志失败:', e));

      return new Response(clientStream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
    } catch (e) {
      // 所有厂商失败 / 压缩失败：显式报错，不静默降级
      const isPE = e instanceof ProviderError;
      const status = isPE && e.status && e.status >= 400 && e.status < 600 ? e.status : 503;
      const type = status === 401 || status === 403 ? 'authentication_error' : 'overloaded_error';
      const message = e instanceof Error ? e.message : String(e);
      storage.finish(logId, {
        status: 'error',
        error: message,
        durationMs: Date.now() - startedAt,
      });
      return c.json(anthropicError(type, message), status as 500);
    }
  });

  return app;
}

// 直接运行时启动服务（被测试 import 时不触发）
import { pathToFileURL } from 'node:url';
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const configPath = process.argv[2] ?? './config.yaml';
  const app = createApp(configPath);
  const { host, port } = loadConfig(configPath).server;
  serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(`ai-router 已启动: http://${host}:${info.port}`);
    console.log(`Claude Code 接入: ANTHROPIC_BASE_URL=http://${host}:${info.port} ANTHROPIC_AUTH_TOKEN=<accessKeys 中的 Key>`);
  });
}
