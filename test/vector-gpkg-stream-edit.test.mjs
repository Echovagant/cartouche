/**
 * 超大 GeoPackage 的原生写操作验收：加字段、改属性、删要素。
 *
 * 这组用例直接调用流式实现（普通路径在 512 MB 以下走整层读写，测不到这里），
 * 并用同样的小 GPKG 与引擎自己的表达式引擎对拍：
 *  - 条件：SQL 命中的主键集合必须与 matchesWhere 完全一致；
 *  - 表达式：SQL 算出来的值必须与 evaluate 一致；
 *  - 三条写操作：值正确、命中之外的行不被改、预留备份。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync,
  cpSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { probeLayer, readFeatures, matchesWhere } = await import(eng('vector/read.ts'));
const { gpkgQuery, quoteIdent } = await import(eng('vector/gpkg-native.ts'));
const {
  makeSqlContext,
  compileWhereSql,
  compileNewColumnSql,
  sqlLiteral,
} = await import(eng('vector/sql-expression.ts'));
const {
  gpkgStreamAddField,
  gpkgStreamSetAttributes,
  gpkgStreamDelete,
} = await import(eng('vector/stream-gpkg-edit.ts'));
const { parseExpression, evaluate } = await import(eng('expression/index.ts'));
const { columnKindOf } = await import(eng('feature/common.ts'));
const { previewOp } = await import(eng('ops/index.ts'));

const loc = resolveGdal();
if (!loc) throw new Error('本机没有 GDAL，这组用例跑不了');

const TMP_BASE = process.env.CARTOUCHE_TEST_TMP || join(root, '.tmp-test');
let dir = '';
let gpkg = '';

/** 造一个投影坐标系（EPSG:3857）的面图层：面积按平方米，ST_Area 可算 */
function makeGeoJson() {
  const rect = (x, y, size) => ({
    type: 'Polygon',
    coordinates: [[[x, y], [x, y + size], [x + size, y + size], [x + size, y], [x, y]]],
  });
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { 名称: '甲', 编码: 1, 面积: 100.5 }, geometry: rect(0, 0, 10) },
      { type: 'Feature', properties: { 名称: '乙', 编码: 2, 面积: 250 }, geometry: rect(100, 100, 20) },
      { type: 'Feature', properties: { 名称: 'abc', 编码: 3, 面积: null }, geometry: rect(300, 300, 30) },
    ],
  };
}

async function freshGpkg(name) {
  const target = join(dir, name);
  const src = join(dir, `${name}.geojson`);
  writeFileSync(src, JSON.stringify(makeGeoJson()), 'utf8');
  const res = await tools(loc).ogr2ogr([
    '-f', 'GPKG', '-a_srs', 'EPSG:3857', '-nln', 'parcels', target, src,
  ]);
  assert.ok(res.ok, `造 GPKG 失败：${res.stderr}`);
  return target;
}

function fieldKind(info, name) {
  const f = info.fields.find((x) => x.name === name);
  assert.ok(f, `应当有「${name}」这一列`);
  return columnKindOf(f.type);
}

before(async () => {
  mkdirSync(TMP_BASE, { recursive: true });
  dir = mkdtempSync(join(TMP_BASE, 'cartouche-gpkg-stream-'));
  gpkg = await freshGpkg('base.gpkg');
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/* ── 条件与表达式：与引擎口径对拍 ─────────────────────────────── */

test('条件编译：SQL 命中的主键与 matchesWhere 完全一致', async () => {
  const info = await probeLayer(loc, gpkg);
  const read = await readFeatures(loc, { path: gpkg });
  const fids = read.features.map((_, i) => i + 1); // GPKG 的 fid 从 1 开始，顺序即文件顺序
  const cases = [
    '编码 > 1',
    "名称 = '甲'",
    "名称 <> '乙'",
    "名称 LIKE '%b%'",
    '编码 IN (1, 3)',
    '编码 NOT IN (1, 3)',
    '面积 BETWEEN 100 AND 260',
    '面积 IS NULL',
    '面积 IS NOT NULL',
    'NOT (编码 = 1)',
    '编码 = 1 OR 面积 > 200',
    '面积 > 100 AND 编码 < 3',
  ];

  for (const src of cases) {
    const node = parseExpression(src);
    const ctx = makeSqlContext(info.fields, null);
    const whereSql = compileWhereSql(node, ctx);
    const rows = await gpkgQuery(
      loc,
      gpkg,
      `SELECT fid FROM ${quoteIdent('parcels')} WHERE ${whereSql} ORDER BY fid`,
    );
    const sqlFids = rows.map((r) => Number(r['__fid']));
    const jsFids = fids.filter((i) => matchesWhere(node, read.features[i - 1].properties));
    assert.deepEqual(sqlFids, jsFids, `条件「${src}」的命中集合不一致`);
  }
});

test('条件里的函数：SQL 命中集合与 matchesWhere 一致', async () => {
  const info = await probeLayer(loc, gpkg);
  const read = await readFeatures(loc, { path: gpkg });
  for (const src of ["UPPER(名称) = 'ABC'", 'LENGTH(名称) = 1', 'COALESCE(面积, 0) > 200']) {
    const node = parseExpression(src);
    const ctx = makeSqlContext(info.fields, null);
    const whereSql = compileWhereSql(node, ctx);
    const rows = await gpkgQuery(
      loc,
      gpkg,
      `SELECT fid FROM ${quoteIdent('parcels')} WHERE ${whereSql} ORDER BY fid`,
    );
    const sqlFids = rows.map((r) => Number(r['__fid']));
    const jsFids = read.features
      .map((_, i) => i + 1)
      .filter((i) => matchesWhere(node, read.features[i - 1].properties));
    assert.deepEqual(sqlFids, jsFids, `条件「${src}」的命中集合不一致`);
  }
});

test('CONCAT 接数字参数时明确拒绝（两边转文字的位数口径不同）', async () => {
  const info = await probeLayer(loc, gpkg);
  const ctx = makeSqlContext(info.fields, null);
  assert.throws(
    () => compileNewColumnSql(parseExpression("CONCAT(名称, '-', 编码)"), ctx, '__probe'),
    /CONCAT 只接文字参数/,
  );
});

test('SQL 字面量：单引号加倍，空值写成 NULL', () => {
  assert.equal(sqlLiteral("O'Neil"), "'O''Neil'");
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(true), '1');
  assert.equal(sqlLiteral(2.5), '2.5');
});

test('表达式编译：SQL 值与 evaluate 一致', async () => {
  const info = await probeLayer(loc, gpkg);
  const read = await readFeatures(loc, { path: gpkg });
  const cases = [
    '面积 * 2 + 1',
    '面积 / 3',
    '面积 - 10',
    'ABS(面积 - 150)',
    'ROUND(面积, 1)',
    'COALESCE(面积, 0)',
    'UPPER(名称)',
    'LENGTH(名称)',
    '编码 + 1',
  ];
  for (const src of cases) {
    const node = parseExpression(src);
    const ctx = makeSqlContext(info.fields, null);
    const { sql } = compileNewColumnSql(node, ctx, '__probe');
    const rows = await gpkgQuery(
      loc,
      gpkg,
      `SELECT fid, (${sql}) AS v FROM ${quoteIdent('parcels')} ORDER BY fid`,
    );
    for (let i = 0; i < read.features.length; i += 1) {
      const want = read.features[i].properties;
      const got = rows[i] ? rows[i]['v'] : null;
      let expected;
      try {
        expected = evaluate(node, want);
      } catch {
        expected = '__error__';
      }
      if (expected === '__error__') continue;
      if (expected === null) {
        assert.equal(got, null, `「${src}」第 ${i + 1} 行：引擎是空值，SQL 是 ${JSON.stringify(got)}`);
      } else if (typeof expected === 'number' && typeof got === 'number') {
        const scale = Math.max(1, Math.abs(expected), Math.abs(got));
        assert.ok(
          Math.abs(expected - got) <= 1e-9 * scale,
          `「${src}」第 ${i + 1} 行：引擎 ${expected}，SQL ${got}`,
        );
      } else {
        assert.equal(got, expected, `「${src}」第 ${i + 1} 行`);
      }
    }
  }
});

test('条件里的函数：空参数按短路口径检查', async () => {
  const target = join(dir, 'nullname.gpkg');
  writeFileSync(
    join(dir, 'nullname.geojson'),
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { 名称: 'abc', 编码: 1 }, geometry: { type: 'Point', coordinates: [0, 0] } },
        { type: 'Feature', properties: { 名称: null, 编码: 2 }, geometry: { type: 'Point', coordinates: [1, 1] } },
      ],
    }),
    'utf8',
  );
  const made = await tools(loc).ogr2ogr([
    '-f', 'GPKG', '-a_srs', 'EPSG:3857', '-nln', 'names', target, join(dir, 'nullname.geojson'),
  ]);
  assert.ok(made.ok, `造空值样本失败：${made.stderr}`);
  const store = new LocalFolderStore(dir);
  const info = await probeLayer(loc, target);

  // 没有先判空：普通路径会在空名字那一行报错，这里也要拒绝，不能静默跳过
  await assert.rejects(
    () =>
      gpkgStreamSetAttributes(loc, store, {
        targetRel: 'nullname.gpkg',
        absPath: target,
        info,
        whereSource: "UPPER(名称) = 'ABC'",
        whereNode: parseExpression("UPPER(名称) = 'ABC'"),
        targets: [
          {
            name: '编码',
            requested: '编码',
            kind: fieldKind(info, '编码'),
            value: { kind: 'literal', value: 9 },
          },
        ],
        dryRun: false,
      }),
    /空值/,
  );
  let read = await readFeatures(loc, { path: target });
  assert.deepEqual(read.features.map((f) => f.properties['编码']), [1, 2], '被拒绝时不能写盘');

  // 先判空再 UPPER：空名字那一行被短路，不报错
  const res = await gpkgStreamSetAttributes(loc, store, {
    targetRel: 'nullname.gpkg',
    absPath: target,
    info,
    whereSource: "名称 IS NOT NULL AND UPPER(名称) = 'ABC'",
    whereNode: parseExpression("名称 IS NOT NULL AND UPPER(名称) = 'ABC'"),
    targets: [
      {
        name: '编码',
        requested: '编码',
        kind: fieldKind(info, '编码'),
        value: { kind: 'literal', value: 9 },
      },
    ],
    dryRun: false,
  });
  assert.match(res.summary, /已改 1 条要素/);
  read = await readFeatures(loc, { path: target });
  assert.deepEqual(read.features.map((f) => f.properties['编码']), [9, 2]);
});

/* ── 加字段：原生路径 ────────────────────────────────────────── */

test('原生加字段：表达式算出的值与引擎一致，命中之外留空', async () => {
  const target = await freshGpkg('add.gpkg');
  const store = new LocalFolderStore(dir);
  const info = await probeLayer(loc, target);
  const expr = parseExpression('面积 * 2');
  const where = parseExpression('编码 >= 2');

  const res = await gpkgStreamAddField(loc, store, {
    targetRel: 'add.gpkg',
    absPath: target,
    info,
    fieldName: '双倍面积',
    exprNode: expr,
    whereNode: where,
    areaPseudo: false,
    metersPerUnit: 1,
    dryRun: false,
  });
  assert.equal(res.kind, 'value');
  assert.match(res.summary, /已加字段/);
  assert.ok(res.data.backupPath, '应当有备份');

  const read = await readFeatures(loc, { path: target });
  assert.equal(read.features[0].properties['双倍面积'], null, '编码=1 不该被赋值');
  assert.equal(read.features[1].properties['双倍面积'], 500);
  assert.equal(read.features[2].properties['双倍面积'], null, '编码=3 的值为空 → 面积*2 也是空');
});

test('原生加字段：AREA 伪列按平方米算', async () => {
  const target = await freshGpkg('area.gpkg');
  const store = new LocalFolderStore(dir);
  const info = await probeLayer(loc, target);
  const res = await gpkgStreamAddField(loc, store, {
    targetRel: 'area.gpkg',
    absPath: target,
    info,
    fieldName: '面积米',
    exprNode: parseExpression('AREA'),
    whereNode: null,
    areaPseudo: true,
    metersPerUnit: 1,
    dryRun: false,
  });
  assert.match(res.summary, /单位平方米/);
  const read = await readFeatures(loc, { path: target });
  const areas = read.features.map((f) => f.properties['面积米']);
  assert.deepEqual(areas, [100, 400, 900]);
});

test('原生加字段：点图层上的 AREA 明确拒绝', async () => {
  const target = join(dir, 'points.gpkg');
  writeFileSync(
    join(dir, 'points.geojson'),
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { 名称: '点' },
          geometry: { type: 'Point', coordinates: [10, 10] },
        },
      ],
    }),
    'utf8',
  );
  const made = await tools(loc).ogr2ogr([
    '-f', 'GPKG', '-a_srs', 'EPSG:3857', '-nln', 'points', target, join(dir, 'points.geojson'),
  ]);
  assert.ok(made.ok, `造点图层失败：${made.stderr}`);
  const store = new LocalFolderStore(dir);
  const info = await probeLayer(loc, target);
  await assert.rejects(
    () =>
      gpkgStreamAddField(loc, store, {
        targetRel: 'points.gpkg',
        absPath: target,
        info,
        fieldName: '面积米',
        exprNode: parseExpression('AREA'),
        whereNode: null,
        areaPseudo: true,
        metersPerUnit: 1,
        dryRun: false,
      }),
    /不是面要素/,
  );
});

/* ── 改属性：原生路径 ────────────────────────────────────────── */

test('原生改属性：字面值 + 表达式，命中之外不动', async () => {
  const target = await freshGpkg('set.gpkg');
  const store = new LocalFolderStore(dir);
  const info = await probeLayer(loc, target);
  const res = await gpkgStreamSetAttributes(loc, store, {
    targetRel: 'set.gpkg',
    absPath: target,
    info,
    whereSource: '编码 >= 2',
    whereNode: parseExpression('编码 >= 2'),
    targets: [
      {
        name: '名称',
        requested: '名称',
        kind: fieldKind(info, '名称'),
        value: { kind: 'literal', value: '已核查' },
      },
      {
        name: '面积',
        requested: '面积',
        kind: fieldKind(info, '面积'),
        value: {
          kind: 'expression',
          node: parseExpression('面积 * 2'),
          source: '面积 * 2',
        },
      },
    ],
    dryRun: false,
  });
  assert.match(res.summary, /已改 2 条要素/);
  const read = await readFeatures(loc, { path: target });
  assert.equal(read.features[0].properties['名称'], '甲', '编码=1 不该被改');
  assert.equal(read.features[1].properties['名称'], '已核查');
  assert.equal(read.features[1].properties['面积'], 500);
  assert.equal(read.features[2].properties['名称'], '已核查');
  assert.equal(read.features[2].properties['面积'], null, '空值乘 2 仍是空值');
});

test('原生改属性：0 条命中明确报错', async () => {
  const info = await probeLayer(loc, gpkg);
  const store = new LocalFolderStore(dir);
  await assert.rejects(
    () =>
      gpkgStreamSetAttributes(loc, store, {
        targetRel: 'base.gpkg',
        absPath: gpkg,
        info,
        whereSource: '编码 = 999',
        whereNode: parseExpression('编码 = 999'),
        targets: [
          {
            name: '名称',
            requested: '名称',
            kind: fieldKind(info, '名称'),
            value: { kind: 'literal', value: 'x' },
          },
        ],
        dryRun: false,
      }),
    /没有命中任何要素/,
  );
});

test('原生改属性：跨列引用走顺序逐列更新（与普通路径同语义）', async () => {
  // 2026-11-21 起：跨列引用不再拒收 —— 用「标记列冻结命中行 + 按声明顺序
  // 逐列 UPDATE」实现，后面的表达式能看到前面刚改的值。
  const target = await freshGpkg('cross.gpkg');
  const info = await probeLayer(loc, target);
  const store = new LocalFolderStore(dir);
  const res = await gpkgStreamSetAttributes(loc, store, {
    targetRel: 'cross.gpkg',
    absPath: target,
    info,
    whereSource: '编码 >= 1',
    whereNode: parseExpression('编码 >= 1'),
    targets: [
      {
        name: '编码',
        requested: '编码',
        kind: fieldKind(info, '编码'),
        value: { kind: 'literal', value: 9 },
      },
      {
        name: '面积',
        requested: '面积',
        kind: fieldKind(info, '面积'),
        value: {
          kind: 'expression',
          node: parseExpression('编码 + 1'),
          source: '编码 + 1',
        },
      },
    ],
    dryRun: false,
  });
  assert.match(res.summary, /跨列引用按声明顺序逐列更新/);
  // 顺序语义：面积 = 编码（刚改成 9）+ 1 = 10。若是一次性 SET，面积会按旧编码（1/2/3）各算各的。
  const after = await readFeatures(loc, { path: target });
  for (const f of after.features) {
    assert.equal(f.properties['编码'], 9, '编码统一改成 9');
    assert.equal(f.properties['面积'], 10, '面积按顺序语义 = 9 + 1 = 10');
  }
});

test('原生改属性：整数列的小数按四舍五入写入', async () => {
  const target = await freshGpkg('set-round.gpkg');
  const store = new LocalFolderStore(dir);
  const info = await probeLayer(loc, target);
  const res = await gpkgStreamSetAttributes(loc, store, {
    targetRel: 'set-round.gpkg',
    absPath: target,
    info,
    whereSource: '编码 >= 2',
    whereNode: parseExpression('编码 >= 2'),
    targets: [
      {
        name: '编码',
        requested: '编码',
        kind: fieldKind(info, '编码'),
        value: {
          kind: 'expression',
          node: parseExpression('面积 / 3'),
          source: '面积 / 3',
        },
      },
    ],
    dryRun: false,
  });
  assert.match(res.summary, /四舍五入/);
  const read = await readFeatures(loc, { path: target });
  // 250 / 3 = 83.33 → 83；面积为空的那条 → 空值
  assert.deepEqual(read.features.map((f) => f.properties['编码']), [1, 83, null]);
});

/* ── 删要素：原生路径 ────────────────────────────────────────── */

test('原生删要素：keep=none 删掉命中行', async () => {
  const target = await freshGpkg('del.gpkg');
  const store = new LocalFolderStore(dir);
  const info = await probeLayer(loc, target);
  const res = await gpkgStreamDelete(loc, store, {
    targetRel: 'del.gpkg',
    absPath: target,
    info,
    whereSource: '编码 = 2',
    whereNode: parseExpression('编码 = 2'),
    keep: 'none',
    dryRun: false,
  });
  assert.match(res.summary, /已删掉 1 条/);
  assert.equal(res.data.remaining, 2);
  const after = await probeLayer(loc, target);
  assert.equal(after.featureCount, 2);
});

test('原生删要素：keep=first 保留第一条', async () => {
  const target = await freshGpkg('del-first.gpkg');
  const store = new LocalFolderStore(dir);
  const info = await probeLayer(loc, target);
  const res = await gpkgStreamDelete(loc, store, {
    targetRel: 'del-first.gpkg',
    absPath: target,
    info,
    whereSource: '编码 >= 2',
    whereNode: parseExpression('编码 >= 2'),
    keep: 'first',
    dryRun: false,
  });
  assert.match(res.summary, /保留第一条/);
  assert.equal(res.data.deleted, 1);
  const read = await readFeatures(loc, { path: target });
  assert.deepEqual(read.features.map((f) => f.properties['编码']), [1, 2]);
});

test('原生删要素：keep=largest 留最大面；删空图层仍明确拒绝', async () => {
  // 2026-11-21 起：keep=largest 用 ST_Area 在 SQL 里排序实现（面按面积，线按长度）。
  // 夹具三块面的几何面积是 100 / 400 / 900 —— 应留下丙（900），删掉甲与乙。
  const target = await freshGpkg('largest.gpkg');
  const info = await probeLayer(loc, target);
  const store = new LocalFolderStore(dir);
  const res = await gpkgStreamDelete(loc, store, {
    targetRel: 'largest.gpkg',
    absPath: target,
    info,
    whereSource: '编码 >= 1',
    whereNode: parseExpression('编码 >= 1'),
    keep: 'largest',
    dryRun: false,
  });
  assert.equal(res.data.deleted, 2);
  assert.match(res.data.kept.reason, /面积/);
  const after = await readFeatures(loc, { path: target });
  assert.equal(after.features.length, 1);
  assert.equal(after.features[0].properties['名称'], 'abc', '应保留几何面积最大的那块（丙，900 m²）');
  await assert.rejects(
    async () =>
      gpkgStreamDelete(loc, store, {
        targetRel: 'largest.gpkg',
        absPath: target,
        info: await probeLayer(loc, target),
        whereSource: '编码 >= 1',
        whereNode: parseExpression('编码 >= 1'),
        keep: 'none',
        dryRun: false,
      }),
    /等于清空图层/,
  );
});

/* ── 体积分支：超过 512 MB 的 GPKG 真的走原生路径 ─────────────── */

test('超过 512 MB 的 GPKG：预演走原生路径，非 GPKG 仍被拒绝', async () => {
  const big = join(dir, 'big.gpkg');
  cpSync(gpkg, big);
  const fd = openSync(big, 'r+');
  try {
    ftruncateSync(fd, 600 * 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  const store = new LocalFolderStore(dir);
  const preview = await previewOp(
    { loc, store },
    {
      op: 'feature.setAttributes',
      params: {
        target: 'dataset://big.gpkg',
        where: '编码 = 1',
        set: { 名称: '大文件' },
      },
    },
  );
  assert.equal(preview.ok, true, preview.error ?? '应当成功');
  assert.match(preview.value?.summary ?? '', /超大图层用数据库原生 SQL/);

  const addPreview = await previewOp(
    { loc, store },
    {
      op: 'vector.addField',
      params: { target: 'dataset://big.gpkg', name: '大一', expression: '编码 + 1' },
    },
  );
  assert.equal(addPreview.ok, true, addPreview.error ?? '加字段预演应当成功');
  assert.match(addPreview.value?.summary ?? '', /数据库原生计算/);

  const delPreview = await previewOp(
    { loc, store },
    {
      op: 'feature.delete',
      params: { target: 'dataset://big.gpkg', where: '编码 = 1' },
    },
  );
  assert.equal(delPreview.ok, true, delPreview.error ?? '删除预演应当成功');
  assert.match(delPreview.value?.summary ?? '', /原生删除/);

  const sumPreview = await previewOp(
    { loc, store },
    {
      op: 'feature.summarize',
      params: { target: 'dataset://big.gpkg', groupBy: ['名称'], aggregates: ['count', 'sum'] },
    },
  );
  assert.equal(sumPreview.ok, true, sumPreview.error ?? '汇总预演应当成功');
  assert.match(sumPreview.value?.summary ?? '', /数据库原生汇总/);

  // 同样内容的文件换个非 GPKG 扩展名：仍然被 512 MB 闸门拒绝
  const other = join(dir, 'big.sqlite');
  cpSync(big, other);
  const blocked = await previewOp(
    { loc, store },
    {
      op: 'feature.setAttributes',
      params: { target: 'dataset://big.sqlite', where: '编码 = 1', set: { 名称: 'x' } },
    },
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.error ?? '', /512 MB/);
});
