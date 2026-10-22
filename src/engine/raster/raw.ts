/**
 * 原始像素读写（经 ENVI 原始格式中转）。
 *
 * 为什么要绕一圈 ENVI：GDAL 的命令行工具没有"把裸像元打到 stdout"的干净选项，
 * 而 ENVI 的 .bin + .hdr 是纯二进制 + 纯文本头，解析成本极低，
 * 且写回时用 `gdal_translate -of GTiff -a_ullr ...` 能精确还原仿射参数与坐标系。
 *
 * 好处：像素级运算（修补/混合/提亮）在 TypeScript 里做，
 * 格式保真交给 GDAL，两边职责清晰且都易于单测。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';
import { windowGeotransform, type RasterFrame, type RasterWindow } from './window.ts';

export interface RasterPixels {
  readonly width: number;
  readonly height: number;
  readonly bandCount: number;
  /** 每个波段一份，长度 = width * height */
  readonly bands: Uint8Array[];
  /** [originX, pixelW, 0, originY, 0, pixelH] */
  readonly geotransform: number[] | null;
  /** 坐标系 WKT */
  readonly crs: string | null;
  /**
   * GDAL 驱动短名（如 `GTiff` / `HFA` / `PNG` / `VRT`）。
   *
   * 写回时统一用 `gdal_translate -of GTiff` 产出，所以**只有 GTiff 能原样写回**——
   * 别的驱动写出来的是 GeoTIFF 字节，扩展名却还是原来的，ArcGIS 直接打不开。
   * 引擎据此在动手前就拒绝，而不是把文件改坏。
   */
  readonly driver: string;
  /** 内容校验和（波段顺序拼接） */
  readonly checksum: string;
}

/** 解析 ENVI 头文件 */
function parseEnviHeader(text: string): {
  samples: number;
  lines: number;
  bands: number;
  interleave: string;
  dataType: number;
} {
  const pick = (key: string): string | undefined => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*\\{?([^}\\r\\n]*)`, 'im').exec(text);
    return m?.[1]?.trim();
  };
  const samples = Number(pick('samples') ?? 0);
  const lines = Number(pick('lines') ?? 0);
  const bands = Number(pick('bands') ?? 1);
  const interleave = (pick('interleave') ?? 'bip').toLowerCase();
  const dataType = Number(pick('data type') ?? 1);
  if (!samples || !lines || !bands) throw new Error('ENVI 头文件解析失败：缺少尺寸信息');
  return { samples, lines, bands, interleave, dataType };
}

/**
 * 波段内容的校验和（波段顺序拼接）。
 *
 * 导出它是为了**预演**：预演时像素在内存里算完就丢，
 * 但确认卡要给出"改完之后长什么样"的凭据 —— 同一个算法算出来的校验和
 * 才能和真实执行后的校验和对得上，否则预演给的是个假数字。
 */
export function checksumOf(bands: readonly Uint8Array[]): string {
  const h = createHash('sha256');
  for (const b of bands) h.update(b);
  return h.digest('hex');
}

/** 读一份 ENVI 中转文件，返回拆好的波段。ENVI 头的命名有两种约定。 */
function readEnviBands(bin: string, width: number, height: number, bandCount: number): Uint8Array[] {
  const headerCandidates = [`${bin}.hdr`, bin.replace(/\.bin$/i, '.hdr')];
  const headerPath = headerCandidates.find((p) => existsSync(p));
  if (!headerPath) {
    throw new Error(`未找到 ENVI 头文件（尝试过：${headerCandidates.join('、')}）`);
  }
  const header = readFileSync(headerPath, 'utf8');
  const meta = parseEnviHeader(header);
  const raw = new Uint8Array(readFileSync(bin));
  const expected = width * height * bandCount;
  if (raw.length < expected) {
    throw new Error(`原始像素长度异常：期望 ${expected}，实际 ${raw.length}`);
  }
  const bands: Uint8Array[] = [];
  if (meta.interleave === 'bip' || meta.interleave === 'bil') {
    for (let b = 0; b < bandCount; b++) {
      const band = new Uint8Array(width * height);
      for (let i = 0; i < width * height; i++) band[i] = raw[i * bandCount + b]!;
      bands.push(band);
    }
  } else {
    // bsq / bil
    for (let b = 0; b < bandCount; b++) {
      bands.push(raw.slice(b * width * height, (b + 1) * width * height));
    }
  }
  return bands;
}

/** 读取一个栅格的原始像素（不含缩放、不做重采样） */
export async function readRasterPixels(
  loc: GdalLocation,
  absPath: string,
): Promise<RasterPixels> {
  const gdal = tools(loc);
  const infoRes = await gdal.info(absPath, ['-json']);
  if (!infoRes.ok) {
    throw new Error(`读取栅格信息失败：${absPath}\n${infoRes.stderr}`);
  }
  const info = JSON.parse(infoRes.stdout) as {
    size?: [number, number];
    bands?: unknown[];
    geoTransform?: number[];
    coordinateSystem?: { wkt?: string };
    driverShortName?: string;
  };
  const width = info.size?.[0] ?? 0;
  const height = info.size?.[1] ?? 0;
  const bandCount = info.bands?.length ?? 0;
  if (!width || !height || !bandCount) {
    throw new Error(`栅格尺寸异常：${absPath}`);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'cartouche-raw-'));
  const bin = join(tmp, 'raw.bin');
  const tr = await gdal.translate(['-of', 'ENVI', '-ot', 'Byte', absPath, bin]);
  if (!tr.ok) {
    throw new Error(`导出原始像素失败：${absPath}\n${tr.stderr}`);
  }

  const bands = readEnviBands(bin, width, height, bandCount);

  return {
    width,
    height,
    bandCount,
    bands,
    geotransform: info.geoTransform ? [...info.geoTransform] : null,
    crs: info.coordinateSystem?.wkt ?? null,
    driver: String(info.driverShortName ?? 'GTiff'),
    checksum: checksumOf(bands),
  };
}

/** 把原始像素写成 GeoTIFF（保留仿射参数与坐标系） */
export async function writeRasterPixels(
  loc: GdalLocation,
  outAbsPath: string,
  pixels: {
    readonly width: number;
    readonly height: number;
    readonly bands: readonly Uint8Array[];
    readonly geotransform: readonly number[] | null;
    readonly crs: string | null;
  },
): Promise<void> {
  const gdal = tools(loc);
  const bandCount = pixels.bands.length;
  if (!bandCount) throw new Error('没有可写入的波段');

  const tmp = mkdtempSync(join(tmpdir(), 'cartouche-write-'));
  const bin = join(tmp, 'out.bin');
  const hdr = join(tmp, 'out.hdr');

  // 写成 BIP（像元交错），并附 ENVI 头
  const raw = new Uint8Array(pixels.width * pixels.height * bandCount);
  for (let i = 0; i < pixels.width * pixels.height; i++) {
    for (let b = 0; b < bandCount; b++) raw[i * bandCount + b] = pixels.bands[b]![i]!;
  }
  writeFileSync(bin, raw);
  writeFileSync(
    hdr,
    [
      'ENVI',
      `samples = ${pixels.width}`,
      `lines   = ${pixels.height}`,
      `bands   = ${bandCount}`,
      'header offset = 0',
      'file type = ENVI Standard',
      'data type = 1',
      'interleave = bip',
      'byte order = 0',
      '',
    ].join('\n'),
    'utf8',
  );

  const args = ['-of', 'GTiff', '-ot', 'Byte'];
  const gt = pixels.geotransform;
  if (gt && gt.length >= 6) {
    const originX = gt[0] ?? 0;
    const pixelW = gt[1] ?? 1;
    const originY = gt[3] ?? 0;
    const pixelH = gt[5] ?? -1;
    const lrx = originX + pixels.width * pixelW;
    const lry = originY + pixels.height * pixelH;
    args.push('-a_ullr', String(originX), String(originY), String(lrx), String(lry));
  }
  if (pixels.crs) {
    args.push('-a_srs', pixels.crs);
  }
  args.push(bin, outAbsPath);

  const res = await gdal.translate(args);
  if (!res.ok) {
    throw new Error(`写出 GeoTIFF 失败：${outAbsPath}\n${res.stderr}`);
  }
}

/** 一个窗口的像素（窗口自身坐标系下的仿射参数） */
export interface RasterWindowPixels {
  readonly window: RasterWindow;
  readonly width: number;      // = window.w
  readonly height: number;     // = window.h
  readonly bandCount: number;
  readonly bands: Uint8Array[];
  /** 窗口自身的仿射参数 */
  readonly geotransform: number[] | null;
  readonly crs: string | null;
  readonly checksum: string;
}

/** 整图的基本信息（尺寸 + 仿射参数）之外，再带上波段数与坐标系 */
export interface RasterFrameInfo extends RasterFrame {
  readonly bandCount: number;
  readonly crs: string | null;
}

/** 读整图的基本信息（不读像素，很便宜） */
export async function readRasterFrame(
  loc: GdalLocation,
  absPath: string,
): Promise<RasterFrameInfo> {
  const gdal = tools(loc);
  const infoRes = await gdal.info(absPath, ['-json']);
  if (!infoRes.ok) {
    throw new Error(`读取栅格信息失败：${absPath}\n${infoRes.stderr}`);
  }
  const info = JSON.parse(infoRes.stdout) as {
    size?: [number, number];
    bands?: unknown[];
    geoTransform?: number[];
    coordinateSystem?: { wkt?: string };
  };
  const width = info.size?.[0] ?? 0;
  const height = info.size?.[1] ?? 0;
  const bandCount = info.bands?.length ?? 0;
  if (!width || !height || !bandCount) {
    throw new Error(`栅格尺寸异常：${absPath}`);
  }
  if (!info.geoTransform) {
    throw new Error(`栅格缺少仿射参数，无法定位窗口：${absPath}`);
  }
  return {
    width,
    height,
    bandCount,
    geotransform: [...info.geoTransform],
    crs: info.coordinateSystem?.wkt ?? null,
  };
}

/**
 * 只读一个窗口的像素。
 *
 * 走 `-srcwin`：GDAL 只把窗口那一块导出成 ENVI，
 * Node 内存里就只有窗口大小，与原文件大小无关。
 */
export async function readRasterWindow(
  loc: GdalLocation,
  absPath: string,
  win: RasterWindow,
): Promise<RasterWindowPixels> {
  const gdal = tools(loc);
  const frame = await readRasterFrame(loc, absPath);
  if (win.x < 0 || win.y < 0 || win.w <= 0 || win.h <= 0 ||
      win.x + win.w > frame.width || win.y + win.h > frame.height) {
    throw new Error(`窗口越出栅格范围（窗口 ${win.x},${win.y} ${win.w}×${win.h}；整图 ${frame.width}×${frame.height}）`);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'cartouche-win-'));
  const bin = join(tmp, 'win.bin');
  const tr = await gdal.translate([
    '-of', 'ENVI', '-ot', 'Byte',
    '-srcwin', String(win.x), String(win.y), String(win.w), String(win.h),
    absPath, bin,
  ]);
  if (!tr.ok) {
    throw new Error(`导出窗口像素失败：${absPath}\n${tr.stderr}`);
  }
  const bands = readEnviBands(bin, win.w, win.h, frame.bandCount);

  return {
    window: win,
    width: win.w,
    height: win.h,
    bandCount: frame.bandCount,
    bands,
    geotransform: windowGeotransform(frame, win),
    crs: frame.crs,
    checksum: checksumOf(bands),
  };
}
