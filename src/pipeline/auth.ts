import type { RouterConfig } from '../config.js';
import type { AnthropicRequest } from '../types.js';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export function extractApiKey(headers: Record<string, string | undefined>): string | null {
  const xKey = headers['x-api-key'];
  if (xKey) return xKey;
  const auth = headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return null;
}

const CWD_RE = /(?:^|\n)\s*(?:cwd|working directory|working dir)[:\s]+([^\n]+)/i;

export function parseCwdFromSystem(system: AnthropicRequest['system']): string | null {
  const texts: string[] = [];
  if (typeof system === 'string') texts.push(system);
  else if (Array.isArray(system)) {
    for (const b of system) if (typeof b.text === 'string') texts.push(b.text);
  }
  for (const t of texts) {
    const m = CWD_RE.exec(t);
    if (m) return m[1].trim();
  }
  return null;
}

export function resolveProject(
  config: RouterConfig,
  apiKey: string | null,
  req: AnthropicRequest,
): string {
  if (!apiKey || !Object.hasOwn(config.accessKeys, apiKey)) {
    throw new AuthError('无效的接入 Key');
  }
  const mapped = config.accessKeys[apiKey];
  if (mapped) return mapped;
  return parseCwdFromSystem(req.system) ?? '_default';
}

export function extractSessionId(req: AnthropicRequest): string | null {
  const uid = req.metadata?.user_id;
  if (typeof uid !== 'string' || uid.length === 0) return null;
  // 部分客户端把 user_id 发成 JSON 串（如 {"device_id":...,"session_id":"<uuid>"}），
  // 直接按 "session_" 切片会切在键名上产生 `session_id":"..."}` 残片，先尝试解析
  if (uid.startsWith('{')) {
    try {
      const sid = (JSON.parse(uid) as { session_id?: unknown }).session_id;
      if (typeof sid === 'string' && sid) return sid;
    } catch {
      // 非 JSON，走原逻辑
    }
  }
  const i = uid.lastIndexOf('session_');
  return i >= 0 ? uid.slice(i) : uid;
}
