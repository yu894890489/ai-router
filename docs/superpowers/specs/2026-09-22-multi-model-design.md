# 多模型 + 场景路由改造设计（config v2）

日期：2026-09-22
状态：用户已确认

## 背景

config v1 每家厂商只有 `contextWindow + modelMap`（实际只能用一个模型）。用户需要同厂商多模型按场景使用：

- kimi：k3-1m（1M）、k3（256K）、kimi-for-coding（256K）
- volcengine：glm-5.3、glm-5.3-flash
- bailian：glm-5（256K），压缩工作优先用它

## 配置形态（v2）

```yaml
providers:
  kimi:
    baseUrl: https://api.moonshot.cn/anthropic
    apiKey: ...
    authHeader: bearer
    userAgent: claude-cli/2.0.14 (external, cli)
    models:
      k3-1m:           { upstream: kimi-k3[1m], contextWindow: 1000000 }
      k3:              { upstream: kimi-k3,     contextWindow: 262144 }
      kimi-for-coding: { upstream: kimi-for-coding, contextWindow: 262144 }

routing:
  rules:    # key = Claude Code 发来的模型名，"*" 兜底；链元素为 厂商/模型别名
    claude-opus-4-6:   [kimi/k3-1m, volcengine/glm-5.3, bailian/glm-5]
    claude-sonnet-4-6: [kimi/kimi-for-coding, volcengine/glm-5.3, bailian/glm-5]
    claude-haiku-4-5:  [volcengine/glm-5.3-flash, bailian/glm-5]
    "*":               [kimi/kimi-for-coding, volcengine/glm-5.3, bailian/glm-5]

compact:
  target: bailian/glm-5      # 压缩首选
  fallbackToTarget: true     # 失败用当前转发目标兜底
```

## 接口契约（v2）

### config.ts
- provider schema：`models: Record<alias, { upstream: string; contextWindow: number }>`（非空，沿用 refine），删除 `contextWindow`、`modelMap`
- `routing: { rules: Record<string, string[]（非空）> }`，必须含 `"*"` 键
- `compact`：`target: string`（厂商/别名 ref），删除 `provider`/`model`
- 导出 `parseModelRef(ref: string): { provider: string; alias: string }`（按第一个 `/` 切分；无 `/` 抛错）
- loadConfig 校验：rules 每条链的每个 ref、compact.target 都必须指向已定义的 厂商/别名
- 导出类型 `ModelEntry = { upstream: string; contextWindow: number }`

### providers/base.ts（契约变更）
- `Provider` 接口：
  - `resolveModel(alias: string): string` — 别名 → 上游模型名；未知别名抛 `ProviderError`（retriable: false）
  - `contextWindowFor(alias: string): number` — 未知别名抛 `ProviderError`（retriable: false）
  - `send(body, timeoutMs)` / `sendSync(body, timeoutMs)` — **body.model 传别名，两者都在内部完成别名→上游名映射**（sendSync 契约变更：v1 不映射，v2 统一映射，调用方永远传别名）
  - 删除 `contextWindow` 属性
- `SendResult.upstreamModel` = 映射后的上游模型名（供日志）

### pipeline/router.ts
- 链元素 = ref 字符串 `厂商/别名`
- `interface Candidate { provider: Provider; alias: string; ref: string }`
- `selectChain(chain: string[](refs), breaker, sessions, sessionId): string[]` — 熔断/粘性键均为 ref
- `executeWithFailover(candidates: Candidate[], prepare: (c: Candidate) => Promise<AnthropicRequest>, timeoutMs, breaker, sessions, sessionId)` — prepare 内 `body.model = c.alias`；成功绑定 session 到 c.ref

### compact/summarizer.ts
- `buildSummarizer(config, providers, target: Candidate): Summarizer`
- 首选：`compact.target` 解析出的 厂商+别名（sendSync 传别名，内部映射）
- 兜底：target.provider + target.alias

### session/store.ts
- CircuitBreaker 键改为 ref（`kimi/k3-1m`）；新增 `unbanPrefix(prefix: string): void`（解封某厂商全部 ref，如 `unbanPrefix('kimi/')`），供热重载换 Key 时调用
- `unban(name)` 保留（单 ref 解封）

### server.ts
- `const chainRefs = config.routing.rules[body.model] ?? config.routing.rules['*']`
- refs → Candidate（providers.get + parseModelRef）
- prepare：`guardContext(body, c.provider.contextWindowFor(c.alias), config.compact, summarizer)` → `applySpoof(guarded.req, c.alias)`
- 日志 `upstreamModel` 用 `result.upstreamModel`
- 热重载：`diffUnbanTargets`（apiKey 变化的厂商）→ 对每个厂商调 `breaker.unbanPrefix(provider + '/')`

## 不变的约束

- failover 只在 send 返回前；压缩失败显式报错；存储旁路；模型别名→上游名的映射唯一发生在 Provider 内部
- 现有全部测试随接口变更同步更新（config/providers/router/server/integration）

## 用户 config.yaml 迁移

保留三家厂商真实 Key 不变，按用户场景填入模型：
- kimi：k3-1m（1M，upstream 暂写 `kimi-k3[1m]`，注释提示以厂商文档确认为准）、k3、kimi-for-coding
- volcengine：glm-5.3、glm-5.3-flash
- bailian：glm-5
- rules：opus→[kimi/k3-1m, volcengine/glm-5.3, bailian/glm-5]；sonnet/`*`→[kimi/kimi-for-coding, volcengine/glm-5.3, bailian/glm-5]；haiku→[volcengine/glm-5.3-flash, bailian/glm-5]
- compact.target: bailian/glm-5
