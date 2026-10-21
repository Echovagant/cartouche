/**
 * 引擎服务入口（CLI）。
 *
 * 与前端壳解耦的原因：未来做 Tauri 桌面版时，同一份引擎可以直接内嵌，
 * 而前端保持纯静态导出——这是 docs/05 里"三条不变量"之一。
 */
import { createEngineServer, opCount } from './app.ts';

const PORT = Number(process.env.ENGINE_PORT ?? 8787);
const HOST = process.env.ENGINE_HOST ?? '127.0.0.1';

const server = createEngineServer();

server.listen(PORT, HOST, () => {
  console.log(`[engine] listening on http://${HOST}:${PORT}`);
  console.log(`[engine] ops declared: ${opCount()}`);
});

// 优雅关闭：被任务管理器/父进程终止时先关连接再退出，
// 否则 Windows 上 libuv 会在 socket 仍注册时触发 UV_HANDLE_CLOSING 断言。
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log(`[engine] ${signal} received, closing...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
