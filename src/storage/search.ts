import type { DatabaseSync } from 'node:sqlite';
import type { SearchBackend, SearchHit, Turn } from './interface.js';

const MAX_TERMS = 10;

/** 把用户查询转成安全的 FTS5 MATCH 表达式：空白分词，每个词加双引号（防语法错误），词间 AND */
function toMatchExpr(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TERMS)
    .map((t) => `"${t.replace(/"/g, '')}"`)
    .join(' ');
}

interface HitRow {
  session_id: string;
  session_title: string | null;
  request_id: string;
  seq: number;
  snip: string;
  created_at: string;
}

const toHit = (r: HitRow): SearchHit => ({
  sessionId: r.session_id,
  sessionTitle: r.session_title,
  requestId: r.request_id,
  seq: r.seq,
  snippet: r.snip,
  createdAt: r.created_at,
});

/** 创建 FTS5 后端；turns_fts 虚表不存在（FTS5 不可用）时返回 null */
export function createSqliteFtsBackend(db: DatabaseSync): SearchBackend | null {
  try {
    db.prepare('SELECT rowid FROM turns_fts LIMIT 0').all();
  } catch {
    return null;
  }
  return {
    indexTurn(t: Turn) {
      const row = db.prepare('SELECT rowid FROM turns WHERE id = ?').get(t.id) as
        | { rowid: number }
        | undefined;
      if (!row) return;
      db.prepare('INSERT INTO turns_fts(rowid, user_text, assistant_text) VALUES (?, ?, ?)').run(
        row.rowid,
        t.userText,
        t.assistantText,
      );
    },
    search(query, filter = {}) {
      const expr = toMatchExpr(query);
      if (!expr) return [];
      const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
      const conds: string[] = ['turns_fts MATCH ?'];
      const params: (string | number)[] = [expr];
      if (filter.sessionId) {
        conds.push('t.session_id = ?');
        params.push(filter.sessionId);
      }
      if (filter.project) {
        conds.push('s.project = ?');
        params.push(filter.project);
      }
      const rows = db
        .prepare(
          `SELECT t.session_id, s.title AS session_title, t.request_id, t.seq,
                  snippet(turns_fts, -1, '【', '】', '…', 24) AS snip, t.created_at
           FROM turns_fts f
           JOIN turns t ON t.rowid = f.rowid
           LEFT JOIN sessions s ON s.session_id = t.session_id
           WHERE ${conds.join(' AND ')}
           ORDER BY t.created_at DESC
           LIMIT ?`,
        )
        .all(...params, limit) as unknown as HitRow[];
      return rows.map(toHit);
    },
  };
}

/** LIKE 降级后端（FTS5 不可用时）：子串匹配，snippet 为命中点前后各 40 字符 */
export function createLikeBackend(db: DatabaseSync): SearchBackend {
  return {
    indexTurn() {
      /* 无索引可建 */
    },
    search(query, filter = {}) {
      const q = query.trim();
      if (!q) return [];
      const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
      const like = `%${q}%`;
      const conds: string[] = ['(t.user_text LIKE ? OR t.assistant_text LIKE ?)'];
      const params: (string | number)[] = [like, like];
      if (filter.sessionId) {
        conds.push('t.session_id = ?');
        params.push(filter.sessionId);
      }
      if (filter.project) {
        conds.push('s.project = ?');
        params.push(filter.project);
      }
      const rows = db
        .prepare(
          `SELECT t.session_id, s.title AS session_title, t.request_id, t.seq, t.user_text, t.assistant_text, t.created_at
           FROM turns t LEFT JOIN sessions s ON s.session_id = t.session_id
           WHERE ${conds.join(' AND ')}
           ORDER BY t.created_at DESC
           LIMIT ?`,
        )
        .all(...params, limit) as unknown as Array<HitRow & { user_text: string; assistant_text: string }>;
      return rows.map((r) => {
        const hay = r.user_text.includes(q) ? r.user_text : r.assistant_text;
        const at = hay.indexOf(q);
        const start = Math.max(0, at - 40);
        const snip = (start > 0 ? '…' : '') + hay.slice(start, at + q.length + 40);
        return toHit({ ...r, snip });
      });
    },
  };
}
