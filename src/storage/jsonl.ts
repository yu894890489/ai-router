import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function sanitizeProject(p: string): string {
  const cleaned = p.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return '_default';
  return cleaned;
}

export type JsonlWriter = (
  project: string,
  id: string,
  kind: 'request' | 'response',
  payload: unknown,
) => void;

export function createJsonlWriter(dir: string): JsonlWriter {
  return (project, id, kind, payload) => {
    const date = new Date().toISOString().slice(0, 10);
    const sub = join(dir, sanitizeProject(project));
    mkdirSync(sub, { recursive: true });
    const line = JSON.stringify({ id, kind, ts: new Date().toISOString(), payload });
    appendFileSync(join(sub, `${date}.jsonl`), line + '\n', 'utf8');
  };
}
