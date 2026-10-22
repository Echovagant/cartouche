#!/usr/bin/env node
/**
 * 生成真实的 .tff 样本并做往返校验。
 *
 * 产出：
 *   fixtures/worldref.tff   栅格（GTiff 内容，.tff 扩展名）+ .tfw + .wld + .prj —— Esri 原始组合
 *   fixtures/embedded.tff   栅格 + 内嵌 CRS —— 我们的写回模板
 *   fixtures/sample.shp     Shapefile（含 UTF-8 DBF + .prj）
 *   fixtures/sample.gdb     FileGDB（OpenFileGDB 驱动）
 *
 * 本脚本同时固化 M0' V1 的实测结论：
 *   1) GDAL 按内容识别 .tff（Driver=GTiff/GeoTIFF），与扩展名无关
 *   2) 同名 .tfw 世界文件会被自动关联并生效
 *   3) 同名 .prj 对**栅格无效**（.tif/.tff 均无效），但**对 Shapefile 有效**
 *      → 栅格的 CRS 必须内嵌进 GeoTIFF，否则面积/长度/叠加全错
 *
 * 用法：npm run fixture
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGdalBin, runTool } from './lib/env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixDir = join(root, 'fixtures');
const OK = '\x1b[32m●\x1b[0m';
const BAD = '\x1b[31m■\x1b[0m';
const NOTE = '\x1b[33m▲\x1b[0m';
const DIM = '\x1b[90m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const gdalBin = resolveGdalBin();
if (!gdalBin) {
  console.error('未找到 GDAL。先运行 scripts/setup-conda-gdal.ps1，或 npm run doctor 查看环境。');
  process.exit(1);
}
mkdirSync(fixDir, { recursive: true });

const pnm = join(fixDir, 'sample.pnm');
const tff = join(fixDir, 'worldref.tff');
const tfw = join(fixDir, 'worldref.tfw');
const prj = join(fixDir, 'worldref.prj');
const wld = join(fixDir, 'worldref.wld');
const embedded = join(fixDir, 'embedded.tff');
const shp = join(fixDir, 'sample.shp');
const gdb = join(fixDir, 'sample.gdb');
const roundtrip = join(fixDir, 'roundtrip.tff');

const info = (f, extra = []) => runTool(gdalBin, 'gdalinfo', [...extra, f]);
const hasCrsSection = (text) => /Coordinate System is:/.test(text);
const checksums = (text) => (text.match(/Checksum=(\d+)/g) || []).map((s) => s.split('=')[1]);

// 1) 合成 40x30 的 PNM 影像（完全无地理信息）
const W = 40, H = 30;
const pixels = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    pixels[i] = Math.round((x / (W - 1)) * 255);
    pixels[i + 1] = Math.round((y / (H - 1)) * 255);
    pixels[i + 2] = (x + y) % 256;
  }
}
writeFileSync(pnm, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`, 'ascii'), pixels]));

// 2) 不带任何地理信息地转成 GTiff（强制走"外部世界文件"路径）
runTool(gdalBin, 'gdal_translate', ['-of', 'GTiff', pnm, tff]);

// 3) 写 Esri 风格世界文件与坐标系
const XMIN = 120.3, YMAX = 30.54, CELL = 0.001;
const worldFile = [
  CELL.toFixed(6),
  '0.000000',
  '0.000000',
  (-CELL).toFixed(6),
  (XMIN + CELL / 2).toFixed(6),
  (YMAX - CELL / 2).toFixed(6),
].join('\n');
writeFileSync(tfw, worldFile + '\n');
writeFileSync(wld, worldFile + '\n');
writeFileSync(prj, [
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],',
  'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
].join('\n'));

// 4) 写回模板：CRS 内嵌的 GeoTIFF（仍用 .tff 扩展名）
runTool(gdalBin, 'gdal_translate', ['-of', 'GTiff', '-a_srs', 'EPSG:4326', tff, embedded]);

const infoTff = info(tff);
const infoEmbedded = info(embedded);
const driver = infoTff.match(/Driver:\s*(\S+)/)?.[1] ?? '?';
const size = infoTff.match(/Size is (\d+), (\d+)/);
const origin = infoTff.match(/Origin = \(([-\d.eE+]+),([-\d.eE+]+)\)/);
const px = infoTff.match(/Pixel Size = \(([-\d.eE+]+),([-\d.eE+]+)\)/);
const listsSidecar = /worldref\.tfw/.test(infoTff);

const ck1 = checksums(info(tff, ['-checksum']));
runTool(gdalBin, 'gdal_translate', ['-of', 'GTiff', tff, roundtrip]);
const ck2 = checksums(info(roundtrip, ['-checksum']));

const report = (name, ok, detail) =>
  console.log(`  ${ok ? OK : BAD} ${name.padEnd(36, ' ')}${DIM}${detail}${RESET}`);

console.log(`\n${BOLD}样本生成与往返校验${RESET}  ${DIM}${fixDir}${RESET}\n`);
console.log(`${BOLD}A. Esri 原始组合（.tff + .tfw + .wld + .prj）${RESET}`);
report('GDAL 按内容识别 .tff', driver.startsWith('GTiff'), `Driver = ${driver}`);
report('影像尺寸读取', Boolean(size), size ? `${size[1]} x ${size[2]} 像元` : '读取失败');
report('同名 .tfw 被自动关联', listsSidecar, 'gdalinfo 的 Files: 列出了 .tfw');
report('世界文件生效（仿射参数）', Boolean(px), px ? `Pixel Size = ${px[1]}, ${px[2]}` : '未读到');
report('原点读取', Boolean(origin), origin ? `Origin = (${origin[1]}, ${origin[2]})` : '未读到');
report('同名 .prj 对栅格**无效**（已知行为）', !hasCrsSection(infoTff), 'gdalinfo 无 "Coordinate System is:" 段');

console.log(`\n${BOLD}B. 写回模板（CRS 内嵌）${RESET}`);
report('内嵌 CRS 的 .tff 可解析坐标系', hasCrsSection(infoEmbedded), 'gdal_translate -a_srs EPSG:4326');

console.log(`\n${BOLD}C. 写回往返${RESET}`);
report('像元校验和往返一致', ck1.length > 0 && ck1.join(',') === ck2.join(','), `before=[${ck1}] after=[${ck2}]`);

console.log(`\n${BOLD}D. 矢量格式${RESET}`);
const geojson = join(fixDir, 'sample.geojson');
writeFileSync(geojson, JSON.stringify({
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { 名称: '测试图斑', 编码: 1024 },
    geometry: { type: 'Polygon', coordinates: [[[120.30, 30.52], [120.32, 30.52], [120.32, 30.54], [120.30, 30.54], [120.30, 30.52]]] },
  }],
}));
let shpOk = false, shpCrs = false, shpDetail = '';
try {
  runTool(gdalBin, 'ogr2ogr', ['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', shp, geojson]);
  shpOk = existsSync(shp) && existsSync(join(fixDir, 'sample.dbf'));
  const shpInfo = runTool(gdalBin, 'ogrinfo', ['-so', '-al', shp]);
  shpCrs = /Layer SRS WKT:/.test(shpInfo);
  shpDetail = shpCrs ? 'Layer SRS WKT 存在（.prj 对矢量有效）' : '未读到 SRS';
} catch (e) {
  shpDetail = `写入失败: ${String(e.message).split('\n')[0]}`;
}
report('ESRI Shapefile 写入（含中文属性）', shpOk, shpOk ? 'sample.shp / .dbf / .shx / .cpg 已生成' : shpDetail);
report('同名 .prj 对 Shapefile 有效', shpCrs, shpDetail);

// GBK 编码样本：国内真实成果常见的 DBF 编码，用来暴露体检规则 V-ENC-001
const gbkShp = join(fixDir, 'gbk_sample.shp');
const cnShp = join(fixDir, '中文样本.shp');
let gbkOk = false;
let gbkDetail = '未执行';
try {
  runTool(gdalBin, 'ogr2ogr', ['-f', 'ESRI Shapefile', '-lco', 'ENCODING=GBK', gbkShp, geojson]);
  const cpgPath = join(fixDir, 'gbk_sample.cpg');
  const cpgText = existsSync(cpgPath) ? readFileSync(cpgPath, 'utf8').trim() : '(无 .cpg)';
  gbkOk = existsSync(gbkShp) && existsSync(join(fixDir, 'gbk_sample.dbf'));
  gbkDetail = `gbk_sample.shp / .dbf 已生成，.cpg = ${cpgText}`;
} catch (e) {
  gbkDetail = `写入失败: ${String(e.message).split('\n')[0]}`;
}
report('GBK 编码 Shapefile（暴露 V-ENC-001）', gbkOk, gbkDetail);

// 中文文件名 + 中文路径：验证路径处理与 .prj 侧车不会因编码问题失效
let cnOk = false;
let cnDetail = '未执行';
try {
  runTool(gdalBin, 'ogr2ogr', ['-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', cnShp, geojson]);
  const info2 = runTool(gdalBin, 'ogrinfo', ['-so', '-al', cnShp]);
  cnOk = /Layer SRS WKT:/.test(info2);
  cnDetail = cnOk ? '中文文件名下 .prj 仍被正确读取' : '中文文件名下未读到 SRS';
} catch (e) {
  cnDetail = `写入失败: ${String(e.message).split('\n')[0]}`;
}
report('中文文件名 + 中文属性（路径与编码）', cnOk, cnDetail);

let gdbOk = false, gdbDetail = '未执行';
try {
  runTool(gdalBin, 'ogr2ogr', ['-f', 'OpenFileGDB', gdb, shp]);
  gdbOk = existsSync(gdb);
  gdbDetail = gdbOk ? 'sample.gdb 已生成（OpenFileGDB 内置驱动，无需 Esri SDK）' : '未生成';
} catch (e) {
  gdbDetail = `FileGDB 写入失败: ${String(e.message).split('\n')[0]}`;
}
report('FileGDB 写入（OpenFileGDB）', gdbOk, gdbDetail);

console.log(`\n  ${NOTE}关键结论：Esri 的 ".prj" 侧车对**栅格**无效（.tif/.tff 皆然），对 **Shapefile** 有效。`);
console.log(`  ${DIM}因此写回栅格时必须把 CRS 内嵌进 GeoTIFF，并额外落一份 .prj 供 ArcGIS 使用；`);
console.log(`  ${DIM}同时"数据体检"必须把"栅格缺少内嵌 CRS"列为阻断项——否则面积、长度、叠加全部会错。${RESET}`);
console.log(`  ${DIM}下一步：把 fixtures/ 下这几个样本拷到装有 ArcGIS Pro 的机器上打开，确认 ArcGIS 侧也正常。${RESET}\n`);
