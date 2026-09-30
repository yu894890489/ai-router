import type { Hono } from 'hono';
import { parseModelRef } from './config.js';
import { extractApiKey } from './pipeline/auth.js';
import { readBody } from './storage/bodylog.js';
import { ADMIN_HTML } from './admin-page.js';
import { ADMIN_STATS_HTML } from './admin-stats-page.js';
import type { AppState } from './server.js';

/** 管理页与数据 API。页面不鉴权（无数据），/admin/api/* 用 accessKeys 鉴权。 */
export function registerAdminRoutes(app: Hono, getState: () => AppState): void {
  app.get('/admin', (c) => c.html(ADMIN_HTML));
  app.get('/admin/stats', (c) => c.html(ADMIN_STATS_HTML));

  app.use('/admin/api/*', async (c, next) => {
    const { config } = getState();
    const key = extractApiKey({
      'x-api-key': c.req.header('x-api-key'),
      authorization: c.req.header('authorization'),
    });
    if (!key || !Object.hasOwn(config.accessKeys, key)) {
      return c.json(
        { type: 'error', error: { type: 'authentication_error', message: '无效的接入 Key' } },
        401,
      );
    }
    await next();
  });

  app.get('/admin/api/sessions', (c) => {
    const { storage, sessions } = getState();
    const raw = Number(c.req.query('limit'));
    const limit = Math.min(Math.max(Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50, 1), 500);
    const list = storage.sessions.listRecent(limit).map((s) => ({
      ...s,
      currentRef: s.overrideRef ?? sessions.get(s.sessionId) ?? null,
    }));
    return c.json({ sessions: list });
  });

  app.get('/admin/api/stats', (c) => {
    const { storage } = getState();
    const raw = Number(c.req.query('days'));
    // 0 = 全部；非法/缺省按 30 天
    const days = Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), 3650) : 30;
    return c.json(storage.stats.aggregate(days));
  });

  app.get('/admin/api/models', (c) => {
    const { config } = getState();
    const models = Object.entries(config.providers).flatMap(([provider, p]) =>
      Object.entries(p.models).map(([alias, m]) => ({
        ref: `${provider}/${alias}`,
        provider,
        alias,
        contextWindow: m.contextWindow,
      })),
    );
    return c.json({ models, thresholdRatio: config.compact.thresholdRatio });
  });

  app.post('/admin/api/sessions/:id/model', async (c) => {
    const { config, storage, sessions } = getState();
    const sessionId = c.req.param('id');
    let body: { ref?: string | null };
    try {
      body = (await c.req.json()) as { ref?: string | null };
    } catch {
      return c.json({ error: '请求体非法' }, 400);
    }
    const ref = body.ref ?? null;

    if (!storage.sessions.getSession(sessionId)) {
      return c.json({ error: '会话不存在' }, 404);
    }
    if (ref !== null) {
      let parsed: { provider: string; alias: string } | null = null;
      try {
        parsed = parseModelRef(ref);
      } catch {
        /* 落入 400 */
      }
      if (!parsed || !config.providers[parsed.provider]?.models[parsed.alias]) {
        return c.json({ error: `非法或未配置的模型 ref: ${ref}` }, 400);
      }
      storage.sessions.setOverride(sessionId, ref);
      sessions.bind(sessionId, ref); // 粘性同步，避免旧绑定与覆盖打架
    } else {
      storage.sessions.setOverride(sessionId, null);
      sessions.unbind(sessionId);
    }
    return c.json({ ok: true });
  });

  app.get('/admin/api/sessions/:id/turns', (c) => {
    const { storage } = getState();
    const sessionId = c.req.param('id');
    if (!storage.sessions.getSession(sessionId)) {
      return c.json({ error: '会话不存在' }, 404);
    }
    const turns = storage.turns.listTurns(sessionId).map((t) => ({
      seq: t.seq,
      userText: t.userText,
      assistantText: t.assistantText,
      requestId: t.requestId,
      createdAt: t.createdAt,
    }));
    return c.json({ turns });
  });

  app.get('/admin/api/requests/:id/body', async (c) => {
    const { config, storage } = getState();
    const id = c.req.param('id');
    const req = storage.findRequest(id);
    if (!req) return c.json({ error: '请求不存在' }, 404);
    const body = await readBody(config.storage.jsonlDir, req.project, req.createdAt, id);
    if (!body) return c.json({ error: '报文不存在（日志文件已清理？）' }, 404);
    return c.json(body);
  });

  app.get('/admin/api/search', (c) => {
    const { storage } = getState();
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return c.json({ error: '缺少 q 参数' }, 400);
    const hits = storage.turns.search.search(q, {
      project: c.req.query('project') || undefined,
      sessionId: c.req.query('sessionId') || undefined,
      limit: 30,
    });
    return c.json({ hits });
  });
}
