import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import type { VitestPluginContext } from 'vitest/node';

// compactor 用例包含大量 CJK 文本，js-tiktoken 纯 JS BPE 对 CJK 编码极慢
// （实测约 750 倍于 ASCII），单用例需 ~50s；同步 tokenize 连续阻塞 worker
// 事件循环超过 birpc 硬编码的 60s RPC 超时（vitest 打包的 birpc:
// node_modules/vitest/dist/chunks/index.B521nVV-.js `DEFAULT_TIMEOUT = 6e4`，
// 且 WorkerRpcOptions 只允许 on/post/serialize/deserialize，timeout 不可配置），
// vitest 的 onTimeoutError 抛出 `[vitest-worker]: Timeout calling "onTaskUpdate"`，
// 被 worker 作为 unhandled rejection 上报到主进程 StateManager.catchError。
// 这是一条伪 unhandled error（非测试失败）。
//
// vitest 3.2.7 没有配置级的 onUnhandledError 回调（该名字只是 RuntimeRPC 的
// 内部 RPC 方法），精准豁免只能通过 configureVitest 插件钩子拦截主进程
// StateManager.catchError 实现。
const KNOWN_BIRPC_TIMEOUT = /^\[vitest-worker\]: Timeout calling "onTaskUpdate"/;

// TODO(tokenizer-perf): js-tiktoken 对 CJK 文本的 BPE 编码性能修复后，
// 移除此插件豁免，恢复 vitest 默认的 unhandled error 处理。
function ignoreKnownBirpcTimeout(): Plugin {
  return {
    name: 'ignore-known-birpc-timeout',
    configureVitest({ vitest }: VitestPluginContext) {
      const state = vitest.state;
      const originalCatchError = state.catchError.bind(state);
      state.catchError = (err: unknown, type: string) => {
        const message = String(
          (err as { message?: unknown } | null)?.message ?? err,
        );
        if (KNOWN_BIRPC_TIMEOUT.test(message)) {
          // 只丢弃这一条已知的 birpc RPC 超时伪错误并留痕；
          // 其余 unhandled error 仍进入 errorsSet，
          // 由 vitest._checkUnhandledErrors 置 exitCode = 1 使套件失败。
          vitest.logger.warn(
            `[ignore-known-birpc-timeout] 豁免已知 birpc 伪错误 (${type}): ${message}`,
          );
          return;
        }
        originalCatchError(err, type);
      };
    },
  };
}

export default defineConfig({
  plugins: [ignoreKnownBirpcTimeout()],
  test: {
    environment: 'node',
    // 单用例 ~50s+ 的慢 CJK tokenize 需要宽松的用例超时。
    testTimeout: 180000,
  },
});
