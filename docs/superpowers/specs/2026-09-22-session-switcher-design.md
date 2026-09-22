# 会话切换器（Session Switcher）设计

日期：2026-09-22　状态：已获用户批准　前置：multi-model 设计（2026-09-22-multi-model-design.md）

## 1. 目标与非目标

**目标**：在管理页上列出最近 5 个活跃 Claude 会话（首条用户消息作标题），点击即可把某个会话钉到指定「厂商/别名」ref；钉住后该会话优先走钉住模型，失败仍按原规则链 failover。切换到小窗口模型时由既有压缩管线自动摘要历史，不丢会话。

**非目标（本期不做）**：对话全文落库与回看、ES/MySQL 全文检索、多用户权限、链级别的整体切换。表结构与 API 预留扩展余地。

## 2. 数据层

`data/router.db` 新增 `sessions` 表：

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  project      TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  override_ref TEXT,                 -- NULL = 跟随规则
  last_tokens  INTEGER NOT NULL DEFAULT 0,  -- 最近请求压缩前 token 估算
  created_at   TEXT NOT NULL,
  last_seen    TEXT NOT NULL
);
```

存储层新增接口（实现在 `src/storage/sqlite.ts`，接口定义在 `src/storage/interface.ts`）：

```ts
export interface SessionInfo {
  sessionId: string; project: string; title: string;
  overrideRef: string | null; lastTokens: number;
  createdAt: string; lastSeen: string;
}
export interface SessionDirectory {
  /** 每次请求调用：首次见到记录 title/project，之后更新 lastSeen/lastTokens */
  touchSession(s: { sessionId: string; project: string; title: string; tokens: number }): void;
  setOverride(sessionId: string, ref: string | null): void;
  getOverride(sessionId: string): string | null;
  listRecent(limit: number): SessionInfo[];
}
```

`createStorage` 返回的存储对象上同时暴露 `sessions: SessionDirectory`。override 存 SQLite 而非 config.yaml：UI 即时生效、重启保留、配置文件保持只读语义。

## 3. 路由逻辑

请求流程（server.ts）在 `resolveProject` 之后、构造链之前插入：

1. `sessionId = extractSessionId(body)`（已有）；非空时：
   - `override = storage.sessions.getOverride(sessionId)`
   - 链构造：`override` 非空 → `[override, ...ruleRefs.filter(r => r !== override)]`；为空 → `ruleRefs`（现状）。
   - 优先级：**override > 粘性绑定 > 规则链**。override 存在时粘性绑定不前置（钉住 ref 已在链首）；`setOverride` 时同步把该会话的粘性绑定更新为 override（或清除绑定当 ref=null），避免旧绑定与覆盖打架。
2. `storage.sessions.touchSession(...)` 在 prepare（guardContext）完成之后调用，此时压缩前估算 `before` 已知：title 仅首次写入，lastSeen 与 lastTokens 每次更新；请求在 prepare 之前失败（如鉴权失败）则本次不更新。

ref 合法性：setOverride 前必须 `parseModelRef` + 校验 provider 存在且 alias 存在于该 provider 的 `models`，非法返回 400。

压缩语义不变：切换后首次请求按**新链首候选**的 `contextWindowFor(alias)` 判断，超过 `window × thresholdRatio` 自动走压缩管线（已实测）。

## 4. 标题提取规则

取 `messages` 中第一条 `role === 'user'` 的消息：content 为字符串取其本身；为数组则拼接其中 `type === 'text'` 块的 text。折叠连续空白为单空格、 trim、截断 200 字符。无 user 消息时 title 为 `'（无标题）'`。

## 5. 管理页与 API

页面：`GET /admin` 返回单页 HTML（内联 JS/CSS，Hono 直接渲染，无构建步骤）。页面本身不鉴权（不含数据）；所有数据 API 鉴权。页面首次打开提示输入一个 accessKey，存 localStorage，之后请求带 `x-api-key`。

API（均在 `src/server.ts` 或新 `src/admin.ts`，统一用 `extractApiKey` + accessKeys 校验，失败 401）：

- `GET /admin/api/sessions?limit=5`
  → `{ sessions: [{ sessionId, project, title, overrideRef, currentRef, lastTokens, lastSeen }] }`
  - `currentRef` = overrideRef ?? 粘性绑定 ref ?? null（null 显示「跟随规则」）
- `GET /admin/api/models`
  → `{ models: [{ ref, provider, alias, contextWindow }] }`（遍历 config.providers 的 models 生成，ref = `provider/alias`）
- `POST /admin/api/sessions/:id/model`，body `{ "ref": "volcengine/glm-5.3" }` 或 `{ "ref": null }`
  → 200 `{ ok: true }`；ref 非法 400；会话不存在 404

页面行为：

- 表格列出最近 5 个会话：标题 / 项目 / 当前模型 / 最近 token 量 / 活跃时间 / 操作下拉框
- 下拉框选项 = 「跟随规则」+ 全部已配置 ref（标注窗口，如 `kimi/k3-1m · 1M`）
- `lastTokens > 目标 contextWindow × thresholdRatio` 的选项旁显示 ⚠️「切换后将压缩历史」
- 切换成功后即时刷新行内「当前模型」

## 6. 测试

- 单测：链构造优先级（override > 粘性 > 规则）、title 提取（字符串/数组/空）、SessionDirectory CRUD、setOverride 的 ref 校验。
- 集成：三个 API 的鉴权（无 Key 401）、切换后 `/v1/messages` 请求确实以钉住 ref 为链首（mock provider 断言收到的模型别名）、`ref: null` 恢复跟随规则。
- 回归：既有 103 测试全绿；`tsc --noEmit` 零错误。
- 端到端实测：启动服务 → 浏览器打开 /admin → 发两条不同会话的请求 → 页面出现两个会话（标题正确）→ 给其中一个切模型 → 再发请求，日志 upstream_model 变为新模型。

## 7. 任务拆分

- S1：数据层（sessions 表 + SessionDirectory + touchSession 接线 + 单测）
- S2：路由覆盖逻辑（链构造优先级 + setOverride 校验 + 粘性同步 + 单测/集成）
- S3：管理 API + 页面（/admin 单页 + 三个 API + 集成测试 + README）
- S4：端到端浏览器实测 + 终审
