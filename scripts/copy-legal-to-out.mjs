#!/usr/bin/env node
/**
 * 构建后把 NOTICE 与 LICENSE 拷进 web/out/。
 *
 * 为什么要有这一步：web/out 是真正被分发的东西 —— GitHub Pages 发它，
 * 绿色便携包也装它。MIT/BSD 这类许可要求**随分发物**保留版权与许可声明，
 * NOTICE 则是第三方组件清单的载体（依赖许可门禁只保证仓库里有，不保证
 * 分发物里有 —— 2026-11-08 的审计实测 web/out 里 0 命中，这里补的就是那个口子）。
 *
 * 挂在 web 的 postbuild 钩子上：next build 成功后必然执行，任何产出
 * web/out 的路径都会带上这两份。源文件缺失、out 不存在、拷贝后大小对不上，
 * 都直接报错退出 —— 分发义务这种事不静默跳过。
 */
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'web', 'out');

if (!existsSync(out)) {
  console.error('[copy-legal] web/out 不存在：next build 还没跑过或没成功，先跑 npm run build:web。');
  process.exit(1);
}

let failed = 0;
for (const name of ['LICENSE', 'NOTICE']) {
  const src = join(root, name);
  if (!existsSync(src)) {
    console.error(`[copy-legal] 仓库根目录缺少 ${name}，分发义务没法满足，拒绝继续。`);
    failed += 1;
    continue;
  }
  const dst = join(out, name);
  copyFileSync(src, dst);
  const sizeSrc = statSync(src).size;
  const sizeDst = statSync(dst).size;
  if (sizeSrc !== sizeDst) {
    console.error(`[copy-legal] ${name} 拷贝后大小不一致（源 ${sizeSrc} / 目标 ${sizeDst}）。`);
    failed += 1;
    continue;
  }
  console.log(`[copy-legal] ${name} → web/out/（${sizeSrc} 字节）`);
}
if (failed > 0) process.exit(1);
