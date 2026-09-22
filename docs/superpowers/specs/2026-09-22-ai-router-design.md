# AI Router 设计文档

日期：2026-09-22
状态：已确认（用户逐节审批通过）

## 1. 项目定位

AI Router 是一个本地常驻的 **Claude Code 代理后端**（Node.js 24 + TypeScript + Hono）。Claude Code 通过 `ANTHROPIC_BASE_URL` 指向它，它再将请求转发到多家模型厂商。四大核心功能：

1. **上下文自动压缩**：维护模型窗口规格表，任何「目标窗口 < 当前上下文长度」的切换（含 1M ↔ 256K、单厂商长会话自然超限）都自动触发压缩——切分历史上下文、AI 总结、重组后放入请求
2. **请求伪装**：转发时复刻 Claude Code 官方客户端的请求特征（headers、system prompt 开头、metadata），让厂商认为这是 Claude Code 官方流量
3. **多厂商自动切换**：初期接入 Kimi（Moonshot）、火山引擎 Coding Plan、阿里云百炼 Coding Plan；按优先级链 failover，session 粘性 + TTL 回探 + 熔断
4. **请求日志**：每次请求记录结构化日志，按项目/文件夹维度区分；一期 SQLite + JSONL，存储走抽象接口，二期换 MySQL + ES 并开发类 AI Chat 的对话查看页面（二期不在本设计范围内）

## 2. 关键需求决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 使用形态 | Claude Code 代理后端（Anthropic 协议端点） |
| 技术栈 | Node.js + TypeScript（Hono 框架），自研轻量代理 |
| 压缩触发 | 通用窗口规格表：目标窗口 W，上下文 token 数 T > W × 0.85（可配）即触发 |
| 压缩模型 | 配置的固定小模型优先（如 Haiku 级），失败时兜底用目标厂商的小模型 |
| 伪装理解 | 复刻 Claude Code 请求特征过厂商客户端检测；含模型名映射 |
| 初期厂商 | Kimi / Moonshot、火山引擎 Coding Plan、阿里云百炼 Coding Plan |
| 一期日志存储 | SQLite（结构化记录）+ JSONL（完整请求/响应体），Storage 抽象接口 |
| 项目归属 | 虚拟 Key 映射为主 + 从请求内容（system prompt 环境信息）解析工作目录兜底，均失败归 `_default` |
| failover 触发 | 可配置规则；默认：网络错误/超时、5xx、429 切下一家；401/403 标记不可用并告警；上下文溢出向上切换更大窗口模型 |
| failover 粘性 | session 粘性（TTL 默认 5 分钟）+ 熔断（连续失败 3 次熔断 60 秒） |
| failover 时机约束 | 仅发生在响应第一个字节流出之前；已开始流式输出后断流只能报错 |

## 3. 总体架构与模块划分

```
ai-router/  (Node.js 24 + TypeScript + Hono)
├── src/
│   ├── server.ts            # Hono 入口，监听端口，挂载 Anthropic 兼容端点
│   ├── pipeline/            # 请求管道（中间件链，每层单一职责）
│   │   ├── auth.ts          # 接入 Key 校验 + 项目归属（虚拟 Key 映射）
│   │   ├── context-guard.ts # 上下文窗口检查，触发压缩
│   │   ├── router.ts        # 厂商选择 + failover 调度
│   │   └── spoof.ts         # 伪装转换器：重写 headers/system 特征
│   ├── providers/           # 厂商适配层（每家一个文件，统一接口）
│   │   ├── base.ts          # Provider 接口：chat() / chatStream() / healthCheck()
│   │   ├── kimi.ts          # Moonshot Anthropic 兼容端点
│   │   ├── volcengine.ts    # 火山引擎 Coding Plan
│   │   └── bailian.ts       # 阿里云百炼 Coding Plan
│   ├── compact/             # 上下文压缩模块
│   │   ├── tokenizer.ts     # token 计数
│   │   └── compactor.ts     # 切分 → AI 总结 → 重组上下文
│   ├── session/             # 会话状态：session 粘性的厂商绑定、压缩历史
│   ├── storage/             # 存储抽象层
│   │   ├── interface.ts     # LogStorage 接口（二期换 MySQL/ES 只动这里）
│   │   ├── sqlite.ts        # 一期实现：结构化日志
│   │   └── jsonl.ts         # 一期实现：完整请求/响应体落盘
│   └── config.ts            # 配置文件加载与校验（Zod schema）
├── config.example.yaml      # 厂商、Key、窗口规格表、路由策略
└── test/                    # vitest，按模块镜像组织
```

关键边界：Provider 适配层屏蔽厂商差异；Storage 接口让二期 MySQL/ES 成为纯新增实现；管道中间件各自独立可单测；配置文件（YAML，Zod 校验，支持热重载）是唯一外部状态来源。

## 4. 核心机制

### 4.1 上下文压缩（context-guard + compact）

触发条件：目标模型窗口 W，当前上下文 token 数 T，`T > W × 0.85`（阈值可配）。

压缩流程：

1. **保护头部**：system prompt（含 Claude Code 工具定义）原样保留，绝不压缩
2. **保护尾部**：最近 N 轮对话（默认 6 轮，可配；1 轮 = 一条 user 消息 + 其对应的 assistant 回复，含其中的 tool_use/tool_result 块）原样保留
3. **中间段切分**：剩余历史消息按 token 数切成若干 chunk（每 chunk ≤ 压缩模型安全窗口）
4. **AI 总结**：每个 chunk 发给压缩模型，固定 prompt 模板要求保留：已完成的操作、关键文件路径、重要决策、未解决的 TODO
5. **重组**：`system + [压缩摘要块] + 最近 N 轮`；摘要块用 `<context-summary>` 边界标记包裹，附注此前轮次已压缩
6. **校验**：重组后再数 token，仍超限则递归压缩最近 N 轮之外的部分；压缩模型全部失败则返回明确错误，不静默丢上下文

压缩事件写入日志（原 token 数、压缩后 token 数、压缩模型），供二期页面回放。

### 4.2 请求伪装（spoof 转换器）

每家厂商一个 spoof profile（声明式配置 + 少量代码），转发前变换：

- **Headers**：`User-Agent: claude-cli/x.y.z`、`x-app: cli`、`anthropic-version`；去除暴露第三方的 header；按各厂要求设置鉴权头
- **Body**：确保 system prompt 第一段为 Claude Code 标准开头；`metadata.user_id` 等字段按 Claude Code 格式补齐
- **模型名映射**：配置表维护 `claude-* → kimi-* / doubao-* / qwen3-coder-*` 映射，请求时翻译成厂商实际模型 ID，响应翻译回来

新接一家厂商 = 一个 provider 文件 + 一段配置。

### 4.3 厂商切换 / failover

- **优先级列表**：配置里按场景定义有序厂商链（如 `default: [kimi, volcengine, bailian]`）
- **触发规则**（可配置，默认）：
  - 网络错误 / 超时、5xx、429 → 切下一家
  - 401 / 403 → 标记该厂商不可用并告警（Key 问题，不盲切）
  - 上下文溢出 → 向上切换更大窗口模型链，而非平移下一家
- **Session 粘性**：以 `metadata.user_id` 中 session id 为键，failover 后该 session 绑定新厂商；绑定带 TTL（默认 5 分钟），过期后从优先级最高的厂商重新开始
- **熔断**：单厂商连续失败 3 次进入熔断（默认 60 秒），期间直接跳过
- **时机约束**：failover 仅发生在响应第一个字节流出之前

### 4.4 项目归属与日志

- **归属判定**：接入 Key 命中 → 项目标签；默认 Key → 从 system prompt 环境信息解析工作目录；均失败 → `_default`
- **日志结构**：每次请求一条结构化记录——时间戳、项目标签、session id、目标厂商/模型、输入/输出 token 数、耗时、是否触发压缩、是否发生 failover、最终状态；完整请求/响应体（脱敏后）落 JSONL，按 `项目/日期.jsonl` 组织
- **二期衔接**：SQLite 表结构按查看页面查询需求设计（项目、session、时间索引），MySQL schema 平移，ES 仅做全文检索增量
- **旁路原则**：存储写入失败降级为 stderr 警告，不阻断请求转发

## 5. 数据流

```
Claude Code POST /v1/messages (SSE stream)
  │
  ├─ 1. auth        校验接入 Key → 确定项目标签 → 生成 request id
  ├─ 2. 日志开始     写入请求记录（状态=pending）
  ├─ 3. router      查 session 粘性绑定 → 否则按优先级选第一家可用厂商
  │                  └─ 解析目标模型 → 查窗口规格表得 W
  ├─ 4. context-guard  数 token，T > W×0.85 → compact 压缩 → 重组 body
  ├─ 5. spoof       按目标厂商 profile 变换 headers/body/模型名
  ├─ 6. provider    发起 SSE 流式请求，边收边透传给 Claude Code
  │                  ├─ 未流出任何内容时失败 → 触发 failover
  │                  ├─ 已流出内容后断流 → 报错，不换厂商重发
  │                  └─ 成功 → 从流尾提取 usage（token 数）
  └─ 7. 日志完成     更新记录：token 数、耗时、压缩/failover 标记、最终状态
```

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| 所有厂商都不可用 | 返回标准 Anthropic 错误格式（`overloaded_error`），Claude Code 原生展示 |
| 压缩模型全部失败 | 返回明确错误并注明原因，不静默截断上下文 |
| 配置文件非法 | 启动时 Zod 校验，指出具体字段，拒绝启动（fail fast） |
| 存储写入失败 | 降级为 stderr 警告，不阻断主链路 |
| 厂商返回非标准响应 | provider 适配层兜底包装成标准错误，原始响应摘要进日志 |

## 7. 测试策略（vitest）

- **单元测试**：token 计数精度；压缩切分与重组正确性（mock 压缩模型）；spoof 变换前后 header/body 快照；failover 状态机（粘性、TTL、熔断）；项目归属解析
- **契约测试**：每个 provider 一个人工脱敏的真实响应 fixture，验证适配层解析不漂移
- **集成测试**：内存 Hono 实例 + mock 厂商服务器，端到端跑正常转发、触发压缩、failover 链路、日志落盘
- **不做**：不打真实厂商 API（手动冒烟脚本，不进 CI）；不测框架本身

## 8. 范围外（二期，另行设计）

- 类 AI Chat 的对话记录查看页面
- MySQL + Elasticsearch 存储后端（通过 Storage 接口新增实现接入）
