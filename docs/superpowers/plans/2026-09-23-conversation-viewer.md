# 对话回放与检索（Conversation Viewer）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** /admin 管理页按会话回放去重后的聊天流（用户/AI 气泡 + 可展开原始报文），并支持 SQLite FTS5 全文检索对话内容，搜索后端抽象预留 ES 切换。

**Architecture:** 请求完成时做最长公共前缀增量提取「轮次」存 turns 表 + FTS5 外部内容索引（探测失败降级 LIKE）；原始报文继续读既有 JSONL 落盘文件；页面并入 /admin 单页。设计文档：`docs/superpowers/specs/2026-09-23-conversation-viewer-design.md`。

**Tech Stack:** Node >= 24 / TypeScript（ESM）/ Hono / node:sqlite（FTS5 已实测可用）/ vitest / tsx。

## Global Constraints

- 测试命令：`node node_modules/vitest/vitest.mjs run <文件>`（npx 不可用）；全量约 3 秒。
- 类型检查：`node node_modules/typescript/bin/tsc --noEmit`，必须零错误。
- 提交：`git -c user.name="kimi" -c user.email="kimi@local" commit`，每个 Task 一个提交。
- 不新增 npm 运行时依赖；不碰 `config.yaml`（用户真实配置）。
- 存储旁路原则：turns 写入/索引/搜索失败只告警，不阻断转发（沿用 `src/storage/index.ts` 的 `safe()`）。
- 页面安全约束：一切用户/对话数据用 DOM API + `textContent` 渲染，禁止 innerHTML 拼接；搜索 snippet 只允许纯文本（FTS snippet 的高亮标记符替换为纯文本占位，不用 `<mark>` HTML）。
- 既有约定：ref = `"厂商/别名"`；`/admin/api/*` 必须 accessKeys 鉴权；注册路由用 `() => state` 惰性取值。

---

### Task 1: 轮次提取 + turns 表 + SearchBackend（FTS/LIKE）

**Files:**
- Create: `src/pipeline/turns.ts`
- Create: `src/storage/search.ts`
- Modify: `src/storage/interface.ts`
- Modify: `src/storage/sqlite.ts`
- Modify: `src/storage/index.ts`
- Modify: `src/config.ts`（search 配置节）
- Test: `test/turns.test.ts`、`test/search.test.ts`

**Interfaces:**
- Produces（后续 Task 依赖）：
  - `messageText(m: Message): string`、`extractUserTurn(prev: Message[] | null, curr: Message[]): string`（turns.ts）
  - `Turn`、`SearchHit`、`SearchBackend`（interface.ts）
  - `LogStorage.turns: { addTurn(t: NewTurn): void; listTurns(sessionId: string): Turn[]; search: SearchBackend }`
  - `NewTurn = { sessionId: string; requestId: string; userText: string; assistantText: string }`（id/seq/createdAt 由存储层生成，seq = 该会话 MAX(seq)+1）
  - config：`config.search.backend: 'fts' | 'es'`（默认 fts；es 时 loadConfig 抛错）

- [ ] **Step 1: 写失败测试 test/turns.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { extractUserTurn, messageText } from '../src/pipeline/turns.js';
import type { Message } from '../src/types.js';

const u = (t: string): Message => ({ role: 'user', content: t });
const a = (t: string): Message => ({ role: 'assistant', content: t });

describe('messageText', () => {
  it('字符串 content 原样返回', () => {
    expect(messageText(u('你好'))).toBe('你好');
  });
  it('数组 content 拼接 text 块', () => {
    expect(
      messageText({ role: 'user', content: [{ type: 'text', text: '一' }, { type: 'image' }, { type: 'text', text: '二' }] }),
    ).toBe('一\n二');
  });
});

describe('extractUserTurn', () => {
  const turn1 = [u('第一个问题'), a('回答一')];

  it('prev 为 null（新会话/重启后首条）：取最后一条 user 消息', () => {
    expect(extractUserTurn(null, [...turn1, u('第二个问题')])).toBe('第二个问题');
  });

  it('正常增量：返回前缀之后的新 user 消息', () => {
    const curr = [...turn1, u('第二个问题'), a('回答二'), u('第三个问题')];
    expect(extractUserTurn(turn1, curr)).toBe('第二个问题\n第三个问题');
  });

  it('前缀被压缩打断：兜底取最后一条 user 消息', () => {
    const compacted = [u('[历史摘要] 之前讨论了订单模块'), a('好的'), u('继续')];
    expect(extractUserTurn(turn1, compacted)).toBe('继续');
  });

  it('前缀后无新 user 消息（如仅工具结果续跑）：兜底取最后一条 user', () => {
    const curr = [...turn1, a('再说一句')];
    expect(extractUserTurn(turn1, curr)).toBe('第一个问题');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/turns.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/pipeline/turns.ts**

```ts
import type { Message } from '../types.js';

/** 消息的纯文本：字符串 content 原样；数组拼接 text 块（换行分隔） */
export function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

function lastUserText(curr: Message[]): string {
  for (let i = curr.length - 1; i >= 0; i--) {
    if (curr[i].role === 'user') return messageText(curr[i]);
  }
  return '';
}

/**
 * 增量提取本轮用户输入：与上一次请求的 messages 做最长公共前缀比对。
 * prev 为 null、前缀被打断（压缩改写历史）、或前缀后无新 user 消息时，
 * 兜底取本次最后一条 user 消息。
 */
export function extractUserTurn(prev: Message[] | null, curr: Message[]): string {
  if (!prev) return lastUserText(curr);
  let i = 0;
  while (i < prev.length && i < curr.length && JSON.stringify(prev[i]) === JSON.stringify(curr[i])) i++;
  if (i < prev.length) return lastUserText(curr); // 前缀中断（压缩等）
  const newUsers = curr
    .slice(i)
    .filter((m) => m.role === 'user')
    .map(messageText)
    .filter((t) => t.length > 0);
  if (newUsers.length === 0) return lastUserText(curr);
  return newUsers.join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/turns.test.ts`
Expected: 6 passed

- [ ] **Step 5: 扩展 src/storage/interface.ts**

文件末尾（`LogStorage` 定义之前）追加：

```ts
export interface Turn {
  id: string;
  sessionId: string;
  requestId: string;
  seq: number;
  userText: string;
  assistantText: string;
  createdAt: string;
}

/** addTurn 入参：id/seq/createdAt 由存储层生成 */
export interface NewTurn {
  sessionId: string;
  requestId: string;
  userText: string;
  assistantText: string;
}

export interface SearchHit {
  sessionId: string;
  sessionTitle: string | null; // 联表 sessions.title，无会话行时为 null
  requestId: string;
  seq: number;
  snippet: string;
  createdAt: string;
}

/** 搜索后端抽象：本期 SQLite FTS5（不可用降级 LIKE），预留 ES 实现 */
export interface SearchBackend {
  indexTurn(t: Turn): void;
  search(query: string, filter?: { project?: string; sessionId?: string; limit?: number }): SearchHit[];
}
```

`LogStorage` 接口 `sessions: SessionDirectory;` 之后加：

```ts
  turns: {
    addTurn(t: NewTurn): void;
    listTurns(sessionId: string): Turn[];
    search: SearchBackend;
  };
```

- [ ] **Step 6: 实现 src/storage/search.ts**

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { SearchBackend, SearchHit, Turn } from './interface.js';

const MAX_TERMS = 10;

/** 把用户查询转成安全的 FTS5 MATCH 表达式：空白分词，每个词加双引号（防语法错误），词间 AND */
function toMatchExpr(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TERMS)
    .map((t) => `"${t.replace(/"/g, '')}"`)
    .join(' ');
}

interface HitRow {
  session_id: string;
  session_title: string | null;
  request_id: string;
  seq: number;
  snip: string;
  created_at: string;
}

const toHit = (r: HitRow): SearchHit => ({
  sessionId: r.session_id,
  sessionTitle: r.session_title,
  requestId: r.request_id,
  seq: r.seq,
  snippet: r.snip,
  createdAt: r.created_at,
});

/** 创建 FTS5 后端；turns_fts 虚表不存在（FTS5 不可用）时返回 null */
export function createSqliteFtsBackend(db: DatabaseSync): SearchBackend | null {
  try {
    db.prepare('SELECT rowid FROM turns_fts LIMIT 0').all();
  } catch {
    return null;
  }
  return {
    indexTurn(t: Turn) {
      const row = db.prepare('SELECT rowid FROM turns WHERE id = ?').get(t.id) as
        | { rowid: number }
        | undefined;
      if (!row) return;
      db.prepare('INSERT INTO turns_fts(rowid, user_text, assistant_text) VALUES (?, ?, ?)').run(
        row.rowid,
        t.userText,
        t.assistantText,
      );
    },
    search(query, filter = {}) {
      const expr = toMatchExpr(query);
      if (!expr) return [];
      const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
      const conds: string[] = ['turns_fts MATCH ?'];
      const params: (string | number)[] = [expr];
      if (filter.sessionId) {
        conds.push('t.session_id = ?');
        params.push(filter.sessionId);
      }
      if (filter.project) {
        conds.push('s.project = ?');
        params.push(filter.project);
      }
      const rows = db
        .prepare(
          `SELECT t.session_id, s.title AS session_title, t.request_id, t.seq,
                  snippet(turns_fts, -1, '【', '】', '…', 24) AS snip, t.created_at
           FROM turns_fts f
           JOIN turns t ON t.rowid = f.rowid
           LEFT JOIN sessions s ON s.session_id = t.session_id
           WHERE ${conds.join(' AND ')}
           ORDER BY t.created_at DESC
           LIMIT ?`,
        )
        .all(...params, limit) as unknown as HitRow[];
      return rows.map(toHit);
    },
  };
}

/** LIKE 降级后端（FTS5 不可用时）：子串匹配，snippet 为命中点前后各 40 字符 */
export function createLikeBackend(db: DatabaseSync): SearchBackend {
  return {
    indexTurn() {
      /* 无索引可建 */
    },
    search(query, filter = {}) {
      const q = query.trim();
      if (!q) return [];
      const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
      const like = `%${q}%`;
      const conds: string[] = ['(t.user_text LIKE ? OR t.assistant_text LIKE ?)'];
      const params: (string | number)[] = [like, like];
      if (filter.sessionId) {
        conds.push('t.session_id = ?');
        params.push(filter.sessionId);
      }
      if (filter.project) {
        conds.push('s.project = ?');
        params.push(filter.project);
      }
      const rows = db
        .prepare(
          `SELECT t.session_id, s.title AS session_title, t.request_id, t.seq, t.user_text, t.assistant_text, t.created_at
           FROM turns t LEFT JOIN sessions s ON s.session_id = t.session_id
           WHERE ${conds.join(' AND ')}
           ORDER BY t.created_at DESC
           LIMIT ?`,
        )
        .all(...params, limit) as unknown as Array<HitRow & { user_text: string; assistant_text: string }>;
      return rows.map((r) => {
        const hay = r.user_text.includes(q) ? r.user_text : r.assistant_text;
        const at = hay.indexOf(q);
        const start = Math.max(0, at - 40);
        const snip = (start > 0 ? '…' : '') + hay.slice(start, at + q.length + 40);
        return toHit({ ...r, snip });
      });
    },
  };
}
```

- [ ] **Step 7: 扩展 src/storage/sqlite.ts**

import 行加类型与工厂：

```ts
import type { LogStorage, NewRequestLog, NewTurn, RequestLogPatch, SearchBackend, SessionDirectory, SessionInfo, Turn } from './interface.js';
import { createLikeBackend, createSqliteFtsBackend } from './search.js';
import { randomUUID } from 'node:crypto'; // 已有则忽略本行
```

DDL 常量末尾追加：

```sql
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  user_text TEXT NOT NULL,
  assistant_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, seq);
```

`db.exec(DDL)` 之后加 FTS5 探测建表：

```ts
  // FTS5 探测：不可用（极少见）时 search 降级 LIKE
  let ftsOk = true;
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(user_text, assistant_text, content='turns', content_rowid='rowid')",
    );
  } catch {
    ftsOk = false;
  }
  const searchBackend: SearchBackend = (ftsOk ? createSqliteFtsBackend(db) : null) ?? createLikeBackend(db);
```

`createSqliteStorage` 返回对象内 `sessions,` 之后加：

```ts
    turns: {
      addTurn(t: NewTurn): void {
        const id = randomUUID();
        const seq =
          (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM turns WHERE session_id = ?').get(t.sessionId) as { s: number }).s;
        const createdAt = new Date().toISOString();
        db.prepare(
          'INSERT INTO turns (id, session_id, request_id, seq, user_text, assistant_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(id, t.sessionId, t.requestId, seq, t.userText, t.assistantText, createdAt);
        searchBackend.indexTurn({ ...t, id, seq, createdAt });
      },
      listTurns(sessionId: string): Turn[] {
        const rows = db
          .prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY seq ASC')
          .all(sessionId) as unknown as Array<{
          id: string; session_id: string; request_id: string; seq: number;
          user_text: string; assistant_text: string; created_at: string;
        }>;
        return rows.map((r) => ({
          id: r.id,
          sessionId: r.session_id,
          requestId: r.request_id,
          seq: r.seq,
          userText: r.user_text,
          assistantText: r.assistant_text,
          createdAt: r.created_at,
        }));
      },
      search: searchBackend,
    },
```

- [ ] **Step 8: 扩展 src/storage/index.ts（safe 包装）**

import 加类型：

```ts
import type { LogStorage, NewRequestLog, NewTurn, RequestLogPatch, SearchHit, SessionInfo } from './interface.js';
```

返回对象 `sessions: { ... }` 之后加：

```ts
    turns: {
      addTurn(t: NewTurn) {
        safe(() => db.turns.addTurn(t));
      },
      listTurns(sessionId: string) {
        let v: ReturnType<typeof db.turns.listTurns> = [];
        safe(() => {
          v = db.turns.listTurns(sessionId);
        });
        return v;
      },
      search: {
        indexTurn() {
          /* 索引由 sqlite addTurn 内部完成，这里不重复暴露 */
        },
        search(query: string, filter?: { project?: string; sessionId?: string; limit?: number }) {
          let v: SearchHit[] = [];
          safe(() => {
            v = db.turns.search.search(query, filter);
          });
          return v;
        },
      },
    },
```

- [ ] **Step 9: src/config.ts 加 search 配置节**

zod schema 中 `storage` 节之后（`})` 闭合前）加：

```ts
  search: z
    .object({ backend: z.enum(['fts', 'es']).default('fts') })
    .default({ backend: 'fts' }),
```

`loadConfig` 解析成功后、返回前加：

```ts
  if (cfg.search.backend === 'es') {
    throw new Error('search.backend = "es" 尚未实现，请使用 "fts"');
  }
```

（`loadConfig` 现有结构若是 `const cfg = schema.parse(...); return cfg;` 则插在两行之间；具体位置以现状为准。）

- [ ] **Step 10: 写 test/search.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { createSqliteStorage } from '../src/storage/sqlite.js';

function seed(s: ReturnType<typeof createSqliteStorage>) {
  s.sessions.touchSession({ sessionId: 'session_s1', project: 'proj-a', title: 't', tokens: 1 });
  s.turns.addTurn({ sessionId: 'session_s1', requestId: 'r1', userText: '帮我看看 getUserById 的空指针', assistantText: '问题在第三行没判空' });
  s.turns.addTurn({ sessionId: 'session_s1', requestId: 'r2', userText: '顺便优化一下深度学习的例子', assistantText: '已改成中文示例' });
}

describe('turns + search', () => {
  it('addTurn 自动生成 id/seq/createdAt，listTurns 按 seq 升序', () => {
    const s = createSqliteStorage(':memory:');
    seed(s);
    const turns = s.turns.listTurns('session_s1');
    expect(turns).toHaveLength(2);
    expect(turns[0].seq).toBe(1);
    expect(turns[1].seq).toBe(2);
    expect(turns[0].requestId).toBe('r1');
    expect(turns[0].createdAt).toBeTruthy();
    s.close();
  });

  it('全文搜索命中中文与标识符，snippet 带【】标记', () => {
    const s = createSqliteStorage(':memory:');
    seed(s);
    const hits = s.turns.search.search('空指针');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].sessionId).toBe('session_s1');
    expect(hits[0].sessionTitle).toBe('t'); // 联表 sessions.title
    expect(hits[0].snippet).toContain('【');
    const hits2 = s.turns.search.search('getUserById');
    expect(hits2.length).toBeGreaterThanOrEqual(1);
    s.close();
  });

  it('多词查询为 AND 语义；filter 按 session/project 过滤', () => {
    const s = createSqliteStorage(':memory:');
    seed(s);
    expect(s.turns.search.search('深度学习 空指针')).toHaveLength(0); // 两轮各含一词，不同行不同命中
    expect(s.turns.search.search('空指针', { sessionId: 'session_other' })).toHaveLength(0);
    expect(s.turns.search.search('空指针', { project: 'proj-a' }).length).toBeGreaterThanOrEqual(1);
    expect(s.turns.search.search('空指针', { project: 'proj-x' })).toHaveLength(0);
    s.close();
  });

  it('特殊字符查询不报错（引号/通配符被清理）', () => {
    const s = createSqliteStorage(':memory:');
    seed(s);
    expect(() => s.turns.search.search('" OR *')).not.toThrow();
    s.close();
  });
});
```

- [ ] **Step 11: 全量验证**

Run: `node node_modules/typescript/bin/tsc --noEmit`（如有手写 LogStorage mock 缺 turns，按编译错误补桩）
Run: `node node_modules/vitest/vitest.mjs run`
Expected: 全部通过（含新增 10 个用例）；tsc 零错误

- [ ] **Step 12: Commit**

```bash
git add src/pipeline/turns.ts src/storage src/config.ts test/turns.test.ts test/search.test.ts
git -c user.name="kimi" -c user.email="kimi@local" commit -m "feat: turns 轮次提取 + FTS5 搜索后端（LIKE 降级）"
```

---

### Task 2: 流式文本采集 + server 接线 + 三个 API + JSONL 报文读取

**Files:**
- Modify: `src/stream.ts`（teeUsage 增加 text）
- Create: `src/storage/bodylog.ts`
- Modify: `src/storage/interface.ts`（findRequest）
- Modify: `src/storage/sqlite.ts`（findRequest 实现）
- Modify: `src/storage/index.ts`（findRequest 包装）
- Modify: `src/server.ts`（AppState.turnCache + recordTurn）
- Modify: `src/admin.ts`（三个端点）
- Test: `test/viewer-api.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `extractUserTurn/messageText/Turn/NewTurn/SearchBackend`、`LogStorage.turns`
- Produces:
  - `teeUsage(...)` 返回 `{ clientStream, usage, text }`（text: Promise<string>，助手 text_delta 累积）
  - `LogStorage.findRequest(id: string): { id: string; project: string; createdAt: string } | null`
  - `readBody(jsonlDir, project, createdAt, id): Promise<{ request: unknown | null; response: unknown | null } | null>`（bodylog.ts）
  - API：`GET /admin/api/sessions/:id/turns`、`GET /admin/api/requests/:id/body`、`GET /admin/api/search?q=`

- [ ] **Step 1: src/stream.ts teeUsage 增加 text 采集**

`teeUsage` 函数体内：

`let saw = false;` 之后加：

```ts
  let resolveText!: (t: string) => void;
  const text = new Promise<string>((r) => {
    resolveText = r;
  });
  let reply = '';
```

`handleChunk` 的 if/else 链中，`message_start` 分支之后、`message_delta` 分支之前插入：

```ts
      } else if (json.type === 'content_block_delta') {
        const d = json.delta as { type?: string; text?: string } | undefined;
        if (d?.type === 'text_delta') reply += d.text ?? '';
```

两处 `resolveUsage(...)` 调用之后各加一行 `resolveText(reply);`。

返回语句改为：

```ts
  return { clientStream, usage, text };
```

返回类型标注改为：

```ts
): {
  clientStream: ReadableStream<Uint8Array>;
  usage: Promise<Usage | null>;
  text: Promise<string>;
} {
```

- [ ] **Step 2: interface.ts / sqlite.ts / index.ts 加 findRequest**

interface.ts `LogStorage` 的 `start` 之前加：

```ts
  findRequest(id: string): { id: string; project: string; createdAt: string } | null;
```

sqlite.ts 返回对象 `start` 之前加：

```ts
    findRequest(id: string) {
      const row = db.prepare('SELECT id, project, created_at FROM requests WHERE id = ?').get(id) as
        | { id: string; project: string; created_at: string }
        | undefined;
      return row ? { id: row.id, project: row.project, createdAt: row.created_at } : null;
    },
```

index.ts 返回对象 `start` 之前加：

```ts
    findRequest(id: string) {
      let v: { id: string; project: string; createdAt: string } | null = null;
      safe(() => {
        v = db.findRequest(id);
      });
      return v;
    },
```

- [ ] **Step 3: 实现 src/storage/bodylog.ts**

```ts
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { sanitizeProject } from './jsonl.js';

/** 按请求 id 从 JSONL 落盘日志取原始报文（文件按 项目/日期 分片）；两 kind 都找到即提前结束 */
export async function readBody(
  jsonlDir: string,
  project: string,
  createdAt: string,
  id: string,
): Promise<{ request: unknown | null; response: unknown | null } | null> {
  const date = createdAt.slice(0, 10);
  const file = join(jsonlDir, sanitizeProject(project), `${date}.jsonl`);
  if (!existsSync(file)) return null;
  let request: unknown = null;
  let response: unknown = null;
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes(id)) continue;
    try {
      const rec = JSON.parse(line) as { id?: string; kind?: string; payload?: unknown };
      if (rec.id !== id) continue;
      if (rec.kind === 'request') request = rec.payload;
      else if (rec.kind === 'response') response = rec.payload;
      if (request !== null && response !== null) break;
    } catch {
      /* 跳过坏行 */
    }
  }
  rl.close();
  if (request === null && response === null) return null;
  return { request, response };
}
```

- [ ] **Step 4: src/server.ts 接线**

import 段加：

```ts
import { extractUserTurn } from './pipeline/turns.js';
import type { AnthropicRequest, Message, Usage } from './types.js';
```

（替换原有的 `import type { AnthropicRequest, Usage } from './types.js';`）

`AppState` 接口加字段：

```ts
  /** 会话 -> 上一次请求的客户端 messages（轮次前缀比对用，上限 20 个会话 FIFO 淘汰） */
  turnCache: Map<string, Message[]>;
```

`buildState` 返回对象加 `turnCache: new Map(),`（applyConfigReload 是 `{ ...state, config, providers }` 展开，turnCache 跨热重载自动保留，无需改动）。

`/v1/messages` 中 `touchSession` 辅助函数之后加：

```ts
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
```

非流式路径（7a）：`const message = (await collectStreamToMessage(result.stream)) ...` 之后、`storage.writeBody(logId, 'response', message);` 之前加：

```ts
        const assistantText = ((message.content ?? []) as Array<Record<string, unknown>>)
          .filter((b) => b.type === 'text')
          .map((b) => (b.text as string) ?? '')
          .join('\n');
        recordTurn(assistantText);
```

流式路径（7b）：`const { clientStream, usage } = teeUsage(result.stream);` 改为：

```ts
      const { clientStream, usage, text } = teeUsage(result.stream);
      void Promise.all([usage, text])
        .then(([u, assistantText]) => {
          recordTurn(assistantText ?? '');
```

（其后 `storage.writeBody(logId, 'response', { streamed: true, usage: u });` 等既有内容保持不变，注意原代码是 `void usage.then((u) => {`，替换头部即可。）

catch 路径：`touchSession();` 之后加 `recordTurn('');`（prepare 后失败也留下用户轮次，assistantText 为空）。

- [ ] **Step 5: src/admin.ts 三个端点**

import 加：

```ts
import { readBody } from './storage/bodylog.js';
```

`app.post('/admin/api/sessions/:id/model', ...)` 之后追加：

```ts
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
```

- [ ] **Step 6: 写 test/viewer-api.test.ts（完整文件）**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

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

function startMock(reply: string): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody(reply));
      });
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
  });
}

const UID = 'user_account_session_view1';
const H = { 'x-api-key': 'sk-ok' };

async function setup() {
  const p1 = await startMock('这是AI的回答');
  const dir = mkdtempSync(join(tmpdir(), 'ai-router-view-'));
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
routing:
  rules:
    "*": [p1/m]
compact: { target: p1/m }
storage: { sqlitePath: ${join(dir, 'r.db').replace(/\\/g, '/')}, jsonlDir: ${join(dir, 'logs').replace(/\\/g, '/')} }
`,
    'utf8',
  );
  return createApp(join(dir, 'config.yaml'));
}

function chat(app: ReturnType<typeof createApp>, messages: Array<{ role: string; content: string }>) {
  return app.request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ok' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8,
      stream: true,
      metadata: { user_id: UID },
      messages,
    }),
  });
}

const t1 = [{ role: 'user', content: '第一个问题' }];
const t2 = [...t1, { role: 'assistant', content: '这是AI的回答' }, { role: 'user', content: '第二个问题' }];

describe('viewer api', () => {
  it('无 Key 401', async () => {
    const app = await setup();
    expect((await app.request('http://localhost/admin/api/sessions/session_view1/turns')).status).toBe(401);
    expect((await app.request('http://localhost/admin/api/search?q=x')).status).toBe(401);
    expect((await app.request('http://localhost/admin/api/requests/r1/body')).status).toBe(401);
  });

  it('两轮请求后 turns 按序返回，用户输入去重、AI 回复落库', async () => {
    const app = await setup();
    expect((await chat(app, t1)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect((await chat(app, t2)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));

    const res = await app.request('http://localhost/admin/api/sessions/session_view1/turns', { headers: H });
    expect(res.status).toBe(200);
    const { turns } = await res.json();
    expect(turns).toHaveLength(2);
    expect(turns[0].seq).toBe(1);
    expect(turns[0].userText).toBe('第一个问题');
    expect(turns[0].assistantText).toContain('这是AI的回答');
    expect(turns[1].seq).toBe(2);
    expect(turns[1].userText).toBe('第二个问题');
  });

  it('原始报文按 requestId 可取，未知 id 404', async () => {
    const app = await setup();
    expect((await chat(app, t1)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    const { turns } = await (
      await app.request('http://localhost/admin/api/sessions/session_view1/turns', { headers: H })
    ).json();
    const res = await app.request(`http://localhost/admin/api/requests/${turns[0].requestId}/body`, { headers: H });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request.model).toBe('claude-sonnet-4-6');
    expect((await app.request('http://localhost/admin/api/requests/nope/body', { headers: H })).status).toBe(404);
  });

  it('搜索命中并带 sessionTitle，缺 q 400', async () => {
    const app = await setup();
    expect((await chat(app, t1)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    const res = await app.request('http://localhost/admin/api/search?q=' + encodeURIComponent('第一个'), { headers: H });
    expect(res.status).toBe(200);
    const { hits } = await res.json();
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].sessionId).toBe('session_view1');
    expect(hits[0].sessionTitle).toBe('第一个问题');
    expect((await app.request('http://localhost/admin/api/search', { headers: H })).status).toBe(400);
  });

  it('未知会话 turns 404', async () => {
    const app = await setup();
    expect((await app.request('http://localhost/admin/api/sessions/session_ghost/turns', { headers: H })).status).toBe(404);
  });
});
```

- [ ] **Step 7: 全量验证**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Run: `node node_modules/vitest/vitest.mjs run`
Expected: 全部通过（含新增 5 个用例）；tsc 零错误。若 test/stream.test.ts 因 teeUsage 返回类型变化报错，按其断言补齐 `text` 字段（只读类型层面调整，不改既有断言语义）。

- [ ] **Step 8: Commit**

```bash
git add src/stream.ts src/storage src/server.ts src/admin.ts test/viewer-api.test.ts test/stream.test.ts
git -c user.name="kimi" -c user.email="kimi@local" commit -m "feat: 轮次接线 + turns/body/search 三个管理 API"
```

---

### Task 3: /admin 页面扩展（聊天视图 + 搜索视图）+ README

**Files:**
- Modify: `src/admin-page.ts`
- Modify: `README.md`
- Test: `test/admin-page-viewer.test.ts`

**Interfaces:**
- Consumes: Task 2 的三个 API；既有 `buildRow/it.sessionId/it.title`
- Produces: 页面函数 `openChat(sid, title)`、`showView(name)`、`doSearch()`（E2E 与静态测试依据）

- [ ] **Step 1: 写静态测试 test/admin-page-viewer.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { ADMIN_HTML } from '../src/admin-page.js';

describe('admin page viewer（静态结构）', () => {
  it('包含搜索框、聊天视图、结果视图容器', () => {
    expect(ADMIN_HTML).toContain('id="q"');
    expect(ADMIN_HTML).toContain('id="chat"');
    expect(ADMIN_HTML).toContain('id="results"');
  });

  it('包含聊天/搜索核心函数与原始报文入口', () => {
    expect(ADMIN_HTML).toContain('function openChat(');
    expect(ADMIN_HTML).toContain('function showView(');
    expect(ADMIN_HTML).toContain('function doSearch(');
    expect(ADMIN_HTML).toContain('原始报文');
  });

  it('对话数据渲染不拼 innerHTML（snippet/turn 均走 textContent）', () => {
    expect(ADMIN_HTML).not.toMatch(/innerHTML\s*=\s*[^'"<]/); // 只允许字面量赋值
    expect(ADMIN_HTML).toContain('textContent');
  });

  it('会话行有 💬 对话入口', () => {
    expect(ADMIN_HTML).toContain('💬');
    expect(ADMIN_HTML).toContain('openChat(');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/admin-page-viewer.test.ts`
Expected: FAIL（缺少容器/函数）

- [ ] **Step 3: 修改 src/admin-page.ts**

**3a. CSS：** `<style>` 内 `.tag { ... }` 行之后追加：

```css
  #searchbar { margin-bottom: 14px; }
  #searchbar input { width: 100%; max-width: 520px; padding: 8px; background: #1a1e26; color: #e6e6e6;
                     border: 1px solid #333a47; border-radius: 6px; }
  .back { color: #3b82f6; cursor: pointer; margin-bottom: 12px; display: inline-block; }
  .turn { margin-bottom: 14px; }
  .bubble { max-width: 78%; padding: 10px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
  .b-user { background: #1d3a5f; margin-left: auto; }
  .b-ai { background: #1a1e26; }
  .tmeta { color: #8b8f98; font-size: 12px; margin: 2px 0; }
  .rawbtn { color: #3b82f6; cursor: pointer; font-size: 12px; }
  .raw { background: #0a0c10; border: 1px solid #262a33; border-radius: 6px; padding: 10px;
         font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; word-break: break-all;
         max-height: 320px; overflow: auto; display: none; }
  .hit { background: #1a1e26; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; cursor: pointer; }
  .hit:hover { background: #232836; }
  .chatbtn { background: none; border: 1px solid #333a47; color: #e6e6e6; border-radius: 6px;
             padding: 4px 8px; cursor: pointer; }
  .hl { background: #3a3320; }
```

**3b. HTML：** `<div class="sub">...</div>` 行之后插入搜索框；`</table>` 之后插入两个视图容器：

```html
<div id="searchbar" style="display:none">
  <input id="q" type="search" placeholder="搜索对话内容，回车搜索" />
</div>
```

```html
<div id="chat" style="display:none;max-width:860px"></div>
<div id="results" style="display:none;max-width:860px"></div>
```

**3c. 表头：** `<th>切换模型</th>` 后加 `<th>对话</th>`；空态行 `colspan="6"` 改 `colspan="7"`。

**3d. JS 全局：** `let MODELS = [], THRESH = 0.85, timer = null;` 行改为：

```js
let MODELS = [], THRESH = 0.85, timer = null, VIEW = 'list';
```

**3e. buildRow：** `tr.appendChild(tdSwitch);` 之后、`return tr;` 之前加：

```js
  const tdChat = document.createElement('td');
  const chatBtn = document.createElement('button');
  chatBtn.className = 'chatbtn';
  chatBtn.textContent = '💬 对话';
  chatBtn.addEventListener('click', () => openChat(it.sessionId, it.title || '（无标题）'));
  tdChat.appendChild(chatBtn);
  tr.appendChild(tdChat);
```

**3f. load() 视图守卫：** `const rows = document.getElementById('rows');` 之前加：

```js
    if (VIEW !== 'list') return; // 聊天/搜索视图不被轮询打断
    document.getElementById('searchbar').style.display = 'block';
```

**3g. 视图函数：** `if (!KEY) showKey(''); else load();` 之前插入：

```js
function showView(name) {
  VIEW = name;
  document.getElementById('tbl').style.display = name === 'list' ? 'table' : 'none';
  document.getElementById('chat').style.display = name === 'chat' ? 'block' : 'none';
  document.getElementById('results').style.display = name === 'results' ? 'block' : 'none';
}

async function openChat(sid, title) {
  location.hash = '#chat=' + encodeURIComponent(sid);
  showView('chat');
  const box = document.getElementById('chat');
  box.textContent = '';
  const back = document.createElement('div');
  back.className = 'back';
  back.textContent = '← 返回会话列表';
  back.addEventListener('click', () => { location.hash = ''; showView('list'); load(); });
  const h = document.createElement('h1');
  h.textContent = title;
  const sidDiv = document.createElement('div');
  sidDiv.className = 'sub';
  sidDiv.textContent = sid;
  box.append(back, h, sidDiv);

  const data = await api('/admin/api/sessions/' + encodeURIComponent(sid) + '/turns');
  if (data.turns.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '该会话还没有轮次记录（功能上线前的历史不回填）。';
    box.appendChild(empty);
    return;
  }
  for (const t of data.turns) box.appendChild(buildTurn(t));
}

function buildTurn(t) {
  const wrap = document.createElement('div');
  wrap.className = 'turn';
  wrap.dataset.seq = String(t.seq);

  const um = document.createElement('div');
  um.className = 'tmeta';
  um.textContent = '用户 · ' + fmtTs(t.createdAt);
  const ub = document.createElement('div');
  ub.className = 'bubble b-user';
  ub.textContent = t.userText || '（空）';
  wrap.append(um, ub);

  const am = document.createElement('div');
  am.className = 'tmeta';
  am.textContent = 'AI';
  const ab = document.createElement('div');
  ab.className = 'bubble b-ai';
  ab.textContent = t.assistantText || '（无回复或请求失败）';
  wrap.append(am, ab);

  const rawBtn = document.createElement('span');
  rawBtn.className = 'rawbtn';
  rawBtn.textContent = '▸ 原始报文';
  const raw = document.createElement('pre');
  raw.className = 'raw';
  let loaded = false;
  rawBtn.addEventListener('click', async () => {
    if (!loaded) {
      loaded = true;
      const b = await api('/admin/api/requests/' + encodeURIComponent(t.requestId) + '/body');
      raw.textContent = JSON.stringify(b, null, 2);
    }
    const show = raw.style.display !== 'block';
    raw.style.display = show ? 'block' : 'none';
    rawBtn.textContent = (show ? '▾' : '▸') + ' 原始报文';
  });
  wrap.append(rawBtn, raw);
  return wrap;
}

async function doSearch() {
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  const data = await api('/admin/api/search?q=' + encodeURIComponent(q));
  location.hash = '';
  showView('results');
  const box = document.getElementById('results');
  box.textContent = '';
  const back = document.createElement('div');
  back.className = 'back';
  back.textContent = '← 返回会话列表';
  back.addEventListener('click', () => { showView('list'); load(); });
  const h = document.createElement('h1');
  h.textContent = '搜索：' + q;
  box.append(back, h);
  if (data.hits.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '没有命中。';
    box.appendChild(empty);
    return;
  }
  for (const hit of data.hits) {
    const div = document.createElement('div');
    div.className = 'hit';
    const title = document.createElement('div');
    title.textContent = (hit.sessionTitle || hit.sessionId) + ' · 第 ' + hit.seq + ' 轮';
    const snip = document.createElement('div');
    snip.className = 'muted';
    snip.textContent = hit.snippet; // FTS 高亮标记为纯文本【】，textContent 渲染无注入面
    const ts = document.createElement('div');
    ts.className = 'tmeta';
    ts.textContent = fmtTs(hit.createdAt);
    div.append(title, snip, ts);
    div.addEventListener('click', () => openChat(hit.sessionId, hit.sessionTitle || hit.sessionId));
    box.appendChild(div);
  }
}

document.getElementById('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});
```

**3h. 启动 hash 路由：** 文件末尾 `if (!KEY) showKey(''); else load();` 之后加：

```js
// 刷新保持聊天视图：#chat=<sessionId>
if (KEY && location.hash.startsWith('#chat=')) {
  const sid = decodeURIComponent(location.hash.slice(6));
  openChat(sid, sid);
}
```

- [ ] **Step 4: 全量验证**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 全部通过（含新增 4 个静态用例；既有 admin 用例不受影响——表头多一列不影响其断言）
Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: 零错误

- [ ] **Step 5: README 增补**

在「会话切换器（/admin）」一节末尾追加：

```markdown
### 对话回放与搜索

- 会话列表每行「💬 对话」进入聊天视图：按轮次展示用户输入与 AI 回复（自动去重——Claude Code 每次请求会重发全量历史，路由按最长公共前缀提取增量；压缩后自动兜底，轮次不丢）
- 每轮底部「原始报文」可展开该次请求/响应的完整 JSON（调试压缩、伪装问题时用）
- 页面顶部搜索框：SQLite FTS5 全文检索对话内容（中英文均可），命中按会话分组，点击跳转对应轮次；搜索后端为 `SearchBackend` 接口抽象（`search.backend` 配置），后续可切换 Elasticsearch 实现
- 轮次从功能上线后开始记录，历史 JSONL 不回填
```

- [ ] **Step 6: Commit**

```bash
git add src/admin-page.ts README.md test/admin-page-viewer.test.ts
git -c user.name="kimi" -c user.email="kimi@local" commit -m "feat: /admin 对话回放视图 + 全文搜索"
```

---

### Task 4: 端到端浏览器实测 + 终审（主代理执行，不派实现子代理）

**Files:** 无新增（实测脚本即用即删）

- [ ] **Step 1: 临时端口启动服务，同一会话连续发 3 轮请求（含一条含独特关键词的消息），另发一个不同项目的会话请求**
- [ ] **Step 2: InAppBrowser 打开 /admin：会话行出现 💬 按钮；进入聊天视图验证 3 轮按序、去重正确（用户输入不重复）；展开「原始报文」验证完整 JSON**
- [ ] **Step 3: 顶部搜索框输入独特关键词：命中并显示会话标题与轮次；点击跳转聊天视图**
- [ ] **Step 4: 验证既有功能未回归：会话钉模型切换仍工作（上一特性），全量测试与 tsc 零错误**
- [ ] **Step 5: 生成评审包并派终审子代理（diff 范围：本特性设计文档提交 a87ceb9 的父提交 0935829 .. HEAD）**

```bash
bash "D:/KimiData/daimon-share/daimon/runtime/kimi-code/home/plugins/managed/superpowers/skills/subagent-driven-development/scripts/review-package" 0935829 HEAD
```
