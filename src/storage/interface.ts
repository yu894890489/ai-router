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

export interface LogStorage {
  start(entry: NewRequestLog): string;
  finish(id: string, patch: RequestLogPatch): void;
  writeBody(id: string, kind: 'request' | 'response', payload: unknown): void;
  close(): void;
}
