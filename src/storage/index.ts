import { randomUUID } from 'node:crypto';
import type { StorageConfig } from '../config.js';
import type { LogStorage, NewRequestLog, RequestLogPatch } from './interface.js';
import { createJsonlWriter } from './jsonl.js';
import { createSqliteStorage } from './sqlite.js';

export type { LogStorage, NewRequestLog, RequestLogPatch } from './interface.js';

function safe(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    // 旁路原则：存储失败不阻断转发
    console.warn('[storage] 写入失败（已降级，不影响转发）:', e);
  }
}

export function createStorage(cfg: StorageConfig): LogStorage {
  const db = createSqliteStorage(cfg.sqlitePath);
  const writeJsonl = createJsonlWriter(cfg.jsonlDir);
  const projects = new Map<string, string>();

  return {
    start(entry: NewRequestLog): string {
      let id: string = randomUUID();
      safe(() => {
        id = db.start(entry);
      });
      projects.set(id, entry.project);
      return id;
    },

    finish(id: string, patch: RequestLogPatch): void {
      safe(() => db.finish(id, patch));
    },

    writeBody(id: string, kind: 'request' | 'response', payload: unknown): void {
      const project = projects.get(id) ?? '_default';
      safe(() => writeJsonl(project, id, kind, payload));
    },

    close(): void {
      safe(() => db.close());
    },
  };
}
