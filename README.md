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

- **failover**：按 `routing.default` 顺序尝试；网络错误/超时/5xx/429 切下一家；401/403 封禁该厂商；session 粘性 5 分钟；连续失败 3 次熔断 60 秒。
- **上下文压缩**：上下文超过目标厂商窗口 × 0.85 时，保留 system 与最近 6 轮，中段切分后由压缩模型总结为 `<context-summary>` 注入。压缩模型首选 `compact.provider/model`，失败时目标厂商兜底。
- **伪装**：转发时携带 Claude Code 客户端特征（user-agent、`x-app: cli`、system 首块、metadata.user_id）。
- **日志**：结构化记录在 `data/router.db`（SQLite，表 `requests`）；完整请求/响应体在 `data/logs/<项目>/<日期>.jsonl`。

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
