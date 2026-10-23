/**
 * export.image 与 export.report 两个 op 的执行与预演。
 *
 * 这两个 op **不改像元**，产出的是**文件** —— 走的是非栅格型结果那条路
 * （和上一轮落地的 dataset.* 一样）。这组用例盯的是：
 *  - 成功路径：四种出图格式、三种报告都要真的产出能用的文件；
 *  - 预演**不写盘**：确认卡上点一下就留下文件，这个"预演"就是假的；
 *  - 引用与路径：layer:// 引用、绝对路径、`..` 都要被明确拒掉；
 *  - 目标不存在、格式不支持、kind 尚未支持、include 项做不到 —— 一律报错，
 *    不静默跳过、不拿通用内容冒充某种报告。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { executePlan, previewOp, listImplementedOps } = await import(eng('ops/index.ts'));
const { inspectPdf } = await import(eng('export/index.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

/** Windows 上真实存在的绝对路径（用来试越界） */
const HOSTS = 'C:/Windows/System32/drivers/etc/hosts';

/**
 * 临时目录位置。
 *
 * 与仓库里其它测试同一套做法；这台机器的 C 盘空间紧张，
 * 可以用 CARTOUCHE_TEST_TMP 指到 D 盘 —— 路径不进代码，测试产物别往系统盘上堆。
 */
const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || tmpdir();

/* ── 造数据 ─────────────────────────────────────────────────── */

/** 造一张 16x12 的三波段影像（EPSG:4326） */
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
  const dir = await mkdtemp(join(TMP_BASE, 'cartouche-export-op-'));
  const store = new LocalFolderStore(dir);
  await makeRaster(dir, 'scan');
  await makeVector(dir, 'counties');
  return { dir, store };
}

/** 工作区里有没有产出物 */
async function outputEntries(dir) {
  const outDir = join(dir, '.cartouche', 'outputs');
  if (!existsSync(outDir)) return [];
  return readdir(outDir);
}

/* ── 1. 登记 ─────────────────────────────────────────────────── */

test('export.image 与 export.report 都进了已实现清单', () => {
  const ops = listImplementedOps();
  assert.ok(ops.includes('export.image'));
  assert.ok(ops.includes('export.report'));
  // 清单是「引擎真能跑的 op」，加一个 op 就要改这个数 ——
  // 写死是有意的：少登记了会被这条拦住，多登记了也会被这条拦住。
  assert.equal(ops.length, 16, `实际：${ops.join('、')}`);
});

/* ── 2. export.image ────────────────────────────────────────── */

test('export.image：png 产出真的 PNG 文件，落在工作区的产出目录里', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'export.image',
      params: { target: 'dataset://scan.tif', format: 'png' },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const v = res.results[0].value;
    assert.ok(v, '要有非栅格型结果');
    assert.equal(v.outputPath, v.data.outputPath);
    assert.match(v.outputPath, /^\.cartouche\/outputs\//, '产出物要落在 .cartouche/outputs/ 下');

    const file = join(dir, v.outputPath);
    const st = await stat(file);
    assert.ok(st.size > 0, '产出的文件不能是空的');
    const head = await import('node:fs/promises').then((fs) => fs.readFile(file));
    assert.equal(head[0], 0x89, '应是 PNG 文件头');
    assert.equal(head[1], 0x50);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.image：jpeg / pdf / tif 三种格式各产出对的东西', async () => {
  const { dir, store } = await setup();
  try {
    const jpeg = await executePlan({ loc, store }, {
      op: 'export.image',
      params: { target: 'dataset://scan.tif', format: 'jpeg' },
    });
    assert.equal(jpeg.ok, true, jpeg.results[0]?.error ?? '');
    const jpegPath = join(dir, jpeg.results[0].value.outputPath);
    const jpegBytes = await import('node:fs/promises').then((fs) => fs.readFile(jpegPath));
    assert.equal(jpegBytes[0], 0xff, '应是 JPEG 文件头');
    assert.equal(jpegBytes[1], 0xd8);

    const pdf = await executePlan({ loc, store }, {
      op: 'export.image',
      params: { target: 'dataset://scan.tif', format: 'pdf' },
    });
    assert.equal(pdf.ok, true, pdf.results[0]?.error ?? '');
    const pdfBytes = new Uint8Array(
      await import('node:fs/promises').then((fs) => fs.readFile(join(dir, pdf.results[0].value.outputPath))),
    );
    const info = inspectPdf(pdfBytes);
    assert.equal(info.valid, true, `PDF 结构不合法：${info.issues.join('、')}`);
    assert.equal(info.hasImage, true, 'PDF 里应当有图像');

    const tif = await executePlan({ loc, store }, {
      op: 'export.image',
      params: { target: 'dataset://scan.tif', format: 'tif' },
    });
    assert.equal(tif.ok, true, tif.results[0]?.error ?? '');
    const tifPath = join(dir, tif.results[0].value.outputPath);
    const info2 = JSON.parse((await gdal.info(tifPath, ['-json'])).stdout);
    assert.equal(info2.driverShortName, 'GTiff');
    assert.ok(Array.isArray(info2.geoTransform), '导出的 GeoTIFF 应当带仿射参数');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.image：给了 bbox 就只导那一块，输出尺寸跟着变小', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'export.image',
      params: {
        target: 'dataset://scan.tif',
        format: 'png',
        bbox: [120.30, 30.52, 120.308, 30.526],
      },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const v = res.results[0].value;
    assert.ok(v.data.width < 16, `窗口应当比整幅窄，实为 ${v.data.width}`);
    assert.ok(v.data.height < 12, `窗口应当比整幅矮，实为 ${v.data.height}`);
    await stat(join(dir, v.outputPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.image：layer:// 引用 → 明确报错（这个引用不是文件路径）', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'export.image',
      params: { target: 'layer://2024_basemap', format: 'png' },
    });
    assert.equal(res.ok, false);
    const err = res.results[0].error ?? '';
    assert.match(err, /不是文件路径/);
    assert.match(err, /dataset:\/\//);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.image：越界路径被拒（.. 与绝对路径），且什么都不写', async () => {
  const { dir, store } = await setup();
  try {
    const dotdot = await executePlan({ loc, store }, {
      op: 'export.image',
      params: { target: '../evil.tif', format: 'png' },
    });
    assert.equal(dotdot.ok, false);
    assert.match(dotdot.results[0].error ?? '', /不在已登记的工作区根之下/);

    const abs = await executePlan({ loc, store }, {
      op: 'export.image',
      params: { target: HOSTS, format: 'png' },
    });
    assert.equal(abs.ok, false);
    assert.match(abs.results[0].error ?? '', /相对路径/);

    assert.deepEqual(await outputEntries(dir), [], '被拒的导出不能留下任何文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.image：目标不存在 → 明确报错', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'export.image',
      params: { target: 'dataset://not-here.tif', format: 'png' },
    });
    assert.equal(res.ok, false);
    assert.match(res.results[0].error ?? '', /目标不存在/);
    assert.deepEqual(await outputEntries(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.image：格式不支持 / 缺格式 → 明确报错', async () => {
  const { dir, store } = await setup();
  try {
    const bad = await executePlan({ loc, store }, {
      op: 'export.image',
      params: { target: 'dataset://scan.tif', format: 'bmp' },
    });
    assert.equal(bad.ok, false);
    assert.match(bad.results[0].error ?? '', /不支持的导出格式/);

    const missing = await executePlan({ loc, store }, {
      op: 'export.image',
      params: { target: 'dataset://scan.tif' },
    });
    assert.equal(missing.ok, false);
    assert.match(missing.results[0].error ?? '', /缺少参数 format/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.image：目标是矢量 → 明确报错，不拿栅格冒充', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'export.image',
      params: { target: 'dataset://counties.shp', format: 'png' },
    });
    assert.equal(res.ok, false);
    assert.match(res.results[0].error ?? '', /矢量/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.image：带 layers → 明确说尚未支持', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'export.image',
      params: { target: 'dataset://scan.tif', format: 'png', layers: ['dataset://counties.shp'] },
    });
    assert.equal(res.ok, false);
    assert.match(res.results[0].error ?? '', /尚未支持/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.image：南向上的源明确报错，不给一张上下颠倒的图', async () => {
  const { dir, store } = await setup();
  try {
    // 造一张南向上（正 NS 分辨率）的图：上左 y 小于下右 y
    const south = await makeRaster(dir, 'south');
    await gdal.translate([
      '-of', 'GTiff',
      '-a_srs', 'EPSG:4326',
      '-a_ullr', '120.30', '30.52', '120.316', '30.532',
      south,
      join(dir, 'south-up.tif'),
    ]);
    const res = await executePlan({ loc, store }, {
      op: 'export.image',
      params: { target: 'dataset://south-up.tif', format: 'png' },
    });
    assert.equal(res.ok, false);
    assert.match(res.results[0].error ?? '', /南向上/);
    assert.deepEqual(await outputEntries(dir), [], '被拒的导出不能留下任何文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 3. export.report ───────────────────────────────────────── */

test('export.report：兼容性自检报告（html）产出完整的交差正文', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'export.report',
      params: { target: 'dataset://scan.tif', kind: 'compat-report', format: 'html' },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const v = res.results[0].value;
    assert.match(v.outputPath, /^\.cartouche\/outputs\//);
    const html = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(dir, v.outputPath), 'utf8'),
    );
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /兼容性自检报告/);
    assert.match(html, /坐标系/);
    assert.match(html, /伴随文件/);
    assert.equal(v.data.hasBlocker, false, '坐标系内嵌的栅格不该有阻断项');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.report：兼容性自检报告（json）是合法 JSON，带结论与明细', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'export.report',
      params: { target: 'dataset://scan.tif', kind: 'compat-report', format: 'json' },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const v = res.results[0].value;
    const parsed = JSON.parse(
      await import('node:fs/promises').then((fs) => fs.readFile(join(dir, v.outputPath), 'utf8')),
    );
    assert.equal(typeof parsed.hasBlocker, 'boolean');
    assert.ok(Array.isArray(parsed.findings));
    assert.ok(parsed.body.includes('兼容性自检报告'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.report：数据体检报告（csv）给出规则明细表', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'export.report',
      params: { target: 'dataset://scan.tif', kind: 'health-report', format: 'csv' },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const v = res.results[0].value;
    const csv = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(dir, v.outputPath), 'utf8'),
    );
    assert.match(csv, /ruleId/);
    assert.match(csv, /severity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.report：kind=csv 导出属性表，几何以 WKT 形式带上', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'export.report',
      params: { target: 'dataset://counties.shp', kind: 'csv', format: 'csv' },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const v = res.results[0].value;
    const csv = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(dir, v.outputPath), 'utf8'),
    );
    assert.match(csv, /name/);
    assert.match(csv, /code/);
    assert.match(csv, /POLYGON/, '几何必须以 WKT 带出来，不能静默丢掉');
    assert.match(v.summary, /2 条记录/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.report：改动报告 / 审计日志 → 明确说尚未支持', async () => {
  const { dir, store } = await setup();
  try {
    for (const kind of ['change-report', 'audit-log']) {
      const res = await executePlan({ loc, store }, {
        op: 'export.report',
        params: { target: 'dataset://scan.tif', kind },
      });
      assert.equal(res.ok, false, `${kind} 不该报成功`);
      assert.match(res.results[0].error ?? '', /尚未支持/);
    }
    assert.deepEqual(await outputEntries(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.report：pdf 格式与做不到的 include 项 → 明确报错', async () => {
  const { dir, store } = await setup();
  try {
    const pdf = await executePlan({ loc, store }, {
      op: 'export.report',
      params: { target: 'dataset://scan.tif', kind: 'compat-report', format: 'pdf' },
    });
    assert.equal(pdf.ok, false);
    assert.match(pdf.results[0].error ?? '', /不支持 pdf 格式/);

    const include = await executePlan({ loc, store }, {
      op: 'export.report',
      params: { target: 'dataset://scan.tif', kind: 'compat-report', include: ['op-list'] },
    });
    assert.equal(include.ok, false);
    assert.match(include.results[0].error ?? '', /没有对应的内容/);

    const bogus = await executePlan({ loc, store }, {
      op: 'export.report',
      params: { target: 'dataset://scan.tif', kind: 'compat-report', include: ['不存在的项'] },
    });
    assert.equal(bogus.ok, false);
    assert.match(bogus.results[0].error ?? '', /不在契约里/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.report：做得到的 include 项会进报告（crs / file-hashes）', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'export.report',
      params: {
        target: 'dataset://scan.tif',
        kind: 'compat-report',
        format: 'json',
        include: ['crs', 'file-hashes', 'timestamps'],
      },
    });
    assert.equal(res.ok, true, res.results[0]?.error ?? '');
    const v = res.results[0].value;
    const parsed = JSON.parse(
      await import('node:fs/promises').then((fs) => fs.readFile(join(dir, v.outputPath), 'utf8')),
    );
    assert.match(parsed.metadata.crs, /EPSG:4326/);
    assert.match(parsed.metadata.sha256, /^[0-9a-f]{64}$/);
    assert.ok(parsed.metadata.at);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.report：layer:// 引用 / 越界路径 / 目标不存在 → 明确报错', async () => {
  const { dir, store } = await setup();
  try {
    const layer = await executePlan({ loc, store }, {
      op: 'export.report',
      params: { target: 'layer://2024_basemap', kind: 'compat-report' },
    });
    assert.equal(layer.ok, false);
    assert.match(layer.results[0].error ?? '', /不是文件路径/);

    const dotdot = await executePlan({ loc, store }, {
      op: 'export.report',
      params: { target: '../evil.tif', kind: 'compat-report' },
    });
    assert.equal(dotdot.ok, false);
    assert.match(dotdot.results[0].error ?? '', /不在已登记的工作区根之下/);

    const missing = await executePlan({ loc, store }, {
      op: 'export.report',
      params: { target: 'dataset://not-here.tif', kind: 'compat-report' },
    });
    assert.equal(missing.ok, false);
    assert.match(missing.results[0].error ?? '', /目标不存在/);

    assert.deepEqual(await outputEntries(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export.report：栅格没有属性表，kind=csv 要明确报错', async () => {
  const { dir, store } = await setup();
  try {
    const res = await executePlan({ loc, store }, {
      op: 'export.report',
      params: { target: 'dataset://scan.tif', kind: 'csv', format: 'csv' },
    });
    assert.equal(res.ok, false);
    assert.match(res.results[0].error ?? '', /属性表/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── 4. 预演 ────────────────────────────────────────────────── */

test('预演：两个 op 都能预演，且一个字节都不落盘', async () => {
  const { dir, store } = await setup();
  try {
    const image = await previewOp({ loc, store }, {
      op: 'export.image',
      params: { target: 'dataset://scan.tif', format: 'png' },
    });
    assert.equal(image.ok, true, image.error ?? '');
    assert.equal(image.impact, undefined, '非栅格型 op 不填像元影响面');
    assert.ok(image.value, '预演要给出非栅格型结果');
    assert.equal(image.value.data.dryRun, true, '要标明这是预演');
    assert.ok(image.value.data.width > 0);

    const report = await previewOp({ loc, store }, {
      op: 'export.report',
      params: { target: 'dataset://scan.tif', kind: 'compat-report' },
    });
    assert.equal(report.ok, true, report.error ?? '');
    assert.ok(report.value);
    assert.equal(report.value.data.dryRun, true);

    assert.deepEqual(await outputEntries(dir), [], '预演不能留下任何产出物');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('预演：预演里目标不存在也要报错，不能给一份"看起来没问题"的计划', async () => {
  const { dir, store } = await setup();
  try {
    const rec = await previewOp({ loc, store }, {
      op: 'export.image',
      params: { target: 'dataset://not-here.tif', format: 'png' },
    });
    assert.equal(rec.ok, false);
    assert.match(rec.error ?? '', /目标不存在/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
