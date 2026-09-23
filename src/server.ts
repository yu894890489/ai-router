import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { watch } from 'node:fs';
import { registerAdminRoutes } from './admin.js';
import { buildSummarizer } from './compact/summarizer.js';
import { loadConfig, parseModelRef, type RouterConfig } from './config.js';
import { AuthError, extractApiKey, extractSessionId, resolveProject } from './pipeline/auth.js';
import { guardContext } from './pipeline/context-guard.js';
import { executeWithFailover, resolveChainRefs, selectChain, type Candidate } from './pipeline/router.js';
import { applySpoof } from './pipeline/spoof.js';
import { extractTitle } from './pipeline/title.js';
import { extractUserTurn } from './pipeline/turns.js';
import { ProviderError, type Provider } from './providers/base.js';
import { createProviders } from './providers/index.js';
import { CircuitBreaker, SessionStore } from './session/store.js';
import { createStorage, type LogStorage } from './storage/index.js';
import { collectStreamToMessage, teeUsage } from './stream.js';
import type { AnthropicRequest, Message, Usage } from './types.js';

export interface AppState {
  config: RouterConfig;
  providers: Map<string, Provider>;
  storage: LogStorage;
  breaker: CircuitBreaker;
  sessions: SessionStore;
  /** 会话 -> 上一次请求的客户端 messages（轮次前缀比对用，上限 20 个会话 FIFO 淘汰） */
  turnCache: Map<string, Message[]>;
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
    turnCache: new Map(),
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

/**
 * 应用一次配置热重载：apiKey 变化的厂商解除其全部模型 ref 的 401/403 封禁
 * （熔断计数保留），替换 config 与 providers；breaker/sessions/storage 保留。
 * 从 watch 回调中抽出以便服务端级测试直接调用。
 */
export function applyConfigReload(state: AppState, config: RouterConfig): AppState {
  for (const name of diffUnbanTargets(state.config, config)) {
    state.breaker.unbanPrefix(name + '/');
  }
  return { ...state, config, providers: createProviders(config) };
}

export function createApp(configPath: string): Hono {
  let state = buildState(loadConfig(configPath));

  // 配置热重载：替换 config 与 providers；breaker/sessions/storage 保留（会话粘性不丢）
  watch(configPath, () => {
    try {
      state = applyConfigReload(state, loadConfig(configPath));
      console.log('[config] 已热重载');
    } catch (e) {
      console.warn('[config] 热重载失败，沿用旧配置:', e);
    }
  });

  const app = new Hono();

  registerAdminRoutes(app, () => state);

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
    let lastBefore: number | null = null;

    // 会话台账：title 仅首次写入，lastSeen/lastTokens 每次更新（存储失败不阻断转发）
    const touchSession = () => {
      if (!sessionId) return;
      storage.sessions.touchSession({
        sessionId,
        project,
        title: extractTitle(body.messages),
        tokens: lastBefore ?? 0,
      });
    };

    // 轮次提取：prev 取客户端视角 messages（压缩只改上游请求，客户端历史 append-only）
    const recordTurn = (assistantText: string) => {
      if (!sessionId) return;
      const prev = state.turnCache.get(sessionId) ?? null;
      const userText = extractUserTurn(prev, body.messages);
      if (state.turnCache.size >= 20) {
        const oldest = state.turnCache.keys().next().value;
        if (oldest !== undefined) state.turnCache.delete(oldest);
      }
      state.turnCache.set(sessionId, body.messages);
      storage.turns.addTurn({ sessionId, requestId: logId, userText, assistantText });
    };

    try {
      // 3. 场景路由：rules 精确匹配 + "*" 兜底；会话 override 置顶（钉住优先、规则链兜底）
      const ruleRefs = config.routing.rules[body.model] ?? config.routing.rules['*'];
      const overrideRef = sessionId ? storage.sessions.getOverride(sessionId) : null;
      const chainRefs = resolveChainRefs(ruleRefs, overrideRef);
      // 4. 链选择（session 粘性 > 配置顺序，过滤熔断/封禁；键均为 ref）
      // override 存在时粘性不前置（钉住 ref 已在链首），避免旧绑定与覆盖打架
      const selectedRefs = selectChain(chainRefs, breaker, sessions, overrideRef ? null : sessionId);
      // refs → Candidate（loadConfig 已校验 ref 合法，这里防御性跳过异常项）
      const candidates: Candidate[] = [];
      for (const ref of selectedRefs) {
        try {
          const { provider, alias } = parseModelRef(ref);
          const p = providers.get(provider);
          if (p) candidates.push({ provider: p, alias, ref });
        } catch {
          console.warn(`[routing] 跳过非法 ref: ${ref}`);
        }
      }
      if (candidates.length === 0) {
        throw new ProviderError('所有厂商均不可用（熔断或封禁中）', 503, false);
      }

      // 5-7. 每次尝试：context-guard（按该候选别名的窗口）→ spoof（写别名）→ send
      // 注意：spoof/send 都传模型别名，别名→上游名的映射唯一发生在 Provider 内部；
      // 映射后的真实上游名取 result.upstreamModel 供日志。
      const { result, candidate, failovered } = await executeWithFailover(
        candidates,
        async (cand) => {
          // 每次尝试开头重置，避免前一厂商的压缩结果残留到未触发压缩的厂商
          compactInfo = null;
          const summarizer = buildSummarizer(config, providers, cand);
          const guarded = await guardContext(
            body,
            cand.provider.contextWindowFor(cand.alias),
            config.compact,
            summarizer,
          );
          lastBefore = guarded.before;
          if (guarded.compacted) {
            compactInfo = { before: guarded.before, after: guarded.after };
          }
          return applySpoof(guarded.req, cand.alias);
        },
        config.failover.requestTimeoutMs,
        breaker,
        sessions,
        sessionId,
      );

      // compactInfo 在回调闭包内赋值，TS 控制流会把它窄化为 null，这里显式还原声明类型
      touchSession();
      const compact = compactInfo as { before: number; after: number } | null;
      const baseLog = {
        provider: candidate.provider.name,
        upstreamModel: result.upstreamModel,
        compacted: compact !== null,
        compactBefore: compact?.before,
        compactAfter: compact?.after,
        failovered,
      };

      // 7a. 客户端要非流式：聚合后一次性返回
      if (body.stream === false) {
        const message = (await collectStreamToMessage(result.stream)) as {
          usage?: Usage;
          content?: Array<Record<string, unknown>>;
        };
        const assistantText = ((message.content ?? []) as Array<Record<string, unknown>>)
          .filter((b) => b.type === 'text')
          .map((b) => (b.text as string) ?? '')
          .join('\n');
        try {
          recordTurn(assistantText);
        } catch (e) {
          // 轮次记录失败不阻断响应日志收尾，否则 requests 表永久 pending
          console.error('[turns] 轮次记录失败:', e);
        }
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

      // 7b. 流式透传：旁路提取 usage + 助手文本，流结束后完成日志与轮次记录
      const { clientStream, usage, text, streamError } = teeUsage(result.stream);
      void Promise.all([usage, text, streamError])
        .then(([u, assistantText, sErr]) => {
          try {
            recordTurn(assistantText ?? '');
          } catch (e) {
            // 轮次记录失败不阻断 writeBody/finish，否则 requests 表永久 pending
            console.error('[turns] 轮次记录失败:', e);
          }
          storage.writeBody(logId, 'response', { streamed: true, usage: u });
          if (sErr) {
            // 上游把错误混在 SSE 流里：客户端已收到错误事件，日志如实记失败
            storage.finish(logId, {
              ...baseLog,
              status: 'error',
              error: sErr,
              inputTokens: u?.input_tokens,
              outputTokens: u?.output_tokens,
              durationMs: Date.now() - startedAt,
            });
            return;
          }
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
      touchSession();
      try {
        recordTurn('');
      } catch (e2) {
        // 错误路径也要保证 finish 落库
        console.error('[turns] 轮次记录失败:', e2);
      }
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
