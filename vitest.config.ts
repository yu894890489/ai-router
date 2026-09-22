import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // compactor 用例包含大量 CJK 文本，js-tiktoken 纯 JS BPE 对 CJK 编码极慢
    // （实测约 750 倍于 ASCII），单用例需 ~50s；同步 tokenize 连续阻塞 worker
    // 事件循环超过 vitest birpc 内部硬编码的 60s RPC 超时，会产生一条
    // "Timeout calling onTaskUpdate" 的伪 unhandled error（非测试失败）。
    testTimeout: 180000,
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
