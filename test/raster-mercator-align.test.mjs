/**
 * 栅格底图与矢量图层的**对位**（2026-11-16 用户实测发现错位后立的规矩）。
 *
 * 现象：栅格底图只占画布中间一块、矢量图层铺满全屏，两者明显错开。
 *
 * 根因（不是素材问题，是引擎的投影口径）：
 *   前端 MapLibre 用的是 **Web Mercator**，它的 image source 把 PNG 按经纬度四角
 *   贴成一个矩形 —— 那么**图片内容也必须是墨卡托的视图**。
 *   引擎原来默认出 EPSG:4326（线性经纬）的内容，被塞进墨卡托四角 = 二次形变，
 *   必然与矢量图层错位。
 *   修法：默认 targetCrs 改成 **EPSG:3857**；bbox 仍按 4326 经纬度传，
 *   引擎用 **-te_srs EPSG:4326** 告诉 gdalwarp 那四个数是什么坐标系
 *   （-te 的坐标属于目标 CRS，3857 是米，不说明就会被当米用 → 取景全错）。
 *
 * 这几条钉在源码上：改回 4326 或去掉 -te_srs，测试立刻红。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const rasterImage = read('src', 'engine', 'export', 'raster-image.ts');
const app = read('server', 'src', 'app.ts');

describe('栅格底图与矢量图层对位（墨卡托口径）', () => {
  test('栅格渲染默认出 EPSG:3857（与 MapLibre 同一投影）', () => {
    assert.match(
      app,
      /url\.searchParams\.get\('targetCrs'\) \?\? 'EPSG:3857'/,
      'raster.png 路由的默认 targetCrs 必须是 EPSG:3857',
    );
    assert.doesNotMatch(
      app,
      /url\.searchParams\.get\('targetCrs'\) \?\? 'EPSG:4326'/,
      '不能默认回 4326 —— 那会让栅格与矢量错位',
    );
  });

  test('warp 取景必须声明 -te_srs（-te 的坐标属于目标 CRS，单位是米）', () => {
    assert.match(
      rasterImage,
      /args\.push\('-te_srs', 'EPSG:4326'\)/,
      'bbox 是 4326 的经纬度，-te 用目标 CRS（3857 米），必须用 -te_srs 声明',
    );
  });

  test('bbox 约定仍是 EPSG:4326 的经纬度（前端传的就是它）', () => {
    assert.match(
      rasterImage,
      /readonly bbox\?: BBox4326/,
      'bbox 类型要锁定在 4326',
    );
  });
});
