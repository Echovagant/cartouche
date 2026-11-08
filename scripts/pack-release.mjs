#!/usr/bin/env node
/**
 * 打一个可下载的发布包（zip）。
 *
 * 给谁用：拿到包的人**不需要会 Git**，解压 → 装 Node 与 GDAL → npm install →
 * 起引擎 → 打开画布，就能用。图签是"装在你自己电脑上"的工具，
 * 下载物如果只给一个 clone 指引，实际上等于没有下载。
 *
 * 包里放什么：
 *   - 源码（src/ server/ 的源码与配置）
 *   - 前端源码（web/app 与配置）
 *   - 预构建产物（引擎 dist、服务端 dist、前端静态站 out）—— 省掉对方一次 build
 *   - 脚本（setup-conda-gdal / run-engine / set-key / serve-static / doctor）
 *   - 许可与说明（LICENSE / NOTICE / README / 快速开始）
 *   - 不含 node_modules（体积大、且平台相关）—— 装的时候 npm install 一次
 *
 * ⚠️ **不收 `web/public/`**：public 里的东西 next build 时会**整份复制进 web/out/**，
 * 两边都收就是每张图存两份（实测多出 7.1MB，其中首屏那张 PNG 就 4.5MB）。
 * 打包前会核对 out 里确实有 public 的全部文件，缺了就不打这个包。
 *
 * ⚠️ **收 `web/fonts/`**：字体是自托管的（next/font/local，见 web/app/layout.tsx），
 * 不收就等于对方 `npm run build:web` 时字体找不到。
 * 字体许可：Geist / Geist Mono 是 SIL OFL 1.1，可商用、可随仓库分发，
 * 声明写在 NOTICE 里。
 *
 * ⚠️ **收 `test/helpers/`**：`scripts/smoke-engine.mjs` 从 `../test/helpers/listen-safe.mjs`
 * 借了一个起端口的辅助函数。不收它，对方在包里跑 `npm run smoke:engine` 会直接失败。
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
  'web/package.json',
  'web/tsconfig.json',
  'web/next.config.mjs',
  'web/postcss.config.mjs',
  'web/next-env.d.ts',
  'web/fonts',
  'test/helpers',
  'scripts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'README.md',
  'QUICKSTART.md',
  'LICENSE',
  'NOTICE',
  '.env.example',
];

const PREBUILT = [
  'src/engine/dist',
  'server/dist',
  'web/out',
];

/**
 * 这些目录一律不进包。
 *
 * ⚠️ **必须是"路径全等"而不是"路径段相等"**：
 * 曾经写成 `rel.split('/').some((seg) => SKIP_DIR.has(seg))`，
 * 那是**任意层级**同名目录都跳过 —— 于是 `src/engine/workspace/`
 * （引擎的工作区适配器，被 `src/engine/index.ts` 直接 import）
 * 连同它的预构建产物 `src/engine/dist/workspace/`
 * 一起被吞掉，**打出来的包连引擎都加载不了**。
 * 实测（2026-11-08）：已发布的 v0.1.0 与 v0.2.0 两个包都是坏的，
 * `import('.../src/engine/dist/index.js')` 直接报
 * `Cannot find module .../dist/workspace/index.js`。
 *
 * 同一个坑在 `.gitignore` 里已经踩过并修过一次（那里写成了 `/workspace/`，
 * 锚定到仓库根），打包脚本这边**当时漏改了**。
 *
 * 现在只跳过**仓库根那一层**的这些目录（路径全等）。
 * 嵌套同名的目录一律保留 —— 引擎的 `workspace/` 就是靠这条规则活下来的。
 */
const SKIP_DIR = new Set(['node_modules', '.git', '.next', '.turbo', 'coverage', '.impeccable', 'shots', 'workspace']);

/**
 * 这些目录**只在仓库根那一层**跳过（路径全等），嵌套的同名目录保留。
 *
 * 为什么单独列：`node_modules` 之类的在任何层级出现都是不要的；
 * 但 `workspace` 是有意义的目录名（引擎的工作区适配器），
 * 把两者混在一起就会误伤 —— 见 SKIP_DIR 上面的说明。
 */
const SKIP_DIR_ROOT_ONLY = new Set(['workspace', 'shots', '.impeccable']);

/** 任何层级都不要的目录（这些名字在嵌套处出现也一律不要） */
const SKIP_DIR_ANYWHERE = new Set(['node_modules', '.git', '.next', '.turbo', 'coverage']);

const SKIP_FILE = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * 文件名像开发日志 / 临时产物的，一律不进包。
 *
 * 为什么单独列：`.gitignore` 挡住了它们进**仓库**，但打包走的是**文件系统**，
 * 不是 git —— 本机残留的日志会被原样打进给别人的包。
 * 实测（2026-10-23）：已发布的 v0.1.0 包里带着 `scripts/gdal-setup.log`，
 * 里面写着打包者本机的 conda 安装路径 —— 别人的包不该带打包者的本机路径。
 */
const SKIP_FILE_RE = /(\.log(\.err)?|\.err\.log|\.tmp|\.bak|\.old)$/i;

/**
 * 本机路径的特征 —— 只认**指向具体账号**的那几种。
 *
 * 命中就**拒绝出包**（见 {@link findLocalPathLeaks}）。
 *
 * 为什么不含「系统目录」那一类：Windows 的系统目录（System32、Program Files 之类）
 * 谁都一样，不是身份信息；而**用户目录**（Windows 的 Users 下、macOS 的 Users 下、
 * Linux 的 home 下）指向的是**某一个人**，那才是要拦的。
 * 误报一次就足以让人不再信任这道闸，所以宁可少认几种、别多认。
 */
const LOCAL_PATH_PATTERNS = [
  /[A-Za-z]:\\Users\\[^\\\s"'<>|]+/g, // Windows 的用户目录
  /\/Users\/[^/\s"'<>|]+/g, // macOS 的用户目录
  /\/home\/[^/\s"'<>|]+/g, // Linux 的用户目录
];

/* ── 出包前的最后一道闸 ─────────────────────────────────────── */

/**
 * 找出打进包里的本机路径。
 *
 * 为什么要有这道闸：包是给别人的。带着打包者本机的用户目录路径出去，
 * 等于把打包者的本机路径公开 —— 2026-10-23 的 v0.1.0 就是这么漏出去的
 * （`scripts/gdal-setup.log` 里有 `打包者本机的用户目录\miniconda3`）。
 * 与其事后从已发布的资产里删，不如**打不出来**：出了包就是已经扩散了。
 *
 * 只扫文本文件：二进制（含 NUL 字节）跳过 —— 扫它没有意义，
 * 而且一次误报就足以让人不再信任这道闸。
 */
function findLocalPathLeaks(entries) {
  const leaks = [];
  for (const e of entries) {
    const head = e.data.subarray(0, 4096);
    if (head.includes(0)) continue; // 二进制，跳过
    const text = e.data.toString('utf8');
    for (const re of LOCAL_PATH_PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(text);
      if (m) {
        leaks.push({ name: e.name, sample: m[0].slice(0, 120) });
        break;
      }
    }
  }
  return leaks;
}

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

/**
 * 这个相对路径要不要跳过。
 *
 * 规则分两类（见 SKIP_DIR 的说明）：
 *   - **任何层级都不要**：node_modules / .git / .next 等
 *   - **只有仓库根那一层不要**：workspace / shots / .impeccable
 *
 * @param {string} rel 相对仓库根的路径（始终用 `/` 分隔）
 */
function shouldSkip(rel) {
  const segs = rel.split('/');
  // 仓库根那一层：路径全等才跳
  if (SKIP_DIR_ROOT_ONLY.has(rel)) return true;
  // 任何层级：路径段相等就跳
  if (segs.some((seg) => SKIP_DIR_ANYWHERE.has(seg))) return true;
  return false;
}

async function walk(abs, rel, out) {
  let st;
  try {
    st = await stat(abs);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    if (shouldSkip(rel)) return;
    for (const name of await readdir(abs)) {
      await walk(join(abs, name), rel ? `${rel}/${name}` : name, out);
    }
  } else if (st.isFile()) {
    if (SKIP_FILE.has(rel)) return;
    // 文件名像日志/临时产物的：不进包（见 SKIP_FILE_RE 的说明）
    if (SKIP_FILE_RE.test(rel.split(sep).pop() ?? rel)) return;
    if (shouldSkip(rel)) return;
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

  /* ── 打包前核对：web/out 必须含有 web/public 的全部文件 ──────────
     不收 web/public 是为了不重复存一份（见文件头）。
     但这条成立的前提是「out 是完整的」——产物没建全就收，
     等于把「图片全丢」这件事推到用户机器上才暴露。 */
  const publicDir = join(root, 'web', 'public');
  const outDir_ = join(root, 'web', 'out');
  try {
    await stat(publicDir);
    await stat(outDir_);
    const publicFiles = [];
    await walk(publicDir, '', publicFiles);
    const outFiles = [];
    await walk(outDir_, '', outFiles);
    const outSet = new Set(outFiles.map((f) => f.rel.split(sep).join('/')));
    const missing = publicFiles
      .map((f) => f.rel.split(sep).join('/'))
      .filter((rel) => !outSet.has(rel));
    if (missing.length > 0) {
      console.error(
        `[pack] web/out 缺少 web/public 的 ${missing.length} 个文件（先跑 npm run build:web）：` +
          `\n        ${missing.slice(0, 5).join('\n        ')}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`[pack] 核对通过：web/out 含有 web/public 的全部 ${publicFiles.length} 个文件（不重复打包 public）`);
  } catch {
    console.warn('[pack] 没有 web/public 或 web/out，跳过核对');
  }

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

  /* ── 同一个路径只进包一次 ───────────────────────────────────────
     `src/engine/dist` 既在 INCLUDE 的 `src` 里（源码树的一部分），
     又在 PREBUILT 里（预构建产物），会被 walk 两次、**打出两个同名条目**。
     后果不是"多了几 KB"：Windows 的解压与 .NET 的 ExtractToDirectory
     遇到重复条目会直接抛「文件已存在」而中断 —— 别人拿这个包解压会失败。 */
  const unique = new Map();
  for (const f of files) {
    const key = f.rel.split(sep).join('/');
    if (!unique.has(key)) unique.set(key, { ...f, rel: key });
  }
  const dupes = files.length - unique.size;
  if (dupes > 0) console.log(`[pack] 去掉 ${dupes} 个重复条目（同路径只留一份）`);
  files.length = 0;
  files.push(...unique.values());

  const entries = [];
  let raw = 0;
  for (const f of files) {
    const data = await readFile(f.abs);
    raw += data.length;
    entries.push({ name: f.rel.split(sep).join('/'), data });
  }

  // 出包前的最后一道闸：包里不许有本机路径。
  // 放在写文件之前 —— 写下去就等于扩散了，删本地文件追不回已发布的资产。
  const leaks = findLocalPathLeaks(entries);
  if (leaks.length > 0) {
    console.error(`[pack] 拒绝出包：发现 ${leaks.length} 处本机路径痕迹`);
    for (const l of leaks) {
      console.error(`        ${l.name}  →  ${l.sample}`);
    }
    console.error(
      '        这些是打包者本机的路径，不该出现在给别人的包里。\n' +
        '        处理：把对应文件排除掉（scripts/pack-release.mjs 的 SKIP_FILE_RE），' +
        '        并确认它已被 .gitignore 挡住。',
    );
    process.exitCode = 1;
    return;
  }

  /* ── 出包后的完整性自检：包里必须有的文件，一个都不能少 ──────────
     这道闸是为 2026-11-08 那个事故加的：v0.1.0 与 v0.2.0 两个已发布的包
     都因为 SKIP_DIR 吞掉 `src/engine/workspace/` 而**连引擎都加载不了**，
     而当时所有的门禁（类型检查、单测、许可、密钥、编码）**全部通过** ——
     因为它们检查的都是仓库，不是包。

     所以这里检查的是「**包里**有没有」，不是「仓库里有没有」。
     一个包少了一个目录，从外面看还是那个大小差不多的 zip，
     只有解压后才会炸 —— 那时已经扩散出去了。 */
  const required = [
    'src/engine/index.ts',
    'src/engine/workspace/index.ts',
    'src/engine/workspace/roots.ts',
    'src/engine/dist/index.js',
    'src/engine/dist/workspace/index.js',
    'server/dist/index.js',
    'server/package.json',
    'package.json',
    'package-lock.json',
    'web/app/layout.tsx',
    'web/fonts/geist.woff2',
    'web/fonts/geist-mono.woff2',
    'test/helpers/listen-safe.mjs',
  ];
  const have = new Set(entries.map((e) => e.name));
  const missing = required.filter((r) => !have.has(r));
  if (missing.length > 0) {
    console.error(`[pack] 拒绝出包：包里缺少 ${missing.length} 个必需文件`);
    for (const m of missing) console.error(`        ${m}`);
    console.error(
      '        这些文件是引擎能跑起来的前提。\n' +
        '        多半是 SKIP_DIR / INCLUDE 的规则把它们漏掉了（见 shouldSkip 的说明）。',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[pack] 完整性核对通过：${required.length} 个必需文件都在包里`);

  const buf = zip(entries);
  await mkdir(outDir, { recursive: true });
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version ?? '0.0.0';
  // 资产名不带日期：发布资产的链接要稳定。
  // 带日期的话，每重打一次包就是一个新文件名 —— 那不是"发布"，是"再发一次"。
  // 要区分不同构建，看同名的 .sha256 就行。
  const outFile = join(outDir, `cartouche-${version}.zip`);
  await writeFile(outFile, buf);

  const sha = createHash('sha256').update(buf).digest('hex');
  await writeFile(`${outFile}.sha256`, `${sha}  ${outFile.split(/[\\/]/).pop()}\n`, 'utf8');

  console.log(`[pack] ${files.length} 个文件，原始 ${(raw / 1048576).toFixed(1)} MB → 压缩后 ${(buf.length / 1048576).toFixed(1)} MB`);
  console.log(`[pack] 输出：${outFile}`);
  console.log(`[pack] sha256：${sha}`);
}

await main();
