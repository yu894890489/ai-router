import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LogStorage, NewRequestLog, RequestLogPatch, SessionDirectory, SessionInfo } from './interface.js';

const DDL = `
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  session_id TEXT,
  client_model TEXT,
  provider TEXT,
  upstream_model TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  input_tokens INTEGER,
  output_tokens INTEGER,
  duration_ms INTEGER,
  compacted INTEGER NOT NULL DEFAULT 0,
  compact_before INTEGER,
  compact_after INTEGER,
  failovered INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_project ON requests(project);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  override_ref TEXT,
  last_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);
`;

// RequestLogPatch 字段 -> 列名与值变换
const COLUMN_MAP: Record<string, { column: string; toDb: (v: unknown) => unknown }> = {
  provider: { column: 'provider', toDb: (v) => v },
  upstreamModel: { column: 'upstream_model', toDb: (v) => v },
  status: { column: 'status', toDb: (v) => v },
  inputTokens: { column: 'input_tokens', toDb: (v) => v },
  outputTokens: { column: 'output_tokens', toDb: (v) => v },
  durationMs: { column: 'duration_ms', toDb: (v) => v },
  compacted: { column: 'compacted', toDb: (v) => (v ? 1 : 0) },
  compactBefore: { column: 'compact_before', toDb: (v) => v },
  compactAfter: { column: 'compact_after', toDb: (v) => v },
  failovered: { column: 'failovered', toDb: (v) => (v ? 1 : 0) },
  error: { column: 'error', toDb: (v) => v },
};

export function createSqliteStorage(path: string): LogStorage {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(DDL);

  interface SessionRow {
    session_id: string;
    project: string;
    title: string;
    override_ref: string | null;
    last_tokens: number;
    created_at: string;
    last_seen: string;
  }
  const toInfo = (r: SessionRow): SessionInfo => ({
    sessionId: r.session_id,
    project: r.project,
    title: r.title,
    overrideRef: r.override_ref,
    lastTokens: r.last_tokens,
    createdAt: r.created_at,
    lastSeen: r.last_seen,
  });

  const sessions: SessionDirectory = {
    touchSession(s) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO sessions (session_id, project, title, last_tokens, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_seen = excluded.last_seen,
           last_tokens = excluded.last_tokens`,
      ).run(s.sessionId, s.project, s.title, s.tokens, now, now);
    },
    setOverride(sessionId, ref) {
      db.prepare('UPDATE sessions SET override_ref = ? WHERE session_id = ?').run(ref, sessionId);
    },
    getOverride(sessionId) {
      const row = db
        .prepare('SELECT override_ref FROM sessions WHERE session_id = ?')
        .get(sessionId) as { override_ref: string | null } | undefined;
      return row?.override_ref ?? null;
    },
    getSession(sessionId) {
      const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as
        | SessionRow
        | undefined;
      return row ? toInfo(row) : null;
    },
    listRecent(limit) {
      const rows = db
        .prepare('SELECT * FROM sessions ORDER BY last_seen DESC LIMIT ?')
        .all(limit) as unknown as SessionRow[];
      return rows.map(toInfo);
    },
  };

  return {
    start(entry: NewRequestLog): string {
      const id = randomUUID();
      db.prepare(
        'INSERT INTO requests (id, project, session_id, client_model, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, entry.project, entry.sessionId, entry.clientModel, new Date().toISOString());
      return id;
    },

    finish(id: string, patch: RequestLogPatch): void {
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [key, raw] of Object.entries(patch)) {
        const map = COLUMN_MAP[key];
        if (!map || raw === undefined) continue;
        sets.push(`${map.column} = ?`);
        values.push(map.toDb(raw));
      }
      if (sets.length === 0) return;
      values.push(id);
      db.prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = ?`).run(
        ...(values as (string | number | null)[]),
      );
    },

    writeBody(): void {
      // 请求/响应体由 jsonl 实现负责，sqlite 不存大文本
    },

    sessions,

    close(): void {
      db.close();
    },
  };
}
