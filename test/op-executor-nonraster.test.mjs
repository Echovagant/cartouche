/**
 * 非栅格型 op 的执行与预演：dataset.open / dataset.healthCheck / dataset.snapshot。
 *
 * 这三个 op **不改像元** —— 它们走的是非栅格型结果那条路。
 * 在那之前执行器只有像元形状的结果，「改了 0 像元就是失败」那道闸门
 * 会把一次完全正常的体检报成失败。这组用例盯的就是那条分界线：
 *  - 成功的非栅格型 op 不许被误判成失败（value 有、impact 不填）；
 *  - 预演不许落盘（快照尤其重要：确认卡上点一下就留下快照文件，这个预演就是假的）；
 *  - 路径越界、layer:// 引用、打不开的目标、契约外的检查项，都要明确报错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { executePlan, previewOp, listImplementedOps } = await import(eng('ops/index.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

/** Windows 上真实存在的绝对路径（用来试越界） */
const HOSTS = 'C:/Windows/System32/drivers/etc/hosts';

/**
 * 临时目录位置。
 *
 * 默认走系统临时目录（与仓库里其它测试同一套做法，保证换台机器也跑得起来）。
 * 这台机器的 C 盘空间紧张，跑测试时可以用 CARTOUCHE_TEST_TMP 指到 D 盘 ——
 * 路径不进代码，测试产物就别往系统盘上堆。
 */
const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || tmpdir();

/* ── 造数据 ──────────────────────────────────────────────── */

/** 造一张 16x12 的三波段影像（与 op-executor 测试同一套做法） */
async function makeRaster(dir, name, { crs = true } = {}) {
  const w = 16, h = 12, bands = 3;
  const raw = new Uint8Array(w * h * bands);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let b = 0; b < bands; b++) {
        raw[(y * w + x) * bands + b] = (x * 7 + y * 3 + b * 40 + 11) % 200;
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
  await gdal.translate([
    '-of', 'GTiff',
    ...(crs ? ['-a_srs', 'EPSG:4326', '-a_ullr', '120.30', '30.532', '120.316', '30.52'] : []),
    bin,
    tif,
  ]);
  return tif;
}

/** 造一个两要素两字段的 shapefile */
async function makeVector(dir, name) {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'A', code: 1 },
        geometry: {
          type: 'Polygon',
          coordinates: [[[120.3, 30.5], [120.31, 30.5], [120.31, 30.51], [120.3, 30.51], [120.3, 30.5]]],
        },
      },
      {
        type: 'Feature',
        properties: { name: 'B', code: 2 },
        geometry: {
          type: 'Polygon',
          coordinates: [[[120.31, 30.5], [120.32, 30.5], [120.32, 30.51], [120.31, 30.51], [120.31, 30.5]]],
        },
      },
    ],
  };
  const src = join(dir, `${name}.geojson`);
  await writeFile(src, JSON.stringify(geojson), 'utf8');
  const shp = join(dir, `${name}.shp`);
  await gdal.ogr2ogr(['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', shp, src]);
  return shp;
}

async function setup() {
  const dir = await mkdtemp(join(TMP_BASE, 'cartouche-nonraster-'));
  const store = new LocalFolderStore(dir);
  await makeRaster(dir, 'scan');
  await makeVector(dir, 'counties');
  // 栅格的伴随文件：世界文件 + 坐标系侧车
  await writeFile(join(dir, 'scan.tfw'), '0.001\n0\n0\n-0.001\n120.3005\n30.5395\n', 'utf8');
  await writeFile(
    join(dir, 'scan.prj'),
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
      'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]\n',
    'utf8',
  );
  return { dir, store };
}

/* ── 1. 登记 ─────────────────────────────────────────────── */

test('三个 dataset.* op 都进了已实现清单', () => {
  const ops = listImplementedOps();
  assert.ok(ops.includes('dataset.open'));
  assert.ok(ops.includes('dataset.healthCheck'));
  assert.ok(ops.includes('dataset.snapshot'));
});

/* ── 2. dataset.open ─────────────────────────────────────── */

test('dataset.open：栅格与矢量都能打开，信息照抄探查结果', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'dataset.open',
      params: { targets: ['dataset://scan.tif', 'dataset://counties.shp'] },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const r = res.results[0];
    assert.equal(r.ok, true);
    assert.equal(r.impact, undefined, '非栅格型 op 不填像元影响面');
    assert.ok(r.value, '要有非栅格型结果');
    assert.equal(r.value.kind, 'value');
    assert.match(r.value.summary, /打开 2 个数据集/);
    assert.match(r.value.summary, /scan（栅格 16×12）/);
    assert.match(r.value.summary, /counties（矢量 2 个要素）/);

    const datasets = r.value.data.datasets;
    assert.equal(datasets.length, 2);
    assert.equal(datasets[0].kind, 'raster');
    assert.equal(datasets[0].width, 16);
    assert.equal(datasets[0].height, 12);
    assert.equal(datasets[0].bandCount, 3);
    assert.equal(datasets[0].crs.present, true);
    assert.equal(datasets[1].kind, 'vector');
    assert.equal(datasets[1].featureCount, 2);
    assert.equal(datasets[1].fieldCount, 2);
    // 相对路径口径：结果里不该出现本机绝对路径
    assert.equal(datasets[0].path, 'scan.tif');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.open：有一个目标打不开 → 整个 op 失败，并点名是哪个', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'dataset.open',
      params: { targets: ['dataset://scan.tif', 'dataset://not-here.tif'] },
    });
    assert.equal(res.ok, false, '有一个打不开就不能算成功');
    assert.equal(res.completed, 0);
    assert.equal(res.failedAt, 0);
    const err = res.results[0].error ?? '';
    assert.match(err, /not-here\.tif/, '要点名是哪个目标打不开');
    assert.match(err, /打不开数据集/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.open：layer:// 引用 → 明确报错（这个引用不是文件路径）', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'dataset.open',
      params: { targets: ['layer://2024_basemap'] },
    });
    assert.equal(res.ok, false);
    const err = res.results[0].error ?? '';
    assert.match(err, /不是文件路径/, '要说清这不是文件路径');
    assert.match(err, /dataset:\/\//, '要说清引擎只认 dataset:// 开头的工作区相对路径');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.open：越界路径被拒（.. 与绝对路径）', async () => {
  const { dir, store } = await setup();
  try {
    const dotdot = await executePlan({ loc, store }, {
      op: 'dataset.open',
      params: { targets: ['../evil.tif'] },
    });
    assert.equal(dotdot.ok, false);
    assert.match(dotdot.results[0].error ?? '', /\.\./);
    assert.match(dotdot.results[0].error ?? '', /不在已登记的工作区根之下/);

    const abs = await executePlan({ loc, store }, {
      op: 'dataset.open',
      params: { targets: [HOSTS] },
    });
    assert.equal(abs.ok, false);
    assert.match(abs.results[0].error ?? '', /相对路径/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 3. dataset.healthCheck ──────────────────────────────── */

test('dataset.healthCheck：给出阻断项、结论与兼容性报告正文', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'dataset.healthCheck',
      params: { target: 'dataset://scan.tif', checks: ['crs-present'] },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const r = res.results[0];
    assert.equal(r.impact, undefined, '非栅格型 op 不填像元影响面');
    assert.ok(r.value);
    assert.match(r.value.summary, /体检/);
    assert.equal(typeof r.value.data.hasBlocker, 'boolean');
    assert.equal(r.value.data.hasBlocker, false, '坐标系内嵌的栅格不该有阻断项');
    assert.ok(Array.isArray(r.value.data.manualChecks));
    assert.ok(r.value.data.markdown.includes('## 1. 文件格式'), '要给出兼容性报告正文');
    assert.ok(r.value.data.markdown.includes('## 4. 伴随文件'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.healthCheck：缺坐标系的栅格 → 结论里点明阻断项', async () => {
  const { dir, store } = await setup();
  try {
    await makeRaster(dir, 'bare', { crs: false });
    const res = await executePlan({ loc, store }, {
      op: 'dataset.healthCheck',
      params: { target: 'dataset://bare.tif', checks: ['crs-present'] },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const v = res.results[0].value;
    assert.equal(v.data.hasBlocker, true, '缺坐标系是阻断项');
    assert.match(v.summary, /阻断项/);
    assert.ok(
      v.data.findings.some((f) => f.ruleId === 'R-CRS-001'),
      '要给出具体是哪条规则',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.healthCheck：契约外的检查项 → 报错，不静默忽略', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'dataset.healthCheck',
      params: { target: 'dataset://scan.tif', checks: ['不存在的检查项'] },
    });
    assert.equal(res.ok, false);
    assert.match(res.results[0].error ?? '', /契约里没有的检查项/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.healthCheck：没查成的检查项要点名，不能悄悄跳过', async () => {
  const { dir, store } = await setup();
  try {
    // crs-mismatch 已经实现了，但没给参照层 → 只能算「未检查」，
    // 不能混进 coveredChecks（那等于骗人说"查过、没问题"）。
    const res = await executePlan({ loc, store }, {
      op: 'dataset.healthCheck',
      params: { target: 'dataset://counties.shp', checks: ['crs-present', 'crs-mismatch'] },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const v = res.results[0].value;
    assert.deepEqual(v.data.coveredChecks, ['crs-present']);
    assert.deepEqual(v.data.skippedChecks, ['crs-mismatch']);
    assert.deepEqual(v.data.unsupportedChecks, []);
    assert.match(v.summary, /crs-mismatch/, '没查的检查项要点名');
    assert.match(v.summary, /未检查/);
    // 覆盖情况里必须写清为什么没查
    const cov = v.data.checkCoverage.find((c) => c.check === 'crs-mismatch');
    assert.equal(cov.status, 'skipped');
    assert.match(cov.reason ?? '', /参照层/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.healthCheck：对栅格不适用的检查项要点名', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'dataset.healthCheck',
      params: { target: 'dataset://scan.tif', checks: ['crs-present', 'crs-mismatch'] },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const v = res.results[0].value;
    assert.deepEqual(v.data.coveredChecks, ['crs-present']);
    assert.deepEqual(v.data.notApplicableChecks, ['crs-mismatch']);
    assert.deepEqual(v.data.unsupportedChecks, []);
    assert.match(v.summary, /crs-mismatch/, '不适用的检查项要点名');
    assert.match(v.summary, /不适用/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.healthCheck：layer:// 引用 → 明确报错', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'dataset.healthCheck',
      params: { target: 'layer://2024_basemap', checks: ['crs-present'] },
    });
    assert.equal(res.ok, false);
    const err = res.results[0].error ?? '';
    assert.match(err, /不是文件路径/);
    assert.match(err, /dataset:\/\//);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.healthCheck：目标打不开 → 明确报错，不给假结论', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'dataset.healthCheck',
      params: { target: 'dataset://not-here.tif', checks: ['crs-present'] },
    });
    assert.equal(res.ok, false);
    assert.match(res.results[0].error ?? '', /not-here\.tif/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 4. dataset.snapshot ─────────────────────────────────── */

test('dataset.snapshot：目标文件与伴随文件都复制到快照目录', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'dataset.snapshot',
      params: { target: 'dataset://scan.tif', label: 'before' },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const r = res.results[0];
    assert.equal(r.impact, undefined, '快照不改像元，不填像元影响面');
    const v = r.value;
    assert.ok(v.outputPath, '要给出快照文件的工作区相对路径');
    assert.match(v.outputPath, /^_snapshots\//);
    assert.match(v.outputPath, /before/, '目录名要带 label');

    // 快照主文件真的在
    const st = await stat(join(dir, v.outputPath));
    assert.ok(st.size > 0, '快照文件不能是空的');

    // 伴随文件（.tfw / .prj）一起复制了
    assert.equal(v.data.sidecars.length, 2, `实际：${JSON.stringify(v.data.sidecars)}`);
    for (const sc of v.data.sidecars) {
      await stat(join(dir, sc));
    }
    assert.ok(
      v.data.sidecars.some((p) => p.endsWith('scan.tfw')),
      '世界文件要跟着走',
    );

    // 原文件还在（快照不是移动）
    await stat(join(dir, 'scan.tif'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.snapshot：includeSidecars=false → 只复制主文件', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'dataset.snapshot',
      params: { target: 'dataset://scan.tif', label: 'solo', includeSidecars: false },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const v = res.results[0].value;
    assert.deepEqual(v.data.sidecars, []);
    assert.equal(v.data.files.length, 1);
    await stat(join(dir, v.outputPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.snapshot：目标不存在 → 明确报错', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'dataset.snapshot',
      params: { target: 'dataset://not-here.tif' },
    });
    assert.equal(res.ok, false);
    assert.match(res.results[0].error ?? '', /目标不存在/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.snapshot：越界路径被拒，且什么都不写', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'dataset.snapshot',
      params: { target: '../evil.tif' },
    });
    assert.equal(res.ok, false);
    assert.match(res.results[0].error ?? '', /不在已登记的工作区根之下/);
    const entries = await readdir(dir);
    assert.ok(!entries.includes('_snapshots'), '被拒的快照不能留下任何东西');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.snapshot：快照目录写不了 → 明确报错', async () => {
  const { dir, store } = await setup();
  try {
    // 占掉快照目录这个名字，让 mkdir 失败
    await writeFile(join(dir, '_snapshots'), 'not a directory', 'utf8');
    const res = await executePlan({ loc, store }, {
      op: 'dataset.snapshot',
      params: { target: 'dataset://scan.tif' },
    });
    assert.equal(res.ok, false, '写不了目录必须报错，不能假装成功');
    assert.match(res.results[0].error ?? '', /快照/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 5. 预演 ─────────────────────────────────────────────── */

test('预演：三个 op 都能预演，且一个字节都不落盘', async () => {
  const { dir, store } = await setup();
  try {
    const specs = [
      { op: 'dataset.open', params: { targets: ['dataset://scan.tif'] } },
      { op: 'dataset.healthCheck', params: { target: 'dataset://scan.tif', checks: ['crs-present'] } },
      { op: 'dataset.snapshot', params: { target: 'dataset://scan.tif', label: 'dry' } },
    ];
    for (const spec of specs) {
      const rec = await previewOp({ loc, store }, spec);
      assert.equal(rec.ok, true, `${spec.op} 预演不该失败：${rec.error ?? ''}`);
      assert.equal(rec.impact, undefined, `${spec.op} 预演不填像元影响面`);
      assert.ok(rec.value, `${spec.op} 预演要给出非栅格型结果`);
      assert.equal(rec.value.kind, 'value');
    }

    const entries = await readdir(dir);
    assert.ok(!entries.includes('_snapshots'), '快照预演不能留下快照目录');
    const tif = await stat(join(dir, 'scan.tif'));
    assert.ok(tif.size > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('预演：快照预演会说明将要复制哪些文件', async () => {
  const { dir, store } = await setup();
  try {
    const rec = await previewOp({ loc, store }, {
      op: 'dataset.snapshot',
      params: { target: 'dataset://scan.tif', label: 'dry' },
    });
    assert.equal(rec.ok, true, rec.error ?? '');
    assert.equal(rec.value.data.dryRun, true, '要标明这是预演');
    assert.equal(rec.value.data.sidecars.length, 2, '要说明会带上哪些伴随文件');
    assert.match(rec.value.summary, /将快照/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 6. 混排 ─────────────────────────────────────────────── */

test('一份计划里非栅格型与栅格型 op 混排：两类结果各归各位', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      version: '1.0',
      ops: [
        { op: 'dataset.open', params: { targets: ['dataset://scan.tif'] } },
        {
          op: 'raster.paint',
          params: {
            target: 'dataset://scan.tif',
            region: { minX: 0, minY: 0, maxX: 4, maxY: 4 },
            color: '#00FF00',
          },
        },
        { op: 'dataset.snapshot', params: { target: 'dataset://scan.tif', label: 'after' } },
      ],
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    assert.equal(res.completed, 3);
    assert.ok(res.results[0].value, '第一条是非栅格型结果');
    assert.equal(res.results[0].impact, undefined);
    assert.ok(res.results[1].impact, '第二条是像元影响面');
    assert.equal(res.results[1].value, undefined);
    assert.ok(res.results[2].value, '第三条也是非栅格型结果');
    assert.equal(res.results[2].impact, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
