// 用公开真实数据量出「实现程度」。
//
// 两层评测：
//
//   第一层（原有）：这个数据能不能打开、体检报什么、像素能不能读进来、
//                   类型有没有被悄悄降级、写回往返校验和是否一致。
//
//   第二层（新增）：**每个 op 是不是真能跑**。
//                   原来只看得到「打不开 / 体检报什么」，看不到 op 跑起来会怎样 ——
//                   而用户真正用的就是 op。这一层才是「引擎到底做了多少」的答案。
//
//   第二层的结论分三档，这是这份评测的价值所在：
//     PASS   —— 成功，且结果**可验证**（重投影后坐标真的变了、涂色后那一块像元
//                真的变了、写回后属性表能再读回来且条数对得上）。
//     REJECT —— 引擎**明确拒绝**并给出人话原因。**这是正确行为，不是 bug。**
//                例如：图层没有坐标系时 vector.reproject 应该拒绝，而不是乱猜一个投影。
//     CRASH  —— 抛了不该抛的异常 / 静默失败（没报错也没产出）/ 把源数据改坏了。
//                **这才是要修的 bug。**
//
// 铁律：所有写操作都在**副本**上做，绝不碰原始下载的数据；
//       每个数据集跑完 op 之后核对原始文件的校验和，对不上就是 CRASH。
//
// 用法：node scripts/eval-samples.mjs [--only <id>] [--op-timeout <秒>]
// 产出：samples/report.json（第一层）
//       samples/op-eval.json（第二层）
//       控制台：两张矩阵 + 绝对数字

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  readdirSync,
  statSync,
  createReadStream,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { Worker } from 'node:worker_threads';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_DIR = join(ROOT, 'samples');
const manifest = JSON.parse(readFileSync(join(SAMPLE_DIR, 'manifest.json'), 'utf8'));

/**
 * 仓库外的目录。
 *
 * 为什么放 D 盘：系统盘空间紧张，评测要拷数据、建临时工作区，
 * 堆在系统临时目录里迟早把 C 盘撑满。
 */
/**
 * 扩展样本目录（baseDir: "ext"）的默认位置。
 *
 * 放在**用户主目录**下，不写死盘符：固定盘符只在这台机器上成立，
 * 而且公开仓库里不该出现作者本机的绝对路径。
 * 要放到别的盘，设环境变量 CARTOUCHE_EXT_SAMPLES。
 */
const EXT_SAMPLES_DIR = process.env.CARTOUCHE_EXT_SAMPLES ?? join(homedir(), 'cartouche-samples');
/** 评测用的临时工作区落点。 */
const TMP_ROOT = process.env.CARTOUCHE_TMP_DIR ?? join(EXT_BASE, '_cartouche-tmp');
/** 刁难数据集的清单（不存在就跳过，不报错退出）。 */
const HARDCASES_MANIFEST =
  process.env.CARTOUCHE_HARDCASES ?? join(EXT_BASE, 'cartouche-hardcases', 'cases.json');

const ENGINE_URL = pathToFileURL(join(ROOT, 'src', 'engine', 'index.ts')).href;
const {
  resolveGdal,
  tools,
  probeDataset,
  runHealthCheck,
  readRasterPixels,
  writeRasterPixels,
  listImplementedOps,
  probeLayer,
  readFeatures,
} = await import(ENGINE_URL);

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const timeoutIdx = args.indexOf('--op-timeout');
/** 单条 op 的超时上限；超时按失败算（并单列出来）。 */
const OP_TIMEOUT_MS = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) * 1000 : 180_000;

/** 像素预算：超过就不整读（否则 10008² 的文件会把内存打爆），改为只验 GDAL 通路 */
const PIXEL_BUDGET = 4_000_000;
/**
 * op 层跑栅格操作时的像元预算。
 *
 * 为什么另设一个：整读预算管的是「能不能读进来」，op 层要反复读同一幅图
 * （改前一次、改后一次），预算太大就把评测拖成几小时。
 */
const OP_RASTER_BUDGET = 2_000_000;

const loc = resolveGdal();
if (!loc) {
  console.error('找不到 GDAL，先跑 npm run doctor');
  process.exit(2);
}
const gdal = tools(loc);

/* ────────────────────────── 小工具 ────────────────────────── */

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}

/** 文件的 sha256（流式读：大文件不进内存）。 */
function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(abs);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/** 目录树拷贝（评测工作区复位用）。 */
function copyTree(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      copyTree(src, dst);
    } else {
      copyFileSync(src, dst);
    }
  }
}

/** 同步等一会儿（毫秒）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 删目录，Windows 上要重试。
 *
 * 为什么：刚被掐掉的工作线程留下的 GDAL 子进程还占着文件，
 * 这一刻删目录会报 EPERM（文件被占用）。等它退出再删就好 ——
 * 一次失败就把整个评测带崩是本末倒置。
 */
function rmWithRetry(path, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (i === attempts - 1) throw err;
      sleepSync(500);
    }
  }
  return false;
}

function safeId(s) {
  return String(s).replace(/[^\w.-]+/g, '_').slice(0, 80);
}

/**
 * 把产物里的本机绝对路径抹掉。
 *
 * 为什么：报告是给人看的、也可能外发；里面出现 C:\Users\... 这类路径
 * 会泄露使用者是谁，评测用的临时目录也不该出现在产物里。
 *
 * 只认「盘符 + 冒号 + 斜杠」这种形态，并要求盘符前面不是字母数字 ——
 * 这样 https:// 里的 s: 不会被当成盘符，EPSG:4326 也不会。
 */
function redactPaths(value) {
  if (typeof value === 'string') {
    return value.replace(/(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s"'<>|]*/g, '<本机路径>');
  }
  if (Array.isArray(value)) return value.map(redactPaths);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactPaths(v);
    return out;
  }
  return value;
}

/** 建临时目录（落在 D 盘，不用系统临时目录）。 */
function mkdtemp(prefix) {
  mkdirSync(TMP_ROOT, { recursive: true });
  return join(
    TMP_ROOT,
    `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

/**
 * 源数据的原生数据类型与 nodata（gdalinfo -json）
 */
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

/* ───────────────── baseDir 逻辑名 ───────────────── */

/**
 * 样本落在哪个目录。
 *
 * 逻辑名有两种：
 *   "samples" —— 仓库里的 samples/ 目录
 *   "ext"     —— 仓库外的扩展样本目录（环境变量 CARTOUCHE_EXT_SAMPLES 决定）
 * 没有 baseDir 的样本按老逻辑走（base ?? 'samples'），保持向后兼容。
 */
function resolveSampleBase(sample) {
  const logical = typeof sample.baseDir === 'string' ? sample.baseDir.trim() : '';
  if (logical === 'samples') return { dir: join(ROOT, 'samples'), label: 'samples' };
  if (logical === 'ext') return { dir: EXT_SAMPLES_DIR, label: 'ext' };
  if (logical !== '') {
    // 没登记过的逻辑名：当作仓库内的相对目录处理，并在报告里标出来，
    // 免得「文件没找到」与「逻辑名写错了」混成同一件事。
    return { dir: join(ROOT, logical), label: logical, unknownBase: true };
  }
  const legacy = typeof sample.base === 'string' && sample.base !== '' ? sample.base : 'samples';
  return { dir: join(ROOT, legacy), label: legacy };
}

/** 报告里展示用的路径：外部目录不写绝对路径。 */
function displayPath(label, entryRel) {
  if (label === 'ext') return `<外部目录>/${entryRel}`;
  return `${label}/${entryRel}`;
}

/* ────────────────────────── 第一层 ────────────────────────── */

async function evaluate(sample) {
  const isRemote = Boolean(sample.remote);
  const base = resolveSampleBase(sample);
  const path = isRemote
    ? (sample.vsicurl ?? sample.url)
    : join(base.dir, sample.expect.entry);
  const row = {
    id: sample.id,
    title: sample.title,
    kind: sample.kind,
    source: isRemote ? 'remote-cog' : sample.base === 'fixtures' ? 'synthetic' : 'local',
    path: isRemote ? (sample.vsicurl ?? sample.url) : displayPath(base.label, sample.expect.entry),
    checks: {},
    notes: [],
  };
  if (base.unknownBase) {
    row.notes.push(`manifest 里的 baseDir「${base.label}」没有登记，按仓库内目录处理`);
  }

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
  const tmp = mkdtemp('cartouche-eval-');
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

/* ────────────────────────── 第二层：op 评测 ────────────────────────── */

/** 22 个 op，按「通用 / 矢量侧 / 栅格侧」分组。 */
const OP_COMMON = ['dataset.open', 'dataset.healthCheck', 'dataset.snapshot', 'export.report'];
const OP_VECTOR = [
  'vector.query',
  'vector.addField',
  'vector.spatialJoin',
  'vector.reproject',
  'vector.renameFields',
  'vector.recode',
  'feature.setAttributes',
  'feature.delete',
  'feature.summarize',
];
const OP_RASTER = [
  'raster.paint',
  'raster.erase',
  'raster.replaceRegion',
  'raster.inpaint',
  'raster.adjustLevels',
  'raster.clip',
  'raster.resample',
  'raster.mosaic',
];
const OP_COLUMNS = [...OP_COMMON, 'export.image', ...OP_VECTOR, ...OP_RASTER];

/** 矩阵里的列名（短名，宽度固定，表格才排得开）。 */
const OP_ALIAS = {
  'dataset.open': 'open',
  'dataset.healthCheck': 'hc',
  'dataset.snapshot': 'snap',
  'export.image': 'img',
  'export.report': 'rep',
  'vector.query': 'query',
  'vector.addField': 'addF',
  'vector.spatialJoin': 'join',
  'vector.reproject': 'reprj',
  'vector.renameFields': 'renF',
  'vector.recode': 'recod',
  'feature.setAttributes': 'setA',
  'feature.delete': 'del',
  'feature.summarize': 'summ',
  'raster.paint': 'paint',
  'raster.erase': 'erase',
  'raster.replaceRegion': 'repl',
  'raster.inpaint': 'inpnt',
  'raster.adjustLevels': 'level',
  'raster.clip': 'clip',
  'raster.resample': 'resmp',
  'raster.mosaic': 'mosac',
};

/** 契约里的 15 项检查（dataset.healthCheck 只认这些）。 */
const HEALTH_CHECKS = [
  'crs-present',
  'crs-mismatch',
  'crs-range-sanity',
  'axis-order',
  'extent-plausibility',
  'systematic-offset',
  'encoding',
  'field-naming',
  'field-type',
  'default-fields',
  'null-geometry',
  'zero-area',
  'sharp-angle',
  'outlier-extent',
  'extent-compare',
];

/**
 * JS 运行时的报错长相。
 *
 * 为什么用消息长相来判「引擎崩了」：执行器把 op 抛出的异常压成一句 message
 * （类型名丢了），所以「引擎崩了」与「引擎明确拒绝」只能从消息内容上分。
 * 引擎自己写的拒绝消息全是中文人话，不会长成下面这些形态。
 */
const JS_CRASH_PATTERNS = [
  /Cannot read propert/i,
  /Cannot set propert/i,
  /Cannot destructure/i,
  /is not a function/i,
  /is not iterable/i,
  /is not defined/i,
  /undefined is not/i,
  /null is not/i,
  /Maximum call stack/i,
  /Invalid array length/i,
  /Assignment to constant/i,
  /circular structure/i,
  /out of memory/i,
  /Array buffer allocation failed/i,
  /\bat [A-Za-z_$][\w$]* \(/,
  /code: 'E[A-Z]+'/,
];

/** 消息长得像 JS 运行时错误 → 引擎崩了；否则是「明确拒绝」。 */
function looksLikeCrash(message) {
  const text = String(message ?? '');
  if (text.trim() === '') return true;
  return JS_CRASH_PATTERNS.some((re) => re.test(text));
}

/** 同一主名的数据伴随文件（Shapefile 的 .shx/.dbf、.prj/.cpg、世界文件…）。 */
const SIDECAR_SUFFIXES = [
  '.prj',
  '.cpg',
  '.tfw',
  '.wld',
  '.tifw',
  '.jgw',
  '.aux.xml',
  '.shx',
  '.dbf',
  '.sbn',
  '.sbx',
  '.qix',
  '.fbn',
  '.fbx',
  '.ain',
  '.aih',
  '.ixs',
  '.mxs',
  '.atx',
];

function findSidecars(absFile) {
  const dir = dirname(absFile);
  const base = basename(absFile);
  const stem = base.replace(/\.[^.]+$/, '');
  const out = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === base) continue;
    if (!name.startsWith(`${stem}.`)) continue;
    const lower = name.toLowerCase();
    if (lower.endsWith('.lock') || lower.endsWith('.lck')) continue;
    if (!SIDECAR_SUFFIXES.some((ext) => lower.endsWith(ext))) continue;
    out.push(join(dir, name));
  }
  return out;
}

/** 字段名写进条件时的安全写法：不是普通标识符就用方括号括起来。 */
function identInWhere(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `[${name}]`;
}

/**
 * 挑一个能拿来做条件的列。
 *
 * 条件能不能算得出来，取决于**每一条要素**：
 *   - 列得每条都有：GeoJSON 转出来时空值那一列整个不写（DataV 的国家那条要素
 *     就只剩 adcode/name/adchar），引用到缺列的要素上引擎会直接报错；
 *   - 类型得每条一致：同一列里有数字又有文字，比的时候类型对不上，引擎也会报错。
 * 引擎这两处都做得对（宁可报错也不猜），但这一轮问的是「op 能不能跑通」，
 * 所以要挑一列**每条要素都有、类型又一致**的来当条件。
 *
 * 另一个坑：写回时的值要符合**列的类型**（数字列写不进文字），
 * 而条件里的常量要符合**值的类型**。两者分开算。
 */
function pickAnchorField(features, fields) {
  const total = features.length;
  const typeOf = (name) => {
    const hit = fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
    return String(hit?.type ?? '');
  };
  const stats = new Map();
  for (const f of features) {
    for (const [name, value] of Object.entries(f.properties ?? {})) {
      if (value === null || value === undefined) continue;
      const s = stats.get(name) ?? { types: new Map(), filled: 0 };
      s.filled += 1;
      const t =
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? typeof value
          : 'other';
      s.types.set(t, (s.types.get(t) ?? 0) + 1);
      stats.set(name, s);
    }
  }
  const candidates = [];
  for (const [name, s] of stats) {
    if (s.filled !== total) continue;
    if (s.types.size !== 1) continue;
    const type = [...s.types.keys()][0];
    if (type === 'other') continue;
    candidates.push({ name, type });
  }
  // 数值列优先：不用转义，条件最不容易被引号坑到
  candidates.sort((a, b) => (a.type === 'number' ? 0 : 1) - (b.type === 'number' ? 0 : 1));

  for (const cand of candidates) {
    const raw = features
      .map((f) => f.properties?.[cand.name])
      .find((v) => v !== null && v !== undefined);
    if (raw === undefined) continue;
    const columnType = typeOf(cand.name);
    const numericColumn = /integer|int|real|float|double|decimal|numeric/i.test(columnType);
    let where;
    let newValue;
    if (cand.type === 'number') {
      where = `${identInWhere(cand.name)} = ${raw}`;
      newValue = numericColumn ? Number(raw) + 1 : `${raw}_eval`;
    } else if (cand.type === 'string') {
      where = `${identInWhere(cand.name)} = '${String(raw).replace(/'/g, "''")}'`;
      newValue = numericColumn ? Number(raw) + 1 : `${raw}_eval`;
    } else {
      where = `${identInWhere(cand.name)} = ${raw ? 'TRUE' : 'FALSE'}`;
      newValue = !raw;
    }
    return { name: cand.name, where, oldValue: raw, newValue, kind: cand.type, columnType };
  }
  return null;
}

/** 几何的第一个坐标点（用来核对「坐标真的变了」）。 */
function firstVertex(features) {
  for (const f of features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    const stack = [g.coordinates];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (typeof cur === 'number') return cur;
      if (Array.isArray(cur)) {
        for (let i = cur.length - 1; i >= 0; i -= 1) stack.push(cur[i]);
      }
    }
  }
  return null;
}

/** 一幅栅格某个矩形区域的 0 波段求和（用来核对「那一块真的变了」）。 */
function regionSum(px, region) {
  const band = px.bands[0];
  if (!band) return null;
  let sum = 0;
  for (let y = region.minY; y < region.maxY; y += 1) {
    if (y < 0 || y >= px.height) continue;
    for (let x = region.minX; x < region.maxX; x += 1) {
      if (x < 0 || x >= px.width) continue;
      sum += band[y * px.width + x] ?? 0;
    }
  }
  return sum;
}

/**
 * 挑一块「有内容」的矩形当改动区。
 *
 * 为什么不能随便取一块：地图边角常常是一整片纯色（深海、空白区），
 * 在那种地方做修补，像元值前后一模一样 —— 引擎会报「改了 0 像元」，
 * 看起来像失败，其实是这块地本来就没有可改的东西。
 * 所以挑方差最大的一块：有纹理的地方才谈得上「改动有没有发生」。
 */
function pickTexturedRegion(px, size = 10) {
  const width = px?.width ?? 0;
  const height = px?.height ?? 0;
  const band = px?.bands?.[0];
  if (!band || width < size || height < size) {
    return {
      minX: 0,
      minY: 0,
      maxX: Math.max(1, Math.min(size, width)),
      maxY: Math.max(1, Math.min(size, height)),
    };
  }
  let best = null;
  for (let gy = 0; gy < 8; gy += 1) {
    for (let gx = 0; gx < 8; gx += 1) {
      const minX = Math.min(width - size, Math.floor((gx * (width - size)) / 7));
      const minY = Math.min(height - size, Math.floor((gy * (height - size)) / 7));
      const region = { minX, minY, maxX: minX + size, maxY: minY + size };
      const sum = regionSum(px, region) ?? 0;
      const sumSq = regionSumSq(px, region);
      const variance = sumSq - (sum * sum) / (size * size);
      if (!best || variance > best.variance) best = { region, variance };
    }
  }
  return best?.region ?? { minX: 0, minY: 0, maxX: size, maxY: size };
}

/** 区域像元的平方和（与求和一起算方差）。 */
function regionSumSq(px, region) {
  const band = px.bands[0];
  if (!band) return 0;
  let sum = 0;
  for (let y = region.minY; y < region.maxY; y += 1) {
    if (y < 0 || y >= px.height) continue;
    for (let x = region.minX; x < region.maxX; x += 1) {
      if (x < 0 || x >= px.width) continue;
      const v = band[y * px.width + x] ?? 0;
      sum += v * v;
    }
  }
  return sum;
}

/** 仿射参数 → 地理范围。 */
function bboxFromGeoTransform(gt, width, height) {
  const [originX, pixelW, , originY, , pixelH] = gt;
  const xs = [originX, originX + pixelW * width];
  const ys = [originY, originY + pixelH * height];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** 超时哨兵。 */
const TIMEOUT_MARK = '__cartouche_op_timeout__';

/**
 * 执行一条 op 的工作线程脚本。
 *
 * 为什么要单独开线程：**引擎里有的 op 是纯 CPU 计算**（空间连接是逐对扫描），
 * 要素一多就能把事件循环占满几十分钟。这时候在主进程里设的 setTimeout 根本不会触发 ——
 * 定时器要等事件循环空下来才有机会跑。主进程被堵住，超时就是一句空话，
 * 评测会永远卡在那里（实测：25 万要素的空间连接把整个评测挂住了）。
 *
 * 放到 worker 里就两件事都成立：主线程一直醒着，超时一到 terminate() 就能把
 * 线程掐掉（V8 的 TerminateExecution 能打断正在跑的同步循环）。
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const engine = await import(workerData.engineUrl);
    const loc = engine.resolveGdal();
    if (!loc) throw new Error('找不到 GDAL');
    const store = new engine.LocalFolderStore(workerData.workRoot);
    const result = await engine.executePlan(
      { loc, store, confirmed: true },
      { op: workerData.op, params: workerData.params },
    );
    parentPort.postMessage({ type: 'result', result });
  } catch (err) {
    parentPort.postMessage({
      type: 'error',
      message: String((err && err.message) || err),
      stack: String((err && err.stack) || ''),
    });
  }
})();
`;

/**
 * 在工作线程里跑一条 op，带硬超时。
 *
 * @returns {Promise<{type: 'result'|'error'|'timeout'|'exit', result?: unknown, message?: string}>}
 */
function runOpInWorker({ engineUrl, workRoot, op, params, timeoutMs }) {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { engineUrl, workRoot, op, params },
    });
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(payload);
    };
    const timer = setTimeout(
      () => finish({ type: 'timeout', message: `超过 ${Math.round(timeoutMs / 1000)} 秒没有返回` }),
      timeoutMs,
    );
    worker.on('message', (msg) => finish(msg));
    worker.on('error', (err) => finish({ type: 'error', message: String(err?.message ?? err) }));
    worker.on('exit', (code) => {
      if (!settled) finish({ type: 'exit', message: `工作线程退出了（code=${code}），没有结果` });
    });
  });
}

/* ── op 计划构造 ── */

/**
 * 矢量侧的 op 计划。
 *
 * @param {object} ds 待测数据集
 * @param {object} ctx 上下文：锚点字段、改名列、分组列、连接用的第二份图层
 */
function vectorOpCases(ds, ctx) {
  const target = ds.entryRel;
  const cases = [];

  cases.push({
    op: 'dataset.open',
    caseKind: 'primary',
    params: { targets: [target] },
    verify: async (env) => {
      const info = env.record.value?.data?.datasets?.[0];
      if (!info) return { ok: false, note: '结果里没有数据集信息' };
      return { ok: true, note: `打开成功：${info.driver}（${info.kind}）` };
    },
  });

  cases.push({
    op: 'dataset.healthCheck',
    caseKind: 'primary',
    params: { target, checks: HEALTH_CHECKS },
    verify: async (env) => {
      const data = env.record.value?.data;
      if (!data || !Array.isArray(data.findings)) return { ok: false, note: '结果里没有体检条目' };
      return {
        ok: true,
        note: `体检 ${data.findings.length} 条发现、阻断 ${data.hasBlocker ? '有' : '无'}`,
      };
    },
  });

  cases.push({
    op: 'dataset.snapshot',
    caseKind: 'primary',
    params: { target, label: 'eval' },
    verify: async (env) => {
      const files = env.record.value?.data?.files ?? [];
      const missing = files.filter((f) => !existsSync(env.abs(f)));
      if (missing.length > 0) return { ok: false, note: `快照缺文件：${missing.join('、')}` };
      return { ok: true, note: `快照 ${files.length} 个文件都在` };
    },
  });

  cases.push({
    op: 'export.report',
    caseKind: 'primary',
    params: { target, kind: 'csv', format: 'csv' },
    verify: async (env) => {
      const out = env.record.value?.outputPath;
      if (!out) return { ok: false, note: '结果里没有产出文件路径' };
      if (!existsSync(env.abs(out))) return { ok: false, note: `产出文件不存在：${out}` };
      const size = statSync(env.abs(out)).size;
      if (size <= 0) return { ok: false, note: '产出文件是空的' };
      return { ok: true, note: `属性表已导出（${size} 字节）` };
    },
  });

  cases.push({
    op: 'vector.query',
    caseKind: 'primary',
    params: ctx.anchor ? { target, where: ctx.anchor.where, limit: 50 } : { target, limit: 50 },
    verify: async (env) => {
      const data = env.record.value?.data;
      if (!data || typeof data.featureCount !== 'number') {
        return { ok: false, note: '结果里没有要素条数' };
      }
      const listLen = Array.isArray(data.features) ? data.features.length : -1;
      if (listLen !== data.featureCount) {
        return { ok: false, note: `报 ${data.featureCount} 条但只给了 ${listLen} 条` };
      }
      return {
        ok: true,
        note: ctx.anchor
          ? `按条件查到 ${data.featureCount} 条（条件：${ctx.anchor.where}）`
          : `查到 ${data.featureCount} 条`,
      };
    },
  });

  if (ctx.anchor) {
    const anchor = ctx.anchor;

    cases.push({
      op: 'vector.addField',
      caseKind: 'primary',
      params: { target, name: 'eval_flag', expression: '1' },
      verify: async (env) => {
        const info = await probeLayer(env.loc, env.abs(target)).catch(() => null);
        if (!info) return { ok: false, note: '写回之后打不开图层' };
        if (!info.fields.some((f) => f.name.toLowerCase() === 'eval_flag')) {
          return {
            ok: false,
            note: `写回之后没有 eval_flag 这一列（现有：${info.fields.map((f) => f.name).join('、')}）`,
          };
        }
        const read = await readFeatures(env.loc, { path: env.abs(target) }).catch(() => null);
        const filled = (read?.features ?? []).filter(
          (f) => f.properties['eval_flag'] !== null && f.properties['eval_flag'] !== undefined,
        );
        if (filled.length === 0) return { ok: false, note: '新列存在但没有任何要素被赋值' };
        return { ok: true, note: `新列 eval_flag 已写入，${filled.length} 条要素有值` };
      },
    });

    cases.push({
      op: 'vector.spatialJoin',
      caseKind: 'primary',
      params: {
        target: ctx.joinTargetRel,
        source: target,
        relation: 'intersects',
        aggregate: 'count',
        fieldPrefix: 'evalj',
      },
      verify: async (env) => {
        const info = await probeLayer(env.loc, env.abs(ctx.joinTargetRel)).catch(() => null);
        if (!info) return { ok: false, note: '写回之后打不开目标图层' };
        const added = info.fields.filter((f) => f.name.toLowerCase().startsWith('evalj'));
        if (added.length === 0) {
          return {
            ok: false,
            note: `目标图层没有新增汇总列（现有：${info.fields.map((f) => f.name).join('、')}）`,
          };
        }
        const matched = env.record.value?.data?.matched;
        return { ok: true, note: `连接列 ${added.map((f) => f.name).join('、')} 已写入，匹配 ${matched} 条` };
      },
    });

    cases.push({
      op: 'feature.setAttributes',
      caseKind: 'primary',
      params: { target, where: anchor.where, set: { [anchor.name]: anchor.newValue } },
      verify: async (env) => {
        const read = await readFeatures(env.loc, { path: env.abs(target) }).catch(() => null);
        if (!read) return { ok: false, note: '写回之后读不回要素' };
        if (read.features.length !== ctx.preFeatureCount) {
          return {
            ok: false,
            note: `改属性的同时要素数变了（${ctx.preFeatureCount} → ${read.features.length}）`,
          };
        }
        const hit = read.features.filter(
          (f) => String(f.properties[anchor.name]) === String(anchor.newValue),
        );
        if (hit.length === 0) {
          return { ok: false, note: `没有要素的「${anchor.name}」变成 ${anchor.newValue}` };
        }
        return { ok: true, note: `「${anchor.name}」已改成 ${anchor.newValue}（${hit.length} 条）` };
      },
    });

    cases.push({
      op: 'feature.delete',
      caseKind: 'primary',
      params: { target, where: anchor.where },
      verify: async (env) => {
        const read = await readFeatures(env.loc, { path: env.abs(target) }).catch(() => null);
        if (!read) return { ok: false, note: '写回之后读不回要素' };
        const claimed = env.record.value?.data?.remaining;
        const deleted = env.record.value?.data?.deleted;
        if (typeof deleted !== 'number' || deleted < 1) {
          return { ok: false, note: `报告删了 ${deleted} 条（应为正数）` };
        }
        if (typeof claimed === 'number' && read.features.length !== claimed) {
          return {
            ok: false,
            note: `文件里剩 ${read.features.length} 条，报告说剩 ${claimed} 条`,
          };
        }
        if (read.features.length >= ctx.preFeatureCount) {
          return { ok: false, note: '要素数没减少' };
        }
        return {
          ok: true,
          note: `删掉 ${deleted} 条（${ctx.preFeatureCount} → ${read.features.length}）`,
        };
      },
    });
  }

  /* ── 下面这几条不依赖「第一条要素的值」：
     空图层（0 个要素）、没有属性列的图层也照样要能跑，
     所以它们放在锚点条件之外。 ── */

  cases.push({
    op: 'vector.reproject',
    caseKind: 'primary',
    params: { target, to: 'EPSG:3857' },
    verify: async (env) => {
      const info = await probeLayer(env.loc, env.abs(target)).catch(() => null);
      if (!info) return { ok: false, note: '写回之后打不开图层' };
      if (info.epsg !== 3857 && !(info.srsWkt ?? '').includes('3857')) {
        return { ok: false, note: `写回之后坐标系不是 3857（现在是 ${info.epsg ?? '认不出'}）` };
      }
      const read = await readFeatures(env.loc, { path: env.abs(target) }).catch(() => null);
      const after = firstVertex(read?.features);
      const before = firstVertex(ctx.preFeatures);
      if (before !== null && after !== null && before === after) {
        return { ok: false, note: `坐标系标签变了但坐标没变（${before} → ${after}）` };
      }
      return { ok: true, note: `坐标系已转到 3857，坐标 ${before} → ${after}` };
    },
  });

  if (ctx.renameFrom) {
    cases.push({
      op: 'vector.renameFields',
      caseKind: 'primary',
      params: { target, mapping: { [ctx.renameFrom]: ctx.renameTo } },
      verify: async (env) => {
        const info = await probeLayer(env.loc, env.abs(target)).catch(() => null);
        if (!info) return { ok: false, note: '写回之后打不开图层' };
        const names = info.fields.map((f) => f.name.toLowerCase());
        if (names.includes(ctx.renameFrom.toLowerCase())) {
          return { ok: false, note: `旧列名「${ctx.renameFrom}」还在` };
        }
        if (!names.includes(ctx.renameTo.toLowerCase())) {
          return {
            ok: false,
            note: `新列名「${ctx.renameTo}」没找到（现有：${info.fields.map((f) => f.name).join('、')}）`,
          };
        }
        return { ok: true, note: `「${ctx.renameFrom}」已改名为「${ctx.renameTo}」` };
      },
    });
  }

  cases.push({
    op: 'vector.recode',
    caseKind: 'primary',
    params: { target, to: 'UTF-8' },
    verify: async (env) => {
      // probeDataset 返回的是 { dataset, error }，取里面的 dataset 才是图层信息。
      const probe = await probeDataset(env.loc, env.abs(target)).catch(() => null);
      const info = probe?.dataset;
      if (!info || info.kind !== 'vector') {
        return { ok: false, note: '写回之后认不出矢量图层' };
      }
      const enc = String(info.encoding ?? '').toUpperCase();
      if (!enc.includes('UTF-8')) {
        return { ok: false, note: `写回之后编码不是 UTF-8（现在是 ${info.encoding}）` };
      }
      return { ok: true, note: '属性表已是 UTF-8' };
    },
  });

  if (ctx.groupBy) {
    cases.push({
      op: 'feature.summarize',
      caseKind: 'primary',
      params: { target, groupBy: [ctx.groupBy], aggregates: ['count'] },
      verify: async (env) => {
        const data = env.record.value?.data;
        if (!data || !Array.isArray(data.rows)) return { ok: false, note: '结果里没有汇总行' };
        if (data.rows.length !== data.groupCount) {
          return { ok: false, note: `报 ${data.groupCount} 组但给了 ${data.rows.length} 行` };
        }
        return { ok: true, note: `按「${ctx.groupBy}」分成 ${data.groupCount} 组` };
      },
    });
  }

  /* 刁难探针：引擎应该明确拒绝，而不是崩了或者闷头改。 */
  cases.push({
    op: 'vector.query',
    caseKind: 'probe',
    params: { target, where: '[eval_no_such_column] = 1' },
    verify: async () => ({ ok: false, note: '条件列不存在时居然查成功了' }),
  });

  cases.push({
    op: 'vector.addField',
    caseKind: 'probe',
    params: { target, name: 'eval_probe', expression: '[eval_no_such_column] + 1' },
    verify: async () => ({ ok: false, note: '表达式引用不存在的列时居然加成功了' }),
  });

  if (ctx.groupBy) {
    /* 探针：没有数值列时求 sum 必须明确拒绝，不能返回一列全是 0 的表冒充成功。 */
    cases.push({
      op: 'feature.summarize',
      caseKind: 'probe',
      params: { target, groupBy: [ctx.groupBy], aggregates: ['sum'] },
      verify: async (env) => {
        const data = env.record.value?.data;
        if (!data || !Array.isArray(data.rows)) return { ok: false, note: '结果里没有汇总行' };
        const columns = data.columns ?? [];
        const sums = columns.filter((c) => c.startsWith('sum_'));
        if (sums.length === 0) return { ok: true, note: '没有数值列，引擎已明确报错' };
        // 这一层到底有没有数值列？（按图层自己的列类型判，不能只看结果）
        const info = await probeLayer(env.loc, env.abs(target)).catch(() => null);
        const numeric = (info?.fields ?? []).filter((f) =>
          /integer|int|real|float|double|decimal|numeric/i.test(String(f.type)),
        );
        const allZero = data.rows.every((row) => sums.every((c) => row[c] === null || row[c] === 0));
        if (numeric.length === 0 && data.rows.length > 0 && allZero) {
          return { ok: false, note: '这一层没有数值列，却算出了全是 0 的求和列' };
        }
        return { ok: true, note: `求和列 ${sums.join('、')}（这一层数值列 ${numeric.length} 个）` };
      },
    });
  }

  return cases;
}

/** 栅格侧的 op 计划。 */
function rasterOpCases(ds, ctx) {
  const target = ds.entryRel;
  const region = ctx.region;
  const cases = [];

  cases.push({
    op: 'dataset.open',
    caseKind: 'primary',
    params: { targets: [target] },
    verify: async (env) => {
      const info = env.record.value?.data?.datasets?.[0];
      if (!info) return { ok: false, note: '结果里没有数据集信息' };
      return { ok: true, note: `打开成功：${info.driver} ${info.width}×${info.height}` };
    },
  });

  cases.push({
    op: 'dataset.healthCheck',
    caseKind: 'primary',
    params: { target, checks: HEALTH_CHECKS },
    verify: async (env) => {
      const data = env.record.value?.data;
      if (!data || !Array.isArray(data.findings)) return { ok: false, note: '结果里没有体检条目' };
      return {
        ok: true,
        note: `体检 ${data.findings.length} 条发现、阻断 ${data.hasBlocker ? '有' : '无'}`,
      };
    },
  });

  cases.push({
    op: 'dataset.snapshot',
    caseKind: 'primary',
    params: { target, label: 'eval' },
    verify: async (env) => {
      const files = env.record.value?.data?.files ?? [];
      const missing = files.filter((f) => !existsSync(env.abs(f)));
      if (missing.length > 0) return { ok: false, note: `快照缺文件：${missing.join('、')}` };
      return { ok: true, note: `快照 ${files.length} 个文件都在` };
    },
  });

  cases.push({
    op: 'export.image',
    caseKind: 'primary',
    params: { target, format: 'png' },
    verify: async (env) => {
      const out = env.record.value?.outputPath;
      if (!out) return { ok: false, note: '结果里没有产出文件路径' };
      if (!existsSync(env.abs(out))) return { ok: false, note: `产出文件不存在：${out}` };
      const size = statSync(env.abs(out)).size;
      if (size <= 0) return { ok: false, note: '产出文件是空的' };
      return { ok: true, note: `已出图（${size} 字节）` };
    },
  });

  cases.push({
    op: 'export.report',
    caseKind: 'primary',
    params: { target, kind: 'compat-report', format: 'html' },
    verify: async (env) => {
      const out = env.record.value?.outputPath;
      if (!out) return { ok: false, note: '结果里没有产出文件路径' };
      if (!existsSync(env.abs(out))) return { ok: false, note: `产出文件不存在：${out}` };
      const size = statSync(env.abs(out)).size;
      if (size <= 0) return { ok: false, note: '产出文件是空的' };
      return { ok: true, note: `已出兼容性报告（${size} 字节）` };
    },
  });

  /** 像元级改动：核对「那一块真的变了」。 */
  const pixelCase = (op, params, label) => ({
    op,
    caseKind: 'primary',
    params,
    verify: async (env) => {
      const impact = env.record.impact;
      if (!impact) return { ok: false, note: '结果里没有影响面' };
      if (!(impact.affectedPixels > 0)) {
        return { ok: false, note: `报告改了 ${impact.affectedPixels} 个像元（应为正数）` };
      }
      const after = await readRasterPixels(env.loc, env.abs(target)).catch(() => null);
      if (!after) return { ok: false, note: '改完之后读不回像素' };
      const afterSum = regionSum(after, region);
      const beforeSum = ctx.preRegionSum;
      const sumChanged = beforeSum !== null && afterSum !== null && beforeSum !== afterSum;
      const checksumChanged = impact.checksumBefore !== impact.checksumAfter;
      if (!sumChanged && !checksumChanged) {
        return { ok: false, note: `区域像元与整图校验和都没变（和都是 ${beforeSum}）` };
      }
      return {
        ok: true,
        note: `${label}：区域像元和 ${beforeSum} → ${afterSum}，影响 ${impact.affectedPixels} 像元`,
      };
    },
  });

  cases.push(pixelCase('raster.paint', { target, region, color: '#FF0000' }, '涂色'));
  cases.push(pixelCase('raster.erase', { target, region }, '擦除'));
  cases.push(
    pixelCase('raster.replaceRegion', { target, source: ctx.replaceSrcRel, region }, '区域替换'),
  );
  cases.push(pixelCase('raster.inpaint', { target, region, radiusPx: 2 }, '边界修补'));
  cases.push(pixelCase('raster.adjustLevels', { target, brightness: 10 }, '亮度调整'));

  cases.push({
    op: 'raster.clip',
    caseKind: 'primary',
    params: { target, bbox: ctx.clipBbox },
    verify: async (env) => {
      const impact = env.record.impact;
      if (!impact) return { ok: false, note: '结果里没有影响面' };
      if (impact.width >= ctx.preWidth || impact.height >= ctx.preHeight) {
        return {
          ok: false,
          note: `裁切后尺寸没变小（${ctx.preWidth}×${ctx.preHeight} → ${impact.width}×${impact.height}）`,
        };
      }
      return { ok: true, note: `裁切后 ${impact.width}×${impact.height}` };
    },
  });

  cases.push({
    op: 'raster.resample',
    caseKind: 'primary',
    params: { target, targetResolution: ctx.targetResolution },
    verify: async (env) => {
      const impact = env.record.impact;
      if (!impact) return { ok: false, note: '结果里没有影响面' };
      if (impact.width === ctx.preWidth && impact.height === ctx.preHeight) {
        return { ok: false, note: '重采样后尺寸没变' };
      }
      return {
        ok: true,
        note: `重采样后 ${impact.width}×${impact.height}（原来 ${ctx.preWidth}×${ctx.preHeight}）`,
      };
    },
  });

  cases.push({
    op: 'raster.mosaic',
    caseKind: 'primary',
    params: { inputs: [target, ctx.mosaicRel], output: ctx.mosaicOutRel },
    verify: async (env) => {
      const outAbs = env.abs(ctx.mosaicOutRel);
      if (!existsSync(outAbs)) return { ok: false, note: '拼接没有产出文件' };
      const size = statSync(outAbs).size;
      if (size <= 0) return { ok: false, note: '拼接产出是空文件' };
      return { ok: true, note: `已拼接（${fmtBytes(size)}）` };
    },
  });

  /* 刁难探针：区域落在影像之外，引擎应该明确说「不在图上」，而不是闷头改 0 像元。 */
  cases.push({
    op: 'raster.paint',
    caseKind: 'probe',
    params: {
      target,
      region: {
        minX: ctx.preWidth + 1000,
        minY: ctx.preHeight + 1000,
        maxX: ctx.preWidth + 1100,
        maxY: ctx.preHeight + 1100,
      },
      color: '#00FF00',
    },
    verify: async () => ({ ok: false, note: '区域落在影像之外时居然涂成功了' }),
  });

  return cases;
}

/* ── 单条 op 的执行与判定 ── */

async function runOpCase(ds, opCase, env, opIndex) {
  const record = {
    dataset: ds.id,
    datasetTitle: ds.title,
    op: opCase.op,
    case: opCase.caseKind,
    verdict: 'CRASH',
    durationMs: 0,
    error: null,
    note: '',
  };
  const started = Date.now();

  // 一条 op 出问题不能把整轮评测带崩 —— 后面的 op 还得跑，
  // 否则一个数据集的怪癖就把所有数据集的结论一起吃掉了。
  try {
    // 每条 op 用**自己的工作目录**：上一条 op 被掐断后留下的半成品文件
    // （还有它 spawn 出去、仍在后台跑的 GDAL 子进程）不会挡住下一条 op。
    const workRoot = join(env.dsRoot, 'work', String(opIndex));
    rmWithRetry(workRoot);
    mkdirSync(workRoot, { recursive: true });
    copyTree(env.stageRoot, workRoot);

    let planResult = null;
    let thrown = null;
    let timedOut = false;
    const outcome = await runOpInWorker({
      engineUrl: ENGINE_URL,
      workRoot,
      op: opCase.op,
      params: opCase.params,
      timeoutMs: OP_TIMEOUT_MS,
    });
    if (outcome.type === 'result') {
      planResult = outcome.result;
    } else if (outcome.type === 'timeout') {
      timedOut = true;
      thrown = new Error(`${TIMEOUT_MARK} ${opCase.op}`);
    } else {
      thrown = new Error(outcome.message ?? '工作线程没有返回结果');
    }
    record.durationMs = Date.now() - started;

    if (thrown) {
      const msg = String(thrown?.message ?? thrown);
      if (timedOut || msg.startsWith(TIMEOUT_MARK)) {
        record.verdict = 'CRASH';
        record.crashKind = 'timeout';
        record.error = `超时：${opCase.op} 超过 ${Math.round(OP_TIMEOUT_MS / 1000)} 秒没有返回（已掐断工作线程）`;
        record.note = record.error;
      } else {
        record.verdict = 'CRASH';
        record.crashKind = 'threw';
        record.error = msg;
        record.note = msg;
      }
      return record;
    }

    const first = planResult?.results?.[0];
    if (!first) {
      record.verdict = 'CRASH';
      record.crashKind = 'no-result';
      record.error = '执行器没有返回任何一条结果';
      record.note = record.error;
      return record;
    }

    if (!first.ok) {
      const msg = String(first.error ?? '（没有错误说明）');
      record.error = msg;
      if (first.unimplemented) {
        record.verdict = 'REJECT';
        record.rejectKind = 'unimplemented';
        record.note = msg;
      } else if (looksLikeCrash(msg)) {
        record.verdict = 'CRASH';
        record.crashKind = 'js-error';
        record.note = msg;
      } else {
        record.verdict = 'REJECT';
        record.rejectKind = 'guard';
        record.note = msg;
      }
      return record;
    }

    /* 引擎说成功了 —— 但「成功」必须能被验证，否则就是静默失败。 */
    const env2 = {
      ...env,
      record: first,
      abs: (rel) => join(workRoot, rel),
      loc,
    };
    /* 体检结论另算一档：体检 op 跑成功 ≠ 数据没问题，
       得看它到底报出了什么（阻断 / 错误 / 提示 / 干净）。 */
    if (opCase.op === 'dataset.healthCheck') {
      const findings = first.value?.data?.findings ?? [];
      const severities = new Set(findings.map((f) => f.severity));
      record.healthVerdict = first.value?.data?.hasBlocker
        ? 'BLOCK'
        : severities.has('error')
          ? 'ERROR'
          : severities.has('warn')
            ? 'WARN'
            : 'PASS';
    }
    try {
      const v = await opCase.verify(env2);
      if (v.ok) {
        record.verdict = 'PASS';
        record.note = v.note;
      } else {
        record.verdict = 'CRASH';
        record.crashKind = 'silent-failure';
        record.note = `引擎报成功，但验证不过：${v.note}`;
      }
    } catch (err) {
      record.verdict = 'CRASH';
      record.crashKind = 'unverifiable';
      record.error = `验证过程自身出错：${String(err?.message ?? err)}`;
      record.note = '引擎报成功，但这次评测没能独立验证结果';
    }
    return record;
  } catch (err) {
    record.durationMs = Date.now() - started;
    record.verdict = 'CRASH';
    record.crashKind = 'harness';
    record.error = `评测脚本自身出错：${String(err?.message ?? err)}`;
    record.note = record.error;
    return record;
  }
}

/* ── 数据集的准备与 op 阶段的编排 ── */

/**
 * 组装待测数据集清单。
 *
 * 两个来源：manifest 里的公开样本 + 刁难数据集清单（存在才读）。
 */
function collectDatasets() {
  const out = [];

  for (const s of manifest.samples) {
    const base = resolveSampleBase(s);
    const isRemote = Boolean(s.remote);
    const entry = s.expect?.entry ?? (isRemote ? basename(s.url ?? 'remote') : null);
    if (!entry) continue;
    out.push({
      id: s.id,
      title: s.title,
      kind: s.kind,
      origin: 'manifest',
      remote: isRemote,
      vsicurl: isRemote ? (s.vsicurl ?? s.url) : null,
      absPath: isRemote ? null : join(base.dir, entry),
      entryRel: entry,
      display: displayPath(base.label, entry),
      expected: null,
      focus: s.focus ?? [],
    });
  }

  const hard = loadHardcases();
  for (const c of hard) {
    out.push({
      id: c.id,
      title: c.title ?? c.id,
      kind: c.kind,
      origin: 'hardcase',
      remote: false,
      vsicurl: null,
      absPath: join(c.root, c.entry),
      entryRel: c.entry,
      display: `<刁难数据集>/${c.entry}`,
      expected: c.expected ?? null,
      focus: c.focus ?? [],
    });
  }

  return out;
}

/** 读刁难数据集清单；文件不在就当没有这一批，不报错退出。 */
function loadHardcases() {
  if (!existsSync(HARDCASES_MANIFEST)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(HARDCASES_MANIFEST, 'utf8'));
  } catch (err) {
    console.error(`[warn] 刁难数据集清单读不出来，跳过：${String(err.message)}`);
    return [];
  }
  const cases = Array.isArray(parsed?.cases) ? parsed.cases : [];
  return cases.filter((c) => c && typeof c.entry === 'string' && typeof c.root === 'string');
}

/** 为一个数据集准备 op 阶段的工作区与上下文。 */
async function prepareDataset(ds, tmpRoot) {
  const dsRoot = join(tmpRoot, safeId(ds.id));
  const stageRoot = join(dsRoot, 'stage');
  const workRoot = join(dsRoot, 'work');
  rmWithRetry(dsRoot);
  mkdirSync(stageRoot, { recursive: true });
  mkdirSync(workRoot, { recursive: true });

  const ctx = {
    ds,
    dsRoot,
    stageRoot,
    workRoot,
    abs: (rel) => join(workRoot, rel),
  };

  /* 拷贝主文件 + 伴随文件到 stage（原始数据只读，不动）。 */
  const targetAbs = join(stageRoot, ds.entryRel);
  mkdirSync(dirname(targetAbs), { recursive: true });
  copyFileSync(ds.absPath, targetAbs);
  const sidecars = findSidecars(ds.absPath);
  for (const sc of sidecars) {
    const dest = join(stageRoot, dirname(ds.entryRel), basename(sc));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(sc, dest);
  }

  const probe = await probeDataset(loc, targetAbs);
  if (!probe.dataset) {
    return { ...ctx, openError: probe.error?.message ?? '打不开', cases: [] };
  }
  let info = probe.dataset;

  if (info.kind === 'vector') {
    const layer = await probeLayer(loc, targetAbs).catch(() => null);
    // 多取一些要素：挑条件列要看类型是否一致，只看一条不够。
    const read = await readFeatures(loc, { path: targetAbs, limit: 5000 }).catch(() => null);
    const features = read?.features ?? [];
    const fields = layer?.fields ?? [];
    const anchor = pickAnchorField(features, fields);

    /* 空间连接需要两个不同的图层：把数据集整份复制一份当被连接的目标。 */
    const joinTargetRel = `_join/${basename(ds.entryRel)}`;
    const joinDir = join(stageRoot, '_join');
    mkdirSync(joinDir, { recursive: true });
    copyFileSync(targetAbs, join(joinDir, basename(ds.entryRel)));
    for (const sc of sidecars) {
      copyFileSync(sc, join(joinDir, basename(sc)));
    }

    return {
      ...ctx,
      kind: 'vector',
      info,
      cases: vectorOpCases(ds, {
        anchor,
        joinTargetRel,
        preFeatures: features,
        preFeatureCount: layer?.featureCount ?? 0,
        // 改名的目标列要短：Shapefile 的列名上限 10 字节。
        renameFrom: fields[0]?.name ?? '',
        renameTo: 'ev_f1',
        groupBy:
          fields.find((f) => /string|text/i.test(f.type))?.name ?? fields[0]?.name ?? '',
      }),
    };
  }

  /* 栅格：太大了就做一份降采样的代理，否则 op 跑一次要几分钟。 */
  const totalPixels = info.width * info.height;
  const notes = [];
  if (totalPixels > OP_RASTER_BUDGET) {
    const scale = Math.sqrt(OP_RASTER_BUDGET / totalPixels);
    const w = Math.max(1, Math.round(info.width * scale));
    const h = Math.max(1, Math.round(info.height * scale));
    const proxyAbs = `${targetAbs}.proxy.tif`;
    const res = await gdal.translate(['-of', 'GTiff', '-outsize', String(w), String(h), targetAbs, proxyAbs]);
    if (!res.ok) {
      return { ...ctx, kind: 'raster', info, cases: [], openError: `降采样失败：${res.stderr}` };
    }
    rmSync(targetAbs, { force: true });
    copyFileSync(proxyAbs, targetAbs);
    rmSync(proxyAbs, { force: true });
    notes.push(
      `源图 ${info.width}×${info.height}（${totalPixels.toLocaleString()} 像元）超出 op 层预算，已降采样到 ${w}×${h} 代理后跑 op`,
    );
    const after = await probeDataset(loc, targetAbs);
    info = after.dataset ?? info;
  }

  const native = await nativeMeta(targetAbs);
  const bandType = native?.bandTypes?.[0] ?? 'Byte';

  /* 替换用的源图：同尺寸、不同内容（等比缩放取值范围）。 */
  const replaceSrcRel = '_aux/replace-src.tif';
  const replaceSrcAbs = join(stageRoot, replaceSrcRel);
  mkdirSync(dirname(replaceSrcAbs), { recursive: true });
  const scaleArgs =
    bandType === 'UInt16'
      ? ['-scale', '0', '65535', '3000', '65535']
      : ['-scale', '0', '255', '30', '255'];
  const scaleRes = await gdal.translate(['-of', 'GTiff', ...scaleArgs, targetAbs, replaceSrcAbs]);
  if (!scaleRes.ok) {
    return { ...ctx, kind: 'raster', info, cases: [], notes, openError: `造替换源图失败：${scaleRes.stderr}` };
  }

  /* 拼接用的第二幅：取左上半块，拼接才有意义。 */
  const mosaicRel = '_aux/mosaic-2.tif';
  const mosaicAbs = join(stageRoot, mosaicRel);
  mkdirSync(dirname(mosaicAbs), { recursive: true });
  const mosaicRes = await gdal.translate([
    '-of',
    'GTiff',
    '-srcwin',
    '0',
    '0',
    String(Math.max(1, Math.floor(info.width / 2))),
    String(Math.max(1, Math.floor(info.height / 2))),
    targetAbs,
    mosaicAbs,
  ]);
  if (!mosaicRes.ok) {
    return { ...ctx, kind: 'raster', info, cases: [], notes, openError: `造拼接源图失败：${mosaicRes.stderr}` };
  }

  /* 改动区域：挑一块有纹理的地方（纯色区改了也看不出来）。 */
  const pre = await readRasterPixels(loc, targetAbs).catch(() => null);
  const region = pre ? pickTexturedRegion(pre) : { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const preRegionSum = pre ? regionSum(pre, region) : null;

  const gt = info.geotransform;
  const fullBbox = gt ? bboxFromGeoTransform(gt, info.width, info.height) : null;
  const clipBbox = fullBbox
    ? [
        fullBbox[0] + (fullBbox[2] - fullBbox[0]) * 0.25,
        fullBbox[1] + (fullBbox[3] - fullBbox[1]) * 0.25,
        fullBbox[0] + (fullBbox[2] - fullBbox[0]) * 0.75,
        fullBbox[1] + (fullBbox[3] - fullBbox[1]) * 0.75,
      ]
    : null;
  const pixelSize = gt ? Math.abs(gt[1]) : 1;

  return {
    ...ctx,
    kind: 'raster',
    info,
    notes,
    cases: rasterOpCases(ds, {
      region,
      preRegionSum,
      preWidth: info.width,
      preHeight: info.height,
      clipBbox,
      targetResolution: pixelSize * 2,
      replaceSrcRel,
      mosaicRel,
      mosaicOutRel: '_aux/merged.tif',
    }),
  };
}

/** 跑一个数据集的全部 op。 */
async function evaluateDatasetOps(ds, tmpRoot) {
  const results = [];
  const notes = [];

  if (ds.remote) {
    return {
      dataset: ds.id,
      title: ds.title,
      kind: ds.kind,
      origin: ds.origin,
      source: ds.display,
      skipped: '远程 COG 不参与 op 评测：写回类 op 需要可写的本地副本，整文件下载体积过大',
      ops: results,
      notes,
    };
  }

  if (!existsSync(ds.absPath)) {
    return {
      dataset: ds.id,
      title: ds.title,
      kind: ds.kind,
      origin: ds.origin,
      source: ds.display,
      skipped: '文件不存在，跳过 op 评测',
      ops: results,
      notes,
    };
  }

  const env = await prepareDataset(ds, tmpRoot);
  if (env.openError) {
    return {
      dataset: ds.id,
      title: ds.title,
      kind: ds.kind,
      origin: ds.origin,
      source: ds.display,
      skipped: `准备失败：${env.openError.split('\n')[0]}`,
      ops: results,
      notes,
    };
  }
  notes.push(...(env.notes ?? []));

  /* 原始数据的校验和：跑完 op 之后必须一模一样。 */
  const sourceHashBefore = await hashFile(ds.absPath);
  const sourceStatBefore = statSync(ds.absPath);

  for (const [opIndex, opCase] of env.cases.entries()) {
    const rec = await runOpCase(ds, opCase, env, opIndex);
    results.push(rec);
    process.stdout.write(
      `  ${opCase.op.padEnd(22)} ${opCase.caseKind.padEnd(8)} ${rec.verdict.padEnd(6)} ${String(rec.durationMs).padStart(7)}ms  ${redactPaths(rec.note || rec.error || '').slice(0, 90)}\n`,
    );
  }

  const sourceHashAfter = await hashFile(ds.absPath);
  const sourceStatAfter = statSync(ds.absPath);
  const sourceIntact =
    sourceHashBefore === sourceHashAfter &&
    sourceStatBefore.size === sourceStatAfter.size &&
    sourceStatBefore.mtimeMs === sourceStatAfter.mtimeMs;
  if (!sourceIntact) {
    results.push({
      dataset: ds.id,
      datasetTitle: ds.title,
      op: '(源数据完整性)',
      case: 'primary',
      verdict: 'CRASH',
      crashKind: 'source-mutated',
      durationMs: 0,
      error: '原始样本文件在 op 评测之后被改动了',
      note: '源数据校验和与跑之前不一致 —— 这条最严重',
    });
  }

  return {
    dataset: ds.id,
    title: ds.title,
    kind: ds.kind,
    origin: ds.origin,
    source: ds.display,
    sourceIntact,
    ops: results,
    notes,
  };
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

/* ── op 层 ── */

const allDatasets = collectDatasets().filter((d) => !only || d.id === only);
const tmpRoot = mkdtemp('cartouche-opeval-');
const opRows = [];
try {
  for (const ds of allDatasets) {
    process.stdout.write(`[ops  ] ${ds.id.padEnd(26)} ${ds.kind}\n`);
    const r = await evaluateDatasetOps(ds, tmpRoot);
    opRows.push(r);
    for (const n of r.notes ?? []) console.log(`        ! ${n}`);
    if (r.skipped) console.log(`        - ${r.skipped}`);
  }
} finally {
  // 清理失败不能把评测结果一起弄丢：结果已经攒在内存里，写完报告再说。
  try {
    rmWithRetry(tmpRoot);
  } catch (err) {
    console.error(`[warn] 临时工作区清理失败（${tmpRoot}）：${String(err.message)}`);
  }
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

/* ── op 层矩阵 ── */

const OP_MARKS = { PASS: '✓', REJECT: '⊘', CRASH: '✗', SKIP: '·' };
const opCells = new Map();
for (const r of opRows) {
  for (const op of OP_COLUMNS) {
    const hit = r.ops.find((o) => o.op === op && o.case === 'primary');
    opCells.set(`${r.dataset}|${op}`, hit?.verdict ?? 'SKIP');
  }
}

console.log('\n=== op 层能力矩阵（每个 op 真跑一遍）===\n');
console.log('符号：✓ 成功且可验证　⊘ 引擎明确拒绝（正确行为）　✗ 崩了/静默失败（要修）　· 不适用\n');
console.log(`| 数据集 | ${OP_COLUMNS.map((op) => OP_ALIAS[op].padEnd(6)).join(' ')} |`);
console.log(`|${'-'.repeat(11)}|${OP_COLUMNS.map(() => '------').join('|')}|`);
for (const r of opRows) {
  const cells = OP_COLUMNS.map((op) => {
    const v = opCells.get(`${r.dataset}|${op}`) ?? 'SKIP';
    return `${OP_MARKS[v] ?? '·'} ${v === 'SKIP' ? '' : v}`.padEnd(6);
  });
  console.log(`| ${r.dataset.padEnd(20)} | ${cells.join(' ')} |`);
}

/* ── 统计 ── */

const allOps = opRows.flatMap((r) => r.ops);
const verdictCount = (v) => allOps.filter((o) => o.verdict === v).length;
const opRuns = allOps.filter((o) => o.op !== '(源数据完整性)').length;
const passCount = verdictCount('PASS');
const rejectCount = verdictCount('REJECT');
const crashCount = verdictCount('CRASH');

console.log('\n=== op 层统计 ===\n');
console.log(`跑了 ${opRuns} 次 op　PASS ${passCount}　REJECT ${rejectCount}　CRASH ${crashCount}`);
console.log(`（另有 ${verdictCount('SKIP')} 次不适用/未跑）`);

const crashes = allOps.filter((o) => o.verdict === 'CRASH');
console.log(`\n--- CRASH 清单（${crashes.length} 条）---`);
if (crashes.length === 0) {
  console.log('0 条');
} else {
  for (const c of crashes) {
    console.log(`* ${c.dataset} × ${c.op}（${c.case}，${c.crashKind ?? '?'}）`);
    console.log(`  报错原文：${redactPaths(c.error ?? c.note)}`);
    console.log(`  复现命令：node scripts/eval-samples.mjs --only ${c.dataset}`);
  }
}

const rejects = allOps.filter((o) => o.verdict === 'REJECT');
console.log(`\n--- REJECT 清单（${rejects.length} 条，引擎明确拒绝，属正确行为）---`);
for (const r of rejects) {
  console.log(`* ${r.dataset} × ${r.op}（${r.case}）：${redactPaths(r.note ?? r.error ?? '').slice(0, 160)}`);
}

/* ── 与刁难数据集的预期比对 ────────────────────────────────── */

/**
 * 预期结论的写法有两种，都得认：
 *   字符串   —— "PASS" / "REJECT" / "CRASH"（任务书里的简写）
 *   对象     —— { verdict, rules, note } 或 { op名: 结论 }（cases.json 里的详细写法）
 */
const VERDICT_TOKENS = new Set(['PASS', 'REJECT', 'CRASH', 'OK', 'BLOCKED', 'BLOCK', 'FAIL']);

/** 体检结论的四种口径：阻断 / 错误 / 提示 / 干净。 */
function healthVerdictOf(hc) {
  if (!hc) return 'SKIP';
  if (hc.verdict !== 'PASS') return hc.verdict;
  const verdict = hc.healthVerdict;
  return verdict ?? 'PASS';
}

/** 预期里某个字段的结论（字符串或对象都支持）。 */
function expectedVerdictOf(spec) {
  if (typeof spec === 'string') return spec.toUpperCase();
  if (spec && typeof spec === 'object' && typeof spec.verdict === 'string') {
    return spec.verdict.toUpperCase();
  }
  return null;
}

const expectedMismatches = [];
const expectedNotCovered = [];
const crashWatchViolations = [];
const budgetViolations = [];

for (const r of opRows) {
  const ds = allDatasets.find((d) => d.id === r.dataset);
  const expected = ds?.expected;
  if (!expected) continue;

  /* 打开：实测口径与 op 层一致（PASS / REJECT / CRASH）。 */
  const openOp = r.ops.find((o) => o.op === 'dataset.open' && o.case === 'primary');
  const openVerdict = openOp?.verdict ?? 'SKIP';
  const wantOpen = expectedVerdictOf(expected.open);
  if (wantOpen && VERDICT_TOKENS.has(wantOpen) && openVerdict !== wantOpen) {
    expectedMismatches.push({
      case: r.dataset,
      field: 'open',
      expected: wantOpen,
      actual: openVerdict,
      detail: r.skipped ?? openOp?.note ?? '',
    });
  }

  /* 体检：预期可能是 "BLOCK"，也可能是一段 { verdict, rules }。 */
  const hc = r.ops.find((o) => o.op === 'dataset.healthCheck' && o.case === 'primary');
  const wantHealth = expectedVerdictOf(expected.health);
  if (wantHealth && VERDICT_TOKENS.has(wantHealth)) {
    const actual = healthVerdictOf(hc);
    // 预期写 BLOCK / ERROR / WARN 时，含义是「体检要报出这一类问题」，
    // 不是「体检这一步要失败」—— 体检 op 自己跑成功了才是对的。
    if (actual !== wantHealth) {
      expectedMismatches.push({
        case: r.dataset,
        field: 'health',
        expected: wantHealth,
        actual,
        detail: hc?.note ?? hc?.error ?? '',
      });
    }
  }

  /* op 预期：对象是「op 名 → 结论」的表；字符串是整批的结论。 */
  const opExpectations = new Map();
  if (typeof expected.ops === 'string') {
    const want = expected.ops.toUpperCase();
    if (VERDICT_TOKENS.has(want)) {
      const actual = r.ops.some((o) => o.verdict === want)
        ? want
        : r.ops.some((o) => o.verdict === 'CRASH')
          ? 'CRASH'
          : r.ops.some((o) => o.verdict === 'REJECT')
            ? 'REJECT'
            : r.ops.some((o) => o.verdict === 'PASS')
              ? 'PASS'
              : 'SKIP';
      if (actual !== want) {
        expectedMismatches.push({
          case: r.dataset,
          field: 'ops',
          expected: want,
          actual,
          detail: '',
        });
      }
    }
  } else if (expected.ops && typeof expected.ops === 'object') {
    for (const [op, wantRaw] of Object.entries(expected.ops)) {
      const want = String(wantRaw).toUpperCase();
      const hits = r.ops.filter((o) => o.op === op);
      if (hits.length === 0) {
        // 这一轮矩阵里没有这个 op（多半是引擎里尚未实现的那几个）：
        // 记下来，但不能算成「实测与预期不符」—— 那是没测，不是测错。
        expectedNotCovered.push({ case: r.dataset, op, expected: want });
        continue;
      }
      // 一个 op 可能跑了不止一条用例（正常路径 + 刁难探针）；
      // 只要其中一条对上了预期，就认为这条 op 的行为符合预期。
      if (hits.some((o) => o.verdict === want)) continue;
      const primary = hits.find((o) => o.case === 'primary') ?? hits[0];
      expectedMismatches.push({
        case: r.dataset,
        field: `ops.${op}`,
        expected: want,
        actual: primary.verdict,
        detail: primary.note ?? primary.error ?? '',
      });
    }
  }

  /* crashWatch：这几条 op 一旦崩了就是 bug。 */
  if (Array.isArray(expected.crashWatch)) {
    for (const op of expected.crashWatch) {
      const hit = r.ops.find((o) => o.op === op && o.case === 'primary');
      if (hit && hit.verdict === 'CRASH') {
        crashWatchViolations.push({
          case: r.dataset,
          op,
          kind: hit.crashKind ?? '?',
          detail: hit.error ?? hit.note ?? '',
        });
      }
    }
  }

  /* budget：每个 op 的耗时上限（秒）。超了就是没跑完。 */
  if (expected.budget && typeof expected.budget === 'object') {
    for (const [op, secondsRaw] of Object.entries(expected.budget)) {
      const hit = r.ops.find((o) => o.op === op && o.case === 'primary');
      if (!hit) continue;
      const limit = Number(secondsRaw) * 1000;
      if (Number.isFinite(limit) && hit.durationMs > limit) {
        budgetViolations.push({
          case: r.dataset,
          op,
          budgetSeconds: Number(secondsRaw),
          actualMs: hit.durationMs,
          verdict: hit.verdict,
        });
      }
    }
  }
}

console.log(`\n--- 与 cases.json 预期不一致的清单（${expectedMismatches.length} 条）---`);
if (expectedMismatches.length === 0) {
  console.log(
    existsSync(HARDCASES_MANIFEST)
      ? '0 条'
      : '（刁难数据集清单还不存在，本轮没有可比对的对象）',
  );
} else {
  for (const m of expectedMismatches) {
    console.log(`* ${m.case} · ${m.field}：预期 ${m.expected}，实测 ${m.actual}${m.detail ? `　${m.detail}` : ''}`);
  }
}

console.log(`\n--- 预期里提到、但本轮矩阵没覆盖的 op（${expectedNotCovered.length} 条，不算测错）---`);
for (const m of expectedNotCovered) {
  console.log(
    `* ${m.case} · ${m.op}（预期 ${m.expected}）：本轮没跑这一条（引擎里没登记，或这一层没有可用的条件列），不计入对错`,
  );
}

console.log(`\n--- crashWatch 被违反的清单（${crashWatchViolations.length} 条）---`);
if (crashWatchViolations.length === 0) {
  console.log('0 条');
} else {
  for (const m of crashWatchViolations) {
    console.log(`* ${m.case} · ${m.op}（${m.kind}）：${m.detail}`);
  }
}

console.log(`\n--- 超出 cases.json 耗时预算的 op（${budgetViolations.length} 条）---`);
if (budgetViolations.length === 0) {
  console.log('0 条');
} else {
  for (const m of budgetViolations) {
    console.log(
      `* ${m.case} · ${m.op}：预算 ${m.budgetSeconds}s，实测 ${Math.round(m.actualMs / 1000)}s（${m.verdict}）`,
    );
  }
}

/* ── 最慢的 10 条 ── */

const slowest = [...allOps].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
console.log('\n--- 耗时最长的 10 条 ---');
for (const s of slowest) {
  console.log(`${String(s.durationMs).padStart(8)}ms  ${s.dataset} × ${s.op}（${s.verdict}）`);
}

/* ── 引擎 op 清单核对 ── */

const implemented = listImplementedOps();
const missing = OP_COLUMNS.filter((op) => !implemented.includes(op));
const extra = implemented.filter((op) => !OP_COLUMNS.includes(op));

/* ────────────────────────── 落盘 ────────────────────────── */

writeFileSync(
  join(SAMPLE_DIR, 'report.json'),
  JSON.stringify(redactPaths({ evaluatedAt: new Date().toISOString(), rows }), null, 2),
  'utf8',
);
console.log(`报告已写入 samples/report.json`);

writeFileSync(
  join(SAMPLE_DIR, 'op-eval.json'),
  JSON.stringify(
    redactPaths({
      evaluatedAt: new Date().toISOString(),
      opTimeoutMs: OP_TIMEOUT_MS,
      engine: { implemented, missingFromMatrix: missing, extraInEngine: extra },
      summary: {
        datasets: opRows.length,
        opRuns,
        pass: passCount,
        reject: rejectCount,
        crash: crashCount,
      },
      datasets: opRows,
      crashes,
      expectedMismatches,
      expectedNotCovered,
      crashWatchViolations,
      budgetViolations,
      slowest: slowest.map((s) => ({
        dataset: s.dataset,
        op: s.op,
        durationMs: s.durationMs,
        verdict: s.verdict,
      })),
    }),
    null,
    2,
  ),
  'utf8',
);
console.log(`报告已写入 samples/op-eval.json`);
