import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', 'raster', p)).href;

const { buildAlphaMask } = await import(eng('mask.ts'));
const { blendBands } = await import(eng('blend.ts'));
const { inpaintRegion } = await import(eng('inpaint.ts'));
const { adjustLevels } = await import(eng('levels.ts'));

/* ─────────── mask ─────────── */

test('掩膜：区域内 alpha=1，区域外 alpha=0', () => {
  const m = buildAlphaMask(10, 10, { minX: 2, minY: 2, maxX: 6, maxY: 6 }, 0);
  assert.equal(m.length, 100);
  assert.equal(m[2 * 10 + 2], 1, '左上角应在区域内');
  assert.equal(m[5 * 10 + 5], 1, '中心应在区域内');
  assert.equal(m[0], 0, '左上角应在区域外');
  assert.equal(m[9 * 10 + 9], 0, '右下角应在区域外');
});

test('掩膜：羽化使边缘出现中间值', () => {
  const m = buildAlphaMask(10, 10, { minX: 2, minY: 2, maxX: 6, maxY: 6 }, 2);
  assert.equal(m[2 * 10 + 2], 1, '核心仍为 1');
  assert.ok(m[1 * 10 + 3] > 0 && m[1 * 10 + 3] < 1, '羽化带内应是中间值');
  assert.equal(m[0], 0, '羽化带外应为 0');
});

test('掩膜：羽化像素为 0 时不产生中间值', () => {
  const m = buildAlphaMask(10, 10, { minX: 2, minY: 2, maxX: 6, maxY: 6 }, 0);
  const values = new Set(m);
  assert.deepEqual([...values].sort(), [0, 1]);
});

/* ─────────── blend ─────────── */

test('混合：alpha=0 处保留底图，alpha=1 处取覆盖图', () => {
  const base = [new Uint8Array([10, 20, 30])];
  const overlay = [new Uint8Array([200, 210, 220])];
  const alpha = new Float32Array([0, 1, 0]);
  const out = blendBands(base, overlay, alpha, 1);
  assert.equal(out[0][0], 10, 'alpha=0 应保留底图');
  assert.equal(out[0][1], 210, 'alpha=1 应取覆盖图');
  assert.equal(out[0][2], 30, 'alpha=0 应保留底图');
});

test('混合：alpha=0.5 取中值', () => {
  const base = [new Uint8Array([0])];
  const overlay = [new Uint8Array([100])];
  const out = blendBands(base, overlay, new Float32Array([0.5]), 1);
  assert.equal(out[0][0], 50);
});

test('混合：中间 alpha 按比例插值（a≠0.5 才能区分插值方向）', () => {
  // a=0.5 时"base*(1-a)+overlay*a"与"base*a+overlay*(1-a)"结果相同，
  // 所以必须用 a=0.25 / 0.75 才能真正验证插值公式
  const base = [new Uint8Array([0])];
  const overlay = [new Uint8Array([100])];
  const out25 = blendBands(base, overlay, new Float32Array([0.25]), 1);
  assert.equal(out25[0][0], 25, 'a=0.25 应取 25% 覆盖图');
  const out75 = blendBands(base, overlay, new Float32Array([0.75]), 1);
  assert.equal(out75[0][0], 75, 'a=0.75 应取 75% 覆盖图');
});

test('混合：结果被钳制在 0..255', () => {
  const base = [new Uint8Array([250])];
  const overlay = [new Uint8Array([250])];
  const out = blendBands(base, overlay, new Float32Array([1]), 1);
  assert.ok(out[0][0] <= 255);
});

/* ─────────── inpaint ─────────── */

test('修补：区域内的脏像元被边界颜色填充', () => {
  const w = 6, h = 6, b = 1;
  const px = [new Uint8Array(w * h)];
  // 全部填 100，然后中心 2x2 置为 0（模拟污点）
  px[0].fill(100);
  for (let y = 2; y < 4; y++) for (let x = 2; x < 4; x++) px[0][y * w + x] = 0;

  const out = inpaintRegion(px, w, h, b, { minX: 2, minY: 2, maxX: 4, maxY: 4 }, 3);
  assert.equal(out[0][2 * w + 2], 100, '污点应被填成周围颜色');
  assert.equal(out[0][3 * w + 3], 100);
});

test('修补：区域外像元完全不变', () => {
  const w = 6, h = 6;
  const px = [new Uint8Array(w * h)];
  for (let i = 0; i < w * h; i++) px[0][i] = (i * 7) % 251;
  const before = Uint8Array.from(px[0]);
  const out = inpaintRegion(px, w, h, 1, { minX: 2, minY: 2, maxX: 4, maxY: 4 }, 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x >= 2 && x < 4 && y >= 2 && y < 4;
      if (!inside) assert.equal(out[0][y * w + x], before[y * w + x], `(${x},${y}) 不应被改动`);
    }
  }
});

test('修补：多波段同步处理', () => {
  const w = 4, h = 4;
  const px = [new Uint8Array(w * h).fill(10), new Uint8Array(w * h).fill(20)];
  px[0][5] = 0;
  px[1][5] = 0;
  const out = inpaintRegion(px, w, h, 2, { minX: 1, minY: 1, maxX: 2, maxY: 2 }, 2);
  assert.equal(out[0][5], 10);
  assert.equal(out[1][5], 20);
});

test('修补：区域较大时需要多轮向内推进（只跑一轮填不满）', () => {
  // 10x10 全 100，中心 4x4 置 0 → 至少要 3 轮才能填到中心
  const w = 10, h = 10;
  const px = [new Uint8Array(w * h)];
  px[0].fill(100);
  for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) px[0][y * w + x] = 0;

  const out = inpaintRegion(px, w, h, 1, { minX: 3, minY: 3, maxX: 7, maxY: 7 }, 8);
  assert.equal(out[0][5 * w + 5], 100, '最中心的像元需要多轮推进才能填上');
  assert.equal(out[0][3 * w + 3], 100, '边界圈应被填上');
});

/* ─────────── levels ─────────── */

test('提亮：线性拉伸把窄值域拉开到 0..255', () => {
  // 扫描件常见情形：整体偏暗、值域很窄（如 100~130）
  const px = [new Uint8Array([100, 110, 120, 130])];
  const out = adjustLevels(px, { method: 'linear-stretch' });
  assert.equal(out[0][0], 0, '最暗值应拉到 0');
  assert.equal(out[0][3], 255, '最亮值应拉到 255');
  assert.ok(out[0][1] < 110, '低于中点的值被进一步压低（对比拉开）');
  assert.ok(out[0][2] > 120, '高于中点的值被进一步抬高（对比拉开）');
});

test('提亮：gamma 修正可区分明暗', () => {
  const px = [new Uint8Array([64, 128, 192])];
  const out = adjustLevels(px, { method: 'gamma', gamma: 2.0 });
  assert.ok(out[0][0] < out[0][1] && out[0][1] < out[0][2]);
  assert.ok(out[0][0] < 64, 'gamma>1 应压暗中间调');
});

test('提亮：结果仍在 0..255', () => {
  const px = [new Uint8Array([200, 250])];
  const out = adjustLevels(px, { method: 'linear-stretch', brightness: 1 });
  for (const v of out[0]) {
    assert.ok(v >= 0 && v <= 255, `越界：${v}`);
  }
});

test('提亮：不改几何信息（只动像素）', () => {
  const px = [new Uint8Array([10, 20])];
  const out = adjustLevels(px, { method: 'linear-stretch' });
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 2);
});

test('提亮：linear-stretch 也要吃 brightness（否则亮度滑块是死的）', () => {
  // 值域已经铺满 0..255 的图，linear-stretch 本身就是恒等变换。
  // 如果 brightness 被丢掉，用户拖亮度滑块时像元一个都不会变 ——
  // 界面上的控件看着能动，实际什么也没发生，预演还会报"影响 0 个像元"。
  const px = [new Uint8Array([0, 64, 128, 255])];
  const flat = adjustLevels(px, { method: 'linear-stretch' });
  assert.deepEqual([...flat[0]], [0, 64, 128, 255], '值域铺满时拉伸应是恒等变换');

  const brighter = adjustLevels(px, { method: 'linear-stretch', brightness: 0.2 });
  assert.ok(brighter[0][0] > flat[0][0], '亮度滑块要真的把像元提亮');
  assert.equal(brighter[0][3], 255, '已经到顶的像元被夹住，不会溢出');
  for (const v of brighter[0]) {
    assert.ok(v >= 0 && v <= 255, `越界：${v}`);
  }
});

test('提亮：整幅同值（max === min）时 brightness 同样生效', () => {
  const px = [new Uint8Array([100, 100, 100])];
  const out = adjustLevels(px, { method: 'linear-stretch', brightness: 0.2 });
  assert.ok(out[0][0] > 100, '没有值域可拉时，亮度也要能加上去');
});

/* ─────────── 16 位运算（SP-0A2：运算层按像素类型算） ─────────── */

test('混合：16 位按 0..65535 算，不被压成 255', () => {
  const base = [new Uint16Array([0, 60000])];
  const overlay = [new Uint16Array([60000, 60000])];
  const alpha = new Float32Array([0.5, 0.5]);
  const out = blendBands(base, overlay, alpha, 1);
  assert.ok(out[0] instanceof Uint16Array, '结果带必须仍是 Uint16Array，不能变成 Uint8Array');
  assert.deepEqual([...out[0]], [30000, 60000], '16 位混合要按 0..65535 的口径算');
});

test('混合：显式指定 pixelType 时按指定类型出带', () => {
  const base = [new Uint16Array([0])];
  const overlay = [new Uint16Array([60000])];
  const out = blendBands(base, overlay, new Float32Array([0.5]), 1, 'UInt16');
  assert.ok(out[0] instanceof Uint16Array);
  assert.equal(out[0][0], 30000);
});

test('修补：16 位的拷贝与填补都不截断', () => {
  // 2×2 单波段，第 2 个像元（索引 1）是洞。
  // 它的 4 邻域里已填充的是索引 0（100）与索引 3（60000），均值 30050。
  const px = [new Uint16Array([100, 60000, 200, 60000])];
  const out = inpaintRegion(px, 2, 2, 1, { minX: 1, minY: 0, maxX: 2, maxY: 1 }, 1);
  assert.ok(out[0] instanceof Uint16Array, '结果带必须仍是 Uint16Array');
  assert.equal(out[0][1], 30050, '洞里应是邻居均值 30050，不能是被截断的数');
  assert.deepEqual([...out[0]], [100, 30050, 200, 60000], '区域外的像元要原样保留');
});

test('调色：16 位线性拉伸铺满 0..65535', () => {
  const px = [new Uint16Array([800, 3200])];
  const out = adjustLevels(px, { method: 'linear-stretch' });
  assert.ok(out[0] instanceof Uint16Array, '结果带必须仍是 Uint16Array');
  assert.deepEqual([...out[0]], [0, 65535], '拉伸要铺满 16 位的值域');
});

test('调色：16 位的 gamma 查找表覆盖整个值域', () => {
  const px = [new Uint16Array([0, 32768, 65535])];
  const out = adjustLevels(px, { method: 'gamma', gamma: 2.0 });
  assert.ok(out[0] instanceof Uint16Array);
  assert.equal(out[0][0], 0, '0 仍是 0');
  assert.ok(out[0][1] < 32768, 'gamma>1 应压暗中间调');
  assert.equal(out[0][2], 65535, '满值仍是满值');
});

test('类型对不上时报错（不静默截断）', () => {
  const px = [new Uint8Array([1, 2, 3, 4])];
  assert.throws(
    () => inpaintRegion(px, 2, 2, 1, { minX: 0, minY: 0, maxX: 1, maxY: 1 }, 1, 'UInt16'),
    (err) => /Byte/.test(err.message) && /UInt16/.test(err.message),
    '错误信息里要同时出现期望类型与实际类型',
  );
});

test('类型对不上时混合与调色也要报错', () => {
  const b8 = [new Uint8Array([10, 20])];
  assert.throws(
    () => blendBands(b8, [new Uint16Array([60000, 60000])], new Float32Array([0.5, 0.5]), 1, 'UInt16'),
    (err) => /Byte/.test(err.message) && /UInt16/.test(err.message),
    '混合的底图/覆盖图类型必须与目标类型一致',
  );
  assert.throws(
    () => adjustLevels(b8, { method: 'linear-stretch' }, 'UInt16'),
    (err) => /Byte/.test(err.message) && /UInt16/.test(err.message),
    '调色的波段类型必须与目标类型一致',
  );
});

/* ─────────── 8 位行为不变（基准值取自改动前的实现） ─────────── */

test('8 位混合：逐值与改动前一致', () => {
  // 基准值来自 git HEAD 的 8 位实现，8 位链路一个像元都不许变
  const b1 = blendBands(
    [new Uint8Array([10, 20, 30])],
    [new Uint8Array([200, 210, 220])],
    new Float32Array([0, 1, 0]),
    1,
  );
  assert.ok(b1[0] instanceof Uint8Array, '8 位结果带仍应是 Uint8Array');
  assert.deepEqual([...b1[0]], [10, 210, 30]);

  const b2 = blendBands([new Uint8Array([0])], [new Uint8Array([100])], new Float32Array([0.25]), 1);
  assert.deepEqual([...b2[0]], [25]);

  const b3 = blendBands([new Uint8Array([10, 20, 30])], [new Uint8Array([200, 210, 220])], new Float32Array([0.25, 0.25, 0.25]), 1);
  assert.deepEqual([...b3[0]], [58, 68, 78]);
});

test('8 位调色：逐值与改动前一致（含对比度）', () => {
  const cases = [
    [[new Uint8Array([100, 110, 120, 130])], { method: 'linear-stretch' }, [0, 85, 170, 255]],
    [[new Uint8Array([64, 128, 192])], { method: 'gamma', gamma: 2.0 }, [16, 64, 145]],
    [[new Uint8Array([200, 250])], { method: 'linear-stretch', brightness: 1 }, [255, 255]],
    [[new Uint8Array([0, 64, 128, 255])], { method: 'linear-stretch', brightness: 0.2 }, [51, 115, 179, 255]],
    [[new Uint8Array([100, 100, 100])], { method: 'linear-stretch', brightness: 0.2 }, [151, 151, 151]],
    // 带对比度这一条能验出"中心点"：改动前是 128，改动后必须仍是 128
    [[new Uint8Array([10, 120, 200])], { method: 'linear-stretch', contrast: 1.5, brightness: 0.1 }, [0, 184, 255]],
    [[new Uint8Array([50, 128, 200])], { method: 'manual', brightness: 0.2 }, [101, 179, 251]],
    [[new Uint8Array([0, 32, 64, 96, 128, 160, 192, 224, 255])], { method: 'gamma', gamma: 1.8, brightness: 0.05, contrast: 1.2 }, [0, 0, 12, 40, 76, 119, 171, 230, 255]],
    [[new Uint8Array([7, 7, 7])], { method: 'linear-stretch', contrast: 2 }, [0, 0, 0]],
  ];
  for (const [px, opts, expect] of cases) {
    const out = adjustLevels(px, opts);
    assert.ok(out[0] instanceof Uint8Array, '8 位结果带仍应是 Uint8Array');
    assert.deepEqual([...out[0]], expect, `8 位结果不能变：${JSON.stringify(opts)}`);
  }
});

test('8 位修补：逐值与改动前一致', () => {
  const w = 6, h = 6;
  const px = [new Uint8Array(w * h)];
  px[0].fill(100);
  for (let y = 2; y < 4; y++) for (let x = 2; x < 4; x++) px[0][y * w + x] = 0;
  const out = inpaintRegion(px, w, h, 1, { minX: 2, minY: 2, maxX: 4, maxY: 4 }, 3);
  assert.ok(out[0] instanceof Uint8Array, '8 位结果带仍应是 Uint8Array');
  assert.deepEqual([...out[0]], new Array(w * h).fill(100), '8 位修补结果不能变');
});
