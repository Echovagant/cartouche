/**
 * 引擎服务入口（CLI）。
 *
 * 与前端壳解耦的原因：未来做 Tauri 桌面版时，同一份引擎可以直接内嵌，
 * 而前端保持纯静态导出——这是 docs/05 里"三条不变量"之一。
 */
import { randomBytes } from 'node:crypto';
import { createEngineServer, opCount } from './app.ts';

const PORT = Number(process.env.ENGINE_PORT ?? 8787);
const HOST = process.env.ENGINE_HOST ?? '127.0.0.1';

/**
 * 监听地址护栏：默认只允许回环地址。
 *
 * 把 ENGINE_HOST 改成 0.0.0.0 就等于把这个「能读写用户数据目录」的服务
 * 暴露到局域网；要这么做必须显式设 CARTOUCHE_ALLOW_NON_LOOPBACK=1，
 * 不能让一次随手改配置静默生效。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
if (!LOOPBACK_HOSTS.has(HOST.toLowerCase()) && process.env.CARTOUCHE_ALLOW_NON_LOOPBACK !== '1') {
  console.error(
    `[engine] 拒绝监听 ${HOST}：引擎只允许回环地址。` +
      ' 确需局域网访问，请显式设置 CARTOUCHE_ALLOW_NON_LOOPBACK=1，并自行承担暴露风险。',
  );
  process.exit(1);
}

/**
 * 本机访问令牌。
 *
 * 启动器（start.cmd / start-portable.cmd / run-engine.ps1）生成后经环境变量传入；
 * 直接 `node server/dist/index.js` 时这里生成一枚，并打印带令牌的画布地址。
 * 令牌每次启动都换，不落盘。
 */
const tokenFromEnv = (process.env.CARTOUCHE_ENGINE_TOKEN ?? '').trim();
const authToken = tokenFromEnv || randomBytes(32).toString('hex');

const server = createEngineServer({ authToken });

server.listen(PORT, HOST, () => {
  console.log(`[engine] listening on http://${HOST}:${PORT}`);
  console.log(`[engine] ops declared: ${opCount()}`);
  if (tokenFromEnv) {
    console.log('[engine] 访问令牌由启动器提供（不打印）');
  } else {
    console.log(`[engine] 本次访问令牌（仅本机）：${authToken}`);
    console.log(`[engine] 画布地址：http://127.0.0.1:8080/canvas.html#t=${authToken}`);
  }
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
