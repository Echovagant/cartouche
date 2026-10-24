import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { renderCompatReport } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'report', 'index.ts')).href
);

/* ────────── 造数据 ────────── */

function rasterDataset(overrides = {}) {
  return {
    kind: 'raster',
    path: 'x.tif',
    driver: 'GTiff/GeoTIFF',
    width: 100,
    height: 80,
    bandCount: 3,
    // 波段类型是探查结果的必需字段：8 位影像写 Byte，16 位写 UInt16。
    bandTypes: ['Byte', 'Byte', 'Byte'],
    crs: { present: true, epsg: 32631, source: 'embedded', wkt: 'PROJCRS[...]' },
    geotransform: [0.001, 0, 120.3, 0, -0.001, 30.54],
    origin: [120.3, 30.54],
    pixelSize: [0.001, 0.001],
    nodata: null,
    sidecars: { worldFile: 'x.tfw', prj: 'x.prj', auxXml: null },
    ...overrides,
  };
}

function vectorDataset(overrides = {}) {
  return {
    kind: 'vector',
    path: 'x.shp',
    driver: 'ESRI Shapefile',
    layerName: 'x',
    featureCount: 12,
    crs: { present: true, epsg: 4326, source: 'sidecar', wkt: 'GEOGCRS[...]' },
    fields: [{ name: 'a', type: 'String' }, { name: 'b', type: 'Integer' }],
    geometryType: 'Polygon',
    encoding: 'UTF-8',
    sidecars: { prj: 'x.prj', cpg: 'x.cpg' },
    ...overrides,
  };
}

function health(findings = [], blockers = []) {
  return {
    path: 'x',
    kind: 'raster',
    driver: 'GTiff/GeoTIFF',
    findings,
    blockers,
    passed: blockers.length === 0,
    checkedAt: '2026-10-21T00:00:00Z',
  };
}

function finding(ruleId, severity, title, detail = '说明', hint = undefined) {
  return { ruleId, severity, title, detail, ...(hint ? { hint } : {}) };
}

/* ────────── 报告结构 ────────── */

test('报告包含六个规定章节', () => {
  const { markdown } = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset(),
    health: health(),
    at: '2026-10-21 10:00',
  });
  for (const heading of [
    '## 1. 文件格式',
    '## 2. 坐标系',
    '## 3. 几何有效性',
    '## 4. 伴随文件',
    '## 5. 本次改动的量化摘要',
  ]) {
    assert.ok(markdown.includes(heading), `缺少章节：${heading}`);
  }
  assert.ok(markdown.includes('在 ArcGIS 中打开需要注意'), '缺少「在 ArcGIS 中打开需要注意」段落');
});

test('栅格：尺寸/波段/驱动都写进「文件格式」', () => {
  const { markdown } = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset(),
    health: health(),
  });
  assert.ok(markdown.includes('GTiff/GeoTIFF'));
  assert.ok(markdown.includes('100×80'));
  assert.ok(markdown.includes('3 波段'));
});

test('栅格缺坐标系：报告标为阻断，并给出 ArcGIS 侧的提醒', () => {
  const blockers = [finding('R-CRS-001', 'blocker', '栅格缺少内嵌坐标系', '该栅格无法解析出坐标参考信息')];
  const res = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset({ crs: { present: false, source: 'none' } }),
    health: health(blockers, blockers),
  });
  assert.equal(res.hasBlocker, true);
  assert.ok(res.markdown.includes('R-CRS-001'));
  assert.ok(res.markdown.includes('坐标系未知'), '应提示 ArcGIS 会提示坐标系未知');
  assert.ok(res.markdown.includes('不会报错'), '应说明这类错误是静默的');
});

test('栅格 CRS 只在侧车里：提醒 ArcGIS 读得到、别的工具读不到', () => {
  const { markdown } = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset({ crs: { present: true, epsg: 4490, source: 'sidecar' } }),
    health: health(),
  });
  assert.ok(markdown.includes('Esri 软件会读同名'), '应说明 Esri 侧的行为差异');
});

test('矢量：缺 .prj 与 .cpg 都会进「在 ArcGIS 中打开需要注意」', () => {
  const res = renderCompatReport({
    path: 'x.shp',
    dataset: vectorDataset({
      crs: { present: false, source: 'none' },
      sidecars: { prj: null, cpg: null },
    }),
    health: health(),
  });
  assert.ok(res.markdown.includes('.prj'));
  assert.ok(res.markdown.includes('.cpg'));
  assert.ok(res.markdown.includes('坐标系未知'));
});

test('矢量编码是 GBK：提示转码会丢生僻字，并列入人工确认项', () => {
  const res = renderCompatReport({
    path: 'x.shp',
    dataset: vectorDataset({ encoding: 'GBK' }),
    health: health(),
  });
  assert.ok(res.markdown.includes('GBK'));
  assert.ok(res.markdown.includes('生僻字'));
  assert.equal(res.manualChecks.length, 1);
  assert.ok(res.manualChecks[0].includes('生僻字'));
});

test('字段很多：列入人工确认项', () => {
  const many = Array.from({ length: 42 }, (_, i) => ({ name: `f${i}`, type: 'String' }));
  const res = renderCompatReport({
    path: 'x.shp',
    dataset: vectorDataset({ fields: many }),
    health: health(),
  });
  assert.ok(res.manualChecks.some((c) => c.includes('42')));
});

test('几何问题进「几何有效性」，并提醒 Pro 拓扑检查会报错', () => {
  const findings = [finding('V-GEOM-001', 'warn', '存在自相交的面要素', '3 个要素自相交')];
  const { markdown } = renderCompatReport({
    path: 'x.shp',
    dataset: vectorDataset(),
    health: health(findings),
  });
  assert.ok(markdown.includes('V-GEOM-001'));
  assert.ok(markdown.includes('拓扑检查'));
});

test('无几何问题时明确说"未发现"', () => {
  const { markdown } = renderCompatReport({
    path: 'x.shp',
    dataset: vectorDataset(),
    health: health(),
  });
  // 文案要分清「查了没问题」与「没查」：自相交我们查不了，就得写明没查
  assert.ok(markdown.includes('未发现空几何、零面积面'));
  assert.ok(markdown.includes('尚未检查'), '没查的项必须写出来：' + markdown);
});

test('量化摘要：像元数、占比、备份、校验和都在', () => {
  const { markdown } = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset(),
    health: health(),
    operations: [
      {
        op: 'raster.erase',
        target: 'x.tif',
        affectedPixels: 250,
        totalPixels: 1000,
        backupPath: 'x.tif.bak.20261021-100000',
        checksumBefore: 'abcdef0123456789',
        checksumAfter: '9876543210fedcba',
      },
    ],
  });
  assert.ok(markdown.includes('raster.erase'));
  assert.ok(markdown.includes('影响像元 250'));
  assert.ok(markdown.includes('25.00%'), '应算出占比');
  assert.ok(markdown.includes('x.tif.bak.20261021-100000'), '应写出备份路径');
  assert.ok(markdown.includes('abcdef012345'));
});

test('没有操作记录时明说"仅体检，未改数据"，不编造', () => {
  const { markdown } = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset(),
    health: health(),
  });
  assert.ok(markdown.includes('仅体检，未改数据'));
});

test('没有阻断项时结论是"未发现阻断问题"', () => {
  const res = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset(),
    health: health(),
  });
  assert.equal(res.hasBlocker, false);
  assert.ok(res.markdown.includes('未发现阻断问题'));
});

test('阻断项必须带着"怎么改"出现在结论里', () => {
  // 只说"缺坐标系"而不说怎么修，收件人会以为这工具只会报错、修不了。
  // 报告是给对方照着做的材料，不是故障单。
  const f = finding(
    'R-CRS-001',
    'blocker',
    '栅格没有可用的坐标系',
    'GDAL 无法从该栅格解析出坐标系。',
    '检测到同名 .prj 侧车，但 GDAL 的栅格驱动不会自动读取它。写回时会把它内嵌进 GeoTIFF。',
  );
  const res = renderCompatReport({
    path: 'x.tff',
    dataset: rasterDataset(),
    health: health([f], [f]),
  });
  assert.equal(res.hasBlocker, true);
  const conclusion = res.markdown.slice(res.markdown.indexOf('## 结论'), res.markdown.indexOf('## 1.'));
  assert.ok(conclusion.includes('怎么改'), '结论段里没有"怎么改"');
  assert.ok(conclusion.includes('内嵌进 GeoTIFF'), '结论段里没有带上具体做法');
});

test('阻断项也要出现在体检明细附录里', () => {
  const f = finding('R-CRS-001', 'blocker', '栅格没有可用的坐标系', '说明', '建议这样改');
  const res = renderCompatReport({
    path: 'x.tff',
    dataset: rasterDataset(),
    health: health([f], [f]),
  });
  const detail = res.markdown.slice(res.markdown.indexOf('## 附：体检明细'));
  assert.ok(detail.includes('R-CRS-001'), '体检明细里没有 blocker');
  assert.ok(detail.includes('建议这样改'), '体检明细里没有带建议');
});

test('报告是纯函数：同样的输入产出完全一样的 markdown', () => {
  const input = {
    path: 'x.tif',
    dataset: rasterDataset(),
    health: health(),
    at: '2026-10-21 10:00',
  };
  const a = renderCompatReport(input);
  const b = renderCompatReport(input);
  assert.equal(a.markdown, b.markdown);
});

test('报告开头就写明文件、检查时间与用途（转给 GIS 同事即可）', () => {
  const { markdown } = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset(),
    health: health(),
    at: '2026-10-21 10:00',
    operator: '张三',
  });
  assert.ok(markdown.includes('x.tif'));
  assert.ok(markdown.includes('2026-10-21 10:00'));
  assert.ok(markdown.includes('张三'));
  assert.ok(markdown.includes('无需安装本软件'));
});

/* ────────── 波段类型（A2-4） ────────── */

test('8 位栅格：类型写进「文件格式」，且不出现 16 位说明', () => {
  const { markdown } = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset({ bandTypes: ['Byte', 'Byte', 'Byte'] }),
    health: health(),
  });
  assert.ok(markdown.includes('类型 Byte'), '报告里应写明波段类型 Byte');
  // 8 位影像写 16 位说明就是噪音：报告是给普通 GIS 同事看的，不是类型词典。
  assert.ok(!markdown.includes('16 位'), '8 位影像不应出现 16 位说明');
});

test('16 位栅格：类型写 UInt16，并在注意事项里说明降位行为', () => {
  const { markdown } = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset({ bandTypes: ['UInt16', 'UInt16', 'UInt16'] }),
    health: health(),
  });
  assert.ok(markdown.includes('类型 UInt16'), '报告里应写明波段类型 UInt16');
  assert.ok(markdown.includes('16 位无符号'), '应说明这是 16 位无符号影像');
  assert.ok(markdown.includes('导出 PNG / PDF 时降为 8 位显示'), '应说明导出时才降位');
});

test('16 位说明放在「在 ArcGIS 中打开需要注意」段落里，不塞进正文', () => {
  const { markdown } = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset({ bandTypes: ['UInt16'] }),
    health: health(),
  });
  const notes = markdown.slice(
    markdown.indexOf('在 ArcGIS 中打开需要注意'),
    markdown.indexOf('## 1.'),
  );
  assert.ok(notes.includes('16 位无符号'), '16 位说明应出现在注意事项段落里');
  assert.ok(
    !markdown.slice(markdown.indexOf('## 1.'), markdown.indexOf('## 2.')).includes('16 位无符号'),
    '16 位说明不应堆在「文件格式」正文里',
  );
});

test('多波段同类型：类型只写一次，不写成 Byte、Byte、Byte', () => {
  const { markdown } = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset({ bandTypes: ['Byte', 'Byte', 'Byte'] }),
    health: health(),
  });
  assert.ok(markdown.includes('类型 Byte'), '应写明类型 Byte');
  assert.ok(!markdown.includes('Byte、Byte、Byte'), '同类型不应重复列出');
});

test('各波段类型不一致：顿号分隔', () => {
  const { markdown } = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset({ bandTypes: ['Byte', 'UInt16', 'Byte'] }),
    health: health(),
  });
  assert.ok(markdown.includes('类型 Byte、UInt16'), '不同类型应用顿号分隔');
});

test('波段类型拿不到：写「未知」，不编造类型', () => {
  const { markdown } = renderCompatReport({
    path: 'x.tif',
    dataset: rasterDataset({ bandTypes: [] }),
    health: health(),
  });
  assert.ok(markdown.includes('类型 未知'), '拿不到类型时应写「未知」');
});
