import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, statfsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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

test('窗口字节数：16 位时是 8 位的两倍', async () => {
  const { windowBytes } = await import(eng('window.ts'));
  const { BYTES_PER_SAMPLE } = await import(eng('pixels.ts'));
  const win = { x: 0, y: 0, w: 100, h: 50 };
  assert.equal(windowBytes(win, 3), 15000, '默认按 1 字节/样本');
  assert.equal(windowBytes(win, 3, BYTES_PER_SAMPLE.UInt16), 30000, '16 位应是两倍');
});

/* ────────── 窗口化读取 ────────── */

const GDAL_BIN = process.env.GDAL_BIN ?? '';
const gdalBin = (tool) => (GDAL_BIN ? join(GDAL_BIN, tool) : tool);
// 可执行文件后缀随平台走：Windows 是 .exe，Linux 没有（CI 跑在 ubuntu 上）
const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

/**
 * 跑一个 GDAL 命令。退出码非 0 就报成"夹具失败"——
 * 否则夹具没造出来，后面会变成一条莫名其妙的断言失败，排查方向完全跑偏。
 */
function runGdal(tool, args, what) {
  try {
    return execFileSync(gdalBin(`${tool}${EXE_SUFFIX}`), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`夹具失败：${what}（${tool} 退出码 ${e.status ?? '未知'}）\n${e.stderr ?? ''}`);
  }
}

/**
 * ENVI map info 里的坐标文本。
 *
 * 整数保留 ".0" 的写法，小数直接给十进制文本 ——
 * 拼 `${x}.0` 会把 4.5 变成 "4.5.0"，那是解析不出来的非法值。
 */
const enviCoord = (n) => (Number.isInteger(n) ? `${n}.0` : String(n));

/**
 * 造一张栅格：每个像元值 = valueAt(x, y, band)。
 *
 * map info 的参考点是 1 基的像元号（ENVI 约定），所以参考点取 (1.0, 1.0)、
 * 参考像元的位置取 (0, h)：GDAL 读进来后整图原点正好落在 (0, h)、像元 1x1，
 * 也就是这张图铺满 [0,w]×[0,h]。
 *
 * southUp=true 时改用 -a_ullr 造**南向上**（正 NS 分辨率）的图。
 *
 * dataType='UInt16' 时写 16 位裸数据（ENVI data type = 12，小端）——
 * 16 位原图过去会被 GDAL 判为异构而跳过窗口（实测 GDAL 3.13.3），必须能造出来才测得了。
 *
 * bands > 1 时按 bsq 交错铺（一个波段一整段）。
 * colorinterp 给 'red,green,blue' 时在转成 GTiff 后**补一次** -colorinterp：
 * ENVI 本身不带颜色解释信息，不补的话 3 波段出来是 Undefined/Undefined/Undefined
 * （实测），与彩色原图合成时会被 gdalbuildvrt 判为异构。
 *
 * width/height 可调：体积上限的用例需要一张"整图远大于窗口"的大图，
 * 而小图（默认 40×30）造不出那个比例。
 */
function makeRaster(file, valueAt, { southUp = false, dataType = 'Byte', bands = 1, colorinterp = null, width = 40, height = 30 } = {}) {
  const w = width, h = height;
  const bytesPerSample = dataType === 'UInt16' ? 2 : 1;
  const data = Buffer.alloc(w * h * bands * bytesPerSample);
  for (let b = 0; b < bands; b++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      // bsq：一个波段一整段
      const off = (b * w * h + y * w + x) * bytesPerSample;
      if (bytesPerSample === 2) data.writeUInt16LE(valueAt(x, y, b), off);
      else data[off] = valueAt(x, y, b);
    }
  }
  const bin = file.replace(/\.tif$/, '.img');
  writeFileSync(bin, data);
  writeFileSync(file.replace(/\.tif$/, '.hdr'),
    ['ENVI',`bands = ${bands}`,'header offset = 0','file type = ENVI Standard',
     `data type = ${dataType === 'UInt16' ? 12 : 1}`,'interleave = bsq','byte order = 0',`lines = ${h}`,`samples = ${w}`,
     'header size = 0', 'pixel size = 1.0000000000e+000',
     'map info = {Geographic Lat/Lon, 1.0, 1.0, 0.0, ' + enviCoord(h) + ', 1.0, 1.0, units=degrees}',''].join('\n'),
    'latin1');
  const args = ['-of','GTiff'];
  if (southUp) args.push('-a_ullr', '0', '0', String(w), String(h));
  // -colorinterp 只能给一次，值逗号分隔
  if (colorinterp) args.push('-colorinterp', colorinterp);
  args.push(bin, file);
  runGdal('gdal_translate', args, `造原图 ${file}`);
  return { width: w, height: h };
}

test('窗口读取：只读到窗口内的像素，且尺寸是窗口尺寸', async () => {
  const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
  const loc = resolveGdal();
  assert.ok(loc, '本机需装好 GDAL');

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-win-'));
  try {
    const tif = join(dir, 'r.tif');
    makeRaster(tif, (x, y) => (x * 100 + y) & 0xff);

    const { readRasterWindow } = await import(eng('raw.ts'));
    const win = { x: 5, y: 6, w: 10, h: 8 };
    const px = await readRasterWindow(loc, tif, win);

    assert.equal(px.width, 10);
    assert.equal(px.height, 8);
    assert.equal(px.bandCount, 1);
    assert.equal(px.bands[0].length, 80);
    // 窗口内第一个像元 = 整图 (5,6) 的值
    assert.equal(px.bands[0][0], (5 * 100 + 6) & 0xff);
    // 窗口原点应平移
    assert.equal(px.geotransform[0], 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('窗口读取：窗口越出整图范围时报错，不静默返回', async () => {
  const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
  const loc = resolveGdal();
  assert.ok(loc, '本机需装好 GDAL');

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-win-'));
  try {
    const tif = join(dir, 'r.tif');
    makeRaster(tif, (x, y) => (x * 100 + y) & 0xff);

    const { readRasterWindow } = await import(eng('raw.ts'));
    // 整图只有 40 宽，窗口 30+20 已经越界
    await assert.rejects(
      () => readRasterWindow(loc, tif, { x: 30, y: 0, w: 20, h: 10 }),
      /窗口越出栅格范围/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ────────── 局部覆盖合成 ────────── */

/**
 * 造一个与原图**同一像元网格**的窗口文件（北向上）。
 *
 * cornerX/cornerY 是窗口左上角的地理坐标；ENVI 的 map info 里
 * 参考点取 (1,1)、像元大小 pixel，读进来后原点正好落在 (cornerX, cornerY)。
 *
 * ⚠️ 千万别改用 -a_ullr 造北向上的窗口：那会让输出变成南向上。
 *    gdalbuildvrt 遇到南向上的源是"打一条 Warning 后把那个源跳过、退出码仍然是 0"
 *    （实测 GDAL 3.13.3），不是拒绝 —— 所以方向必须由我们自己保证。
 */
function makeWindowFile(file, w, h, cornerX, cornerY, value, { pixel = 1, southUp = false } = {}) {
  const data = Buffer.alloc(w * h, value);
  const bin = file.replace(/\.tif$/, '.img');
  writeFileSync(bin, data);
  writeFileSync(file.replace(/\.tif$/, '.hdr'),
    ['ENVI', `samples = ${w}`, 'bands = 1', 'header offset = 0', 'file type = ENVI Standard',
     'data type = 1', 'interleave = bsq', 'byte order = 0', `lines = ${h}`,
     'header size = 0', `pixel size = ${pixel.toExponential(10)}`,
     `map info = {Geographic Lat/Lon, 1.0, 1.0, ${enviCoord(cornerX)}, ${enviCoord(cornerY)}, ${enviCoord(pixel)}, ${enviCoord(pixel)}, units=degrees}`, ''].join('\n'),
    'latin1');
  const args = ['-of','GTiff'];
  if (southUp) {
    // 与北向上版本盖住同一块地，只是方向反过来（NS 分辨率为正）
    args.push('-a_ullr',
      String(cornerX), String(cornerY - h * pixel),
      String(cornerX + w * pixel), String(cornerY));
  }
  args.push(bin, file);
  runGdal('gdal_translate', args, `造窗口 ${file}`);
}

/** 按地理坐标探一个像元的值（-geoloc：默认是像元/行坐标，不是地理坐标） */
function probeGeo(file, x, y) {
  const out = execFileSync(gdalBin(`gdallocationinfo${EXE_SUFFIX}`), ['-valonly', '-geoloc', file, String(x), String(y)], { encoding: 'utf8' });
  return out.trim().split('\n').pop();
}

/** 读出 gdalinfo 里的尺寸 / 原点 / 像元大小（坐标系是契约的一部分） */
function infoOf(file) {
  const txt = execFileSync(gdalBin(`gdalinfo${EXE_SUFFIX}`), ['-nomd', '-noct', file], { encoding: 'utf8' });
  const size = /Size is (\d+), (\d+)/.exec(txt);
  const origin = /Origin\s*=\s*\(([^)]*)\)/.exec(txt);
  const pixel = /Pixel Size\s*=\s*\(([^)]*)\)/.exec(txt);
  if (!size || !origin || !pixel) throw new Error(`gdalinfo 输出里没找到尺寸/原点/像元大小：${file}`);
  return {
    size: `${size[1]}x${size[2]}`,
    origin: origin[1].trim(),
    pixel: pixel[1].trim(),
  };
}

/** 载入 GDAL 位置与被测函数 */
async function loadOverlay() {
  const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
  const loc = resolveGdal();
  assert.ok(loc, '本机需装好 GDAL');
  const { overlayWindowOntoRaster } = await import(eng('overlay.ts'));
  return { loc, overlayWindowOntoRaster };
}

test('局部覆盖：尺寸不变、原点与像元大小不变、窗口内被覆盖、窗口外逐像素原样', async () => {
  const { loc, overlayWindowOntoRaster } = await loadOverlay();

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-ovl-'));
  try {
    // 原图：40x30，铺满 geo [0,40]x[0,30]，值 10
    const full = join(dir, 'full.tif');
    makeRaster(full, () => 10);
    // 窗口：8x6，盖住 geo [4,12]x[6,12]，值 99
    const winFile = join(dir, 'win.tif');
    makeWindowFile(winFile, 8, 6, 4, 12, 99);

    const out = join(dir, 'out.tif');
    await overlayWindowOntoRaster(loc, full, winFile, out);

    // 尺寸不变
    const info = execFileSync(gdalBin(`gdalinfo${EXE_SUFFIX}`), ['-nomd', '-noct', out], { encoding: 'utf8' });
    assert.match(info, /Size is 40, 30/, '输出尺寸必须与原图一致');

    // 原点与像元大小也必须与原图一致（坐标系是契约的一部分）
    const outInfo = infoOf(out);
    const fullInfo = infoOf(full);
    assert.equal(outInfo.origin, fullInfo.origin, '输出原点必须与原图一致');
    assert.equal(outInfo.pixel, fullInfo.pixel, '输出像元大小必须与原图一致');

    // 窗口内 = 99，窗口外 = 10
    assert.equal(probeGeo(out, 6, 8), '99', '窗口内应被覆盖');
    assert.equal(probeGeo(out, 30, 25), '10', '窗口外应原样搬运');
    assert.equal(probeGeo(out, 2, 2), '10', '窗口外应原样搬运');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 失败路径必须既报错、又**不留下产出文件**。
 *
 * 只断言"抛错"不够：要是报错之前已经把文件写出来（或写了一半），
 * 调用方拿到的就是一个看着正常、其实没叠加过的文件 —— 那正是最坏的情况。
 */
async function assertRejectsWithoutOutput(fn, outPath, check) {
  await assert.rejects(fn, check);
  assert.equal(existsSync(outPath), false, '失败路径不能留下产出文件');
}

test('局部覆盖：原图是南向上时报错，不静默产出错文件', async () => {
  const { loc, overlayWindowOntoRaster } = await loadOverlay();

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-ovl-'));
  try {
    const full = join(dir, 'full_south.tif');
    makeRaster(full, () => 10, { southUp: true });
    const winFile = join(dir, 'win.tif');
    makeWindowFile(winFile, 8, 6, 4, 12, 99);

    // gdalbuildvrt 对南向上的源是"Warning + 跳过 + 退出码 0"，
    // 产出反而只剩窗口那么大（8×6）。必须由我们自己报错。
    const out = join(dir, 'out.tif');
    await assertRejectsWithoutOutput(
      () => overlayWindowOntoRaster(loc, full, winFile, out),
      out,
      (err) => {
        assert.match(err.message, /南向上/, '错误信息要指出是方向问题');
        assert.match(err.message, /Skipping/, '错误信息要带上 GDAL 原文');
        assert.match(err.message, /full_south\.tif/, '错误信息要指名被跳过的文件');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('局部覆盖：窗口是南向上时报错，窗口被丢掉也要报错', async () => {
  const { loc, overlayWindowOntoRaster } = await loadOverlay();

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-ovl-'));
  try {
    const full = join(dir, 'full.tif');
    makeRaster(full, () => 10);
    const winFile = join(dir, 'win_south.tif');
    makeWindowFile(winFile, 8, 6, 4, 12, 99, { southUp: true });

    const out = join(dir, 'out.tif');
    await assertRejectsWithoutOutput(
      () => overlayWindowOntoRaster(loc, full, winFile, out),
      out,
      (err) => {
        assert.match(err.message, /南向上/, '错误信息要指出是方向问题');
        assert.match(err.message, /Skipping/, '错误信息要带上 GDAL 原文');
        assert.match(err.message, /win_south\.tif/, '错误信息要指名被跳过的文件');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('局部覆盖：窗口文件不存在时报错，不产出没叠加过的文件', async () => {
  const { loc, overlayWindowOntoRaster } = await loadOverlay();

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-ovl-'));
  try {
    const full = join(dir, 'full.tif');
    makeRaster(full, () => 10);
    const missing = join(dir, 'nope.tif');

    const out = join(dir, 'out.tif');
    await assertRejectsWithoutOutput(
      () => overlayWindowOntoRaster(loc, full, missing, out),
      out,
      (err) => {
        assert.match(err.message, /Skipping/, '错误信息要带上 GDAL 原文');
        assert.match(err.message, /nope\.tif/, '错误信息要指名被跳过的文件');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('局部覆盖：窗口没完全落在原图内时报错，不悄悄裁掉或扩出去', async () => {
  const { loc, overlayWindowOntoRaster } = await loadOverlay();

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-ovl-'));
  try {
    const full = join(dir, 'full.tif');
    makeRaster(full, () => 10);
    // 窗口盖住 geo x∈[36,44]，原图只有 x∈[0,40] —— 右边探出去了
    const winFile = join(dir, 'win_out.tif');
    makeWindowFile(winFile, 8, 6, 36, 12, 99);

    const out = join(dir, 'out.tif');
    await assertRejectsWithoutOutput(
      () => overlayWindowOntoRaster(loc, full, winFile, out),
      out,
      /窗口超出原图范围/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('局部覆盖：窗口像元分辨率与原图不一致时报错，不按平均分辨率重采样', async () => {
  const { loc, overlayWindowOntoRaster } = await loadOverlay();

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-ovl-'));
  try {
    const full = join(dir, 'full.tif');
    makeRaster(full, () => 10);
    // 窗口像元 0.5、原图像元 1：gdalbuildvrt 会取平均分辨率，原图像素就不再是原样搬运
    const winFile = join(dir, 'win_fine.tif');
    makeWindowFile(winFile, 8, 6, 4, 12, 99, { pixel: 0.5 });

    const out = join(dir, 'out.tif');
    await assertRejectsWithoutOutput(
      () => overlayWindowOntoRaster(loc, full, winFile, out),
      out,
      /像元大小/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ────────── 16 位与彩色原图走通合成 ────────── */

/**
 * 用引擎自己的 writeRasterPixels 写一个窗口文件。
 *
 * 为什么不用 makeWindowFile：那条夹具造的是 ENVI 直转的裸文件，
 * 而 Task 4 的既定链路是 writeRasterPixels -> overlayWindowOntoRaster，
 * 要验的就是这条链路（writeRasterPixels 负责类型与颜色解释，overlay 负责合成）。
 *
 * 窗口的仿射必须与原图落在**同一个像元网格**上：
 * 原图原点在 (0,30)、像元 1x1，所以盖住 geo [4,12]x[6,12] 的窗口
 * 自身仿射就是 [4, 1, 0, 12, 0, -1]（原点相差整数个像元）。
 *
 * crs 必须跟着原图走：坐标系不一致同样是 gdalbuildvrt 判异构的原因之一。
 */
async function writeWindowViaEngine(loc, file, { width, height, bands, pixelType, colorInterpretation, crs }) {
  const { writeRasterPixels } = await import(eng('raw.ts'));
  await writeRasterPixels(loc, file, {
    width,
    height,
    bands,
    pixelType,
    colorInterpretation,
    geotransform: [4, 1, 0, 12, 0, -1],
    crs,
  });
}

/** 原图的坐标系：窗口必须继承它，否则会被判异构 */
async function crsOf(loc, file) {
  const { readRasterFrame } = await import(eng('raw.ts'));
  return (await readRasterFrame(loc, file)).crs;
}

test('合成：UInt16 原图 + 16 位窗口，合成成功且类型不丢', async () => {
  const { loc, overlayWindowOntoRaster } = await loadOverlay();
  const { readRasterPixels } = await import(eng('raw.ts'));
  const { newBand } = await import(eng('pixels.ts'));

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-ovl-'));
  try {
    // 原图：40x30 的 UInt16，铺满 geo [0,40]x[0,30]
    const full = join(dir, 'full_u16.tif');
    const valueAt = (x, y) => 1000 + x * 10 + y;
    makeRaster(full, valueAt, { dataType: 'UInt16' });

    // 窗口：8x6，盖住 geo [4,12]x[6,12]，值 60000
    const winFile = join(dir, 'win_u16.tif');
    const band = newBand('UInt16', 8 * 6);
    band.fill(60000);
    await writeWindowViaEngine(loc, winFile, {
      width: 8, height: 6, bands: [band], pixelType: 'UInt16',
      colorInterpretation: ['Gray'], crs: await crsOf(loc, full),
    });

    const out = join(dir, 'out.tif');
    await overlayWindowOntoRaster(loc, full, winFile, out);

    const px = await readRasterPixels(loc, out);
    assert.equal(px.pixelType, 'UInt16', '产出必须仍是 16 位，不能被压成 8 位');
    assert.equal(px.bandCount, 1);

    // geo -> 像元：col = X，row = 30 - Y。窗口盖住 col 4..11、row 18..23。
    const idx = (col, row) => row * px.width + col;
    assert.equal(px.bands[0][idx(6, 22)], 60000, '窗口内应被 16 位窗口覆盖');
    assert.equal(px.bands[0][idx(30, 5)], valueAt(30, 5), '窗口外应与原图一致');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合成：RGB 原图 + 3 波段窗口，合成成功且仍是 3 波段', async () => {
  const { loc, overlayWindowOntoRaster } = await loadOverlay();
  const { readRasterPixels } = await import(eng('raw.ts'));
  const { newBand } = await import(eng('pixels.ts'));

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-ovl-'));
  try {
    // 原图：3 波段，颜色解释 Red/Green/Blue
    const full = join(dir, 'full_rgb.tif');
    const valueAt = (x, y, band) => 10 * (band + 1) + ((x + y) % 200);
    makeRaster(full, valueAt, { bands: 3, colorinterp: 'red,green,blue' });

    const winFile = join(dir, 'win_rgb.tif');
    const bands = [newBand('Byte', 8 * 6), newBand('Byte', 8 * 6), newBand('Byte', 8 * 6)];
    bands[0].fill(200);
    bands[1].fill(100);
    bands[2].fill(50);
    await writeWindowViaEngine(loc, winFile, {
      width: 8, height: 6, bands, pixelType: 'Byte',
      colorInterpretation: ['Red', 'Green', 'Blue'], crs: await crsOf(loc, full),
    });

    const out = join(dir, 'out.tif');
    await overlayWindowOntoRaster(loc, full, winFile, out);

    const px = await readRasterPixels(loc, out);
    assert.equal(px.bandCount, 3, '产出必须仍是 3 波段');
    assert.deepEqual(px.colorInterpretation, ['Red', 'Green', 'Blue'], '颜色解释不能丢');

    const idx = (col, row) => row * px.width + col;
    assert.equal(px.bands[0][idx(6, 22)], 200, '窗口内 Red 波段应被覆盖');
    assert.equal(px.bands[1][idx(6, 22)], 100, '窗口内 Green 波段应被覆盖');
    assert.equal(px.bands[2][idx(6, 22)], 50, '窗口内 Blue 波段应被覆盖');
    assert.equal(px.bands[0][idx(30, 5)], valueAt(30, 5, 0), '窗口外应与原图一致');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合成：UInt16 原图配 Byte 窗口时报错，要说清是波段类型问题', async () => {
  const { loc, overlayWindowOntoRaster } = await loadOverlay();
  const { newBand } = await import(eng('pixels.ts'));

  const dir = mkdtempSync(join(tmpdir(), 'cartouche-ovl-'));
  try {
    const full = join(dir, 'full_u16.tif');
    makeRaster(full, () => 1000, { dataType: 'UInt16' });

    // 类型不一致的窗口：颜色解释与原图一致（都是 Gray），
    // 这样唯一的异构就是波段类型，报错必须指向这一点。
    const winFile = join(dir, 'win_b8.tif');
    const band = newBand('Byte', 8 * 6);
    band.fill(99);
    await writeWindowViaEngine(loc, winFile, {
      width: 8, height: 6, bands: [band], pixelType: 'Byte',
      colorInterpretation: ['Gray'], crs: await crsOf(loc, full),
    });

    const out = join(dir, 'out.tif');
    await assertRejectsWithoutOutput(
      () => overlayWindowOntoRaster(loc, full, winFile, out),
      out,
      (err) => {
        console.log(`\n[类型不一致时的完整错误信息]\n${err.message}\n`);
        assert.match(err.message, /波段类型/, '错误信息要指出是波段类型问题');
        assert.match(err.message, /heterogeneous band data type/, '要带上 GDAL 原文');
        assert.match(err.message, /Skipping/, '要说明是有源被跳过了');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ────────── RasterEditor 走窗口路径（局部操作只读窗口） ────────── */

const { LocalFolderStore } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'workspace', 'index.ts')).href
);
const { RasterEditor } = await import(eng('ops.ts'));
const { readRasterPixels, readRasterWindow, readRasterFrame } = await import(eng('raw.ts'));
const { inpaintRegion } = await import(eng('inpaint.ts'));
const { buildAlphaMask } = await import(eng('mask.ts'));
const { blendBands } = await import(eng('blend.ts'));

/** 载入 GDAL 位置（窗口路径要真调 GDAL，没有 GDAL 就没法测） */
async function loadEditor(dir, deps = {}) {
  const { resolveGdal } = await import(pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href);
  const loc = resolveGdal();
  assert.ok(loc, '本机需装好 GDAL');
  const store = new LocalFolderStore(dir);
  return { loc, store, editor: new RasterEditor({ loc, store, ...deps }) };
}

/* 体积上限那组用例的关键数字：
 *   整图 2048×1536×1 波段×8 位 = 3 145 728 字节（3 MB）
 *   窗口 64×64×1×1            =     4 096 字节
 *   上限                      = 1 048 576 字节（1 MB）
 * 上限**比整图小、比窗口大** —— 于是"整读整图"的实现必然撞上限，
 * 只有"只读窗口"的实现才能过。这才是区分新旧实现的那把尺子。 */
const BIG_W = 2048;
const BIG_H = 1536;
const LIMIT = 1024 * 1024;
const BIG_REGION = { minX: 100, minY: 100, maxX: 164, maxY: 164 };
const BIG_VALUE = (x, y) => (x * 7 + y * 3) & 0xff;

test('窗口路径：整图超过上限也能局部涂色，且窗口外逐像素不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-winop-'));
  try {
    const tif = join(dir, 'big.tif');
    makeRaster(tif, BIG_VALUE, { width: BIG_W, height: BIG_H });

    const { loc, editor } = await loadEditor(dir, { maxWindowBytes: LIMIT });
    const wholeBytes = BIG_W * BIG_H * 1 * 1;
    const winBytes = 64 * 64 * 1 * 1;
    console.log(
      `[体积上限] 上限 ${LIMIT} 字节；整图 ${BIG_W}×${BIG_H} = ${wholeBytes} 字节；` +
      `窗口 64×64 = ${winBytes} 字节`,
    );
    assert.ok(wholeBytes > LIMIT, '整图必须大于上限，这条用例才说明得了问题');
    assert.ok(winBytes < LIMIT, '窗口必须小于上限');

    const before = await readRasterPixels(loc, tif);
    const res = await editor.paint({ target: 'big.tif', region: BIG_REGION, color: [200, 100, 50] });
    const after = await readRasterPixels(loc, tif);

    assert.equal(res.verified, true, '窗口路径也要通过回读校验');
    assert.equal(after.width, BIG_W, '尺寸不能变');
    assert.equal(after.height, BIG_H, '尺寸不能变');
    assert.equal(after.pixelType, 'Byte', '类型不能变');

    // 窗口内：涂成目标颜色
    const idx = (x, y) => y * after.width + x;
    assert.equal(after.bands[0][idx(120, 120)], 200, '窗口内应被涂成目标颜色');
    assert.equal(after.bands[0][idx(100, 100)], 200, '区域左上角也要涂到');
    assert.equal(after.bands[0][idx(163, 163)], 200, '区域右下角也要涂到');

    // 窗口外逐像素不变（这是窗口化最容易出错的地方：整图被重算了）
    let outsideDiff = 0;
    let firstDiff = null;
    for (let y = 0; y < BIG_H; y++) {
      for (let x = 0; x < BIG_W; x++) {
        const inside = x >= BIG_REGION.minX && x < BIG_REGION.maxX &&
          y >= BIG_REGION.minY && y < BIG_REGION.maxY;
        if (inside) continue;
        const was = before.bands[0][idx(x, y)];
        const now = after.bands[0][idx(x, y)];
        if (was !== now) {
          outsideDiff++;
          if (!firstDiff) firstDiff = { x, y, was, now };
        }
      }
    }
    assert.equal(
      outsideDiff, 0,
      `窗口外必须逐像素不变（实际 ${outsideDiff} 个差异，例如 ${JSON.stringify(firstDiff)}）`,
    );
    console.log('[窗口外逐像素比对] 差异数 =', outsideDiff, '（抽查 (99,100)=', after.bands[0][idx(99, 100)],
      ' (164,100)=', after.bands[0][idx(164, 100)], ' (100,99)=', after.bands[0][idx(100, 99)], '）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('体积上限：全局操作超限时明确报错，不是 OOM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-winop-'));
  try {
    const tif = join(dir, 'big.tif');
    makeRaster(tif, BIG_VALUE, { width: BIG_W, height: BIG_H });
    const { editor } = await loadEditor(dir, { maxWindowBytes: LIMIT });

    await assert.rejects(
      () => editor.adjustLevels({ target: 'big.tif', method: 'linear-stretch' }),
      (err) => {
        console.log('[超限时的错误信息]\n' + err.message);
        assert.match(err.message, /超过上限/, '要说明是超过上限');
        assert.match(err.message, /3 MB/, '要报出实际需要的 MB');
        assert.match(err.message, /1 MB/, '要报出上限的 MB');
        assert.match(err.message, /局部操作请缩小范围/, '要给出下一步该怎么做');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('校验和口径：窗口路径报的是窗口范围的校验和', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-winop-'));
  try {
    const tif = join(dir, 'big.tif');
    makeRaster(tif, BIG_VALUE, { width: BIG_W, height: BIG_H });
    const { loc, editor } = await loadEditor(dir, { maxWindowBytes: LIMIT });

    const win = { x: BIG_REGION.minX, y: BIG_REGION.minY, w: 64, h: 64 };
    const winBefore = await readRasterWindow(loc, tif, win);
    const wholeBefore = await readRasterPixels(loc, tif);

    const res = await editor.paint({ target: 'big.tif', region: BIG_REGION, color: [200, 100, 50] });
    const winAfter = await readRasterWindow(loc, tif, win);

    // 窗口口径：前后都是**窗口**的校验和，两者才可比
    assert.equal(res.checksumBefore, winBefore.checksum, 'checksumBefore 必须是窗口的校验和');
    assert.equal(res.checksumAfter, winAfter.checksum, 'checksumAfter 必须是窗口的校验和');
    assert.notEqual(res.checksumBefore, res.checksumAfter, '涂色后窗口内容应当变了');
    assert.notEqual(res.checksumBefore, wholeBefore.checksum, '窗口口径不能是整图的校验和');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('校验和口径：整图路径报的是整图的校验和', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-winop-'));
  try {
    const tif = join(dir, 'small.tif');
    makeRaster(tif, BIG_VALUE);
    const { loc, editor } = await loadEditor(dir);

    const wholeBefore = await readRasterPixels(loc, tif);
    const res = await editor.adjustLevels({ target: 'small.tif', method: 'linear-stretch' });
    const wholeAfter = await readRasterPixels(loc, tif);

    assert.equal(res.checksumBefore, wholeBefore.checksum, '整图路径的 checksumBefore 必须是整图的');
    assert.equal(res.checksumAfter, wholeAfter.checksum, '整图路径的 checksumAfter 必须是整图的');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('预演：窗口路径的预演一个字节都不写盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-winop-'));
  try {
    const tif = join(dir, 'big.tif');
    makeRaster(tif, BIG_VALUE, { width: BIG_W, height: BIG_H });
    const { editor } = await loadEditor(dir, { maxWindowBytes: LIMIT });

    const bytesBefore = readFileSync(tif);
    const res = await editor.paint(
      { target: 'big.tif', region: BIG_REGION, color: [200, 100, 50] },
      { dryRun: true },
    );

    assert.equal(res.dryRun, true, '要标明这是预演');
    assert.ok(res.affectedPixels > 0, '预演要给出像元数');
    assert.equal(res.backupPath, null, '预演不该产生备份');
    assert.deepEqual(readFileSync(tif), bytesBefore, '预演不能改文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('16 位影像走窗口路径：产出仍是 16 位，窗口内是预期值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-winop-'));
  try {
    // 2048×1024×1 波段×16 位 = 4 194 304 字节（4 MB）
    const tif = join(dir, 'u16.tif');
    makeRaster(tif, (x, y) => (x * 13 + y * 7) % 4096, {
      dataType: 'UInt16', width: 2048, height: 1024,
    });
    // 上限 3 MB：按 1 字节/样点算是 2 MB（能过），按 2 字节算是 4 MB（过不了）——
    // 所以这条用例同时锁住"字节宽度按像素类型算"这条规则。
    const { loc, editor } = await loadEditor(dir, { maxWindowBytes: 3 * 1024 * 1024 });

    await assert.rejects(
      () => editor.adjustLevels({ target: 'u16.tif', method: 'linear-stretch' }),
      (err) => {
        assert.match(err.message, /4 MB/, '16 位整图要按 4 MB 算（2 字节/样点）');
        assert.match(err.message, /3 MB/, '要报出上限');
        return true;
      },
    );

    // 局部涂色：窗口 64×64×2 = 8192 字节，可以走
    const res = await editor.paint({ target: 'u16.tif', region: BIG_REGION, color: [200, 100, 50] });
    assert.equal(res.verified, true, '16 位也要通过回读校验');

    const frame = await readRasterFrame(loc, tif);
    assert.equal(frame.pixelType, 'UInt16', '产出必须仍是 16 位，不能被压成 8 位');

    const win = await readRasterWindow(loc, tif, { x: 100, y: 100, w: 64, h: 64 });
    assert.equal(win.pixelType, 'UInt16');
    assert.equal(win.bands[0][20 * 64 + 20], 200 * 257, '窗口内应是放大到 16 位口径的色值');
    assert.equal(win.bands[0][0], 200 * 257, '区域左上角也要涂到');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('修补：窗口外扩的余量够用，结果与整图算出来的一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-winop-'));
  try {
    const tif = join(dir, 'm.tif');
    makeRaster(tif, BIG_VALUE);
    const { loc, editor } = await loadEditor(dir);

    const region = { minX: 10, minY: 8, maxX: 20, maxY: 14 };
    const before = await readRasterPixels(loc, tif);
    // 参照答案：直接在整图上算一遍修补
    const expected = inpaintRegion(
      before.bands, before.width, before.height, before.bandCount, region, 8, 'Byte',
    );

    await editor.inpaint({ target: 'm.tif', region, radiusPx: 4 });
    const after = await readRasterPixels(loc, tif);

    let diff = 0;
    for (let i = 0; i < expected[0].length; i++) {
      if (after.bands[0][i] !== expected[0][i]) diff++;
    }
    assert.equal(diff, 0, `窗口路径的修补结果必须与整图一致（差异 ${diff} 个像元）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('区域替换：羽化向外生长，窗口留足余量，边缘过渡与整图一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-winop-'));
  try {
    const target = join(dir, 't.tif');
    const source = join(dir, 's.tif');
    makeRaster(target, BIG_VALUE);
    makeRaster(source, (x, y) => (x * 11 + y * 5 + 40) & 0xff);
    const { loc, editor } = await loadEditor(dir);

    const region = { minX: 10, minY: 8, maxX: 20, maxY: 14 };
    const featherPx = 3;
    const before = await readRasterPixels(loc, target);
    const src = await readRasterPixels(loc, source);
    // 参照答案：整图上按羽化掩膜混合
    const alpha = buildAlphaMask(before.width, before.height, region, featherPx);
    const expected = blendBands(before.bands, src.bands, alpha, before.bandCount, 'Byte');

    await editor.replaceRegion({ source: 's.tif', target: 't.tif', region, featherPx });
    const after = await readRasterPixels(loc, target);

    let diff = 0;
    for (let i = 0; i < expected[0].length; i++) {
      if (after.bands[0][i] !== expected[0][i]) diff++;
    }
    assert.equal(diff, 0, `羽化边缘必须与整图一致（差异 ${diff} 个像元）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ────────── 磁盘余量护栏 ────────── */

/**
 * 造一张"整图远大于可用空间"的稀疏大图。
 *
 * 为什么用 gdal_create 而不是真写像素：整图要是真写出来，
 * 几十 GB 的数据会把测试机直接写满 —— 那正是这条护栏要防的事故本身。
 * gdal_create 建的是**稀疏**文件：磁盘上几乎不占地方，头里却写着真实尺寸，
 * 于是"按整图算的需求"超过可用空间、"按窗口算的需求"不超 ——
 * 这正是区分两种实现的那把尺子。
 *
 * `--config CHECK_DISK_FREE_SPACE FALSE`：GDAL 3.13 自己也会拦
 * "要建的比可用空间还大"（实测原文："Free disk space available is 29.15 GB,
 * whereas 62.50 GB are at least necessary"），而这里要的正是那个尺寸，所以得关掉它。
 */
function makeSparseHugeRaster(file, side) {
  runGdal('gdal_create', [
    '--config', 'CHECK_DISK_FREE_SPACE', 'FALSE',
    '-outsize', String(side), String(side),
    '-bands', '1', '-ot', 'Byte', '-burn', '0',
    // 必须给仿射参数：gdal_create 默认不带地理变换，
    // 而窗口路径要求"栅格缺少仿射参数"这一关能过（否则根本走不到磁盘护栏）。
    // -a_ullr 的顺序是 上左 x、上左 y、下右 x、下右 y ——
    // 上左 y 必须**大于**下右 y 才是北向上（正 NS 分辨率会被 gdalbuildvrt 跳过）。
    '-a_ullr', '0', String(side), String(side), '0',
    '-of', 'GTiff', file,
  ], `造稀疏大图 ${file}`);
}

/** gdal_create 是否可用（造稀疏大图要用；没有就跳过那条用例） */
function hasGdalCreate() {
  try {
    execFileSync(gdalBin(`gdal_create${EXE_SUFFIX}`), ['--help'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    // 工具不存在才会是 ENOENT；退出码非 0 说明工具在、只是 --help 不是合法用法
    return err.code !== 'ENOENT';
  }
}

test('磁盘余量：余量不足时明确报错，原文件一个字节都没变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-disk-'));
  try {
    const tif = join(dir, 'small.tif');
    makeRaster(tif, BIG_VALUE);
    const bytesBefore = readFileSync(tif);

    // 下限顶到天上 → 必然不够用
    const { editor } = await loadEditor(dir, { minFreeBytes: Number.MAX_SAFE_INTEGER });

    await assert.rejects(
      () => editor.paint({
        target: 'small.tif',
        region: { minX: 2, minY: 2, maxX: 8, maxY: 8 },
        color: [10, 20, 30],
      }),
      (err) => {
        console.log('[磁盘余量不足时的错误信息]\n' + err.message);
        assert.match(err.message, /磁盘/, '要说明是磁盘问题');
        assert.match(err.message, /空间/, '要说明是空间不足');
        assert.match(err.message, /当前可用/, '要报出实际可用空间');
        assert.match(err.message, /建议/, '要给出下一步该怎么做');
        return true;
      },
    );

    assert.deepEqual(readFileSync(tif), bytesBefore, '原文件必须一个字节都没变');
    // 护栏要挡在**写临时文件之前**：失败路径不能留下半个临时文件
    const leftovers = readdirSync(dir).filter((f) => f.startsWith('.'));
    assert.deepEqual(leftovers, [], '失败路径不能留下临时文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('磁盘余量：余量够时正常写回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-disk-'));
  try {
    const tif = join(dir, 'small.tif');
    makeRaster(tif, BIG_VALUE);
    const { loc, editor } = await loadEditor(dir, { minFreeBytes: 0 });

    const res = await editor.paint({
      target: 'small.tif',
      region: { minX: 2, minY: 2, maxX: 8, maxY: 8 },
      color: [10, 20, 30],
    });
    assert.equal(res.verified, true, '余量够时应当正常写回并通过回读校验');

    const after = await readRasterPixels(loc, tif);
    const idx = (x, y) => y * after.width + x;
    assert.equal(after.bands[0][idx(4, 4)], 10, '涂色应当生效');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* 这条用例的关键数字（随机器的可用空间自适应，所以永远成立）：
 *   可用空间 avail = bavail × bsize（statfsSync）
 *   整图 side×side 字节 = wholeBytes，side = ceil(sqrt(avail × 2)) + 1
 *        ⇒ 整图字节数 > 可用空间（留一倍余量，防测试期间磁盘占用变化导致量级翻转）
 *   窗口 64×64 = 4 096 字节
 *   minFreeBytes = 64 MB（**介于窗口大小与整图大小之间**）
 *
 * 为什么这条能区分两种实现 —— 需求取"本次实际需求"与"下限"里更大的那个：
 *   按窗口算 → 需求 = max(4 096, 64 MB) = 64 MB ≤ 可用 → **放行**（错：必然写满磁盘）
 *   按整图算 → 需求 = max(整图, 64 MB) = 整图 > 可用 → **拦下**（对）
 * 也就是说：这条用例拦下来了，就说明需求是按整图算的；放行了，就说明按窗口算了。 */
test('磁盘余量：窗口路径按**整图**算 —— 整图必然写满磁盘时必须拦下', async (t) => {
  if (!hasGdalCreate()) {
    t.skip('本机没有 gdal_create，造不出稀疏大图');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-disk-'));
  try {
    const st = statfsSync(dir);
    const avail = st.bavail * st.bsize;
    const side = Math.ceil(Math.sqrt(avail * 2)) + 1;
    const wholeBytes = side * side;
    const winBytes = 64 * 64;
    const minFree = 64 * 1024 * 1024;

    const tif = join(dir, 'huge.tif');
    makeSparseHugeRaster(tif, side);
    console.log(
      `[磁盘余量] 可用 ${avail} 字节（bavail ${st.bavail} × bsize ${st.bsize}）；` +
      `整图 ${side}×${side} = ${wholeBytes} 字节；窗口 64×64 = ${winBytes} 字节；` +
      `下限 ${minFree} 字节`,
    );
    assert.ok(wholeBytes > avail, '整图必须大于可用空间，这条用例才说明得了问题');
    assert.ok(winBytes < minFree && minFree < wholeBytes, '下限必须介于窗口大小与整图大小之间');

    const { editor } = await loadEditor(dir, { minFreeBytes: minFree });
    await assert.rejects(
      () => editor.paint({ target: 'huge.tif', region: BIG_REGION, color: [10, 20, 30] }),
      (err) => {
        console.log('[整图写不下时的错误信息]\n' + err.message);
        assert.match(err.message, /磁盘/, '要说明是磁盘问题');
        assert.match(err.message, /空间/, '要说明是空间不足');
        assert.match(
          err.message,
          new RegExp(`${(wholeBytes / 1024 ** 3).toFixed(2)} GB`),
          '报出的需求必须是整图大小',
        );
        assert.doesNotMatch(err.message, /4\.0 KB/, '不能报窗口大小');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('磁盘余量：窗口路径报出的需求是整图大小，不是窗口大小', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-disk-'));
  try {
    const tif = join(dir, 'big.tif');
    makeRaster(tif, BIG_VALUE, { width: BIG_W, height: BIG_H });
    // 整图 2048×1536×1 波段×8 位 = 3 145 728 字节（3.0 MB）；窗口 64×64 = 4 096 字节（4.0 KB）
    const { editor } = await loadEditor(dir, { minFreeBytes: Number.MAX_SAFE_INTEGER });

    await assert.rejects(
      () => editor.paint({ target: 'big.tif', region: BIG_REGION, color: [200, 100, 50] }),
      (err) => {
        console.log('[窗口路径的磁盘需求]\n' + err.message);
        // 需求按**整图**算，不按窗口算
        assert.match(err.message, /临时文件 3\.0 MB/, '需求必须按整图算（临时文件 3.0 MB）');
        assert.doesNotMatch(err.message, /4\.0 KB/, '不能报窗口大小（4.0 KB）');
        assert.doesNotMatch(err.message, /4 096 字节/, '不能报窗口大小');
        // 原地替换的峰值是**两份**：临时文件 + 备份副本。
        // 只算一份的话，磁盘看着够，实际写到一半就满了 —— 那正是这道护栏要防的事。
        assert.match(err.message, /备份副本/, '必须把备份副本算进需求');
        const backupBytes = statSync(tif).size;
        assert.match(
          err.message,
          new RegExp(`备份副本 ${(backupBytes / 1024 ** 2).toFixed(1)} MB`),
          '备份副本按原文件的真实大小算',
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('磁盘余量：查的是目标所在目录（临时文件与目标同目录 ⇒ 同一卷）', async () => {
  // 动态导入：护栏函数还不存在时也能把别的用例跑完（ESM 静态导入缺导出是整份文件加载失败）
  const { assertFreeSpace } = await import(eng('ops.ts'));
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-disk-'));
  try {
    const st = statfsSync(dir);
    const avail = st.bavail * st.bsize;
    const target = join(dir, 'x.tif');

    // 需求略小于可用空间 → 放行
    assertFreeSpace(target, avail - 1024 * 1024);

    // 需求略大于可用空间 → 拦下，且报错要带上被查的目录
    assert.throws(
      () => assertFreeSpace(target, avail + 1024 * 1024),
      (err) => {
        assert.match(err.message, /磁盘/, '要说明是磁盘问题');
        assert.ok(err.message.includes(dir), `报错要带上被检查的目录（${dir}）`);
        return true;
      },
    );

    // 另存为到**还不存在**的子目录：按它所在的卷算，不能因此报"查不了磁盘"
    assertFreeSpace(join(dir, 'sub', 'deep', 'out.tif'), 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('磁盘余量：另存为时查的是新文件所在目录（临时文件落在那儿）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-disk-'));
  try {
    const tif = join(dir, 'small.tif');
    makeRaster(tif, BIG_VALUE);
    // 另存到的子目录要先建好：临时文件由 gdal_translate 写，它不会自己建目录
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const { editor } = await loadEditor(dir, { minFreeBytes: Number.MAX_SAFE_INTEGER });

    await assert.rejects(
      () => editor.paint(
        { target: 'small.tif', region: { minX: 2, minY: 2, maxX: 8, maxY: 8 }, color: [10, 20, 30] },
        { outputPath: 'sub/out.tif' },
      ),
      (err) => {
        assert.match(err.message, /磁盘/, '要说明是磁盘问题');
        assert.ok(
          err.message.includes(join(dir, 'sub')),
          `要查新文件所在目录（临时文件落在那儿）：${err.message}`,
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
