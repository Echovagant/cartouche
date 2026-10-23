#!/usr/bin/env node
/**
 * 大影像实测：造一张几 GB 的 GTiff，量「改一小块」的内存峰值与耗时。
 *
 * 用法：
 *   node scripts/check-large-raster.mjs --size-gb 3 --block 512
 *   node scripts/check-large-raster.mjs --size-gb 3 --block 512 --dir D:\tmp
 *
 * 为什么不在 CI 里跑：3 GB 的磁盘与时间开销不适合每次 CI 都付。
 * 但这个数字是本项目的核心承诺（"几 GB 的影像能改"），必须定期人工验。
 *
 * 测的是哪两件事（验收线：内存 < 500 MB、耗时 < 60 s）：
 *   - **耗时**：从"下笔"到"原文件已被原子替换"的全过程 ——
 *     读窗口、写窗口、合成整图、备份原文件、原子替换，一个都不少。
 *   - **内存峰值**：Node 引擎进程的 RSS 峰值 **加上** GDAL 子进程的工作集峰值。
 *     只量 Node 不够 —— 真正吃内存的可能是 gdal_translate 这类子进程；
 *     只量子进程也不够 —— 引擎把整图读进内存才是这个项目要防的事。
 *
 * 造图用 gdal_create（一次写盘，比自己拼 ENVI 头快得多）：
 * 它建的是**真实**文件（不是稀疏文件），头里也写着真实尺寸。
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function argOf(name, dflt) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return dflt;
}
const hasFlag = (name) => args.includes(`--${name}`);

const sizeGb = Number(argOf('size-gb', 3));
const block = Number(argOf('block', 512));
/** 临时目录放哪儿。默认系统临时目录；机器上系统盘紧张时用 --dir 指到别的盘。 */
const baseDir = String(argOf('dir', tmpdir()));
const keep = hasFlag('keep');

const MEM_LIMIT = 500 * 1024 * 1024;
const TIME_LIMIT = 60;

const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;
const { resolveGdal } = await import(eng('gdal/env.ts'));
const { RasterEditor } = await import(eng('raster/ops.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));

const loc = resolveGdal();
if (!loc) {
  console.error('未找到 GDAL 运行时。先跑 npm run doctor。');
  process.exit(2);
}
const gdalTool = (name) => join(loc.binDir, `${name}${loc.exeSuffix}`);

function runGdal(tool, toolArgs, label) {
  try {
    execFileSync(gdalTool(tool), toolArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).slice(0, 600) : (err.message ?? '');
    throw new Error(`${label} 失败（退出码 ${err.status ?? '?'}）：${detail}`);
  }
}

/* ── 1. 造图 ─────────────────────────────────────────────── */

const side = Math.ceil(Math.sqrt(sizeGb * 1024 * 1024 * 1024));
mkdirSync(baseDir, { recursive: true });
const dir = mkdtempSync(join(baseDir, 'cartouche-big-'));
const tif = join(dir, 'big.tif');

console.log(`目标：${sizeGb} GB 影像改一小块，内存 < 500 MB、耗时 < ${TIME_LIMIT} s`);
console.log(`临时目录：${dir}`);
console.log(`造 ${side}×${side} 的 GTiff（单波段 Byte，约 ${(side * side / 1024 ** 3).toFixed(2)} GB）…`);

const tCreate = Date.now();
runGdal(
  'gdal_create',
  [
    // 关掉 GDAL 自己的"磁盘够不够"检查：要造的尺寸可能比可用空间还大，
    // 而这里要的正是那个尺寸（检查会拦住我们）。
    '--config', 'CHECK_DISK_FREE_SPACE', 'FALSE',
    '-outsize', String(side), String(side),
    '-bands', '1', '-ot', 'Byte', '-burn', '7',
    // 必须给仿射参数，且上左 y 要**大于**下右 y（北向上）——
    // 正 NS 分辨率的南向上影像会被 gdalbuildvrt 直接跳过。
    '-a_ullr', '0', String(side), String(side), '0',
    '-of', 'GTiff', tif,
  ],
  '造大图',
);
const fileBytes = statSync(tif).size;
console.log(
  `造完：${(fileBytes / 1024 ** 3).toFixed(2)} GB，用时 ${((Date.now() - tCreate) / 1000).toFixed(1)} s`,
);

/* ── 2. 内存采样 ─────────────────────────────────────────── */

/**
 * GDAL 子进程的内存采样器。
 *
 * 为什么单独开一个 PowerShell：`Get-Process` 每 200 ms 调一次的代价在
 * PowerShell 内部几乎为零，但每次新起一个进程要 300 ms 起 ——
 * 采样频率会被采样本身拖垮。所以常驻一个子进程做循环。
 *
 * **两个数都要采，但只有一个是真指标：**
 *   - `PrivateMemorySize64`（私有字节）：进程真正申请的内存。**这是要跟阈值比的数。**
 *   - `WorkingSet64`（工作集）：含**文件页缓存** —— GDAL 顺序读一个 3 GB 的源文件时，
 *     Windows 会把读过的页映射进工作集，能撑到几百 MB。
 *     那部分内存随时可被系统回收，不是真实占用，把它算进去等于虚报。
 *     但它是解释"为什么工作集这么大"的证据，所以一并留着。
 */
function startGdalSampler(stopFile, outFile) {
  if (process.platform !== 'win32') return null;
  const ps = join(dir, 'sample.ps1');
  writeFileSync(
    ps,
    [
      'param([string]$Stop, [string]$Out)',
      '$peakPriv = 0',
      '$peakWs = 0',
      '$byName = @{}',
      // 停止标记文件存在 = 该收工了。写反了会让这个循环一次都不跑，
      // 采样结果永远是 0 —— 那比没有采样更坏：它让人以为子进程不吃内存。
      'while (-not (Test-Path -LiteralPath $Stop)) {',
      '  $procs = Get-Process -Name "gdal*" -ErrorAction SilentlyContinue',
      '  if ($procs) {',
      '    $priv = ($procs | Measure-Object -Property PrivateMemorySize64 -Sum).Sum',
      '    $ws = ($procs | Measure-Object -Property WorkingSet64 -Sum).Sum',
      '    if ($priv -gt $peakPriv) { $peakPriv = $priv }',
      '    if ($ws -gt $peakWs) { $peakWs = $ws }',
      // 记每个工具各自的峰值：只知道"GDAL 吃了 830 MB"没用，
      // 得知道是 gdal_translate 还是 gdalbuildvrt 吃的，定位才有着落。
      '  foreach ($p in $procs) {',
      '    $k = $p.ProcessName',
      '    if (-not $byName.ContainsKey($k)) { $byName[$k] = 0 }',
      '    if ($p.PrivateMemorySize64 -gt $byName[$k]) { $byName[$k] = $p.PrivateMemorySize64 }',
      '  }',
      '    $parts = @("$peakPriv,$peakWs")',
      '    foreach ($k in $byName.Keys) { $parts += "$k=$($byName[$k])" }',
      '    Set-Content -LiteralPath $Out -Value ($parts -join ";") -Encoding ascii',
      '  }',
      '  Start-Sleep -Milliseconds 200',
      '}',
      '$parts = @("$peakPriv,$peakWs")',
      'foreach ($k in $byName.Keys) { $parts += "$k=$($byName[$k])" }',
      'Set-Content -LiteralPath $Out -Value ($parts -join ";") -Encoding ascii',
    ].join('\n'),
    'utf8',
  );
  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, stopFile, outFile],
    { stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  return {
    stop() {
      try {
        writeFileSync(stopFile, 'stop');
      } catch {
        /* 采样器已经自己退出了 */
      }
    },
    peak() {
      try {
        const raw = readFileSync(outFile, 'ascii').trim();
        const [head, ...rest] = raw.split(';');
        const [priv, ws] = head.split(',');
        const byName = {};
        for (const kv of rest) {
          const idx = kv.lastIndexOf('=');
          if (idx > 0) byName[kv.slice(0, idx)] = Number(kv.slice(idx + 1)) || 0;
        }
        return { private: Number(priv) || 0, workingSet: Number(ws) || 0, byName };
      } catch {
        return { private: 0, workingSet: 0, byName: {} };
      }
    },
  };
}

const stopFile = join(dir, 'stop.flag');
const outFile = join(dir, 'peak.txt');
const sampler = startGdalSampler(stopFile, outFile);

let nodePeak = 0;
const timer = setInterval(() => {
  nodePeak = Math.max(nodePeak, process.memoryUsage().rss);
}, 100);

/* ── 3. 改一小块 ─────────────────────────────────────────── */

const store = new LocalFolderStore(dir);
/**
 * 金字塔要不要一起测。
 *
 * 写回成功之后会自动建金字塔（影像超过阈值时）。那是**另一笔**开销：
 * gdaladdo 要把整幅降采样一遍，几 GB 的影像上是大几分钟。
 * G1/G2 说的是"改一小块"，所以默认把它排除掉；
 * 想量"用户点一下笔到看见新图"的真实总耗时，就去掉这个开关。
 */
const withOverview = !hasFlag('no-overview');
const editor = new RasterEditor({
  loc,
  store,
  ...(withOverview ? {} : { overviewThresholdBytes: Number.MAX_SAFE_INTEGER }),
});

console.log(
  `\n改 ${block}×${block} 那一块（真实写回：合成整图 + 备份 + 原子替换` +
    `${withOverview ? ' + 建金字塔' : '；金字塔已排除'}）…`,
);
const t0 = Date.now();
let error = null;
try {
  await editor.paint({
    target: 'big.tif',
    region: { minX: 1000, minY: 1000, maxX: 1000 + block, maxY: 1000 + block },
    color: '#FF0000',
  });
} catch (err) {
  error = err;
}
const elapsed = (Date.now() - t0) / 1000;

clearInterval(timer);
nodePeak = Math.max(nodePeak, process.memoryUsage().rss);
sampler?.stop();
// 采样器是异步落盘的，给它一点时间把最后一轮写下去
await new Promise((r) => setTimeout(r, 600));
const gdalPeak = sampler?.peak() ?? { private: 0, workingSet: 0, byName: {} };

// 阈值比的是**私有内存**：文件页缓存随时可被系统回收，算进去等于虚报占用。
const memPeak = nodePeak + gdalPeak.private;

/* ── 4. 报告 ─────────────────────────────────────────────── */

console.log('\n──────────── 大影像实测结果 ────────────');
console.log(`影像        : ${side}×${side} 单波段 Byte，${(fileBytes / 1024 ** 3).toFixed(2)} GB`);
console.log(`耗时        : ${elapsed.toFixed(1)} s${withOverview ? '（含建金字塔）' : '（不含建金字塔）'}`);
console.log(`内存峰值 RSS: ${(memPeak / 1024 / 1024).toFixed(0)} MB`);
console.log(`  ├ Node 引擎: ${(nodePeak / 1024 / 1024).toFixed(0)} MB`);
console.log(`  └ GDAL 子进程（私有内存）: ${(gdalPeak.private / 1024 / 1024).toFixed(0)} MB`);
console.log(
  `  （GDAL 工作集含文件页缓存，峰值 ${(gdalPeak.workingSet / 1024 / 1024).toFixed(0)} MB；` +
    `那部分内存系统随时可回收，不计入阈值）`,
);
for (const [name, bytes] of Object.entries(gdalPeak.byName ?? {}).sort((a, b) => b[1] - a[1])) {
  console.log(`  · ${name}: ${(bytes / 1024 / 1024).toFixed(0)} MB`);
}
console.log(`目标        : 内存 < ${MEM_LIMIT / 1024 / 1024} MB，耗时 < ${TIME_LIMIT} s`);

if (error) {
  console.log(`\n❌ 操作失败：${error.message}`);
}

const ok = !error && memPeak < MEM_LIMIT && elapsed < TIME_LIMIT;
console.log(ok ? '\n✅ 达标' : '\n❌ 未达标');
if (!ok) {
  console.log(
    '\n注意：阈值是承诺，不是待调参数。内存超了说明窗口路径没走通，' +
      '回去查有没有仍在整读；耗时超了先看是不是在合成整图那一段。',
  );
}

if (keep) {
  console.log(`\n临时数据保留在：${dir}`);
} else {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
