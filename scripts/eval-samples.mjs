// 用公开真实数据量出「实现程度」。
//
// 对每个样本依次做四件事，并把结果汇成一张能力矩阵：
//   1. 打开（probe）    —— GDAL 能不能认出来
//   2. 体检（health）   —— 我们的规则集报了什么，阻断项有几个
//   3. 像素读取         —— 引擎能不能把像素读进内存
//   4. 类型保真         —— 读出来的数据类型与源数据是否一致（这一项会抓出静默降级）
//   5. 写回往返         —— 写出去再读回来，校验和是否一致
//
// 用法：node scripts/eval-samples.mjs [--only <id>]
// 产出：samples/report.json + 控制台的能力矩阵

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_DIR = join(ROOT, 'samples');
const manifest = JSON.parse(readFileSync(join(SAMPLE_DIR, 'manifest.json'), 'utf8'));

const { resolveGdal, tools, probeDataset, runHealthCheck, readRasterPixels, writeRasterPixels } =
  await import(pathToFileURL(join(ROOT, 'src', 'engine', 'index.ts')).href);

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

/** 像素预算：超过就不整读（否则 10008² 的文件会把内存打爆），改为只验 GDAL 通路 */
const PIXEL_BUDGET = 4_000_000;

const loc = resolveGdal();
if (!loc) {
  console.error('找不到 GDAL，先跑 npm run doctor');
  process.exit(2);
}
const gdal = tools(loc);

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}

/** 源数据的原生数据类型与 nodata（gdalinfo -json） */
async function nativeMeta(path) {
  const res = await gdal.info(path, ['-json']);
  if (!res.ok) return null;
  try {
    const j = JSON.parse(res.stdout);
    const bands = (j.bands ?? []).map((b) => ({
      type: b.type,
      colorInterpretation: b.colorInterpretation,
      noDataValue: b.noDataValue ?? null,
    }));
    return {
      width: j.size?.[0] ?? 0,
      height: j.size?.[1] ?? 0,
      bandCount: (j.bands ?? []).length,
      bandTypes: [...new Set(bands.map((b) => b.type))],
      nodata: bands[0]?.noDataValue ?? null,
      driver: j.driverShortName ?? null,
      crsWkt: j.coordinateSystem?.wkt ?? null,
      geoTransform: j.geoTransform ?? null,
    };
  } catch {
    return null;
  }
}

async function evaluate(sample) {
  const isRemote = Boolean(sample.remote);
  const baseDir = join(ROOT, sample.base ?? 'samples');
  const path = isRemote
    ? (sample.vsicurl ?? sample.url)
    : join(baseDir, sample.expect.entry);
  const row = {
    id: sample.id,
    title: sample.title,
    kind: sample.kind,
    source: isRemote ? 'remote-cog' : sample.base === 'fixtures' ? 'synthetic' : 'local',
    path,
    checks: {},
    notes: [],
  };

  if (!isRemote && !existsSync(path)) {
    row.checks.open = 'SKIP';
    row.notes.push(
      sample.base === 'fixtures'
        ? '合成样本未生成，先跑 npm run fixture'
        : '文件未下载，先跑 npm run samples',
    );
    return row;
  }

  /* 1. 打开 */
  const { dataset, error } = await probeDataset(loc, path);
  row.checks.open = dataset ? 'PASS' : 'FAIL';
  if (error) row.notes.push(`open: ${error.message.split('\n')[0]}`);
  if (!dataset) return row;

  row.driver = dataset.driver;

  /* 2. 体检 */
  const report = await runHealthCheck(loc, path, { maxFeatureScan: 2000 });
  row.checks.health = report.blockers.length === 0 ? 'PASS' : 'BLOCKED';
  row.blockers = report.blockers.map((b) => `${b.ruleId} ${b.title}`);
  row.findings = report.findings.map((f) => `${f.severity} ${f.ruleId} ${f.title}`);

  if (dataset.kind === 'raster') {
    row.width = dataset.width;
    row.height = dataset.height;
    row.bandCount = dataset.bandCount;
    row.crsPresent = dataset.crs.present;
    row.crsSource = dataset.crs.source;
    row.epsg = dataset.crs.epsg ?? null;
    row.nodata = dataset.nodata;
  } else {
    row.featureCount = dataset.featureCount;
    row.fieldCount = dataset.fields.length;
    row.crsPresent = dataset.crs.present;
    row.crsSource = dataset.crs.source;
    row.encoding = dataset.encoding;
    row.geometryType = dataset.geometryType;
  }

  if (sample.kind !== 'raster') return row;

  /* 3. 原生元数据 + 类型保真 */
  const native = await nativeMeta(path);
  if (native) {
    row.native = native;
    const totalPixels = native.width * native.height;
    row.bytesApprox = totalPixels * native.bandCount * (native.bandTypes.includes('Int16') ? 2 : 1);

    const readAsByteOnly = native.bandTypes.some((t) => t !== 'Byte' && t !== 'UInt8');
    row.typeFidelity = readAsByteOnly ? 'DOWNGRADED' : 'OK';
    if (readAsByteOnly) {
      row.notes.push(
        `类型降级：源数据是 ${native.bandTypes.join('/')}，引擎按 Byte 读取（-ot Byte），物理量纲不可恢复`,
      );
    }
  }

  /* 4. 像素读取 */
  const totalPixels = (row.width ?? 0) * (row.height ?? 0);
  if (totalPixels > PIXEL_BUDGET) {
    row.checks.pixels = 'SKIPPED';
    row.notes.push(
      `像素数 ${totalPixels.toLocaleString()} 超出预算 ${PIXEL_BUDGET.toLocaleString()}，跳过整读（避免打爆内存）`,
    );
    return row;
  }

  let px = null;
  try {
    px = await readRasterPixels(loc, path);
    row.checks.pixels = 'PASS';
    row.readBandCount = px.bandCount;
    row.checksum = px.checksum.slice(0, 16);
  } catch (err) {
    row.checks.pixels = 'FAIL';
    row.notes.push(`pixels: ${String(err.message).split('\n')[0]}`);
    return row;
  }

  /* 5. 写回往返 */
  const tmp = mkdtempSync(join(tmpdir(), 'cartouche-eval-'));
  try {
    const out = join(tmp, 'roundtrip.tif');
    await writeRasterPixels(loc, out, {
      width: px.width,
      height: px.height,
      bands: px.bands,
      pixelType: px.pixelType,
      colorInterpretation: px.colorInterpretation,
      geotransform: px.geotransform,
      crs: px.crs,
    });
    const back = await readRasterPixels(loc, out);
    row.checks.roundtrip = back.checksum === px.checksum ? 'PASS' : 'MISMATCH';
    if (row.checks.roundtrip !== 'PASS') {
      row.notes.push(`往返校验和不一致：${px.checksum.slice(0, 12)} → ${back.checksum.slice(0, 12)}`);
    }
    const backInfo = await nativeMeta(out);
    if (backInfo) {
      row.roundtripNative = { bandTypes: backInfo.bandTypes, crs: backInfo.crsWkt ? 'yes' : 'no' };
      if (backInfo.crsWkt && !px.crs) {
        row.notes.push('写回后带上了 CRS，但源数据本来没有 CRS —— 语义被改写了');
      }
    }
  } catch (err) {
    row.checks.roundtrip = 'FAIL';
    row.notes.push(`roundtrip: ${String(err.message).split('\n')[0]}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  return row;
}

/* ────────────────────────── 主流程 ────────────────────────── */

const rows = [];
for (const s of manifest.samples) {
  if (only && s.id !== only) continue;
  process.stdout.write(`[eval ] ${s.id.padEnd(26)}`);
  const row = await evaluate(s);
  rows.push(row);
  console.log(
    ` open=${row.checks.open} health=${row.checks.health ?? '-'} pixels=${row.checks.pixels ?? '-'} roundtrip=${row.checks.roundtrip ?? '-'}`,
  );
  for (const n of row.notes ?? []) console.log(`        ! ${n}`);
}

/* ────────────────────────── 能力矩阵 ────────────────────────── */

const marks = { PASS: '✅', FAIL: '❌', BLOCKED: '⛔', SKIP: '—', SKIPPED: '—', MISMATCH: '⚠️', DOWNGRADED: '⚠️', OK: '✅' };
const cols = ['open', 'health', 'pixels', 'roundtrip', 'typeFidelity'];

console.log('\n=== 能力矩阵（公开真实数据）===\n');
console.log(`| 样本 | 类型 | 规模 | ${cols.join(' | ')} | 关键发现 |`);
console.log(`|---|---|---|---|---|---|`);
for (const r of rows) {
  const size =
    r.kind === 'raster'
      ? `${r.width ?? '?'}×${r.height ?? '?'}×${r.bandCount ?? '?'}${r.bytesApprox ? ` (${fmtBytes(r.bytesApprox)})` : ''}`
      : `${r.featureCount ?? '?'} 要素 / ${r.fieldCount ?? '?'} 字段`;
  const cells = cols.map((c) => `${marks[r.checks[c] ?? r[c] ?? '—'] ?? '—'} ${r.checks[c] ?? r[c] ?? '—'}`);
  const finding = (r.notes ?? [])[0] ?? (r.blockers?.[0] ?? '');
  console.log(`| ${r.title} | ${r.kind} | ${size} | ${cells.join(' | ')} | ${finding} |`);
}

const total = rows.length;
const allPass = (r) => Object.values(r.checks).every((v) => v === 'PASS' || v === undefined || v === 'OK');
const passed = rows.filter(allPass).length;
const skipped = rows.filter((r) => Object.values(r.checks).some((v) => v === 'SKIPPED')).length;
const failedRows = rows.filter((r) => Object.values(r.checks).some((v) => v === 'FAIL' || v === 'BLOCKED' || v === 'MISMATCH')).length;
console.log(`\n全项通过 ${passed} / ${total}　（另有 ${skipped} 条因数据量超预算跳过像素级环节，${failedRows} 条有失败项）`);

writeFileSync(
  join(SAMPLE_DIR, 'report.json'),
  JSON.stringify({ evaluatedAt: new Date().toISOString(), rows }, null, 2),
  'utf8',
);
console.log(`报告已写入 samples/report.json`);
