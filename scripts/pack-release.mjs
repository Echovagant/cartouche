#!/usr/bin/env node
/**
 * 打一个可下载的发布包（zip）。
 *
 * 给谁用：拿到包的人**不需要会 Git**，解压 → 装 Node 与 GDAL → npm install →
 * 起引擎 → 打开画布，就能用。图签是"装在你自己电脑上"的工具，
 * 下载物如果只给一个 clone 指引，实际上等于没有下载。
 *
 * 包里放什么：
 *   - 源码（src/ server/ web/ 的源码与配置）
 *   - 预构建产物（引擎 dist、服务端 dist、前端静态站 out）—— 省掉对方一次 build
 *   - 脚本（setup-conda-gdal / run-engine / set-key / serve-static / doctor）
 *   - 许可与说明（LICENSE / NOTICE / README / 快速开始）
 *   - 不含 node_modules（体积大、且平台相关）—— 装的时候 npm install 一次
 *
 * 为什么自己写 zip：仓库的依赖许可门禁只放行宽松许可的包，
 * 为打一个包引一个压缩库不划算；而 ZIP 的存储格式本身不复杂（zlib 是 Node 自带的）。
 */
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'release');

/** 打进包里的路径前缀（仓库根目录名不进去，解压后直接就是内容） */
const INCLUDE = [
  'src',
  'server',
  'web/src',
  'web/app',
  'web/public',
  'web/package.json',
  'web/tsconfig.json',
  'web/next.config.mjs',
  'web/postcss.config.mjs',
  'web/next-env.d.ts',
  'scripts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'README.md',
  'docs/QUICKSTART.md',
  'LICENSE',
  'NOTICE',
  '.env.example',
];

const PREBUILT = [
  'src/engine/dist',
  'server/dist',
  'web/out',
];

const SKIP_DIR = new Set(['node_modules', '.git', '.next', '.turbo', 'coverage', '.impeccable', 'shots', 'workspace']);
const SKIP_FILE = new Set(['.DS_Store', 'Thumbs.db']);

/* ── 最小 ZIP 写入器（store + deflate） ── */

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** DOS 时间戳（ZIP 格式只到秒） */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const deflated = deflateRawSync(e.data, { level: 9 });
    // 压不小就存原始数据（小文件 deflate 反而变大）
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(e.data);
    const { time, date } = dosDateTime(new Date());

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 名称
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0o644 << 16, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ── 收集文件 ── */

async function walk(abs, rel, out) {
  let st;
  try {
    st = await stat(abs);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    if (SKIP_DIR.has(rel)) return;
    for (const name of await readdir(abs)) {
      await walk(join(abs, name), rel ? `${rel}/${name}` : name, out);
    }
  } else if (st.isFile()) {
    if (SKIP_FILE.has(rel)) return;
    if (rel.split('/').some((seg) => SKIP_DIR.has(seg))) return;
    out.push({ rel, abs, size: st.size });
  }
}

/** 目录整体进包时补一个空的目录条目（有些解压工具靠它建目录） */
async function walkWithDirs(abs, rel, out) {
  const before = out.length;
  await walk(abs, rel, out);
  for (const e of out.slice(before)) {
    if (!out.some((x) => x.rel.startsWith(`${e.rel}/`))) continue;
  }
}

async function main() {
  const files = [];

  for (const rel of INCLUDE) {
    const abs = join(root, rel);
    let st;
    try {
      st = await stat(abs);
    } catch {
      console.warn(`[pack] 跳过（不存在）：${rel}`);
      continue;
    }
    if (st.isDirectory()) {
      await walk(abs, rel, files);
    } else {
      files.push({ rel, abs, size: st.size });
    }
  }

  for (const rel of PREBUILT) {
    const abs = join(root, rel);
    try {
      await stat(abs);
    } catch {
      console.warn(`[pack] 预构建产物缺失，打包会不含它：${rel}（先跑 npm run build:server / build:web）`);
      continue;
    }
    await walk(abs, rel, files);
  }

  if (files.length === 0) {
    console.error('[pack] 没有可打包的文件');
    process.exitCode = 1;
    return;
  }

  const entries = [];
  let raw = 0;
  for (const f of files) {
    const data = await readFile(f.abs);
    raw += data.length;
    entries.push({ name: f.rel.split(sep).join('/'), data });
  }

  const buf = zip(entries);
  await mkdir(outDir, { recursive: true });
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version ?? '0.0.0';
  const stamp = new Date().toISOString().slice(0, 10);
  const outFile = join(outDir, `cartouche-${version}-${stamp}.zip`);
  await writeFile(outFile, buf);

  const sha = createHash('sha256').update(buf).digest('hex');
  await writeFile(`${outFile}.sha256`, `${sha}  ${outFile.split(/[\\/]/).pop()}\n`, 'utf8');

  console.log(`[pack] ${files.length} 个文件，原始 ${(raw / 1048576).toFixed(1)} MB → 压缩后 ${(buf.length / 1048576).toFixed(1)} MB`);
  console.log(`[pack] 输出：${outFile}`);
  console.log(`[pack] sha256：${sha}`);
}

await main();
