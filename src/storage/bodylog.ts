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
