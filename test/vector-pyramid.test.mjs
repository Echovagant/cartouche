/**
 * 矢量视口金字塔（分块加载第二阶段）+ 图层选择器选层语义。
 *
 * 金字塔的承诺：大源预建粗/中/细简化缓存，视口加载从小缓存裁 —— 快一到两个量级。
 * 本测试用**现场生成的抖动折线**（约 13 MB，超过 12MB 建塔门槛）钉住：
 *   1. 建塔产出至少一级且真的减重（点层/稀疏数据返回空 levels，不装样子）；
 *   2. 重复构建短路（cached:true）；findPyramid 能按源找回同一份缓存；
 *   3. zoom 选级语义（粗→细，越细越靠后，最大 zoom 拿最细一级）；
 *   4. 小文件不建塔（裁剪本身够快，不值得预付）。
 * 选层语义（图层选择器）：指定图层名按交集转换并在结果里如实列出；
 * 选了不存在的层名 → 整体报错（VectorConvertError），绝不静默。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveGdal } = await import(new URL('../src/engine/gdal/env.ts', import.meta.url).href);
const { buildVectorPyramid, findPyramid, pyramidLevelForZoom } = await import(
  new URL('../src/engine/export/vector-pyramid.ts', import.meta.url).href
);
const { vectorToGeoJson, VectorConvertError } = await import(
  new URL('../src/engine/export/vector-geojson.ts', import.meta.url).href
);

const loc = resolveGdal();
const dir = mkdtempSync(join(tmpdir(), 'cartouche-pyramid-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** 确定性伪随机（固定种子：夹具可复现，大小稳定） */
function makeRnd(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/**
 * 生成约 13MB 的平滑正弦线（超过 12MB 建塔门槛）。
 *
 * 为什么是正弦线而不是随机游走：随机游走是 Douglas–Peucker 的**最坏案例**
 * （每一步的偏移都超过容差，几乎删不动任何顶点），真实道路/河流/边界是
 * 平滑曲线，简化收益大 —— 夹具按真实形态造。
 */
function smoothLines(name, { lines = 150, verts = 4200 } = {}) {
  const rnd = makeRnd(42);
  const features = [];
  for (let i = 0; i < lines; i++) {
    const coords = [];
    for (let v = 0; v < verts; v++) {
      const x = 114.4 + v * 0.0002;
      const y = 37.8 + i * 0.001 + 0.01 * Math.sin(x * 40) + (rnd() - 0.5) * 0.000004;
      coords.push([Number(x.toFixed(6)), Number(y.toFixed(6))]);
    }
    features.push({
      type: 'Feature',
      properties: { id: i },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ type: 'FeatureCollection', features }), 'utf8');
  return p;
}

/** 生成超过 12MB 的点层（-simplify 不减重 → 应判为不值得建塔） */
function fatPoints(name, count = 220000) {
  const rnd = makeRnd(7);
  const features = [];
  for (let i = 0; i < count; i++) {
    features.push({
      type: 'Feature',
      properties: { id: i },
      geometry: {
        type: 'Point',
        coordinates: [Number((114.4 + rnd() * 0.6).toFixed(6)), Number((37.8 + rnd() * 0.6).toFixed(6))],
      },
    });
  }
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ type: 'FeatureCollection', features }), 'utf8');
  return p;
}

/** 双图层 GPKG（与 vector-multi-layer 同款造法） */
function twoLayerGpkg() {
  const gpkg = join(dir, 'two-layers.gpkg');
  const mkPoint = (name, marker) =>
    writeFileSync(
      join(dir, name),
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { marker },
            geometry: { type: 'Point', coordinates: [114.5, 38.0] },
          },
        ],
      }),
      'utf8',
    );
  const ogr2ogr = join(loc.binDir, 'ogr2ogr' + (process.platform === 'win32' ? '.exe' : ''));
  mkPoint('a.geojson', 'layer-a');
  mkPoint('b.geojson', 'layer-b');
  execFileSync(ogr2ogr, ['-f', 'GPKG', gpkg, join(dir, 'a.geojson'), '-nln', '图层甲']);
  execFileSync(ogr2ogr, [
    '-f', 'GPKG', '-update', '-append', '-nln', '图层乙', gpkg, join(dir, 'b.geojson'),
  ]);
  return gpkg;
}

describe('矢量视口金字塔', () => {
  const bigSource = smoothLines('big-lines.geojson');
  const rawVertices = 150 * 4200;

  test('大折线源建塔：至少一级且按顶点数真的减重', async () => {
    const res = await buildVectorPyramid(loc, { path: bigSource });
    assert.ok(res.levels.length >= 1, `正弦线应至少建成一级（note: ${res.note ?? '无'}）`);
    for (const level of res.levels) {
      assert.ok(
        level.vertices < rawVertices * 0.85,
        `每级顶点都要比源少 15% 以上（${level.name}: ${level.vertices} vs ${rawVertices}）`,
      );
      assert.ok(level.bytes <= 96 * 1024 * 1024, '每级都不超 96MB 上限');
    }
    // 级与级单调：细级顶点**多于**粗级（更有细节；几乎相等才是「没提供新细节」）
    for (let i = 1; i < res.levels.length; i++) {
      assert.ok(
        res.levels[i].vertices > res.levels[i - 1].vertices,
        `第 ${i} 级顶点应多于上一级（${res.levels[i].vertices} vs ${res.levels[i - 1].vertices}）`,
      );
    }
  });

  test('重复构建短路：cached:true，不再重建', async () => {
    const again = await buildVectorPyramid(loc, { path: bigSource });
    assert.equal(again.cached, true, '第二次构建应命中缓存');
  });

  test('findPyramid 按源找回同一份缓存', async () => {
    const info = findPyramid(bigSource);
    assert.ok(info, '缓存应能按源找到');
    const built = await buildVectorPyramid(loc, { path: bigSource });
    assert.deepEqual(info.levels, built.levels);
    // 缓存文件真的在盘上（findPyramid 会按 existsSync 过滤，能返回就是存在）
    assert.ok(info.levels.length >= 1);
  });

  test('zoom 选级：小 zoom 拿最粗一级；超出建到的级数 → null 落回原始裁剪', async () => {
    const info = findPyramid(bigSource);
    assert.ok(info && info.levels.length >= 1);
    assert.equal(pyramidLevelForZoom(info.levels, 1), info.levels[0], 'zoom=1 → 最粗级');
    if (info.levels.length >= 2) {
      const mid = pyramidLevelForZoom(info.levels, 9);
      assert.notEqual(mid, info.levels[0], 'zoom=9 不应拿最粗级');
    }
    const finest = info.levels[info.levels.length - 1];
    if (finest.zoomMax === Number.POSITIVE_INFINITY) {
      assert.equal(pyramidLevelForZoom(info.levels, 999), finest, 'fine 级在 → 超大 zoom 拿它兜底');
    } else {
      // fine 级没建成（顶点没比 mid 再减 15%）：超大 zoom 返回 null 才对 ——
      // 落回**原始裁剪**（最细），而不是拿粗级硬凑
      assert.equal(pyramidLevelForZoom(info.levels, 999), null);
    }
  });

  test('点层（-simplify 不减重）返回空 levels + 说明', async () => {
    const points = fatPoints('fat-points.geojson');
    const res = await buildVectorPyramid(loc, { path: points });
    assert.equal(res.levels.length, 0, '点层建塔没有意义，应返回空');
    assert.ok(res.note, '空 levels 必须带说明');
    // 空结果也落 manifest：下次不再花几分钟重跑一遍注定无用的简化
    const cached = await buildVectorPyramid(loc, { path: points });
    assert.equal(cached.cached, true);
  });

  test('小文件不建塔（12MB 门槛）', async () => {
    const small = join(dir, 'small.geojson');
    writeFileSync(
      small,
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [114.5, 38] } },
        ],
      }),
      'utf8',
    );
    const res = await buildVectorPyramid(loc, { path: small });
    assert.equal(res.levels.length, 0);
    assert.match(res.note ?? '', /无需金字塔/);
  });
});

describe('图层选择器：vectorToGeoJson 选层语义', () => {
  const gpkg = twoLayerGpkg();

  test('指定图层名：只转所选层，结果如实列出', async () => {
    const res = await vectorToGeoJson(loc, { path: gpkg, layers: ['图层乙'] });
    assert.equal(res.featureCount, 1, '只装所选层（图层乙 1 个要素）');
    const markers = res.geojson.features.map((f) => f.properties.marker);
    assert.deepEqual(markers, ['layer-b']);
    assert.deepEqual(res.layers, ['图层乙'], '结果里要如实列出装了哪些层');
  });

  test('选了不存在的层名 → 整体报错（VectorConvertError），不静默', async () => {
    await assert.rejects(
      () => vectorToGeoJson(loc, { path: gpkg, layers: ['不存在的图层'] }),
      (err) => err instanceof VectorConvertError && /所选图层都不在这个文件里/.test(err.message),
    );
  });

  test('不给 layers 时行为不变（全合并；多图层源在结果里如实列出所装层）', async () => {
    const res = await vectorToGeoJson(loc, { path: gpkg });
    assert.equal(res.featureCount, 2);
    assert.deepEqual(res.layers, ['图层甲', '图层乙'], '多图层源默认全合并时也列出所装层');
  });
});
