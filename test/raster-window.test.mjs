import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', 'raster', p)).href;

const { windowForRegion, windowGeotransform, localRegion, windowBytes } = await import(eng('window.ts'));

/** 100x100 的图，左上角 (0,0)，像元 1x1，北向上（pixelH = -1） */
const FRAME = { width: 100, height: 100, geotransform: [0, 1, 0, 100, 0, -1] };

test('窗口：由区域反推，向上取整、向下取整', () => {
  const win = windowForRegion(FRAME, { minX: 10.2, minY: 20.8, maxX: 30.4, maxY: 40.1 });
  assert.deepEqual(win, { x: 10, y: 20, w: 21, h: 21 });
});

test('窗口：带外扩时四周各留 margin', () => {
  const win = windowForRegion(FRAME, { minX: 10, minY: 20, maxX: 30, maxY: 40 }, 4);
  assert.deepEqual(win, { x: 6, y: 16, w: 28, h: 28 });
});

test('窗口：不越出整图边界', () => {
  const win = windowForRegion(FRAME, { minX: -5, minY: -5, maxX: 500, maxY: 500 });
  assert.deepEqual(win, { x: 0, y: 0, w: 100, h: 100 });
});

test('窗口仿射：原点按窗口偏移平移，像元大小不变', () => {
  const win = windowForRegion(FRAME, { minX: 10, minY: 20, maxX: 30, maxY: 40 });
  const gt = windowGeotransform(FRAME, win);
  assert.equal(gt[0], 10, '原点 X 应平移到窗口左上角');
  assert.equal(gt[1], 1, '像元宽不变');
  assert.equal(gt[3], 80, '原点 Y 应平移（北向上时往下走）');
  assert.equal(gt[5], -1, '像元高不变');
});

test('局部区域：整图像素坐标换成窗口内坐标', () => {
  const win = { x: 10, y: 20, w: 20, h: 20 };
  const local = localRegion(win, { minX: 12, minY: 25, maxX: 18, maxY: 33 });
  assert.deepEqual(local, { minX: 2, minY: 5, maxX: 8, maxY: 13 });
});

test('窗口字节数：宽 × 高 × 波段数', () => {
  assert.equal(windowBytes({ x: 0, y: 0, w: 100, h: 50 }, 3), 15000);
});
