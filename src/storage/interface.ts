export interface NewRequestLog {
  project: string;
  sessionId: string | null;
  clientModel: string;
}

export interface RequestLogPatch {
  provider?: string;
  upstreamModel?: string;
  status?: 'success' | 'error';
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  compacted?: boolean;
  compactBefore?: number;
  compactAfter?: number;
  failovered?: boolean;
  error?: string;
}

export interface SessionInfo {
  sessionId: string;
  project: string;
  title: string;
  overrideRef: string | null;
  lastTokens: number;
  createdAt: string;
  lastSeen: string;
}

export interface SessionDirectory {
  /** 每次请求调用：首次见到写入 title/project，之后仅更新 lastSeen/lastTokens */
  touchSession(s: { sessionId: string; project: string; title: string; tokens: number }): void;
  setOverride(sessionId: string, ref: string | null): void;
  getOverride(sessionId: string): string | null;
  getSession(sessionId: string): SessionInfo | null;
  listRecent(limit: number): SessionInfo[];
}

export interface Turn {
  id: string;
  sessionId: string;
  requestId: string;
  seq: number;
  userText: string;
  assistantText: string;
  createdAt: string;
}

/** addTurn 入参：id/seq/createdAt 由存储层生成 */
export interface NewTurn {
  sessionId: string;
  requestId: string;
  userText: string;
  assistantText: string;
}

export interface SearchHit {
  sessionId: string;
  sessionTitle: string | null; // 联表 sessions.title，无会话行时为 null
  requestId: string;
  seq: number;
  snippet: string;
  createdAt: string;
}

/** 搜索后端抽象：本期 SQLite FTS5（不可用降级 LIKE），预留 ES 实现 */
export interface SearchBackend {
  indexTurn(t: Turn): void;
  search(query: string, filter?: { project?: string; sessionId?: string; limit?: number }): SearchHit[];
}

/** 用量统计的一个分组桶（按厂商/模型/项目等维度） */
export interface StatsBucket {
  key: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}

/** 会话维度：联表带出标题与项目；无会话行的请求 title/project 为 null */
export interface SessionStatsBucket extends StatsBucket {
  sessionId: string;
  title: string | null;
  project: string | null;
}

export interface DailyStatsBucket {
  /** 本地时区日期 YYYY-MM-DD */
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageStats {
  totals: { requests: number; errors: number; inputTokens: number; outputTokens: number };
  byProvider: StatsBucket[];
  byModel: StatsBucket[];
  byProject: StatsBucket[];
  bySession: SessionStatsBucket[];
  daily: DailyStatsBucket[];
}

export interface LogStorage {
  findRequest(id: string): { id: string; project: string; createdAt: string } | null;
  start(entry: NewRequestLog): string;
  finish(id: string, patch: RequestLogPatch): void;
  writeBody(id: string, kind: 'request' | 'response', payload: unknown): void;
  sessions: SessionDirectory;
  turns: {
    addTurn(t: NewTurn): void;
    listTurns(sessionId: string): Turn[];
    search: SearchBackend;
  };
  /** 用量统计聚合：days>0 只看最近 N 天，0 为全部 */
  stats: { aggregate(days: number): UsageStats };
  close(): void;
}
