import { randomUUID } from 'node:crypto';
import type { StorageConfig } from '../config.js';
import type { LogStorage, NewRequestLog, NewTurn, RequestLogPatch, SearchHit, SessionInfo } from './interface.js';
import { createJsonlWriter } from './jsonl.js';
import { createSqliteStorage } from './sqlite.js';

export type { LogStorage, NewRequestLog, RequestLogPatch, SessionDirectory, SessionInfo } from './interface.js';

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

    sessions: {
      touchSession(s) {
        safe(() => db.sessions.touchSession(s));
      },
      setOverride(id, ref) {
        safe(() => db.sessions.setOverride(id, ref));
      },
      getOverride(id) {
        let v: string | null = null;
        safe(() => {
          v = db.sessions.getOverride(id);
        });
        return v;
      },
      getSession(id) {
        let v: SessionInfo | null = null;
        safe(() => {
          v = db.sessions.getSession(id);
        });
        return v;
      },
      listRecent(limit) {
        let v: SessionInfo[] = [];
        safe(() => {
          v = db.sessions.listRecent(limit);
        });
        return v;
      },
    },

    turns: {
      addTurn(t: NewTurn) {
        safe(() => db.turns.addTurn(t));
      },
      listTurns(sessionId: string) {
        let v: ReturnType<typeof db.turns.listTurns> = [];
        safe(() => {
          v = db.turns.listTurns(sessionId);
        });
        return v;
      },
      search: {
        indexTurn() {
          /* 索引由 sqlite addTurn 内部完成，这里不重复暴露 */
        },
        search(query: string, filter?: { project?: string; sessionId?: string; limit?: number }) {
          let v: SearchHit[] = [];
          safe(() => {
            v = db.turns.search.search(query, filter);
          });
          return v;
        },
      },
    },

    close(): void {
      safe(() => db.close());
    },
  };
}
