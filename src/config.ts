import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';

const modelEntrySchema = z.object({
  upstream: z.string().min(1),
  contextWindow: z.number().int().positive(),
});

const providerSchema = z.object({
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  authHeader: z.enum(['x-api-key', 'bearer']),
  userAgent: z.string().min(1),
  extraHeaders: z.record(z.string(), z.string()).default({}),
  models: z
    .record(z.string(), modelEntrySchema)
    .refine((m) => Object.keys(m).length > 0, { message: 'models 至少需要一个模型别名' }),
});

const configSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      // 允许 0：Node listen(0) 表示随机空闲端口（测试/临时实例用）
      port: z.number().int().min(0).default(3456),
    })
    .default({ host: '127.0.0.1', port: 3456 }),
  accessKeys: z.record(z.string(), z.string().nullable()),
  providers: z.record(z.string(), providerSchema),
  routing: z.object({
    rules: z.record(z.string(), z.array(z.string().min(1)).min(1)),
  }),
  compact: z.object({
    thresholdRatio: z.number().min(0.1).max(1).default(0.85),
    targetRatio: z.number().min(0.1).max(1).default(0.7),
    keepRecentTurns: z.number().int().min(1).default(6),
    chunkTokens: z.number().int().positive().default(40000),
    target: z.string().min(1),
    fallbackToTarget: z.boolean().default(true),
    timeoutMs: z.number().int().positive().default(180000), // 总结专用，独立于转发超时（40k token 非流式总结 60s 不够）
    concurrency: z.number().int().min(1).max(8).default(2), // 分块总结并行度
  }),
  failover: z
    .object({
      stickyTtlSeconds: z.number().int().positive().default(300),
      failureThreshold: z.number().int().positive().default(3),
      cooldownSeconds: z.number().int().positive().default(60),
      requestTimeoutMs: z.number().int().positive().default(60000),
    })
    .default({
      stickyTtlSeconds: 300,
      failureThreshold: 3,
      cooldownSeconds: 60,
      requestTimeoutMs: 60000,
    }),
  storage: z
    .object({
      sqlitePath: z.string().default('./data/router.db'),
      jsonlDir: z.string().default('./data/logs'),
    })
    .default({ sqlitePath: './data/router.db', jsonlDir: './data/logs' }),
  search: z
    .object({ backend: z.enum(['fts', 'es']).default('fts') })
    .default({ backend: 'fts' }),
});

export type RouterConfig = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type CompactConfig = RouterConfig['compact'];
export type StorageConfig = RouterConfig['storage'];

/** 把 "厂商/模型别名" ref 按第一个 / 切分。无 /、provider 或 alias 为空时抛错。 */
export function parseModelRef(ref: string): { provider: string; alias: string } {
  const idx = ref.indexOf('/');
  if (idx === -1) {
    throw new Error(`模型 ref 缺少 "/"，应为 "厂商/别名" 格式: "${ref}"`);
  }
  const provider = ref.slice(0, idx);
  const alias = ref.slice(idx + 1);
  if (!provider) {
    throw new Error(`模型 ref 的 provider 为空: "${ref}"`);
  }
  if (!alias) {
    throw new Error(`模型 ref 的 alias 为空: "${ref}"`);
  }
  return { provider, alias };
}

export function loadConfig(path: string): RouterConfig {
  const raw = YAML.parse(readFileSync(path, 'utf8'));
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`配置文件非法 (${path}):\n${issues}`);
  }
  const cfg = result.data;

  if (cfg.search.backend === 'es') {
    throw new Error('search.backend = "es" 尚未实现，请使用 "fts"');
  }

  if (!('*' in cfg.routing.rules)) {
    throw new Error('routing.rules 缺少 "*" 兜底规则');
  }

  const checkRef = (ref: string, where: string) => {
    let provider: string;
    let alias: string;
    try {
      ({ provider, alias } = parseModelRef(ref));
    } catch (e) {
      // 格式错误时补充出处（哪条 rule 或 compact.target）再抛出
      throw new Error(`${where} 的模型 ref 非法: ${(e as Error).message}`);
    }
    // 用 Object.hasOwn 防原型链键（如 constructor、toString）被误认为已定义
    if (!Object.hasOwn(cfg.providers, provider)) {
      throw new Error(`${where} 引用了未定义的厂商: "${ref}"`);
    }
    if (!Object.hasOwn(cfg.providers[provider]!.models, alias)) {
      throw new Error(`${where} 引用了厂商 "${provider}" 下未定义的模型别名: "${ref}"`);
    }
  };

  for (const [scene, chain] of Object.entries(cfg.routing.rules)) {
    for (const ref of chain) {
      checkRef(ref, `routing.rules["${scene}"]`);
    }
  }
  checkRef(cfg.compact.target, 'compact.target');

  return cfg;
}
