# 会话切换器（Session Switcher）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理页列出最近 5 个活跃会话（首条用户消息作标题），可把某会话钉到指定「厂商/别名」ref，钉住优先、原规则链兜底。

**Architecture:** router.db 新增 `sessions` 表（标题/覆盖/最近 token 量）；请求流程在规则链前叠加 override ref；Hono 直接渲染 `/admin` 单页（内联 JS，无构建），数据走三个鉴权 API。设计文档：`docs/superpowers/specs/2026-09-22-session-switcher-design.md`。

**Tech Stack:** Node >= 24 / TypeScript（ESM）/ Hono / node:sqlite / vitest / tsx。

## Global Constraints

- 测试命令：`node node_modules/vitest/vitest.mjs run <文件>`（npx 不可用）；全量约 3 秒。
- 类型检查：`node node_modules/typescript/bin/tsc --noEmit`，必须零错误。
- 提交：`git -c user.name="kimi" -c user.email="kimi@local" commit`，每个 Task 一个提交。
- 不新增任何 npm 运行时依赖（页面为内联 JS 的单页 HTML）。
- 不修改 `config.yaml`（用户真实配置，未入库）。
- 存储旁路原则：sessions 读写失败只告警，不阻断转发（沿用 `src/storage/index.ts` 的 `safe()`）。
- 既有约定：ref = `"厂商/别名"`；熔断/粘性键均为 ref；`body.model` 传别名，上游名映射只在 Provider 内部。

---

### Task 1: 数据层（sessions 表 + SessionDirectory + 标题提取）

**Files:**
- Modify: `src/storage/interface.ts`
- Create: `src/pipeline/title.ts`
- Modify: `src/storage/sqlite.ts`
- Modify: `src/storage/index.ts`
- Test: `test/session-directory.test.ts`、`test/title.test.ts`

**Interfaces:**
- Produces（后续 Task 依赖）:
  - `SessionInfo`、`SessionDirectory`（interface.ts）
  - `LogStorage.sessions: SessionDirectory`
  - `extractTitle(messages: Message[]): string`（title.ts）

- [ ] **Step 1: 写失败测试 test/title.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { extractTitle } from '../src/pipeline/title.js';

describe('extractTitle', () => {
  it('取第一条 user 消息的字符串内容', () => {
    expect(
      extractTitle([
        { role: 'assistant', content: '先开口' },
        { role: 'user', content: '帮我看看这个 bug' },
      ]),
    ).toBe('帮我看看这个 bug');
  });

  it('content 为数组时拼接 text 块', () => {
    expect(
      extractTitle([
        {
          role: 'user',
          content: [
            { type: 'text', text: '第一段' },
            { type: 'image' },
            { type: 'text', text: '第二段' },
          ],
        },
      ]),
    ).toBe('第一段 第二段');
  });

  it('折叠连续空白并截断到 200 字符', () => {
    const long = 'a'.repeat(150) + ' \n\t ' + 'b'.repeat(150);
    const t = extractTitle([{ role: 'user', content: long }]);
    expect(t).not.toMatch(/\s{2,}/);
    expect(t.length).toBeLessThanOrEqual(200);
  });

  it('无 user 消息或空白内容时返回（无标题）', () => {
    expect(extractTitle([{ role: 'assistant', content: 'x' }])).toBe('（无标题）');
    expect(extractTitle([{ role: 'user', content: '  \n ' }])).toBe('（无标题）');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/title.test.ts`
Expected: FAIL（Cannot find module '../src/pipeline/title.js'）

- [ ] **Step 3: 实现 src/pipeline/title.ts**

```ts
import type { Message } from '../types.js';

/** 提取会话标题：第一条 user 消息的文本，折叠空白、截断 200 字符 */
export function extractTitle(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '（无标题）';
  const raw =
    typeof first.content === 'string'
      ? first.content
      : first.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join(' ');
  const t = raw.replace(/\s+/g, ' ').trim();
  return t.length === 0 ? '（无标题）' : t.slice(0, 200);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/title.test.ts`
Expected: 4 passed

- [ ] **Step 5: 扩展 src/storage/interface.ts（完整替换文件内容）**

```ts
export interface NewRequestLog {
  project: string;
  sessionId: string | null;
  clientModel: string;
}

export interface RequestLogPatch {
  provider?: string;
  upstreamModel?: string;
  status?: 'success' | 'error';
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  compacted?: boolean;
  compactBefore?: number;
  compactAfter?: number;
  failovered?: boolean;
  error?: string;
}

export interface SessionInfo {
  sessionId: string;
  project: string;
  title: string;
  overrideRef: string | null;
  lastTokens: number;
  createdAt: string;
  lastSeen: string;
}

export interface SessionDirectory {
  /** 每次请求调用：首次见到写入 title/project，之后仅更新 lastSeen/lastTokens */
  touchSession(s: { sessionId: string; project: string; title: string; tokens: number }): void;
  setOverride(sessionId: string, ref: string | null): void;
  getOverride(sessionId: string): string | null;
  getSession(sessionId: string): SessionInfo | null;
  listRecent(limit: number): SessionInfo[];
}

export interface LogStorage {
  start(entry: NewRequestLog): string;
  finish(id: string, patch: RequestLogPatch): void;
  writeBody(id: string, kind: 'request' | 'response', payload: unknown): void;
  sessions: SessionDirectory;
  close(): void;
}
```

- [ ] **Step 6: 写失败测试 test/session-directory.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { createSqliteStorage } from '../src/storage/sqlite.js';

function makeStorage() {
  return createSqliteStorage(':memory:');
}

describe('SessionDirectory', () => {
  it('touchSession 首次写入 title/project，再次调用只更新 lastTokens/lastSeen', () => {
    const s = makeStorage();
    s.sessions.touchSession({ sessionId: 'session_a', project: 'p1', title: '标题一', tokens: 100 });
    s.sessions.touchSession({ sessionId: 'session_a', project: 'pX', title: '不应覆盖', tokens: 200 });
    const info = s.sessions.getSession('session_a');
    expect(info?.title).toBe('标题一');
    expect(info?.project).toBe('p1');
    expect(info?.lastTokens).toBe(200);
    s.close();
  });

  it('setOverride/getOverride 往返，null 清除', () => {
    const s = makeStorage();
    s.sessions.touchSession({ sessionId: 'session_b', project: 'p1', title: 't', tokens: 1 });
    expect(s.sessions.getOverride('session_b')).toBeNull();
    s.sessions.setOverride('session_b', 'kimi/k3-1m');
    expect(s.sessions.getOverride('session_b')).toBe('kimi/k3-1m');
    s.sessions.setOverride('session_b', null);
    expect(s.sessions.getOverride('session_b')).toBeNull();
    s.close();
  });

  it('getOverride/getSession 对未知会话返回 null', () => {
    const s = makeStorage();
    expect(s.sessions.getOverride('session_none')).toBeNull();
    expect(s.sessions.getSession('session_none')).toBeNull();
    s.close();
  });

  it('listRecent 按 lastSeen 倒序并遵守 limit', async () => {
    const s = makeStorage();
    s.sessions.touchSession({ sessionId: 'session_1', project: 'p', title: '一', tokens: 1 });
    await new Promise((r) => setTimeout(r, 5));
    s.sessions.touchSession({ sessionId: 'session_2', project: 'p', title: '二', tokens: 1 });
    await new Promise((r) => setTimeout(r, 5));
    s.sessions.touchSession({ sessionId: 'session_3', project: 'p', title: '三', tokens: 1 });
    const all = s.sessions.listRecent(5);
    expect(all.map((x) => x.sessionId)).toEqual(['session_3', 'session_2', 'session_1']);
    expect(s.sessions.listRecent(2)).toHaveLength(2);
    s.close();
  });
});
```

- [ ] **Step 7: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/session-directory.test.ts`
Expected: FAIL（sessions 不存在 / 类型错误）

- [ ] **Step 8: 实现 src/storage/sqlite.ts**

DDL 常量末尾（`idx_requests_created` 那行之后、结尾反引号之前）追加：

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  override_ref TEXT,
  last_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);
```

import 行改为：

```ts
import type { LogStorage, NewRequestLog, RequestLogPatch, SessionDirectory, SessionInfo } from './interface.js';
```

`createSqliteStorage` 内 `db.exec(DDL)` 之后加入：

```ts
  interface SessionRow {
    session_id: string;
    project: string;
    title: string;
    override_ref: string | null;
    last_tokens: number;
    created_at: string;
    last_seen: string;
  }
  const toInfo = (r: SessionRow): SessionInfo => ({
    sessionId: r.session_id,
    project: r.project,
    title: r.title,
    overrideRef: r.override_ref,
    lastTokens: r.last_tokens,
    createdAt: r.created_at,
    lastSeen: r.last_seen,
  });

  const sessions: SessionDirectory = {
    touchSession(s) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO sessions (session_id, project, title, last_tokens, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_seen = excluded.last_seen,
           last_tokens = excluded.last_tokens`,
      ).run(s.sessionId, s.project, s.title, s.tokens, now, now);
    },
    setOverride(sessionId, ref) {
      db.prepare('UPDATE sessions SET override_ref = ? WHERE session_id = ?').run(ref, sessionId);
    },
    getOverride(sessionId) {
      const row = db
        .prepare('SELECT override_ref FROM sessions WHERE session_id = ?')
        .get(sessionId) as { override_ref: string | null } | undefined;
      return row?.override_ref ?? null;
    },
    getSession(sessionId) {
      const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as
        | SessionRow
        | undefined;
      return row ? toInfo(row) : null;
    },
    listRecent(limit) {
      const rows = db
        .prepare('SELECT * FROM sessions ORDER BY last_seen DESC LIMIT ?')
        .all(limit) as SessionRow[];
      return rows.map(toInfo);
    },
  };
```

返回对象加 `sessions,`（在 `writeBody` 与 `close` 之间）。

- [ ] **Step 9: 修改 src/storage/index.ts（safe 包装）**

import 行加 `SessionInfo`：

```ts
import type { LogStorage, NewRequestLog, RequestLogPatch, SessionInfo } from './interface.js';
export type { LogStorage, NewRequestLog, RequestLogPatch, SessionDirectory, SessionInfo } from './interface.js';
```

返回对象中 `writeBody` 之后加：

```ts
    sessions: {
      touchSession(s) {
        safe(() => db.sessions.touchSession(s));
      },
      setOverride(id, ref) {
        safe(() => db.sessions.setOverride(id, ref));
      },
      getOverride(id) {
        let v: string | null = null;
        safe(() => {
          v = db.sessions.getOverride(id);
        });
        return v;
      },
      getSession(id) {
        let v: SessionInfo | null = null;
        safe(() => {
          v = db.sessions.getSession(id);
        });
        return v;
      },
      listRecent(limit) {
        let v: SessionInfo[] = [];
        safe(() => {
          v = db.sessions.listRecent(limit);
        });
        return v;
      },
    },
```

- [ ] **Step 10: 修复既有测试 fixture 并全量验证**

`LogStorage` 加了必含属性 `sessions`，若有测试手写 LogStorage mock 会 tsc 报错。先跑：

Run: `node node_modules/typescript/bin/tsc --noEmit`
对每一处报错（对象缺少 sessions），在对应 mock 上加：

```ts
sessions: {
  touchSession() {},
  setOverride() {},
  getOverride: () => null,
  getSession: () => null,
  listRecent: () => [],
},
```

然后：

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 全部通过（含新增 8 个用例）

- [ ] **Step 11: Commit**

```bash
git add src/storage src/pipeline/title.ts test/session-directory.test.ts test/title.test.ts test
git -c user.name="kimi" -c user.email="kimi@local" commit -m "feat: sessions 表与 SessionDirectory 数据层"
```

---

### Task 2: 路由覆盖（override 链构造 + 粘性同步 + touchSession 接线）

**Files:**
- Modify: `src/pipeline/router.ts`（新增纯函数）
- Modify: `src/session/store.ts`（SessionStore 加 unbind）
- Modify: `src/server.ts`（链构造 + touchSession）
- Test: `test/override-routing.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LogStorage.sessions`、`extractTitle`
- Produces:
  - `resolveChainRefs(ruleRefs: string[], overrideRef: string | null): string[]`（router.ts，Task 3 不直接用但保持导出）
  - `SessionStore.unbind(sessionId: string): void`（Task 3 的 admin API 依赖）

- [ ] **Step 1: 写失败测试 test/override-routing.test.ts（前半：纯函数与 unbind）**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { resolveChainRefs } from '../src/pipeline/router.js';
import { SessionStore } from '../src/session/store.js';

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

describe('resolveChainRefs', () => {
  it('无 override 时原样返回规则链', () => {
    expect(resolveChainRefs(['a/x', 'b/y'], null)).toEqual(['a/x', 'b/y']);
  });

  it('override 置顶并去重', () => {
    expect(resolveChainRefs(['a/x', 'b/y', 'c/z'], 'b/y')).toEqual(['b/y', 'a/x', 'c/z']);
  });

  it('override 不在规则链中时照样置顶（钉住优先，规则链兜底）', () => {
    expect(resolveChainRefs(['a/x'], 'b/y')).toEqual(['b/y', 'a/x']);
  });
});

describe('SessionStore.unbind', () => {
  it('解除粘性绑定', () => {
    const s = new SessionStore(60);
    s.bind('session_x', 'a/x');
    s.unbind('session_x');
    expect(s.get('session_x')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/override-routing.test.ts`
Expected: FAIL（resolveChainRefs / unbind 未定义）

- [ ] **Step 3: 实现 router.ts 纯函数与 store.ts unbind**

router.ts 在 `Candidate` 接口之后加：

```ts
/** 规则链叠加会话覆盖：override 置顶并去重；null 原样返回 */
export function resolveChainRefs(ruleRefs: string[], overrideRef: string | null): string[] {
  if (!overrideRef) return ruleRefs;
  return [overrideRef, ...ruleRefs.filter((r) => r !== overrideRef)];
}
```

store.ts `SessionStore` 的 `bind` 方法之后加：

```ts
  unbind(sessionId: string): void {
    this.bindings.delete(sessionId);
  }
```

- [ ] **Step 4: 追加集成测试（override-routing.test.ts 后半）**

在文件末尾追加（mock 上游模式照抄 test/integration.test.ts 的 startMock，这里完整给出）：

```ts
function sseBody(text: string): string {
  const ev = (t: string, d: unknown) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
  return (
    ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'mock', content: [], usage: { input_tokens: 5, output_tokens: 1 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) +
    ev('message_stop', { type: 'message_stop' })
  );
}

interface MockHandle {
  url: string;
  lastModel: () => string | null;
}

function startMock(): Promise<MockHandle> {
  return new Promise((resolve) => {
    let lastModel: string | null = null;
    const s = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        lastModel = (JSON.parse(raw) as { model?: string }).model ?? null;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody('ok'));
      });
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, lastModel: () => lastModel });
    });
  });
}

const SESSION_UID = 'user_account_session_abc123';

function sendChat(app: ReturnType<typeof createApp>) {
  return app.request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ok' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8,
      stream: true,
      metadata: { user_id: SESSION_UID },
      messages: [{ role: 'user', content: '第一句话作为标题' }],
    }),
  });
}

describe('会话 override 路由', () => {
  it('无 override 走规则链；写入 override 后同会话切到钉住 ref', async () => {
    const p1 = await startMock();
    const p2 = await startMock();
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-ovr-'));
    const dbPath = join(dir, 'r.db').replace(/\\/g, '/');
    writeFileSync(
      join(dir, 'config.yaml'),
      `
server: { port: 0 }
accessKeys: { sk-ok: proj1 }
providers:
  p1:
    baseUrl: ${p1.url}
    apiKey: k1
    authHeader: bearer
    userAgent: ua
    models: { m: { upstream: p1-upstream, contextWindow: 262144 } }
  p2:
    baseUrl: ${p2.url}
    apiKey: k2
    authHeader: bearer
    userAgent: ua
    models: { m: { upstream: p2-upstream, contextWindow: 262144 } }
routing:
  rules:
    "*": [p1/m, p2/m]
compact: { target: p2/m }
storage: { sqlitePath: ${dbPath}, jsonlDir: ${join(dir, 'logs').replace(/\\/g, '/')} }
`,
      'utf8',
    );
    const app = createApp(join(dir, 'config.yaml'));

    // 第一次请求：规则链首选 p1
    let res = await sendChat(app);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100)); // 等流尾日志
    expect(p1.lastModel()).toBe('p1-upstream');
    expect(p2.lastModel()).toBeNull();

    // 直接写库设置 override（Admin API 属 Task 3，这里绕开页面测路由行为）
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE sessions SET override_ref = 'p2/m' WHERE session_id = 'session_abc123'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = 'session_abc123'").get())
      .toEqual({ n: 1 }); // touchSession 已建行，且标题/项目已记录
    db.close();

    // 第二次同会话请求：钉住 p2
    res = await sendChat(app);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(p2.lastModel()).toBe('p2-upstream');
  });
});
```

注意：`extractSessionId` 取 `user_id` 中最后一个 `session_` 起子串，故 `SESSION_UID` 对应会话 ID 为 `session_abc123`。

- [ ] **Step 5: 跑测试确认失败（第二次请求仍走 p1）**

Run: `node node_modules/vitest/vitest.mjs run test/override-routing.test.ts`
Expected: 纯函数/unbind 用例通过；集成用例 FAIL（`p2.lastModel()` 仍为 null）

- [ ] **Step 6: 修改 src/server.ts 接线**

import 段加：

```ts
import { extractTitle } from './pipeline/title.js';
```

router import 加 `resolveChainRefs`：

```ts
import { executeWithFailover, resolveChainRefs, selectChain, type Candidate } from './pipeline/router.js';
```

`/v1/messages` 中第 3 步（场景路由）替换为：

```ts
      // 3. 场景路由：rules 精确匹配 + "*" 兜底；会话 override 置顶（钉住优先、规则链兜底）
      const ruleRefs = config.routing.rules[body.model] ?? config.routing.rules['*'];
      const overrideRef = sessionId ? storage.sessions.getOverride(sessionId) : null;
      const chainRefs = resolveChainRefs(ruleRefs, overrideRef);
```

`compactInfo` 声明旁加 tokens 捕获：

```ts
    let compactInfo: { before: number; after: number } | null = null;
    let lastBefore: number | null = null;
```

prepare 回调内 `const guarded = await guardContext(...)` 之后加：

```ts
          lastBefore = guarded.before;
```

再加 touchSession 辅助函数（`/v1/messages` 回调内 try 之前、`compactInfo` 声明之后）：

```ts
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
```

成功路径（`executeWithFailover` 之后、`const compact = ...` 之前）加：

```ts
      touchSession();
```

catch 路径（`storage.finish(logId, {...})` 之前）加：

```ts
      touchSession();
```

- [ ] **Step 7: 全量验证**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 全部通过（含集成用例钉住 p2）
Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: 零错误

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/router.ts src/session/store.ts src/server.ts test/override-routing.test.ts
git -c user.name="kimi" -c user.email="kimi@local" commit -m "feat: 会话级模型 override 路由（钉住优先、规则链兜底）"
```

---

### Task 3: 管理 API + /admin 页面 + README

**Files:**
- Create: `src/admin.ts`
- Create: `src/admin-page.ts`
- Modify: `src/server.ts`（注册路由）
- Test: `test/admin.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 `SessionDirectory`/`SessionInfo`；Task 2 `SessionStore.unbind`；既有 `extractApiKey`、`parseModelRef`、`AppState`
- Produces:
  - `registerAdminRoutes(app: Hono, getState: () => AppState): void`
  - API：`GET /admin`、`GET /admin/api/sessions?limit=5`、`GET /admin/api/models`、`POST /admin/api/sessions/:id/model`

- [ ] **Step 1: 写失败测试 test/admin.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

function writeConfig(dir: string): string {
  const p = join(dir, 'config.yaml');
  writeFileSync(
    p,
    `
server: { port: 3456 }
accessKeys: { sk-ok: proj1 }
providers:
  kimi:
    baseUrl: http://127.0.0.1:1
    apiKey: sk-x
    authHeader: bearer
    userAgent: ua
    models:
      k3: { upstream: k3-up, contextWindow: 1048576 }
      coding: { upstream: coding-up, contextWindow: 262144 }
routing:
  rules:
    "*": [kimi/coding]
compact: { target: kimi/coding }
storage: { sqlitePath: ${join(dir, 'r.db').replace(/\\/g, '/')}, jsonlDir: ${join(dir, 'logs').replace(/\\/g, '/')} }
`,
    'utf8',
  );
  return p;
}

const UID = 'user_account_session_admin1';

async function sendFailingChat(app: ReturnType<typeof createApp>) {
  // 上游不可达会 5xx，但 prepare 已执行，touchSession 落行
  await app.request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ok' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1,
      stream: true,
      metadata: { user_id: UID },
      messages: [{ role: 'user', content: 'admin 测试标题' }],
    }),
  });
}

describe('admin', () => {
  it('GET /admin 返回页面', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-adm-'));
    const app = createApp(writeConfig(dir));
    const res = await app.request('http://localhost/admin');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ai-router');
  });

  it('API 无 Key 401，有 Key 返回会话列表与模型清单', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-adm-'));
    const app = createApp(writeConfig(dir));

    expect((await app.request('http://localhost/admin/api/sessions')).status).toBe(401);
    expect((await app.request('http://localhost/admin/api/models')).status).toBe(401);

    await sendFailingChat(app);

    const list = await (
      await app.request('http://localhost/admin/api/sessions', { headers: { 'x-api-key': 'sk-ok' } })
    ).json();
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0].sessionId).toBe('session_admin1');
    expect(list.sessions[0].title).toBe('admin 测试标题');
    expect(list.sessions[0].overrideRef).toBeNull();

    const models = await (
      await app.request('http://localhost/admin/api/models', { headers: { 'x-api-key': 'sk-ok' } })
    ).json();
    expect(models.models.map((m: { ref: string }) => m.ref).sort()).toEqual(['kimi/coding', 'kimi/k3']);
    expect(typeof models.thresholdRatio).toBe('number');
  });

  it('POST 钉模型：成功/非法 ref/未知会话/清除', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-router-adm-'));
    const app = createApp(writeConfig(dir));
    await sendFailingChat(app);
    const h = { 'content-type': 'application/json', 'x-api-key': 'sk-ok' };

    const ok = await app.request('http://localhost/admin/api/sessions/session_admin1/model', {
      method: 'POST', headers: h, body: JSON.stringify({ ref: 'kimi/k3' }),
    });
    expect(ok.status).toBe(200);

    const list = await (
      await app.request('http://localhost/admin/api/sessions', { headers: { 'x-api-key': 'sk-ok' } })
    ).json();
    expect(list.sessions[0].overrideRef).toBe('kimi/k3');
    expect(list.sessions[0].currentRef).toBe('kimi/k3'); // 粘性同步

    const bad = await app.request('http://localhost/admin/api/sessions/session_admin1/model', {
      method: 'POST', headers: h, body: JSON.stringify({ ref: 'kimi/nope' }),
    });
    expect(bad.status).toBe(400);

    const ghost = await app.request('http://localhost/admin/api/sessions/session_ghost/model', {
      method: 'POST', headers: h, body: JSON.stringify({ ref: 'kimi/k3' }),
    });
    expect(ghost.status).toBe(404);

    const clear = await app.request('http://localhost/admin/api/sessions/session_admin1/model', {
      method: 'POST', headers: h, body: JSON.stringify({ ref: null }),
    });
    expect(clear.status).toBe(200);
    const after = await (
      await app.request('http://localhost/admin/api/sessions', { headers: { 'x-api-key': 'sk-ok' } })
    ).json();
    expect(after.sessions[0].overrideRef).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/admin.test.ts`
Expected: FAIL（/admin 404）

- [ ] **Step 3: 实现 src/admin.ts**

```ts
import type { Hono } from 'hono';
import { parseModelRef } from './config.js';
import { extractApiKey } from './pipeline/auth.js';
import { ADMIN_HTML } from './admin-page.js';
import type { AppState } from './server.js';

/** 管理页与数据 API。页面不鉴权（无数据），/admin/api/* 用 accessKeys 鉴权。 */
export function registerAdminRoutes(app: Hono, getState: () => AppState): void {
  app.get('/admin', (c) => c.html(ADMIN_HTML));

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
    const limit = Math.min(Math.max(Number.isFinite(raw) && raw > 0 ? raw : 5, 1), 50);
    const list = storage.sessions.listRecent(limit).map((s) => ({
      ...s,
      currentRef: s.overrideRef ?? sessions.get(s.sessionId) ?? null,
    }));
    return c.json({ sessions: list });
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
    const body = (await c.req.json()) as { ref?: string | null };
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
}
```

- [ ] **Step 4: 实现 src/admin-page.ts（完整页面）**

```ts
export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ai-router · 会话切换器</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0f1115; color: #e6e6e6;
         font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b8f98; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #262a33; vertical-align: top; }
  th { color: #8b8f98; font-weight: 500; white-space: nowrap; }
  .title { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sid { color: #8b8f98; font-family: ui-monospace, monospace; font-size: 12px; }
  select { background: #1a1e26; color: #e6e6e6; border: 1px solid #333a47; border-radius: 6px; padding: 6px 8px; }
  .warn { color: #f0b429; cursor: help; }
  .cur { font-family: ui-monospace, monospace; font-size: 12px; }
  .muted { color: #8b8f98; }
  #keybox { margin: 40px auto; max-width: 420px; background: #1a1e26; padding: 24px; border-radius: 10px; }
  #keybox input { width: 100%; padding: 8px; margin: 8px 0; background: #0f1115; color: #e6e6e6;
                  border: 1px solid #333a47; border-radius: 6px; }
  #keybox button { padding: 8px 16px; background: #3b82f6; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  #err { color: #f87171; }
  .tag { display: inline-block; background: #1a1e26; border-radius: 4px; padding: 1px 6px; font-size: 12px; }
</style>
</head>
<body>
<h1>ai-router · 会话切换器</h1>
<div class="sub">最近 5 个活跃会话 · 钉住优先，规则链兜底 · <span id="now"></span></div>
<div id="keybox" style="display:none">
  <div>输入 accessKey（config.yaml 中 accessKeys 的任一 Key）</div>
  <input id="key" type="password" placeholder="sk-..." />
  <button onclick="saveKey()">进入</button>
  <div id="err"></div>
</div>
<table id="tbl" style="display:none">
  <thead><tr>
    <th>会话</th><th>项目</th><th>当前模型</th><th>最近 token</th><th>活跃时间</th><th>切换模型</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>
<script>
let KEY = localStorage.getItem('ai-router-key') || '';
let MODELS = [], THRESH = 0.85;

function fmtTs(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
function fmtWindow(n) { return n >= 1000000 ? (n / 1048576).toFixed(0) + 'M' : Math.round(n / 1024) + 'K'; }

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'x-api-key': KEY } }, opts || {}));
  if (res.status === 401) { showKey('Key 无效，请重新输入'); throw new Error('401'); }
  return res.json();
}

function showKey(msg) {
  document.getElementById('keybox').style.display = 'block';
  document.getElementById('tbl').style.display = 'none';
  document.getElementById('err').textContent = msg || '';
}
function saveKey() {
  KEY = document.getElementById('key').value.trim();
  localStorage.setItem('ai-router-key', KEY);
  load();
}

async function switchModel(sid, ref) {
  await api('/admin/api/sessions/' + encodeURIComponent(sid) + '/model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: ref || null }),
  });
  load();
}

async function load() {
  try {
    const m = await api('/admin/api/models');
    MODELS = m.models; THRESH = m.thresholdRatio;
    const s = await api('/admin/api/sessions?limit=5');
    document.getElementById('keybox').style.display = 'none';
    document.getElementById('tbl').style.display = 'table';
    document.getElementById('now').textContent = fmtTs(new Date().toISOString());
    const rows = document.getElementById('rows');
    rows.innerHTML = '';
    for (const it of s.sessions) {
      const tr = document.createElement('tr');
      const opts = ['<option value="">跟随规则</option>'].concat(MODELS.map(function (mo) {
        const sel = it.overrideRef === mo.ref ? ' selected' : '';
        const warn = it.lastTokens > mo.contextWindow * THRESH ? ' ⚠️' : '';
        return '<option value="' + mo.ref + '"' + sel + '>' + mo.ref + ' · ' + fmtWindow(mo.contextWindow) + warn + '</option>';
      })).join('');
      const cur = it.currentRef ? '<span class="tag">' + it.currentRef + '</span>' : '<span class="muted">跟随规则</span>';
      tr.innerHTML =
        '<td><div class="title" title="' + (it.title || '').replace(/"/g, '&quot;') + '">' + (it.title || '（无标题）') + '</div>' +
        '<div class="sid">' + it.sessionId + '</div></td>' +
        '<td>' + it.project + '</td>' +
        '<td class="cur">' + cur + '</td>' +
        '<td>' + it.lastTokens.toLocaleString() + '</td>' +
        '<td class="muted">' + fmtTs(it.lastSeen) + '</td>' +
        '<td><select onchange="switchModel(\\'' + it.sessionId + '\\', this.value)">' + opts + '</select> ' +
        '<span class="warn" title="带 ⚠️ 的选项：该会话 token 量超过目标窗口触发线，切换后将自动压缩历史">?</span></td>';
      rows.appendChild(tr);
    }
    if (s.sessions.length === 0) {
      rows.innerHTML = '<tr><td colspan="6" class="muted">还没有会话记录。用 Claude Code 发一条消息后再来。</td></tr>';
    }
  } catch (e) { /* 401 已处理 */ }
}

document.getElementById('now').textContent = fmtTs(new Date().toISOString());
if (!KEY) showKey(''); else load();
setInterval(load, 15000);
</script>
</body>
</html>`;
```

- [ ] **Step 5: 注册路由（src/server.ts）**

import 加：

```ts
import { registerAdminRoutes } from './admin.js';
```

`createApp` 内 `const app = new Hono();` 之后加：

```ts
  registerAdminRoutes(app, () => state);
```

- [ ] **Step 6: 全量验证**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 全部通过（含 admin 3 个用例）
Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: 零错误

- [ ] **Step 7: README 增补**

在 README 的「多模型配置」相关章节之后加一节：

```markdown
## 会话切换器（/admin）

浏览器打开 `http://127.0.0.1:13456/admin`（端口以 config.yaml 为准），输入任一 accessKey 进入：

- 列出最近 5 个活跃 Claude 会话：标题（首条用户消息）、项目、当前模型、最近 token 量、活跃时间
- 每行下拉框可把该会话**钉到指定模型**（`厂商/别名`）：之后该会话优先走钉住模型，失败仍按原规则链 failover；选「跟随规则」恢复默认
- 钉住关系存 `data/router.db`（sessions 表），重启保留；选项旁带 ⚠️ 表示该会话 token 量超过目标窗口触发线，切换后将自动压缩历史（摘要旧对话，不硬截断）
```

- [ ] **Step 8: Commit**

```bash
git add src/admin.ts src/admin-page.ts src/server.ts test/admin.test.ts README.md
git -c user.name="kimi" -c user.email="kimi@local" commit -m "feat: /admin 会话切换器（页面 + API + 钉模型）"
```

---

### Task 4: 端到端浏览器实测 + 终审（主代理执行，不派实现子代理）

**Files:** 无新增（实测脚本即用即删）

- [ ] **Step 1: 用临时端口启动服务，发两个不同会话的请求（metadata.user_id 各含一个 session_ 前缀），确认 /admin/api/sessions 出现两行且标题正确**
- [ ] **Step 2: 用 InAppBrowser 打开 /admin 页面，输入 Key，确认表格渲染、下拉框选项与窗口标注正确**
- [ ] **Step 3: 在页面上给会话 A 切到另一个模型，再发会话 A 的请求，确认 router.db 日志 upstream_model 变为新模型、override 行 currentRef 更新**
- [ ] **Step 4: 重启服务，确认 override 仍在（SQLite 持久化）**
- [ ] **Step 5: 生成评审包并派评审子代理做 S 系终审（diff 范围：设计文档提交 .. HEAD）**

```bash
bash "D:/KimiData/daimon-share/daimon/runtime/kimi-code/home/plugins/managed/superpowers/skills/subagent-driven-development/scripts/review-package" <设计文档提交SHA> HEAD
```
