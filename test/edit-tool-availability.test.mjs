/**
 * 编辑工具可用性的判定测试。
 *
 * 盯住的是**按工具**判定这条口径：
 *   画笔 / 框选要把屏幕坐标换算成栅格的原生像元 → 换算由**引擎**做
 *     （`POST /api/raster/pixels`：投影 + 仿射反算），
 *     所以**投影坐标系的栅格也能画**（CGCS2000 3 度带是国内最常见的底图）；
 *     只有"压根没有坐标系"才换不了；
 *   调色是整幅逐像元调整（引擎侧 raster.adjustLevels）→ **与坐标系无关**。
 *
 * 这条曾经被压成**一个**全局字符串，于是栅格不是 4326 时「调色」被连坐禁用——
 * CGCS2000 3 度带整层一笔都画不了，连调色都点不着。
 *
 * 本文件里的栅格夹具是**构造数据**（仿射参数与坐标系是按 EPSG 规范写的），
 * 不对应任何真实数据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => pathToFileURL(join(root, 'web', 'app', 'canvas', p)).href;

const { isWgs84Grid } = await import(web('editGeometry.ts'));
const { computeBlockedReasons, isToolDisabled, NO_CRS_REASON } = await import(
  web('editAvailability.ts')
);

/* ── 夹具 ────────────────────────────────────────────────── */

/** CGCS2000 3 度带（EPSG:4547，CM 114E）：坐标是米，不是经纬度 */
const GRID_4547 = {
  width: 512,
  height: 512,
  geotransform: [38500000, 10, 0, 4420000, 0, -10],
  crs: {
    present: true,
    epsg: 4547,
    authority: 'EPSG:4547',
    source: 'embedded',
    wkt: 'PROJCS["CGCS2000 / 3-degree Gauss-Kruger CM 114E"]',
    is4326: false,
  },
};

/** 经纬度栅格（EPSG:4326）：坐标就是度 */
const GRID_4326 = {
  width: 512,
  height: 512,
  geotransform: [120.3, 0.001, 0, 30.52, 0, -0.001],
  crs: {
    present: true,
    epsg: 4326,
    authority: 'EPSG:4326',
    source: 'embedded',
    wkt: 'GEOGCS["WGS 84"]',
    is4326: true,
  },
};

/** 压根没有坐标系的栅格：换算不了经纬度 → 画笔/框选该被挡住 */
const GRID_NO_CRS = {
  width: 512,
  height: 512,
  geotransform: [385000, 10, 0, 3435000, 0, -10],
  crs: {
    present: false,
    epsg: null,
    authority: null,
    source: 'none',
    wkt: null,
    is4326: false,
  },
};

/** 按当前状态算出四个工具的原因（走的是真实判据 isWgs84Grid） */
function reasonsFor(grid, overrides = {}) {
  return computeBlockedReasons({
    hasTarget: true,
    gridLoading: false,
    gridError: null,
    hasGrid: grid !== null,
    gridIsWgs84: grid !== null && isWgs84Grid(grid),
    gridHasCrs: grid?.crs.present === true,
    ...overrides,
  });
}

/* ── 主症状：非 4326 栅格上「画笔/框选」不再被连坐禁用 ────── */

test('非 4326 栅格：调色不被禁用，也不显示任何阻塞原因', () => {
  const reasons = reasonsFor(GRID_4547);
  assert.equal(reasons.levels, null, '调色不该有阻塞原因');
  // 工具条上「调色」按钮因此不禁用（当前工具是查看）
  assert.equal(isToolDisabled(reasons, 'levels', 'view'), false, '调色按钮不该被禁用');
});

test('非 4326 栅格：画笔与框选**不再**被禁用（换算由引擎做）', () => {
  const reasons = reasonsFor(GRID_4547);
  assert.equal(reasons.brush, null, '画笔不该有阻塞原因');
  assert.equal(reasons.box, null, '框选不该有阻塞原因');
  assert.equal(isToolDisabled(reasons, 'brush', 'view'), false, '画笔按钮不该被禁用');
  assert.equal(isToolDisabled(reasons, 'box', 'view'), false, '框选按钮不该被禁用');
});

test('压根没有坐标系的栅格：画笔与框选仍然禁用，并带正确的文案', () => {
  const reasons = reasonsFor(GRID_NO_CRS);
  assert.equal(isToolDisabled(reasons, 'brush', 'view'), true, '画笔必须被禁用');
  assert.equal(isToolDisabled(reasons, 'box', 'view'), true, '框选必须被禁用');
  for (const tool of ['brush', 'box']) {
    const reason = reasons[tool];
    assert.ok(reason, `${tool} 必须有阻塞原因`);
    assert.equal(reason, NO_CRS_REASON, `${tool} 的原因应当是缺坐标系那条`);
    assert.match(reason, /坐标系/, `${tool} 的原因要指出缺坐标系`);
    assert.match(reason, /原生像元/, `${tool} 的原因要指出换算不到原生像元`);
  }
});

test('非 4326 栅格：查看永远可用', () => {
  const reasons = reasonsFor(GRID_4547);
  assert.equal(reasons.view, null, '查看不该有阻塞原因');
  assert.equal(isToolDisabled(reasons, 'view', 'brush'), false, '查看必须能点回去');
});

/* ── 其它工具的判定口径 ───────────────────────────────────── */

test('4326 栅格：四个工具都没有阻塞原因', () => {
  const reasons = reasonsFor(GRID_4326);
  for (const tool of ['view', 'brush', 'box', 'levels']) {
    assert.equal(reasons[tool], null, `${tool} 在 4326 栅格上不该被禁用`);
  }
});

test('没选栅格图层：除查看外都要提示先选栅格', () => {
  const reasons = reasonsFor(null, { hasTarget: false, hasGrid: false });
  assert.equal(reasons.view, null);
  assert.match(reasons.brush ?? '', /先选一个栅格图层/);
  assert.match(reasons.box ?? '', /先选一个栅格图层/);
  assert.match(reasons.levels ?? '', /先选一个栅格图层/);
});

test('栅格网格还在读：画笔/框选提示读取中，调色不受影响', () => {
  const reasons = reasonsFor(null, { gridLoading: true });
  assert.match(reasons.brush ?? '', /正在读取栅格网格/);
  assert.match(reasons.box ?? '', /正在读取栅格网格/);
  assert.equal(reasons.levels, null, '调色不等栅格网格，不该被连坐');
  assert.equal(isToolDisabled(reasons, 'levels', 'view'), false);
});

test('栅格网格读失败：画笔/框选带上失败原因，调色仍不被禁用', () => {
  const reasons = reasonsFor(null, { gridError: '文件被占用' });
  assert.match(reasons.brush ?? '', /读取栅格网格失败/);
  assert.match(reasons.brush ?? '', /文件被占用/);
  assert.match(reasons.box ?? '', /读取栅格网格失败/);
  assert.equal(reasons.levels, null, '调色不需要栅格网格');
  assert.equal(isToolDisabled(reasons, 'levels', 'view'), false);
});

test('当前选中的工具永远不置灰（不能把自己锁死）', () => {
  const reasons = reasonsFor(GRID_4547);
  assert.equal(isToolDisabled(reasons, 'brush', 'brush'), false, '当前工具不该被禁用');
  assert.equal(isToolDisabled(reasons, 'box', 'box'), false);
  assert.equal(isToolDisabled(reasons, 'levels', 'levels'), false);
  assert.equal(isToolDisabled(reasons, 'view', 'view'), false);
});

/* ── 「什么算 4326」只有一个判据 ─────────────────────────── */

test('4326 的判定沿用引擎给的 crs.is4326（前端不自己猜）', () => {
  assert.equal(isWgs84Grid(GRID_4326), true);
  assert.equal(isWgs84Grid(GRID_4547), false);
  // 没有 crs 字段的栅格不算 4326 —— 宁可不判，也不要瞎算
  assert.equal(isWgs84Grid({ crs: null }), false);
});
