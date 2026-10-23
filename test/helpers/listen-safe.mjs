/**
 * 起一个只监听回环地址的 HTTP 服务，**端口避开 Node fetch 拒绝的清单**。
 *
 * 坑（本机 2026-10-23 实测）：
 *   `server.listen(0, '127.0.0.1')` 拿到的端口由操作系统分配，
 *   而这台机器的动态端口范围是 **1024–15000**（不是常见的 49152+）——
 *   WHATWG 的坏端口清单里正好有一批落在这个区间：
 *   1719 / 1720 / 1723 / 2049 / 3659 / 4045 / 4190 / 5060 / 5061 /
 *   6000 / 6566 / 6665–6669 / 6697 / 10080
 *
 *   Node 的 fetch（undici）会**直接拒绝**这些端口：
 *   `TypeError: fetch failed`，cause 是 `Error: bad port`。
 *   于是一整套测试偶发红，而红的原因与被测代码毫无关系。
 *
 *   命中概率 ≈ 18 / 13977 ≈ 0.13% 每次起服务 —— 低，但整轮下来一定会撞上。
 *
 * 做法：拿到端口后查一次，命中就关掉重开（换一个端口重试）。
 * 下面的清单是**实测**出来的，不是照抄规范。
 */

/** 实测：Node fetch 会拒这些端口（本机 Node 24.16） */
export const FETCH_BLOCKED_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

/**
 * 监听一个不会被 fetch 拒绝的端口。
 *
 * @param {import('node:http').Server} server 要监听的 server
 * @param {{host?: string, attempts?: number}} [options]
 * @returns {Promise<number>} 实际监听的端口
 */
export async function listenSafe(server, options = {}) {
  const { host = '127.0.0.1', attempts = 20 } = options;
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, host);
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    if (!FETCH_BLOCKED_PORTS.has(port)) return port;
    // 撞上坏端口：关掉换一个再试
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error(`连续 ${attempts} 次拿到的端口都在 fetch 拒绝清单里`);
}
