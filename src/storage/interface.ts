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

export interface LogStorage {
  start(entry: NewRequestLog): string;
  finish(id: string, patch: RequestLogPatch): void;
  writeBody(id: string, kind: 'request' | 'response', payload: unknown): void;
  sessions: SessionDirectory;
  turns: {
    addTurn(t: NewTurn): void;
    listTurns(sessionId: string): Turn[];
    search: SearchBackend;
  };
  close(): void;
}
