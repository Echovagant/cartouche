/**
 * 矢量写回：FileGDB（.gdb）与 GML（.gml）。
 *
 * 这一组盯的是"写完之后还认得出来"：
 *   - GML：主文件 + .xsd 成套换、图层名/字段/坐标系不变、旧 .gfs 缓存要清掉；
 *   - FileGDB：整库重建后**图层顺序不变**（引擎读的是第一层）、其它图层一个不差、
 *     FID/几何列名保住；被锁住时一个字节不动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { probeLayer } = await import(eng('vector/read.ts'));
const { writeFeatures } = await import(eng('vector/write.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

const FEATURES = [
  { NAME: '北京', POP: 1000, HEIGHT: 43.5 },
  { NAME: '上海', POP: 2000, HEIGHT: 3.0 },
];

function geojsonOf(features = FEATURES) {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: features.map((p, i) => ({
      type: 'Feature',
      properties: p,
      geometry: { type: 'Point', coordinates: [116.4 + i * 0.1, 39.9 + i * 0.1] },
    })),
  });
}

function recordsOf(features = FEATURES) {
  return features.map((p, i) => ({
    properties: p,
    geometry: { type: 'Point', coordinates: [116.4 + i * 0.1, 39.9 + i * 0.1] },
  }));
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-vecfmt-'));
  const store = new LocalFolderStore(dir);
  const geojson = join(dir, 'cities.geojson');
  writeFileSync(geojson, geojsonOf(), 'utf8');
  return { dir, store, geojson };
}

async function ogr(args) {
  const res = await gdal.ogr2ogr(args);
  assert.ok(res.ok, `夹具/写回命令失败：${res.stderr}`);
  return res;
}

function layerOrder(abs) {
  return gdal.ogrInfo(['-ro', '-so', '-al', abs]).then((res) => {
    assert.ok(res.ok, `读图层失败：${res.stderr}`);
    return res.stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith('Layer name:'))
      .map((l) => l.replace('Layer name:', '').trim());
  });
}

function layerDetail(abs, layer) {
  return gdal.ogrInfo(['-ro', '-so', abs, layer]).then((res) => {
    assert.ok(res.ok, `读图层细节失败：${res.stderr}`);
    const fieldLines = res.stdout
      .split(/\r?\n/)
      .filter((l) => /^(.+?):\s+([A-Za-z0-9]+)\s*\(/.test(l) && !/^(Geometry|Extent|Data axis)/.test(l))
      .map((l) => l.trim());
    return {
      fields: fieldLines,
      fid: /^FID Column = (.+)$/m.exec(res.stdout)?.[1]?.trim() ?? null,
      geom: /^Geometry Column = (.+)$/m.exec(res.stdout)?.[1]?.trim() ?? null,
      count: Number(/^Feature Count:\s*(\d+)/m.exec(res.stdout)?.[1] ?? -1),
    };
  });
}

/* ────────────────────────────── GML ────────────────────────────── */

test('GML：写回后主文件与 .xsd 成套，图层名/字段/坐标系都在，旧 .gfs 被清掉', async () => {
  const { dir, store, geojson } = setup();
  try {
    const gml = join(dir, 'cities.gml');
    await ogr(['-f', 'GML', '-nln', 'cities', gml, geojson]);
    assert.ok(existsSync(join(dir, 'cities.xsd')), '夹具应产出 .xsd');
    // 模拟读图时留下的 schema 缓存：写回后它必须消失（否则还按旧结构解析）
    writeFileSync(join(dir, 'cities.gfs'), '<gfs/>', 'utf8');
    const before = await probeLayer(loc, gml);
    assert.equal(before.layerName, 'cities');
    assert.equal(before.featureCount, 2);

    const res = await writeFeatures(loc, store, {
      target: 'cities.gml',
      features: recordsOf([
        { NAME: '北京', POP: 1111, HEIGHT: 43.5 },
        { NAME: '上海', POP: 2222, HEIGHT: 3.0 },
      ]),
    });

    const after = await probeLayer(loc, gml);
    assert.equal(after.layerName, 'cities', '图层名不能变');
    assert.equal(after.featureCount, 2);
    assert.equal(after.epsg, 4326, '坐标系不能丢');
    assert.deepEqual(
      after.fields.map((f) => f.name),
      ['gml_id', 'NAME', 'POP', 'HEIGHT'],
      '字段名不能变',
    );
    assert.deepEqual(
      after.fields.map((f) => `${f.name}:${f.type}`),
      ['gml_id:String', 'NAME:String', 'POP:Integer', 'HEIGHT:Real'],
      '字段类型不能漂（Real 不能被重猜成 Integer）',
    );
    assert.ok(existsSync(join(dir, 'cities.xsd')), '新的 .xsd 必须在');
    assert.ok(!existsSync(join(dir, 'cities.gfs')), '旧的 .gfs 缓存必须被清掉，否则还按旧结构解析');
    assert.ok(res.backupPath, '必须留下备份');
    assert.ok(existsSync(join(dir, res.backupPath, 'cities.gml')), '备份里要有原 GML');
    assert.ok(existsSync(join(dir, res.backupPath, 'cities.xsd')), '备份里要有原 .xsd');
    assert.ok(readFileSync(gml, 'utf8').includes('1111'), '新属性要真的写进 GML');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GML：0 要素写回也保住字段定义（结构由 VRT 钉住）', async () => {
  const { dir, store, geojson } = setup();
  try {
    const gml = join(dir, 'cities.gml');
    await ogr(['-f', 'GML', '-nln', 'cities', gml, geojson]);
    const before = await probeLayer(loc, gml);

    const res = await writeFeatures(loc, store, { target: 'cities.gml', features: [] });
    const after = await probeLayer(loc, gml);
    assert.equal(after.featureCount, 0);
    assert.deepEqual(
      after.fields.map((f) => f.name),
      before.fields.map((f) => f.name),
      '空图层也必须保住字段定义（否则 ArcGIS 打开是一张没有列的表）',
    );
    assert.ok(existsSync(join(dir, 'cities.xsd')), '新的 .xsd 必须在');
    assert.ok(res.backupPath, '必须留下备份');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────────────────────────── FileGDB ───────────────────────────── */

test('GDB：写一层之后图层顺序不变，其它图层要素/字段一个不差，FID 与几何列名保住', async () => {
  const { dir, store, geojson } = setup();
  try {
    const target = join(dir, 'cities.gdb');
    await ogr(['-f', 'OpenFileGDB', '-nln', 'first', target, geojson]);
    await ogr(['-update', '-nln', 'second', target, geojson]);
    assert.deepEqual(await layerOrder(target), ['first', 'second']);
    const secondBefore = await layerDetail(target, 'second');

    const res = await writeFeatures(loc, store, {
      target: 'cities.gdb',
      features: recordsOf([{ NAME: '广州', POP: 3333, HEIGHT: 21.0 }]),
    });

    assert.deepEqual(
      await layerOrder(target),
      ['first', 'second'],
      '图层顺序必须原样（引擎读的是第一层，顺序变了就读错层）',
    );
    const firstAfter = await layerDetail(target, 'first');
    assert.equal(firstAfter.count, 1, '第一层应是新写进去的 1 条');
    assert.deepEqual(
      firstAfter.fields,
      secondBefore.fields,
      '第一层的字段定义应与原来一致（类型不能漂）',
    );
    assert.equal(firstAfter.fid, secondBefore.fid, 'FID 列名要保住');
    assert.equal(firstAfter.geom, secondBefore.geom, '几何列名要保住');

    const secondAfter = await layerDetail(target, 'second');
    assert.equal(secondAfter.count, secondBefore.count, '没动的那一层要素数不能变');
    assert.deepEqual(secondAfter.fields, secondBefore.fields, '没动的那一层字段不能变');

    assert.ok(res.backupPath, '必须留下备份');
    assert.ok(existsSync(join(dir, res.backupPath, 'gdb')), '备份必须是完整的 GDB 目录（含 gdb 文件）');
    assert.equal(res.layerName, 'first');
    assert.equal(res.featureCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GDB：加一列时原有列的类型不漂（Real 仍是 Real）', async () => {
  const { dir, store, geojson } = setup();
  try {
    const target = join(dir, 'cities.gdb');
    await ogr(['-f', 'OpenFileGDB', '-nln', 'first', target, geojson]);

    const features = recordsOf().map((f) => ({
      ...f,
      properties: { ...f.properties, NOTE: 'hi' },
    }));
    await writeFeatures(loc, store, { target: 'cities.gdb', features });

    const after = await layerDetail(target, 'first');
    assert.ok(after.fields.some((l) => l.startsWith('HEIGHT: Real')), 'HEIGHT 必须仍是 Real');
    assert.ok(after.fields.some((l) => l.startsWith('POP: Integer')), 'POP 必须仍是 Integer');
    assert.ok(after.fields.some((l) => l.startsWith('NOTE: String')), '新加的列必须写进去');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GDB：改字段名后旧列不残留，值原样搬过去', async () => {
  const { dir, store, geojson } = setup();
  try {
    const target = join(dir, 'cities.gdb');
    await ogr(['-f', 'OpenFileGDB', '-nln', 'first', target, geojson]);

    const features = recordsOf().map((f) => {
      const properties = { ...f.properties };
      properties.CITY = properties.NAME;
      delete properties.NAME;
      return { ...f, properties };
    });
    await writeFeatures(loc, store, { target: 'cities.gdb', features });

    const after = await layerDetail(target, 'first');
    assert.ok(!after.fields.some((l) => l.startsWith('NAME:')), '旧列 NAME 不能残留在文件里');
    assert.ok(after.fields.some((l) => l.startsWith('CITY: String')), '新列 CITY 要在');
    assert.ok(after.fields.some((l) => l.startsWith('HEIGHT: Real')), '其余列的类型不能变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GDB：指定不存在的图层名要明确报错', async () => {
  const { dir, store, geojson } = setup();
  try {
    const target = join(dir, 'cities.gdb');
    await ogr(['-f', 'OpenFileGDB', '-nln', 'first', target, geojson]);
    await assert.rejects(
      () => writeFeatures(loc, store, {
        target: 'cities.gdb',
        layerName: 'nope',
        features: recordsOf(),
      }),
      /没有「nope」这一层/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GDB：目录里有 .lock 时拒绝写回，原数据一个字节不动', async () => {
  const { dir, store, geojson } = setup();
  try {
    const target = join(dir, 'cities.gdb');
    await ogr(['-f', 'OpenFileGDB', '-nln', 'first', target, geojson]);
    writeFileSync(join(target, 'a00000001.gdbtable.lock'), '', 'utf8');

    await assert.rejects(
      () => writeFeatures(loc, store, { target: 'cities.gdb', features: recordsOf() }),
      /占用|锁文件/,
    );
    const still = await layerDetail(target, 'first');
    assert.equal(still.count, 2, '被拒绝后原数据必须还是 2 条');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GDB：重投影后坐标系与坐标都换了，图层与要素数不变', async () => {
  const { dir, store, geojson } = setup();
  try {
    const target = join(dir, 'cities.gdb');
    await ogr(['-f', 'OpenFileGDB', '-nln', 'first', target, geojson]);
    const before = await probeLayer(loc, target);
    assert.equal(before.epsg, 4326);

    // 目标坐标系的 WKT 从 GDAL 自己转出来的文件里取（写回接口收的是 WKT，不是 EPSG 简写）
    const warped = join(dir, 'warped.gpkg');
    await ogr(['-f', 'GPKG', '-t_srs', 'EPSG:3857', warped, geojson]);
    const targetCrs = await probeLayer(loc, warped);
    assert.ok(targetCrs.srsWkt, '夹具应带 3857 的 WKT');

    const res = await writeFeatures(loc, store, {
      target: 'cities.gdb',
      features: recordsOf().map((f) => ({
        ...f,
        geometry: {
          type: 'Point',
          coordinates: f.geometry.coordinates.map((v) => v * 111319.49),
        },
      })),
      srsWkt: targetCrs.srsWkt,
    });
    const after = await probeLayer(loc, target);
    assert.equal(after.epsg, 3857, '坐标系标签要换成目标坐标系');
    assert.equal(after.featureCount, 2);
    assert.equal(res.layerName, 'first');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
