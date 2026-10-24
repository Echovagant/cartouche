// 下载公开样本数据到 samples/（该目录已在 .gitignore 中，不入库）。
//
// 落位规则（见 samples/manifest.json 的 baseDir 字段）：
//   "samples" → 仓库内的 samples/ 目录
//   "ext"     → 仓库外的扩展样本目录；位置由环境变量 CARTOUCHE_EXT_SAMPLES 决定
//   manifest 是入库文件，所以里面只能写逻辑名，本机实际路径一律在这里解析 ——
//   仓库里不出现任何本机绝对路径，换机器/换用户只改环境变量即可。
//
// 用法：
//   node scripts/fetch-samples.mjs              # 下载缺失的样本
//   node scripts/fetch-samples.mjs --all        # 重新下载全部
//   node scripts/fetch-samples.mjs --only sentinel2-l3-b04
//   node scripts/fetch-samples.mjs --dry-run    # 只打印将要下载什么，不落盘

import {
  readFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
  rmSync,
  readdirSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_DIR = join(ROOT, 'samples');
const manifest = JSON.parse(readFileSync(join(SAMPLE_DIR, 'manifest.json'), 'utf8'));

const args = process.argv.slice(2);
const force = args.includes('--all');
const dryRun = args.includes('--dry-run');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

/** 扩展样本目录：Windows 默认落 D 盘，避免大文件把系统盘撑爆；其它平台用用户目录。 */
function defaultExtRoot() {
  return process.platform === 'win32'
    ? 'D:\\Projects\\cartouche-samples'
    : join(homedir(), 'cartouche-samples');
}

const EXT_ROOT = (process.env.CARTOUCHE_EXT_SAMPLES ?? '').trim() || defaultExtRoot();

/**
 * 样本的落位根目录。
 * ext 样本的相对路径在 manifest 里就带着 "<id>/" 前缀 —— 这样同一个 entry
 * 在拉取脚本和评测脚本里解析出的绝对路径是一致的。
 */
function sampleBase(s) {
  return s.baseDir === 'ext' ? EXT_ROOT : SAMPLE_DIR;
}

/** manifest 里的相对路径 → 绝对路径（相对该样本的落位根目录）。 */
function resolveIn(s, relative) {
  return join(sampleBase(s), relative);
}

function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function download(url, dest) {
  // 用 curl：Windows 10+ 自带，且对大文件比 Invoke-WebRequest 稳
  // --retry-connrefused：镜像站/代理偶发拒连时，连接层错误也要重试
  execFileSync(
    'curl.exe',
    ['-L', '--fail', '--silent', '--show-error', '--retry', '3', '--retry-delay', '3', '--retry-connrefused', '-o', dest, url],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 30 * 60 * 1000,
    },
  );
}

/**
 * 压缩包完整性粗检：找 zip 结尾目录（EOCD）签名。
 * 为什么要在下载后立刻查：实测慢速源上续传拼出来的 zip 会少一截，
 * 表面看是「下载成功」，到解包那一步才炸 —— 报错点离原因太远了。
 */
function looksLikeZip(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < 22) return false;
    const tailLen = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(tailLen);
    readSync(fd, buf, 0, tailLen, size - tailLen);
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return true;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

function unpackZip(zip, dest) {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  // Windows 自带 Expand-Archive；用 pwsh 避免依赖 7z
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'inherit', timeout: 10 * 60 * 1000 },
    );
  } catch {
    // Expand-Archive 遇到某些 zip 会直接抛 New-Object 异常，退回系统自带的 tar
    execFileSync('tar.exe', ['-xf', zip, '-C', dest], { stdio: 'inherit', timeout: 10 * 60 * 1000 });
  }
  // 解包后目录还是空的，说明包本身有问题，不能当成功
  if (readdirSync(dest).length === 0) throw new Error(`解包后 ${dest} 是空的，压缩包可能损坏`);
}

/** manifest 里 derive.tool → 引擎 GdalTools 上的方法名 */
const TOOL_METHOD = {
  gdal_translate: 'translate',
  gdalwarp: 'warp',
  gdalbuildvrt: 'buildVrt',
  ogr2ogr: 'ogr2ogr',
};

/** 派生样本要用的源：另一个样本的入口文件（真实数据来自公共源，派生只是换容器/换坐标系）。 */
function deriveSource(s) {
  const src = manifest.samples.find((x) => x.id === s.derivedFrom);
  if (!src) throw new Error(`derivedFrom 指向不存在的样本：${s.derivedFrom}`);
  if (!src.expect?.entry) throw new Error(`源样本 ${src.id} 没有 expect.entry`);
  return resolveIn(src, src.expect.entry);
}

/**
 * 跑派生。derive 是一个步骤数组，每步 {tool, args, out}：
 *   - {src} 指向输入（第一步是 derivedFrom 样本的入口文件，之后是上一步的产物）
 *   - {out} 指向输出（相对该样本自己的目录）
 * 派生产物由脚本生成，重跑前先删掉旧产物：gdalbuildvrt 之类会拒绝覆盖已存在的输出。
 */
async function runDerive(s) {
  const steps = Array.isArray(s.derive) ? s.derive : [s.derive];

  const { resolveGdal, tools, runTool } = await import(
    pathToFileURL(join(ROOT, 'src', 'engine', 'index.ts')).href
  );
  const loc = resolveGdal();
  if (!loc) throw new Error('找不到 GDAL，无法派生（先跑 npm run doctor）');
  const gdal = tools(loc);

  let src = deriveSource(s);
  let last = null;
  for (const step of steps) {
    const method = TOOL_METHOD[step.tool];
    if (!method) throw new Error(`未知的派生工具：${step.tool}`);
    if (!existsSync(src)) throw new Error(`源文件不存在：${src}（先跑一次下载）`);

    const dest = resolveIn(s, step.out);
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest)) rmSync(dest, { force: true });

    // 指定了 cwd 的步骤在那个目录下运行：VRT 这类索引文件要写**相对路径**，
    // 工具只有在源路径是相对路径时才会这么写。
    const cwd = step.cwd ? resolveIn(s, step.cwd) : null;
    const finalArgs = step.args.map((a) =>
      a
        .replaceAll('{srcRel}', cwd ? relative(cwd, src) : src)
        .replaceAll('{outRel}', cwd ? relative(cwd, dest) : dest)
        .replaceAll('{src}', src)
        .replaceAll('{out}', dest),
    );
    // 步骤可以带环境变量：GDAL 的 PAM 会把仿射参数同时写进 .aux.xml，
    // 关掉它，样本里才只剩世界文件这一个地理信息来源。
    const saved = {};
    for (const [k, v] of Object.entries(step.env ?? {})) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    let res;
    try {
      res = cwd
        ? await runTool(loc, `${step.tool}${loc.exeSuffix}`, finalArgs, { cwd })
        : await gdal[method](finalArgs);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    if (!res.ok) {
      const detail = (res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' / ');
      throw new Error(`${step.tool} 失败（exit=${res.code}）：${detail}`);
    }
    if (!existsSync(dest)) throw new Error(`${step.tool} 执行成功但没有产出 ${step.out}`);
    src = dest;
    last = dest;
  }
  return last;
}

if (!dryRun && !existsSync(SAMPLE_DIR)) mkdirSync(SAMPLE_DIR, { recursive: true });

const results = [];

/* 第一轮：下载（远程 COG 只登记地址，不整文件拉取） */
for (const s of manifest.samples) {
  if (only && s.id !== only) continue;

  if (s.remote) {
    // 远程 COG：不整文件下载，只记录 URL；评测时用 /vsicurl/ 走范围读
    results.push({ id: s.id, status: 'remote', detail: s.vsicurl ?? s.url });
    console.log(`[remote] ${s.id.padEnd(24)} ${s.vsicurl ?? s.url}`);
    continue;
  }

  if (s.derive) continue; // 派生样本等源样本就位后再处理

  if (!s.url) {
    // 合成样本由 npm run fixture 生成，这里没有可下载的东西
    results.push({ id: s.id, status: 'skipped', detail: '本地生成，无下载' });
    console.log(`[skip ] ${s.id.padEnd(24)} 本地生成（npm run fixture），不下载`);
    continue;
  }

  const dest = resolveIn(s, s.file);
  const where = s.baseDir === 'ext' ? 'ext' : 'samples';
  const unpackDir = s.unpack ? resolveIn(s, s.unpack) : null;

  if (dryRun) {
    console.log(`[plan ] ${s.id.padEnd(24)} ${s.url}`);
    console.log(`        -> ${where}:${s.file}${s.unpack ? ` (解包到 ${s.unpack}/)` : ''}`);
    results.push({ id: s.id, status: 'planned', baseDir: where });
    continue;
  }

  mkdirSync(dirname(dest), { recursive: true });
  try {
    let status = 'downloaded';
    if (existsSync(dest) && !force) {
      // 压缩包在但没解包过（上次跑到一半、或手工放进来）：补一次解包。
      // 目录在但里面是空的，也算没解包 —— 上次解包失败会留下这种空壳。
      const unpacked = unpackDir && existsSync(unpackDir) && readdirSync(unpackDir).length > 0;
      if (unpackDir && (!unpacked || force)) {
        unpackZip(dest, unpackDir);
        status = 'unpacked';
        console.log(`[unpack] ${s.id.padEnd(24)} ${where}:${s.unpack}`);
      } else {
        console.log(`[skip ] ${s.id.padEnd(24)} already present (${human(statSync(dest).size)})`);
        results.push({ id: s.id, status: 'cached', bytes: statSync(dest).size, baseDir: where });
        continue;
      }
    } else {
      console.log(`[get  ] ${s.id.padEnd(24)} ${s.url}`);
      download(s.url, dest);
      const size = statSync(dest).size;
      if (size < 1024) throw new Error(`下载结果只有 ${size} 字节，可能被拦截`);
      if (s.file.toLowerCase().endsWith('.zip') && !looksLikeZip(dest)) {
        throw new Error(`下载的 zip 不完整（${human(size)}，缺结尾目录），传输多半中断了`);
      }
      console.log(`        -> ${human(size)} (${where})`);
      if (unpackDir) {
        unpackZip(dest, unpackDir);
        console.log(`        -> unpacked to ${where}:${s.unpack}`);
      }
    }
    results.push({
      id: s.id,
      status,
      bytes: statSync(dest).size,
      baseDir: where,
    });
  } catch (err) {
    console.error(`[FAIL ] ${s.id}: ${err.message}`);
    results.push({ id: s.id, status: 'failed', error: err.message, baseDir: where });
  }
}

/* 第二轮：派生格式（FlatGeobuf / VRT / PNG+世界文件 / 重投影 …） */
for (const s of manifest.samples) {
  if (only && s.id !== only) continue;
  if (!s.derive) continue;

  const where = s.baseDir === 'ext' ? 'ext' : 'samples';
  const steps = Array.isArray(s.derive) ? s.derive : [s.derive];
  if (dryRun) {
    console.log(`[plan ] ${s.id.padEnd(24)} 派生自 ${s.derivedFrom}：${steps.map((x) => x.tool).join(' → ')}`);
    for (const step of steps) console.log(`        -> ${where}:${step.out}`);
    results.push({ id: s.id, status: 'planned', baseDir: where });
    continue;
  }

  console.log(`[make ] ${s.id.padEnd(24)} ${steps.map((x) => x.tool).join(' → ')} ← ${s.derivedFrom}`);
  try {
    const dest = await runDerive(s);
    console.log(`        -> ${human(statSync(dest).size)} (${where})`);
    results.push({ id: s.id, status: 'derived', bytes: statSync(dest).size, baseDir: where });
  } catch (err) {
    console.error(`[FAIL ] ${s.id}: ${err.message}`);
    results.push({ id: s.id, status: 'failed', error: err.message, baseDir: where });
  }
}

// 记一份下载记录，便于复现（不含任何凭据，也不含本机绝对路径）
if (!dryRun) {
  writeFileSync(
    join(SAMPLE_DIR, 'fetched.json'),
    JSON.stringify({ fetchedAt: new Date().toISOString(), extRoot: 'CARTOUCHE_EXT_SAMPLES', results }, null, 2),
    'utf8',
  );
}

const failed = results.filter((r) => r.status === 'failed');
console.log(`\n${results.length} sample(s), ${failed.length} failed${dryRun ? '（dry-run，未下载）' : ''}`);
process.exitCode = failed.length ? 1 : 0;
