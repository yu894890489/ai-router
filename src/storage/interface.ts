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

export interface LogStorage {
  start(entry: NewRequestLog): string;
  finish(id: string, patch: RequestLogPatch): void;
  writeBody(id: string, kind: 'request' | 'response', payload: unknown): void;
  sessions: SessionDirectory;
  close(): void;
}
