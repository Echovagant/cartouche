/**
 * 操作契约与引擎实现的**形状对齐**测试。
 *
 * 盯住一件事：契约（src/engine/ops.schema.json）声明的形状，必须是引擎真的能跑的形状。
 *
 * 背景：`raster.paint` / `raster.erase` / `raster.inpaint` / `raster.replaceRegion`
 * 的 `region` 曾经被声明成图层引用字符串（layer://…），而引擎的 `requireRegion`
 * 只认「像元坐标对象」与「地理范围数组」两种形状 —— 闸门①放行、闸门②报错，
 * AI 提得最多的几个 op 永远给不出执行按钮。
 *
 * 测试分四块：
 *   1. **契约侧**：引擎跑得动的形状，契约必须放行；引擎跑不动的形状，契约必须拦下；
 *   2. **引擎侧**：同一批形状喂给引擎，结论必须与契约一致（两侧形状集合一一对应）；
 *   3. **paint 的 color / mask**：同样按引擎的 `requireColor` / `readMask` 对齐；
 *   4. **replaceRegion 的范围来源**：region 缺省时要走 bbox 分支（真的改到像元），
 *      两者都不给必须明确报错。
 *
 * 本文件里造出来的栅格（16×12 三波段、像元值由公式生成）、遮罩字节、文件名
 * **全部是构造数据**，不对应任何真实数据。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { previewOp, executePlan } = await import(eng('ops/index.ts'));
// 闸门①用的就是服务端这一份校验器，不另写一套
const { readOpsSchema, validatePlanSchema } = await import(
  pathToFileURL(join(root, 'server', 'src', 'llm-plan.ts')).href
);

const loc = resolveGdal();
const gdal = tools(loc);
const SCHEMA = readOpsSchema();

/* ── 构造数据 ────────────────────────────────────────────── */

/** 造一张 16×12 的三波段影像（构造数据：像元值由公式生成，与真实数据无关） */
async function makeRaster(dir, name, fn) {
  const w = 16;
  const h = 12;
  const bands = 3;
  const raw = new Uint8Array(w * h * bands);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let b = 0; b < bands; b++) {
        raw[(y * w + x) * bands + b] = fn(x, y, b) & 0xff;
      }
    }
  }
  const bin = join(dir, `${name}.bin`);
  const hdr = join(dir, `${name}.hdr`);
  await writeFile(bin, raw);
  await writeFile(
    hdr,
    [
      'ENVI',
      `samples = ${w}`,
      `lines   = ${h}`,
      `bands   = ${bands}`,
      'header offset = 0',
      'file type = ENVI Standard',
      'data type = 1',
      'interleave = bip',
      'byte order = 0',
      '',
    ].join('\n'),
    'utf8',
  );
  const tif = join(dir, `${name}.tif`);
  // 固定的地理范围：120.30~120.316 / 30.52~30.532（16×12 像元，每像元 0.001 度）
  await gdal.translate([
    '-of', 'GTiff',
    '-a_srs', 'EPSG:4326',
    '-a_ullr', '120.30', '30.532', '120.316', '30.52',
    bin, tif,
  ]);
  return tif;
}

let ctx = null;

/** 构造好的工作区：target 与 source 同尺寸、同仿射参数（replaceRegion 要求） */
async function setup() {
  if (ctx) return ctx;
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-region-contract-'));
  const store = new LocalFolderStore(dir);
  const pattern = (x, y, b) => (x * 7 + y * 3 + b * 40 + 11) % 200;
  // source 的像元值必须与 target **不同**：两张一样的图替换完看不出差别，
  // 「到底改了没有」就无从验证了。
  const patternB = (x, y, b) => (x * 5 + y * 11 + b * 17 + 200) % 256;
  const target = await makeRaster(dir, 'target', pattern);
  const source = await makeRaster(dir, 'source', patternB);
  ctx = { dir, store, target, source };
  return ctx;
}

after(async () => {
  if (ctx) await rm(ctx.dir, { recursive: true, force: true });
});

/* ── 形状表 ──────────────────────────────────────────────── */

/**
 * `region` 的形状表。
 *
 * schema —— 闸门①（契约）该放行还是该拦下；
 * engine —— 闸门②（引擎）该跑通还是该报错。
 *
 * 「契约更严」= 契约比引擎严：引擎会（偷偷）接受的形状，契约不放行。
 * 这个方向是安全的 —— 契约拦下的东西到不了引擎；
 * 反过来（契约放行、引擎报错）才是危险方向，测试要把这条钉死。
 */
const REGION_SHAPES = [
  {
    id: '像元坐标对象',
    value: { minX: 4, minY: 3, maxX: 10, maxY: 8 },
    schema: 'accept',
    engine: 'accept',
  },
  {
    id: '地理范围数组（目标图层坐标系）',
    value: [120.3, 30.52, 120.308, 30.528],
    schema: 'accept',
    engine: 'accept',
  },
  { id: '图层引用字符串', value: 'layer://markup', schema: 'reject', engine: 'reject' },
  { id: '数据集引用字符串', value: 'dataset://target.tif', schema: 'reject', engine: 'reject' },
  { id: 'null', value: null, schema: 'reject', engine: 'reject' },
  { id: '3 元数组', value: [1, 2, 3], schema: 'reject', engine: 'reject' },
  { id: '5 元数组', value: [1, 2, 3, 4, 5], schema: 'reject', engine: 'reject' },
  { id: '缺字段对象', value: { minX: 1, minY: 2, maxX: 3 }, schema: 'reject', engine: 'reject' },
  { id: '裸数字', value: 42, schema: 'reject', engine: 'reject' },
  {
    id: '字段是数字字符串（契约更严）',
    value: { minX: '4', minY: 3, maxX: 10, maxY: 8 },
    schema: 'reject',
    engine: 'accept',
  },
  {
    id: '多带一个字段（契约更严）',
    value: { minX: 4, minY: 3, maxX: 10, maxY: 8, foo: 1 },
    schema: 'reject',
    engine: 'accept',
  },
];

/** 本次要盯住的四个 op（region 语义各不相同） */
const OPS = ['raster.paint', 'raster.erase', 'raster.inpaint', 'raster.replaceRegion'];

/** 给某个 op 造一份只带 region 变化的计划（其余必填参数齐活） */
function planFor(op, region) {
  const base = { target: 'dataset://target.tif' };
  if (op === 'raster.paint') return { op, params: { ...base, region, color: '#00FF00' } };
  if (op === 'raster.erase') return { op, params: { ...base, region } };
  if (op === 'raster.inpaint') return { op, params: { ...base, region } };
  if (op === 'raster.replaceRegion') {
    return { op, params: { ...base, source: 'dataset://source.tif', region } };
  }
  throw new Error(`没准备这个 op 的计划：${op}`);
}

/** 闸门①：这份计划过不过契约 */
function schemaIssues(plan) {
  return validatePlanSchema({ version: '1.0', ops: [plan] }, SCHEMA);
}

/* ── 1. 契约侧 ────────────────────────────────────────────── */

test('闸门①：引擎跑得动的 region 形状，契约必须放行', () => {
  for (const op of OPS) {
    for (const shape of REGION_SHAPES.filter((s) => s.schema === 'accept')) {
      const issues = schemaIssues(planFor(op, shape.value));
      assert.deepEqual(
        issues.map((i) => i.message),
        [],
        `${op} / ${shape.id}：契约不该报错`,
      );
    }
  }
});

test('闸门①：引擎跑不动的 region 形状，契约必须拦下（不许放行到闸门②才炸）', () => {
  for (const op of OPS) {
    for (const shape of REGION_SHAPES.filter((s) => s.schema === 'reject')) {
      const issues = schemaIssues(planFor(op, shape.value));
      assert.ok(issues.length > 0, `${op} / ${shape.id}：契约必须拦下`);
      assert.match(
        issues[0]?.message ?? '',
        /region/,
        `${op} / ${shape.id}：报错要指明是 region 的问题`,
      );
    }
  }
});

test('闸门①：layer:// 引用不是合法的 region（这条是本次修的主症状）', () => {
  for (const op of OPS) {
    const issues = schemaIssues(planFor(op, 'layer://markup'));
    assert.ok(issues.length > 0, `${op}：layer:// 引用必须被契约拒绝`);
  }
});

/* ── 2. 引擎侧 ────────────────────────────────────────────── */

test('闸门②：同一批形状喂给引擎，结论必须与契约一致（两侧形状集合一一对应）', async () => {
  const c = await setup();
  for (const shape of REGION_SHAPES) {
    const rec = await previewOp({ loc, store: c.store }, planFor('raster.paint', shape.value));
    if (shape.engine === 'accept') {
      assert.equal(
        rec.ok,
        true,
        `raster.paint / ${shape.id}：引擎应当跑通，实际报错：${rec.error ?? ''}`,
      );
    } else {
      assert.equal(rec.ok, false, `raster.paint / ${shape.id}：引擎应当报错`);
      assert.match(
        rec.error ?? '',
        /region/,
        `raster.paint / ${shape.id}：报错要指明是 region 的形状不对`,
      );
    }
  }
});

test('闸门②：三个 op 与 replaceRegion 的 region 形状结论一致', async () => {
  const c = await setup();
  const spot = REGION_SHAPES.filter((s) =>
    ['像元坐标对象', '地理范围数组（目标图层坐标系）', '图层引用字符串'].includes(s.id),
  );
  for (const op of ['raster.erase', 'raster.inpaint', 'raster.replaceRegion']) {
    for (const shape of spot) {
      const rec = await previewOp({ loc, store: c.store }, planFor(op, shape.value));
      assert.equal(
        rec.ok,
        shape.engine === 'accept',
        `${op} / ${shape.id}：结论应当是 ${shape.engine}，实际 ${rec.ok ? '跑通' : `报错 ${rec.error ?? ''}`}`,
      );
      if (shape.engine === 'reject') {
        assert.match(rec.error ?? '', /region/, `${op} / ${shape.id}：报错要指明是 region`);
      }
    }
  }
});

test('闸门②：像元区域真的改到了像元（不是空跑）', async () => {
  const c = await setup();
  const rec = await previewOp(
    { loc, store: c.store },
    {
      op: 'raster.paint',
      params: {
        target: 'dataset://target.tif',
        region: { minX: 4, minY: 3, maxX: 10, maxY: 8 },
        color: '#00FF00',
      },
    },
  );
  assert.equal(rec.ok, true, rec.error ?? '');
  // 构造的栅格是 16×12；涂色区域是 6×5 = 30 个像元
  assert.equal(rec.impact?.affectedPixels, 30);
});

test('闸门②：地理范围数组会被换算成像元区域（落到栅格内的那一块）', async () => {
  const c = await setup();
  const rec = await previewOp(
    { loc, store: c.store },
    {
      op: 'raster.paint',
      params: {
        target: 'dataset://target.tif',
        region: [120.3, 30.52, 120.308, 30.528],
        color: '#00FF00',
      },
    },
  );
  assert.equal(rec.ok, true, rec.error ?? '');
  // 构造栅格每像元 0.001 度 → 这个范围约等于 8 列 × 4 行 = 32 个像元
  assert.ok(
    rec.impact?.affectedPixels && rec.impact.affectedPixels > 0,
    '地理范围要换算成像元并真的改到像元',
  );
  assert.equal(rec.impact?.totalPixels, 16 * 12);
});

/* ── 3. paint 的 color / mask ─────────────────────────────── */

test('契约：paint 的 color 按引擎的 requireColor 对齐（#RRGGBB / sample-from-edge / [r,g,b]）', () => {
  const ok = ['#00FF00', '00FF00', 'sample-from-edge'];
  for (const color of ok) {
    const issues = schemaIssues({
      op: 'raster.paint',
      params: {
        target: 'dataset://target.tif',
        region: { minX: 0, minY: 0, maxX: 4, maxY: 4 },
        color,
      },
    });
    assert.deepEqual(issues.map((i) => i.message), [], `color=${color}：契约不该报错`);
  }
  const rgb = schemaIssues({
    op: 'raster.paint',
    params: {
      target: 'dataset://target.tif',
      region: { minX: 0, minY: 0, maxX: 4, maxY: 4 },
      color: [0, 255, 0],
    },
  });
  assert.deepEqual(rgb.map((i) => i.message), [], 'color=[r,g,b]：契约不该报错');

  // 引擎的 parseColor 只认六位十六进制与 sample-from-edge —— 契约要提前拦下别的写法
  for (const color of ['red', '#fff', [255, 0]]) {
    const issues = schemaIssues({
      op: 'raster.paint',
      params: {
        target: 'dataset://target.tif',
        region: { minX: 0, minY: 0, maxX: 4, maxY: 4 },
        color,
      },
    });
    assert.ok(issues.length > 0, `color=${JSON.stringify(color)}：契约必须拦下`);
  }
});

test('契约：paint 的 mask 按引擎的 readMask 对齐（width/height 正整数 + base64 数据）', async () => {
  const c = await setup();
  // 构造一张与栅格同尺寸的遮罩（16×12），只点亮第 0 个像元
  const bytes = new Uint8Array(16 * 12);
  bytes[0] = 255;
  const mask = { width: 16, height: 12, data: Buffer.from(bytes).toString('base64') };
  const params = {
    target: 'dataset://target.tif',
    region: { minX: 0, minY: 0, maxX: 16, maxY: 12 },
    color: '#00FF00',
    mask,
  };
  assert.deepEqual(
    schemaIssues({ op: 'raster.paint', params }).map((i) => i.message),
    [],
    '契约不该报错',
  );
  const rec = await previewOp({ loc, store: c.store }, { op: 'raster.paint', params });
  assert.equal(rec.ok, true, rec.error ?? '');
  assert.equal(rec.impact?.affectedPixels, 1, '遮罩只亮一个像元，就只该改一个像元');

  // 形状不对的遮罩要被契约拦下
  for (const bad of [
    { width: 0, height: 12, data: mask.data },
    { width: 16, height: 12, data: 123 },
    { width: 16, height: 12 },
  ]) {
    const issues = schemaIssues({
      op: 'raster.paint',
      params: { ...params, mask: bad },
    });
    assert.ok(issues.length > 0, `mask=${JSON.stringify(bad)}：契约必须拦下`);
  }
});

/* ── 4. replaceRegion 的范围来源（region / bbox） ────────────── */

/**
 * 只给 bbox 时**必须真的改到像元**。
 *
 * 这条曾经断言的是缺陷现状：executor 的 requireRegion(params, { optional: true })
 * 缺参时返回 {0,0,0,0}，把 `req.region ?? bbox 换算` 里的 bbox 分支挡掉，
 * 于是预演与执行都报 ok，却一个像元都没改（「改了却没改，还报成功」）。
 *
 * 引擎修好后：optional 缺参返回 undefined，bbox 分支才走得通。
 */
test('replaceRegion 只给 bbox 时真的改到像元（region 缺省不再退化成零区域）', async () => {
  const c = await setup();
  const rec = await previewOp(
    { loc, store: c.store },
    {
      op: 'raster.replaceRegion',
      params: {
        target: 'dataset://target.tif',
        source: 'dataset://source.tif',
        bbox: [120.3, 30.52, 120.308, 30.528],
      },
    },
  );
  assert.equal(rec.ok, true, rec.error ?? '');
  assert.ok(
    (rec.impact?.affectedPixels ?? 0) > 0,
    `只给 bbox 时必须真的改到像元，实际 ${rec.impact?.affectedPixels ?? 0} 个`,
  );
  // 构造栅格每像元 0.001 度 → 这个范围落在栅格内的那一块不超过 8 列 × 8 行
  assert.ok(
    (rec.impact?.affectedPixels ?? 0) <= 64,
    `影响像元数不该超出 bbox 覆盖的范围，实际 ${rec.impact?.affectedPixels ?? 0}`,
  );
  assert.equal(rec.impact?.totalPixels, 16 * 12);
});

test('replaceRegion 只给 bbox 时执行也真的落盘（不是只在预演里好看）', async () => {
  const c = await setup();
  const before = await readFile(c.target);
  const res = await executePlan(
    { loc, store: c.store },
    {
      op: 'raster.replaceRegion',
      params: {
        target: 'dataset://target.tif',
        source: 'dataset://source.tif',
        bbox: [120.3, 30.52, 120.308, 30.528],
      },
    },
  );
  assert.equal(res.ok, true, JSON.stringify(res.results));
  assert.ok(
    (res.results[0]?.impact?.affectedPixels ?? 0) > 0,
    '执行后必须报出改了像元',
  );
  const after = await readFile(c.target);
  assert.notEqual(
    before.toString('base64'),
    after.toString('base64'),
    '文件必须真的变了（改了却没改，还报成功是最严重的一类缺陷）',
  );
});

test('replaceRegion 的 region 与 bbox 都不给时必须明确报错（不许静默改 0 像元）', async () => {
  const c = await setup();
  const rec = await previewOp(
    { loc, store: c.store },
    {
      op: 'raster.replaceRegion',
      params: {
        target: 'dataset://target.tif',
        source: 'dataset://source.tif',
      },
    },
  );
  assert.equal(rec.ok, false, '既没有 region 也没有 bbox，必须报错');
  assert.match(rec.error ?? '', /替换范围|region|bbox/);
});

test('replaceRegion 同时给 region 与 bbox 时以 region 为准（region 优先）', async () => {
  const c = await setup();
  const rec = await previewOp(
    { loc, store: c.store },
    {
      op: 'raster.replaceRegion',
      params: {
        target: 'dataset://target.tif',
        source: 'dataset://source.tif',
        region: { minX: 0, minY: 0, maxX: 2, maxY: 2 },
        bbox: [120.3, 30.52, 120.308, 30.528],
      },
    },
  );
  assert.equal(rec.ok, true, rec.error ?? '');
  assert.equal(rec.impact?.affectedPixels, 4, 'region 是 2×2，就只改 4 个像元');
});
