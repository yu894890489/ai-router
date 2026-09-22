import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';

const providerSchema = z.object({
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  authHeader: z.enum(['x-api-key', 'bearer']),
  contextWindow: z.number().int().positive(),
  userAgent: z.string().min(1),
  extraHeaders: z.record(z.string(), z.string()).default({}),
  modelMap: z
    .record(z.string(), z.string())
    .refine((m) => Object.keys(m).length > 0, { message: 'modelMap 至少需要一个映射' }),
});

const configSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().default(3456),
    })
    .default({ host: '127.0.0.1', port: 3456 }),
  accessKeys: z.record(z.string(), z.string().nullable()),
  providers: z.record(z.string(), providerSchema),
  routing: z.object({ default: z.array(z.string()).min(1) }),
  compact: z.object({
    thresholdRatio: z.number().min(0.1).max(1).default(0.85),
    targetRatio: z.number().min(0.1).max(1).default(0.7),
    keepRecentTurns: z.number().int().min(1).default(6),
    chunkTokens: z.number().int().positive().default(40000),
    provider: z.string(),
    model: z.string(),
    fallbackToTarget: z.boolean().default(true),
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
});

export type RouterConfig = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type CompactConfig = RouterConfig['compact'];
export type StorageConfig = RouterConfig['storage'];

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
  for (const name of cfg.routing.default) {
    if (!cfg.providers[name]) {
      throw new Error(`routing.default 引用了未定义的厂商: ${name}`);
    }
  }
  if (!cfg.providers[cfg.compact.provider]) {
    throw new Error(`compact.provider 引用了未定义的厂商: ${cfg.compact.provider}`);
  }
  return cfg;
}
