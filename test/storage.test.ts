import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStorage, type LogStorage } from '../src/storage/index.js';
import { sanitizeProject } from '../src/storage/jsonl.js';

let storage: LogStorage | null = null;
afterEach(() => {
  storage?.close();
  storage = null;
});

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-router-store-'));
  storage = createStorage({
    sqlitePath: join(dir, 'router.db'),
    jsonlDir: join(dir, 'logs'),
  });
  return { dir, storage: storage! };
}

describe('storage', () => {
  it('start 返回 id，finish 落库完整字段', () => {
    const { dir, storage } = make();
    const id = storage.start({ project: 'homepage', sessionId: 'session_abc', clientModel: 'claude-sonnet-4-6' });
    expect(id).toBeTruthy();
    storage.finish(id, {
      provider: 'kimi',
      upstreamModel: 'kimi-k2-0905-preview',
      status: 'success',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 800,
      compacted: true,
      compactBefore: 90000,
      compactAfter: 30000,
      failovered: false,
    });
    const db = new DatabaseSync(join(dir, 'router.db'));
    const row = db
      .prepare('SELECT * FROM requests WHERE id = ?')
      .get(id) as Record<string, unknown>;
    expect(row.project).toBe('homepage');
    expect(row.provider).toBe('kimi');
    expect(row.status).toBe('success');
    expect(row.compacted).toBe(1);
    expect(row.failovered).toBe(0);
    expect(row.compact_before).toBe(90000);
    db.close();
  });

  it('writeBody 按 项目/日期.jsonl 落盘', () => {
    const { dir, storage } = make();
    const id = storage.start({ project: 'D:\\code\\my app', sessionId: null, clientModel: 'm' });
    storage.writeBody(id, 'request', { hello: 'world' });
    const date = new Date().toISOString().slice(0, 10);
    const file = join(dir, 'logs', sanitizeProject('D:\\code\\my app'), `${date}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const line = JSON.parse(readFileSync(file, 'utf8').trim());
    expect(line.id).toBe(id);
    expect(line.kind).toBe('request');
    expect(line.payload.hello).toBe('world');
  });

  it('sanitizeProject 清洗非法文件名字符', () => {
    expect(sanitizeProject('D:\\code\\my app')).toBe('D__code_my_app');
    expect(sanitizeProject('')).toBe('_default');
    expect(sanitizeProject('..')).toBe('_default');
    expect(sanitizeProject('.')).toBe('_default');
  });

  it('jsonl 目录不可写时降级为 warn，不抛出', () => {
    const { storage } = make();
    const id = storage.start({ project: 'p', sessionId: null, clientModel: 'm' });
    // 传一个会使 JSON.stringify 抛循环引用错误的 payload
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => storage!.writeBody(id, 'request', circular)).not.toThrow();
  });
});
