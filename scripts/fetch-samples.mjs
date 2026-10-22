// 下载公开样本数据到 samples/（该目录已在 .gitignore 中，不入库）。
//
// 选源原则（见 samples/manifest.json）：
//   ① 免登录可直连 ② 许可允许商用 ③ 能压到已知薄弱点
//
// 用法：
//   node scripts/fetch-samples.mjs              # 下载缺失的样本
//   node scripts/fetch-samples.mjs --all        # 重新下载全部
//   node scripts/fetch-samples.mjs --only sentinel2-l3-b04

import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_DIR = join(ROOT, 'samples');
const manifest = JSON.parse(readFileSync(join(SAMPLE_DIR, 'manifest.json'), 'utf8'));

const args = process.argv.slice(2);
const force = args.includes('--all');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

if (!existsSync(SAMPLE_DIR)) mkdirSync(SAMPLE_DIR, { recursive: true });

function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function download(url, dest) {
  // 用 curl：Windows 10+ 自带，且对大文件比 Invoke-WebRequest 稳
  execFileSync('curl.exe', ['-L', '--fail', '--silent', '--show-error', '-o', dest, url], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 30 * 60 * 1000,
  });
}

function unpackZip(zip, dest) {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  // Windows 自带 Expand-Archive；用 pwsh 避免依赖 7z
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
  ], { stdio: 'inherit', timeout: 5 * 60 * 1000 });
}

const results = [];
for (const s of manifest.samples) {
  if (only && s.id !== only) continue;

  if (s.remote) {
    // 远程 COG：不整文件下载，只记录 URL；评测时用 /vsicurl/ 走范围读
    results.push({ id: s.id, status: 'remote', detail: s.vsicurl ?? s.url });
    console.log(`[remote] ${s.id.padEnd(24)} ${s.vsicurl ?? s.url}`);
    continue;
  }

  const dest = join(SAMPLE_DIR, s.file);

  if (existsSync(dest) && !force) {
    const size = statSync(dest).size;
    console.log(`[skip ] ${s.id.padEnd(24)} already present (${human(size)})`);
    results.push({ id: s.id, status: 'cached', bytes: size });
    continue;
  }

  console.log(`[get  ] ${s.id.padEnd(24)} ${s.url}`);
  try {
    download(s.url, dest);
    const size = statSync(dest).size;
    if (size < 1024) throw new Error(`下载结果只有 ${size} 字节，可能被拦截`);
    console.log(`        -> ${human(size)}`);
    if (s.unpack) {
      unpackZip(dest, join(SAMPLE_DIR, s.unpack));
      console.log(`        -> unpacked to samples/${s.unpack}`);
    }
    results.push({ id: s.id, status: 'downloaded', bytes: size });
  } catch (err) {
    console.error(`[FAIL ] ${s.id}: ${err.message}`);
    results.push({ id: s.id, status: 'failed', error: err.message });
  }
}

// 记一份下载记录，便于复现（不含任何凭据）
writeFileSync(
  join(SAMPLE_DIR, 'fetched.json'),
  JSON.stringify({ fetchedAt: new Date().toISOString(), results }, null, 2),
  'utf8',
);

const failed = results.filter((r) => r.status === 'failed');
console.log(`\n${results.length} sample(s), ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;
