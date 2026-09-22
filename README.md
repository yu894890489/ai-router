# ai-router

Claude Code 的本地代理后端：多厂商自动切换、上下文自动压缩、请求伪装、按项目记录日志。

## 快速开始

```bash
npm install
cp config.example.yaml config.yaml   # 编辑填入三家厂商的 API Key
npm run dev
```

Claude Code 接入（在每个项目目录的 shell 或 `~/.claude/settings.json` 的 `env` 中设置）:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3456",
    "ANTHROPIC_AUTH_TOKEN": "sk-router-homepage"
  }
}
```

`ANTHROPIC_AUTH_TOKEN` 填 `config.yaml` 里 `accessKeys` 的 Key；Key 决定日志归到哪个项目。
值为 `null` 的 Key 会从 system prompt 的工作目录自动推断项目名。

## 核心行为

- **多模型 + 场景路由**：每家厂商在 `providers.<厂商>.models` 下配置多个模型别名（`别名 -> { upstream, contextWindow }`）；`routing.rules` 按 Claude Code 发来的模型名（精确匹配，`"*"` 兜底）选择候选链，链元素为 `厂商/别名` ref。failover 沿链按序尝试；网络错误/超时/5xx/429 切下一个；401/403 封禁该 ref；session 粘性 5 分钟（绑定到 ref）；同一 ref 连续失败 3 次熔断 60 秒。别名 → 上游模型名的映射只发生在 Provider 内部。
- **上下文压缩**：上下文超过目标模型窗口 × 0.85 时，保留 system 与最近 6 轮，中段切分后由压缩模型总结为 `<context-summary>` 注入。压缩模型首选 `compact.target`（`厂商/别名` ref），失败时用当前转发目标兜底。
- **伪装**：转发时携带 Claude Code 客户端特征（user-agent、`x-app: cli`、system 首块、metadata.user_id）。
- **日志**：结构化记录在 `data/router.db`（SQLite，表 `requests`）；完整请求/响应体在 `data/logs/<项目>/<日期>.jsonl`。

## 配置（v2）

```yaml
providers:
  kimi:
    baseUrl: https://api.moonshot.cn/anthropic
    apiKey: sk-your-moonshot-key
    authHeader: bearer
    userAgent: claude-cli/2.0.14 (external, cli)
    models:   # 本地别名 -> 上游真实模型名 + 上下文窗口
      k3-1m:           { upstream: "kimi-k3[1m]", contextWindow: 1000000 }
      k3:              { upstream: kimi-k3, contextWindow: 256000 }
      kimi-for-coding: { upstream: kimi-for-coding, contextWindow: 256000 }
  volcengine:
    baseUrl: https://ark.cn-beijing.volces.com/api/coding
    apiKey: your-ark-coding-plan-key
    authHeader: bearer
    userAgent: claude-cli/2.0.14 (external, cli)
    models:
      glm-5.3:       { upstream: glm-5.3, contextWindow: 256000 }
      glm-5.3-flash: { upstream: glm-5.3-flash, contextWindow: 256000 }
  bailian:
    baseUrl: https://coding.dashscope.aliyuncs.com/apps/anthropic
    apiKey: sk-your-dashscope-coding-plan-key
    authHeader: bearer
    userAgent: claude-cli/2.0.14 (external, cli)
    models:
      glm-5: { upstream: glm-5, contextWindow: 256000 }

routing:
  # key = Claude Code 发来的模型名（精确匹配，"*" 为必填兜底）
  # 链元素为 "厂商/模型别名" ref，按序 failover；所有 ref 必须指向已定义的厂商与别名
  rules:
    claude-opus-4-6:   [kimi/k3-1m, volcengine/glm-5.3, bailian/glm-5]
    claude-sonnet-4-6: [kimi/kimi-for-coding, volcengine/glm-5.3, bailian/glm-5]
    claude-haiku-4-5:  [volcengine/glm-5.3-flash, bailian/glm-5]
    "*":               [kimi/kimi-for-coding, volcengine/glm-5.3, bailian/glm-5]

compact:
  target: bailian/glm-5    # 压缩总结首选（"厂商/别名" ref）
  fallbackToTarget: true   # 首选失败时用当前转发目标兜底
```

完整可复制的样例见 `config.example.yaml`。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动服务（`tsx src/server.ts ./config.yaml`） |
| `npm test` | 全部单元 + 集成测试（不打真实厂商） |
| `npm run typecheck` | TS 类型检查 |
| `npm run smoke` | 对运行中的服务发真实请求（需 SMOKE_API_KEY） |

## 厂商端点（2026-09 核实，改模型名前查厂商文档）

| 厂商 | baseUrl | 窗口 |
|---|---|---|
| 阿里百炼 Coding Plan | `https://coding.dashscope.aliyuncs.com/apps/anthropic` | 1M（模型名带 `[1m]` 后缀） |
| Kimi / Moonshot | `https://api.moonshot.cn/anthropic` | 256K |
| 火山方舟 Coding Plan | `https://ark.cn-beijing.volces.com/api/coding` | 256K |

注意：火山务必用 `/api/coding`，`/api/v3` 会走按量计费而非 Coding Plan 额度。
