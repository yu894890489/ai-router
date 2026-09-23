# 对话回放与检索（Conversation Viewer）设计

日期：2026-09-23　状态：已获用户批准　前置：session-switcher 设计（2026-09-22-session-switcher-design.md）

## 1. 目标与非目标

**目标**：把已落盘的完整请求/响应报文（`data/logs/<项目>/<日期>.jsonl`）变成可用的对话回放——/admin 页面按会话展示去重后的聊天流（用户/AI 气泡），每轮可展开原始报文调试；SQLite FTS5 全文检索对话内容；搜索后端抽象化，预留 ES 切换能力。

**非目标（本期不做）**：对话编辑/导出、ES 实现本身、历史 JSONL 数据回填、多用户权限。

## 2. 轮次提取与存储

Claude Code 每次请求重发全量历史，需在请求完成时增量提取「轮次」：

**提取算法**（新模块 `src/pipeline/turns.ts`）：
- `extractUserTurn(prevMessages, currMessages)`：两数组做最长公共前缀比对（逐条比较 role+content 序列化值），`currMessages` 前缀之后的 user 消息文本拼接 = 本轮用户输入。
- `prevMessages` 取自该会话**上一次请求的 messages**（从 JSONL 读，或内存缓存——见下）。
- 前缀比对失败兜底（压缩摘要把历史改写了：上一次请求 messages 不是本次的前缀）：退化为取 `currMessages` 最后一条 user 消息。
- `assistant_text` = 本次响应的全部 text 块拼接（非流式取聚合 message；流式取 teeUsage 旁路已收集的内容——若流式拿不到文本则退化为空串 + 仅存 user_text，实现时以 stream.ts 实际能力为准并在报告说明）。

**prevMessages 来源**：内存 `Map<sessionId, Message[]>`（请求结束缓存本次 messages），进程重启后首条请求无前缀 → 退化规则兜底（视为新会话首轮）。不为此前读 JSONL（复杂且收益小）。

**新表**（`src/storage/sqlite.ts` DDL 追加）：

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
-- FTS5（已实测 node:sqlite 内置可用）；CJK 分词器实现时选定（unicode61 已验证可 MATCH，trigram 更佳则用之）
-- 用外部内容模式（content='turns'），rowid 与 turns.rowid 对齐；snippet() 高亮依赖表内容，不能用 contentless
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(user_text, assistant_text, content='turns', content_rowid='rowid');
```

`turns_fts` 用外部内容模式，索引行 rowid 与 `turns.rowid` 对齐（插入时同时写两表），搜索命中后按 rowid 回表取行。

## 3. 搜索后端抽象（可切 ES）

`src/storage/search.ts`：

```ts
export interface Turn {
  id: string; sessionId: string; requestId: string; seq: number;
  userText: string; assistantText: string; createdAt: string;
}
export interface SearchHit {
  sessionId: string; requestId: string; seq: number;
  snippet: string;        -- 命中片段（FTS5 snippet() 或 LIKE 截断）
  createdAt: string;
}
export interface SearchBackend {
  indexTurn(t: Turn): void;
  search(query: string, filter?: { project?: string; sessionId?: string; limit?: number }): SearchHit[];
}
```

- 本期实现 `createSqliteFtsBackend(db)`；FTS5 探测失败自动降级 `createLikeBackend(db)`（`LIKE '%q%'`，接口相同）。
- 配置：`search: { backend: 'fts' }`（zod schema，默认 fts；`es` 值为预留，配了报「未实现」启动错误）。
- 将来 `EsBackend` 实现同一接口，业务代码零改动。
- 索引/搜索失败走 safe 旁路，不阻断转发。

`SessionDirectory` 不动；`LogStorage` 新增 `turns: { addTurn(t: Turn): void; listTurns(sessionId: string): Turn[]; search: SearchBackend }`（search 暴露 backend 便于 admin 层调用）。

## 4. API（/admin/api/*，沿用 accessKeys 鉴权中间件）

| 端点 | 响应 |
|---|---|
| `GET /admin/api/sessions/:id/turns` | `{ turns: [{ seq, userText, assistantText, requestId, createdAt }] }`（按 seq 升序；未知会话 404） |
| `GET /admin/api/requests/:id/body` | `{ request: <原始报文>, response: <原始报文|null> }`；从 requests 表取 project+created_at 定位 `jsonlDir/<sanitizeProject(project)>/<date>.jsonl`，扫文件按 id 匹配 kind；找不到 404 |
| `GET /admin/api/search?q=..&project=..&sessionId=..` | `{ hits: [{ sessionId, sessionTitle, seq, snippet, createdAt }] }`（sessionTitle 联表 sessions.title；q 为空 400） |

## 5. 页面（并入 /admin 单页，`src/admin-page.ts` 扩展）

- 会话列表每行「切换模型」旁加 **💬 对话** 按钮 → 进入聊天视图（页面内视图切换，URL 加 `#chat=<sessionId>` 便于刷新保持）。
- 聊天视图：顶部返回链接 + 会话标题；气泡按轮次（用户右/AI 左，或上下分栏卡片）；每轮底部「原始报文」折叠区 → 点击懒加载 `GET .../requests/:id/body`，`<pre>` 展示 JSON。
- 页面顶部搜索框（所有视图可见）：输入回车 → 搜索结果视图，按会话分组列出 snippet + 时间，点击跳转 `#chat=<sessionId>` 并高亮对应 seq 的轮次。
- 延续约束：DOM API + textContent 渲染，禁 innerHTML 拼接用户数据；snippet 可能含 FTS 高亮标记（如 `<mark>`），只允许白名单标签或纯文本截断（实现时二选一并在报告说明）。

## 6. 接线点（server.ts）

请求完成处（与 touchSession 同位置，成功/失败两条路径）：`extractUserTurn` + 拼 assistant_text → `storage.turns.addTurn(...)`（seq = 该会话 turns 数 + 1，由 SQL COUNT 或 `SELECT COALESCE(MAX(seq),0)+1` 得出）。鉴权失败等 prepare 前失败不提取。

## 7. 测试

- 单测：前缀去重（正常增量/首轮/压缩打断兜底/多 user 消息拼接）、FTS 搜索（中英文、filter、snippet）、LIKE 降级、JSONL body 读取（kind 匹配/缺失）。
- 集成：三 API 鉴权与语义（404/400）、搜索联表 title、turns 与 requests 关联。
- E2E（主代理）：真实浏览器 发对话 → 💬 聊天流 → 展开原始报文 → 搜索定位。

## 8. 任务拆分

- V1：turns 表 + 提取算法 + SearchBackend（FTS/LIKE）+ 单测
- V2：server 接线 + 三个 API + JSONL body 读取 + 集成测试
- V3：页面（聊天视图 + 搜索视图 + 会话列表入口）+ README
- V4：E2E 浏览器实测 + 终审（主代理）
