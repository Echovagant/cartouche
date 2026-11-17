/**
 * 栅格写回：**按源格式写回**（HFA / AAIGrid / EHdr / PNG）。
 *
 * 这组用例钉住的是"内容换了、格式没换"这条承诺：
 *   - 驱动、位深、坐标系、仿射参数写回后必须还是原来的；
 *   - 伴随文件（.hdr / .prj / .aux.xml）必须跟着新内容成套落盘；
 *   - 装不下的格式（VRT / 调色板 / 扩展名对不上）必须当场拒绝，一个字节都不动。
 *
 * 夹具都是现场用 GDAL 从一张小 GeoTIFF 转出来的，不依赖仓库外的样本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eng = (p) => pathToFileURL(join(root, 'src', 'engine', p)).href;

const { resolveGdal } = await import(eng('gdal/env.ts'));
const { tools } = await import(eng('gdal/runner.ts'));
const { LocalFolderStore } = await import(eng('workspace/index.ts'));
const { RasterEditor, readRasterPixels } = await import(eng('raster/index.ts'));

const loc = resolveGdal();
const gdal = tools(loc);

const W = 24;
const H = 20;
const GT = ['120.30', '30.532', '120.324', '30.512']; // ulx uly lrx lry

/**
 * 造一张 24×20 的单波段 GeoTIFF（ENVI 裸数据 + 头 → gdal_translate）。
 *
 * `values` 是卷积底图：默认给一条随位置变化的坡度，调色才看得出变化。
 */
async function makeTif(dir, name, { valueAt = (x, y) => (x * 7 + y * 5 + 11) % 200 } = {}) {
  const raw = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) raw[y * W + x] = valueAt(x, y) & 0xff;
  }
  const bin = join(dir, `${name}.bin`);
  const hdr = join(dir, `${name}.hdr`);
  writeFileSync(bin, raw);
  writeFileSync(
    hdr,
    [
      'ENVI',
      `samples = ${W}`,
      `lines   = ${H}`,
      'bands   = 1',
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
  const res = await gdal.translate([
    '-of', 'GTiff', '-ot', 'Byte',
    '-a_srs', 'EPSG:4326', '-a_ullr', ...GT, bin, tif,
  ]);
  assert.ok(res.ok, `造原图失败：${res.stderr}`);
  return tif;
}

/** 把 GeoTIFF 转成目标格式（夹具），返回目标文件绝对路径。 */
async function convert(dir, tif, of, ext, extra = []) {
  const out = join(dir, `base${ext}`);
  const res = await gdal.translate(['-of', of, ...extra, tif, out]);
  assert.ok(res.ok, `转 ${of} 失败：${res.stderr}`);
  return out;
}

async function infoOf(abs) {
  const res = await gdal.info(abs, ['-json']);
  assert.ok(res.ok, `gdalinfo 失败：${res.stderr}`);
  return JSON.parse(res.stdout);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cartouche-fmt-'));
  const store = new LocalFolderStore(dir);
  return { dir, store, editor: new RasterEditor({ loc, store }) };
}

const REGION = { minX: 4, minY: 4, maxX: 14, maxY: 12 };

test('HFA：调色后仍是 .img（驱动/位深/坐标系/仿射不变），备份是整组', async () => {
  const { dir, editor } = setup();
  try {
    const tif = await makeTif(dir, 'src');
    await convert(dir, tif, 'HFA', '.img');
    const target = join(dir, 'base.img');
    const before = await infoOf(target);
    assert.equal(before.driverShortName, 'HFA');

    const res = await editor.adjustLevels({ target: 'base.img', method: 'gamma', gamma: 1.5 });
    assert.equal(res.verified, true, '写回后格式与位深必须对得上');

    const after = await infoOf(target);
    assert.equal(after.driverShortName, 'HFA', '写回后必须仍是 HFA');
    assert.equal(after.bands[0].type, before.bands[0].type, '位深不能变');
    assert.ok(after.coordinateSystem?.wkt, '坐标系必须保留');
    assert.deepEqual(after.geoTransform, before.geoTransform, '仿射参数必须保留');

    const px = await readRasterPixels(loc, target);
    assert.equal(px.driver, 'HFA');
    assert.ok(res.backupPath, '必须留下备份');
    assert.ok(existsSync(join(dir, res.backupPath, 'base.img')), '备份目录里要有主文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AAIGrid：局部涂色后仍是 .asc（Int32 / .prj 都在），窗口外像素不变', async () => {
  const { dir, editor } = setup();
  try {
    const tif = await makeTif(dir, 'src');
    await convert(dir, tif, 'AAIGrid', '.asc', ['-ot', 'Int32']);
    const target = join(dir, 'base.asc');
    const before = await infoOf(target);
    assert.equal(before.driverShortName, 'AAIGrid');
    const beforePx = await readRasterPixels(loc, target);

    const res = await editor.paint({ target: 'base.asc', region: REGION, color: '#000000' });
    assert.equal(res.verified, true, '窗口内逐样点必须能读回同样的值');

    const after = await infoOf(target);
    assert.equal(after.driverShortName, 'AAIGrid', '写回后必须仍是 AAIGrid');
    assert.equal(after.bands[0].type, 'Int32', 'ASCII Grid 的位深不能变');
    assert.ok(after.coordinateSystem?.wkt, '坐标系必须保留（.prj 或 .aux.xml）');
    assert.ok(existsSync(join(dir, 'base.prj')), 'AAIGrid 的 .prj 必须成套写出');

    const afterPx = await readRasterPixels(loc, target);
    assert.equal(afterPx.bands[0][5 * W + 5], 0, '窗口内应被涂成 0');
    assert.equal(
      afterPx.bands[0][0],
      beforePx.bands[0][0],
      '窗口外第一个像元必须原样不变',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('EHdr：局部涂色后仍是 .bil，.hdr 跟着一起换，坐标系不丢', async () => {
  const { dir, editor } = setup();
  try {
    const tif = await makeTif(dir, 'src');
    await convert(dir, tif, 'EHdr', '.bil');
    const target = join(dir, 'base.bil');
    const before = await infoOf(target);
    assert.equal(before.driverShortName, 'EHdr');

    const res = await editor.paint({ target: 'base.bil', region: REGION, color: '#000000' });
    assert.equal(res.verified, true);

    const after = await infoOf(target);
    assert.equal(after.driverShortName, 'EHdr', '写回后必须仍是 EHdr');
    assert.equal(after.bands[0].type, before.bands[0].type);
    assert.ok(after.coordinateSystem?.wkt, '坐标系必须保留');
    assert.ok(existsSync(join(dir, 'base.hdr')), '.hdr 是数据的一部分，必须在');
    const files = readdirSync(dir);
    assert.ok(files.some((n) => n === 'base.bil'), '主文件要在');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PNG：涂色后仍是 PNG，坐标系留在 .png.aux.xml 里', async () => {
  const { dir, editor } = setup();
  try {
    const tif = await makeTif(dir, 'src');
    await convert(dir, tif, 'PNG', '.png');
    const target = join(dir, 'base.png');
    const before = await infoOf(target);
    assert.equal(before.driverShortName, 'PNG');

    const res = await editor.paint({ target: 'base.png', region: REGION, color: '#000000' });
    assert.equal(res.verified, true);

    const after = await infoOf(target);
    assert.equal(after.driverShortName, 'PNG', '写回后必须仍是 PNG');
    assert.equal(after.bands[0].type, 'Byte');
    assert.ok(after.coordinateSystem?.wkt, '坐标系必须保留');
    assert.ok(existsSync(join(dir, 'base.png.aux.xml')), 'PNG 的坐标系在 .aux.xml 里，必须在');
    const px = await readRasterPixels(loc, target);
    assert.equal(px.bands[0][5 * W + 5], 0, '窗口内应被涂成黑色');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nodata：写回后原样保留（AAIGrid 的 -9999）', async () => {
  const { dir, editor } = setup();
  try {
    const tif = await makeTif(dir, 'src');
    // 先给源图打上 nodata，再转成 ASCII Grid —— 这两步都是 GDAL 自己做的，
    // 我们只验证写回之后 nodata 还在
    const signed = join(dir, 'src-i16.tif');
    const t1 = await gdal.translate(['-of', 'GTiff', '-ot', 'Int16', '-a_nodata', '-9999', tif, signed]);
    assert.ok(t1.ok, `带 nodata 的夹具失败：${t1.stderr}`);
    const target = join(dir, 'base.asc');
    const t2 = await gdal.translate(['-of', 'AAIGrid', '-ot', 'Int16', '-a_nodata', '-9999', signed, target]);
    assert.ok(t2.ok, `转 AAIGrid 失败：${t2.stderr}`);
    assert.equal((await infoOf(target)).bands[0].noDataValue, -9999);

    const res = await editor.paint({ target: 'base.asc', region: REGION, color: '#000000' });
    assert.equal(res.verified, true);
    const after = await infoOf(target);
    assert.equal(after.bands[0].noDataValue, -9999, 'nodata 不能丢');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('拒绝：带调色板的 PNG 不写回，原文件一个字节不动', async () => {
  const { dir, editor } = setup();
  try {
    await makeTif(dir, 'src');
    // 256 色调色板的小图：像素是调色板序号，重写会把调色板丢掉
    const entries = Array.from({ length: 256 }, (_, i) =>
      `<Entry c1="${i}" c2="${255 - i}" c3="${(i * 7) % 256}" c4="255"/>`,
    ).join('');
    const vrt = join(dir, 'pal.vrt');
    writeFileSync(
      vrt,
      `<VRTDataset rasterXSize="${W}" rasterYSize="${H}">
  <SRS>EPSG:4326</SRS><GeoTransform>120.30, 0.001, 0, 30.532, 0, -0.001</GeoTransform>
  <VRTRasterBand dataType="Byte" band="1">
    <ColorInterp>Palette</ColorInterp>
    <ColorTable>${entries}</ColorTable>
    <SimpleSource><SourceFilename relativeToVRT="0">${join(dir, 'src.tif')}</SourceFilename><SourceBand>1</SourceBand>
    <SrcRect xOff="0" yOff="0" xSize="${W}" ySize="${H}"/><DstRect xOff="0" yOff="0" xSize="${W}" ySize="${H}"/></SimpleSource>
  </VRTRasterBand></VRTDataset>`,
      'utf8',
    );
    const png = join(dir, 'pal.png');
    const tr = await gdal.translate(['-of', 'PNG', vrt, png]);
    assert.ok(tr.ok, `调色板夹具应生成成功：${tr.stderr}`);
    const before = readFileSync(png);

    await assert.rejects(
      () => editor.paint({ target: 'pal.png', region: REGION, color: '#000000' }),
      /调色板/,
    );
    assert.deepEqual(readFileSync(png), before, '被拒绝后原文件必须一个字节都不动');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('拒绝：扩展名与实际格式不一致（HFA 字节叫 .tif）', async () => {
  const { dir, editor } = setup();
  try {
    const tif = await makeTif(dir, 'src');
    await convert(dir, tif, 'HFA', '.img');
    const wrong = join(dir, 'base.tif');
    writeFileSync(wrong, readFileSync(join(dir, 'base.img')));
    const before = readFileSync(wrong);

    await assert.rejects(
      () => editor.paint({ target: 'base.tif', region: REGION, color: '#000000' }),
      /扩展名/,
    );
    assert.deepEqual(readFileSync(wrong), before, '被拒绝后原文件必须一个字节都不动');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
