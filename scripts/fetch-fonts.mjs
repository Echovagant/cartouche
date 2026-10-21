/**
 * 下载 Satoshi（Fontshare）四个字重到 web/fonts/。
 * 与 Geist 一样：一次性下载、随仓库走，构建不依赖网络。
 * 许可：Fontshare EULA，个人与商用均可免费使用。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'web', 'fonts');
mkdirSync(outDir, { recursive: true });

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const cssUrl = 'https://api.fontshare.com/v2/css?f[]=satoshi@400,500,600,700&display=swap';
const css = await (await fetch(cssUrl, { headers: { 'User-Agent': UA } })).text();

// 每个 @font-face 块里带 font-weight 与 woff2 地址
const blocks = css.split('@font-face').slice(1);
for (const block of blocks) {
  const weight = /font-weight:\s*(\d+)/.exec(block)?.[1];
  const url = /url\('?(\/\/cdn\.fontshare\.com\/[^')]+\.woff2)'?\)/.exec(block)?.[1];
  if (!weight || !url) continue;
  const abs = 'https:' + url;
  const bin = Buffer.from(await (await fetch(abs, { headers: { 'User-Agent': UA } })).arrayBuffer());
  const file = join(outDir, `satoshi-${weight}.woff2`);
  writeFileSync(file, bin);
  console.log(`[fonts] satoshi-${weight}.woff2  ${(bin.length / 1024).toFixed(1)} KB`);
}
