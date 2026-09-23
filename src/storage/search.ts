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

/** 转义 LIKE 通配符（配合 SQL 里的 ESCAPE '\'），防 % / _ / \ 被当成通配符 */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c);

interface LikeConds {
  terms: string[];
  conds: string[];
  params: string[];
}

/**
 * LIKE 逐词 AND 条件构造（FTS 短词兜底与 LIKE 降级后端共用）：
 * 每个词一个 (user_text LIKE ? OR assistant_text LIKE ?) 条件，多词之间 AND 连接。
 * 整串子串匹配对多词查询语义错误（要求词按原顺序相邻出现），故逐词拆分。
 */
function buildLikeConds(query: string): LikeConds {
  const terms = query.split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
  const conds: string[] = [];
  const params: string[] = [];
  for (const t of terms) {
    conds.push(`(t.user_text LIKE ? ESCAPE '\\' OR t.assistant_text LIKE ? ESCAPE '\\')`);
    const like = `%${escapeLike(t)}%`;
    params.push(like, like);
  }
  return { terms, conds, params };
}

/** LIKE 路径 snippet：定位首个命中词，取其前后各约 40 字符；纯截断，无【】高亮标记 */
function likeSnippet(userText: string, assistantText: string, terms: string[]): string {
  for (const t of terms) {
    for (const hay of [userText, assistantText]) {
      const at = hay.indexOf(t);
      if (at >= 0) {
        const start = Math.max(0, at - 40);
        return (start > 0 ? '…' : '') + hay.slice(start, at + t.length + 40);
      }
    }
  }
  // SQLite LIKE 对 ASCII 大小写不敏感而 indexOf 敏感，定位不到时退化为开头截断
  return userText.slice(0, 80);
}

/**
 * LIKE 搜索（FTS 短词兜底 / FTS5 不可用降级共用）：
 * 逐词 AND 子串匹配，filter（sessionId/project/limit）与 FTS 路径一致生效；
 * snippet 为纯截断，不带 FTS 路径的【】高亮标记。
 */
function likeSearch(
  db: DatabaseSync,
  query: string,
  filter: { project?: string; sessionId?: string; limit?: number },
): SearchHit[] {
  const { terms, conds, params } = buildLikeConds(query);
  if (terms.length === 0) return [];
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
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
  return rows.map((r) => toHit({ ...r, snip: likeSnippet(r.user_text, r.assistant_text, terms) }));
}

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
      const terms = query.split(/\s+/).filter(Boolean);
      if (terms.length === 0) return [];
      // trigram 分词要求每词 ≥3 字符（码点数，故用 [...t].length 而非 t.length），
      // 不足时 FTS 静默返回空，整体转 LIKE 兜底（逐词 AND，snippet 纯截断无【】标记）
      if (!terms.every((t) => [...t].length >= 3)) {
        return likeSearch(db, query, filter);
      }
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
      // FTS 路径 snippet 由 snippet() 生成，命中词带【】高亮标记
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

/** LIKE 降级后端（FTS 不可用时）：逐词 AND 子串匹配，snippet 为命中点前后各 40 字符，无【】标记 */
export function createLikeBackend(db: DatabaseSync): SearchBackend {
  return {
    indexTurn() {
      /* 无索引可建 */
    },
    search(query, filter = {}) {
      return likeSearch(db, query, filter);
    },
  };
}
