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
import {
  BYTES_PER_SAMPLE,
  clampSample,
  decodeSample,
  newBand,
  pixelTypeFromGdal,
  pixelTypeOf,
  readSample,
  writeSample,
  type PixelBand,
  type PixelType,
} from './pixels.ts';

export interface RasterPixels {
  readonly width: number;
  readonly height: number;
  readonly bandCount: number;
  /** 每个波段一份，长度 = width * height */
  readonly bands: readonly PixelBand[];
  /** 像素类型：8 位还是 16 位 */
  readonly pixelType: PixelType;
  /** 每个波段的颜色解释（Red / Green / Blue / Gray / Undefined…） */
  readonly colorInterpretation: readonly string[];
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

/**
 * ENVI 头里 `data type` 的编号 → 本引擎的像素类型。
 *
 * 只认得两种：1 = Byte、12 = UInt16。
 * 认不出来的必须报错：Int16 / Float32 这类带如果被默默当成 8 位或 16 位处理，
 * 结果就是数据被改错了却看不出来 —— 那正是 `-ot Byte` 静默饱和的老毛病。
 */
const ENVI_DATA_TYPES: Readonly<Record<number, PixelType>> = Object.freeze({
  1: 'Byte',
  12: 'UInt16',
});

/** ENVI `data type` 编号 → 类型名。报错时要说明白到底是哪种类型不支持。 */
const ENVI_DATA_TYPE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'Byte',
  2: 'Int16',
  3: 'Int32',
  4: 'Float32',
  5: 'Float64',
  6: 'Complex',
  9: 'ComplexDouble',
  12: 'UInt16',
  13: 'UInt32',
  14: 'Int64',
  15: 'UInt64',
});

/** 把 ENVI 的 data type 编号翻成本引擎的像素类型；不支持的类型直接报错。 */
function enviPixelType(dataType: number): PixelType {
  const type = ENVI_DATA_TYPES[dataType];
  if (type) return type;
  const name = ENVI_DATA_TYPE_NAMES[dataType] ?? `未知类型（data type = ${dataType}）`;
  throw new Error(
    `不支持的 ENVI 数据类型「${name}」：本引擎只支持 8 位无符号（Byte，data type = 1）` +
    `与 16 位无符号（UInt16，data type = 12）影像`,
  );
}

/** 解析 ENVI 头文件 */
function parseEnviHeader(text: string): {
  samples: number;
  lines: number;
  bands: number;
  interleave: string;
  dataType: number;
  byteOrder: number;
} {
  const pick = (key: string): string | undefined => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*\\{?([^}\\r\\n]*)`, 'im').exec(text);
    return m?.[1]?.trim();
  };
  const samples = Number(pick('samples') ?? 0);
  const lines = Number(pick('lines') ?? 0);
  const bands = Number(pick('bands') ?? 1);
  // 交错方式取不到时按 bsq（波段顺序）处理：ENVI 规范与 GDAL 驱动都是这个默认。
  const interleave = (pick('interleave') ?? 'bsq').toLowerCase();
  const dataType = Number(pick('data type') ?? 1);
  // 字节序：0 = 低字节在前（小端），1 = 高字节在前（大端）。
  // 取不到时按小端处理 —— GDAL 写出来的 ENVI 一律是小端。
  const byteOrder = Number(pick('byte order') ?? 0);
  if (!samples || !lines || !bands) throw new Error('ENVI 头文件解析失败：缺少尺寸信息');
  return { samples, lines, bands, interleave, dataType, byteOrder };
}

/**
 * 波段内容的校验和（波段顺序拼接）。
 *
 * 导出它是为了**预演**：预演时像素在内存里算完就丢，
 * 但确认卡要给出"改完之后长什么样"的凭据 —— 同一个算法算出来的校验和
 * 才能和真实执行后的校验和对得上，否则预演给的是个假数字。
 *
 * 必须按**字节流**算：带可能是 Uint16Array，直接 update 整条带依赖运行时的处理方式，
 * 显式切成字节视图才是确定的做法。8 位带的取值与改动前完全一致。
 */
export function checksumOf(bands: readonly PixelBand[]): string {
  const h = createHash('sha256');
  for (const b of bands) h.update(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
  return h.digest('hex');
}

/**
 * ENVI 三种交错方式下，某个样点在裸字节流里的偏移。
 *
 *  - bsq（波段顺序）：一个波段一整段
 *  - bip（像元交错）：同一像元的各波段相邻
 *  - bil（行交错）：每行内部像元交错，行与行整段分开
 *
 * 把 bil 当 bip 处理的话，**第二行起偏移就全错了**，而那只是数值错误，不会报错。
 */
function enviSampleOffset(
  interleave: string,
  x: number,
  y: number,
  band: number,
  width: number,
  height: number,
  bandCount: number,
  bytesPerSample: number,
): number {
  if (interleave === 'bip') {
    return ((y * width + x) * bandCount + band) * bytesPerSample;
  }
  if (interleave === 'bil') {
    const rowStart = y * width * bandCount * bytesPerSample;
    return rowStart + (x * bandCount + band) * bytesPerSample;
  }
  if (interleave === 'bsq') {
    const bandStart = band * width * height * bytesPerSample;
    return bandStart + (y * width + x) * bytesPerSample;
  }
  throw new Error(`不支持的 ENVI 交错方式「${interleave}」：只支持 bsq / bip / bil`);
}

/**
 * 读一份 ENVI 中转文件，返回拆好的波段。ENVI 头的命名有两种约定。
 *
 * 波段的宽度与类型由 ENVI 头的 `data type` 决定（1 = Byte、12 = UInt16），
 * 样点按头的 `byte order` 解释字节。类型不支持时直接报错，不当成 8 位凑合。
 */
export function readEnviBands(bin: string, width: number, height: number, bandCount: number): PixelBand[] {
  const headerCandidates = [`${bin}.hdr`, bin.replace(/\.bin$/i, '.hdr')];
  const headerPath = headerCandidates.find((p) => existsSync(p));
  if (!headerPath) {
    throw new Error(`未找到 ENVI 头文件（尝试过：${headerCandidates.join('、')}）`);
  }
  const header = readFileSync(headerPath, 'utf8');
  const meta = parseEnviHeader(header);
  const pixelType = enviPixelType(meta.dataType);
  const bytesPerSample = BYTES_PER_SAMPLE[pixelType];
  const raw = new Uint8Array(readFileSync(bin));
  const expected = width * height * bandCount * bytesPerSample;
  if (raw.length < expected) {
    throw new Error(`原始像素长度异常：期望 ${expected}，实际 ${raw.length}`);
  }
  const bands: PixelBand[] = [];
  for (let b = 0; b < bandCount; b++) {
    const band = newBand(pixelType, width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const offset = enviSampleOffset(
          meta.interleave, x, y, b, width, height, bandCount, bytesPerSample,
        );
        writeSample(band, i, decodeSample(raw, offset, bytesPerSample, meta.byteOrder), pixelType);
      }
    }
    bands.push(band);
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
    bands?: { type?: string; colorInterpretation?: string }[];
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

  // 按源的类型读：`-ot Byte` 对 16 位源是**静默饱和**（65535 被压成 255，
  // 退出码仍是 0、stderr 也是空的，实测 GDAL 3.13.3）——值被改坏了却没有任何提示。
  // 要保真就得让 GDAL 按源类型导出，导完再按 ENVI 头的类型与字节序读回来。
  // 源类型不认识（Int16 / Float32 …）在这里就报错，不带着坏数据往下走。
  const pixelType = pixelTypeFromGdal(info.bands?.[0]?.type);
  const colorInterpretation = (info.bands ?? []).map((b) => b.colorInterpretation ?? 'Undefined');

  const tmp = mkdtempSync(join(tmpdir(), 'cartouche-raw-'));
  const bin = join(tmp, 'raw.bin');
  const ot = pixelType === 'UInt16' ? 'UInt16' : 'Byte';
  const tr = await gdal.translate(['-of', 'ENVI', '-ot', ot, absPath, bin]);
  if (!tr.ok) {
    throw new Error(`导出原始像素失败：${absPath}\n${tr.stderr}`);
  }

  const bands = readEnviBands(bin, width, height, bandCount);

  return {
    width,
    height,
    bandCount,
    bands,
    pixelType,
    colorInterpretation,
    geotransform: info.geoTransform ? [...info.geoTransform] : null,
    crs: info.coordinateSystem?.wkt ?? null,
    driver: String(info.driverShortName ?? 'GTiff'),
    checksum: checksumOf(bands),
  };
}

/**
 * ENVI 头的 `data type` 编号 → 本引擎的像素类型（写侧用）。
 *
 * 1 = Byte、12 = UInt16。**2 是 Int16，不是 UInt16** ——
 * 写错的话 GDAL 会按有符号 16 位解释，值 >= 32768 的像元全变成负数。
 */
const ENVI_WRITE_DATA_TYPE: Readonly<Record<PixelType, number>> = Object.freeze({
  Byte: 1,
  UInt16: 12,
});

/**
 * GDAL 的颜色解释名 → gdal_translate `-colorinterp` 认的值。
 *
 * 用白名单而不是原样透传：拼错的值 gdal_translate 会直接报错退出，
 * 但它的报错只有一句 "Invalid value"，看不出是哪个波段写错了。
 */
const COLOR_INTERP_BY_NAME: Readonly<Record<string, string>> = Object.freeze({
  undefined: 'undefined',
  gray: 'gray',
  palette: 'palette',
  red: 'red',
  green: 'green',
  blue: 'blue',
  alpha: 'alpha',
  hue: 'hue',
  saturation: 'saturation',
  lightness: 'lightness',
  cyan: 'cyan',
  magenta: 'magenta',
  yellow: 'yellow',
  black: 'black',
});

/**
 * 决定要传给 gdal_translate 的颜色解释。
 *
 * 为什么必须显式给：ENVI 中转**不带颜色解释**，窗口文件读回来是 Undefined，
 * 而原图是 Red/Green/Blue —— 两者异构时 gdalbuildvrt 会直接把那个窗口跳过，
 * 灰度 / RGB 影像于是整个不可用（实测）。
 *
 * 单波段还有个坑：`-colorinterp undefined` 在单波段上**不生效**（出来仍是 Gray），
 * 所以单波段只能显式给 gray，不能靠 undefined。
 *
 * 给了却对不上（个数与波段数不符、或名字不认识）一律报错：
 * 颜色解释错了必须当场炸掉 —— 默默按默认猜一个，等于把调用方的意图丢掉，
 * 窗口照样会被 gdalbuildvrt 跳过，而现场什么线索都没有。
 */
function resolveColorInterp(
  requested: readonly string[] | undefined,
  bandCount: number,
): string[] {
  // 没给（或给的是空数组）才按波段数猜：1 → gray、3 → rgb。
  // 猜出来的值必须是 GDAL 真正认的拼写，否则 gdal_translate 会直接失败。
  if (!requested || requested.length === 0) {
    return bandCount === 1 ? ['gray'] : (bandCount === 3 ? ['red', 'green', 'blue'] : []);
  }
  if (requested.length !== bandCount) {
    throw new Error(
      `颜色解释的个数（${requested.length}）与波段数（${bandCount}）对不上：` +
      `每个波段要一个颜色解释`,
    );
  }
  const out: string[] = [];
  for (const name of requested) {
    const key = name.trim().toLowerCase();
    const mapped = COLOR_INTERP_BY_NAME[key];
    if (!mapped) {
      throw new Error(
        `无法识别的颜色解释「${name}」：gdal_translate 只认 ` +
        `${Object.keys(COLOR_INTERP_BY_NAME).join(' / ')}`,
      );
    }
    out.push(mapped);
  }
  return out;
}

/** 把原始像素写成 GeoTIFF（保留仿射参数与坐标系） */
export async function writeRasterPixels(
  loc: GdalLocation,
  outAbsPath: string,
  pixels: {
    readonly width: number;
    readonly height: number;
    readonly bands: readonly PixelBand[];
    /** 像素类型：8 位还是 16 位。必须与 bands 的实际类型一致 */
    readonly pixelType: PixelType;
    /** 每个波段的颜色解释；缺省按波段数猜（1 → gray，3 → rgb） */
    readonly colorInterpretation?: readonly string[];
    readonly geotransform: readonly number[] | null;
    readonly crs: string | null;
  },
): Promise<void> {
  const gdal = tools(loc);
  const bandCount = pixels.bands.length;
  if (!bandCount) throw new Error('没有可写入的波段');

  // 类型标签与实际的带必须一致：声明 UInt16 而带其实是 Uint8Array 时，
  // 按 2 字节宽度写出去的是**错位的数据** —— 读回来是垃圾，而且全程不报错。
  for (const band of pixels.bands) {
    const actual = pixelTypeOf(band);
    if (actual !== pixels.pixelType) {
      throw new Error(`像素类型与像素带不一致：声明的是 ${pixels.pixelType}，实际拿到的是 ${actual}。`);
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'cartouche-write-'));
  const bin = join(tmp, 'out.bin');
  const hdr = join(tmp, 'out.hdr');

  // 写成 BIP（像元交错），并附 ENVI 头。
  // 裸数据按**类型对应的字节宽度**写：16 位就是 16 位交错。
  // 字节序用小端（byte order = 0），与 GDAL 自己写出来的 ENVI 一致。
  const bytesPerSample = BYTES_PER_SAMPLE[pixels.pixelType];
  const raw = new Uint8Array(pixels.width * pixels.height * bandCount * bytesPerSample);
  const view = new DataView(raw.buffer);
  for (let i = 0; i < pixels.width * pixels.height; i++) {
    for (let b = 0; b < bandCount; b++) {
      const v = clampSample(readSample(pixels.bands[b]!, i), pixels.pixelType);
      const off = (i * bandCount + b) * bytesPerSample;
      if (bytesPerSample === 2) view.setUint16(off, v, true);
      else raw[off] = v;
    }
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
      `data type = ${ENVI_WRITE_DATA_TYPE[pixels.pixelType]}`,
      'interleave = bip',
      'byte order = 0',
      '',
    ].join('\n'),
    'utf8',
  );

  // -ot 必须按类型给：这一步是整条链路最关键的一处 ——
  // ENVI 头就算写了 data type = 12，最后这一步 `-ot Byte` 也会把值压成 255
  // （退出码 0、stderr 空，实测 GDAL 3.13.3）。
  const args = ['-of', 'GTiff', '-ot', pixels.pixelType === 'UInt16' ? 'UInt16' : 'Byte'];
  // ENVI 中转不带颜色解释，窗口读回来会是 Undefined，
  // 与原图的 Red/Green/Blue 异构 -> gdalbuildvrt 直接跳过窗口。
  // -colorinterp 只能给一次，值用逗号分隔。
  const ci = resolveColorInterp(pixels.colorInterpretation, bandCount);
  if (ci.length) {
    args.push('-colorinterp', ci.join(','));
  }
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
  readonly bands: readonly PixelBand[];
  /** 像素类型：8 位还是 16 位 */
  readonly pixelType: PixelType;
  /** 窗口自身的仿射参数 */
  readonly geotransform: number[] | null;
  readonly crs: string | null;
  readonly checksum: string;
}

/** 整图的基本信息（尺寸 + 仿射参数）之外，再带上波段数与坐标系 */
export interface RasterFrameInfo extends RasterFrame {
  readonly bandCount: number;
  readonly crs: string | null;
  /** 像素类型：8 位还是 16 位 */
  readonly pixelType: PixelType;
  /** 每个波段的颜色解释（Red / Green / Blue / Gray / Undefined…） */
  readonly colorInterpretation: readonly string[];
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
    bands?: { type?: string; colorInterpretation?: string }[];
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
  // 源类型不认识就报错：窗口读按类型导出，类型判错会把 16 位静默压成 8 位
  const pixelType = pixelTypeFromGdal(info.bands?.[0]?.type);
  const colorInterpretation = (info.bands ?? []).map((b) => b.colorInterpretation ?? 'Undefined');
  return {
    width,
    height,
    bandCount,
    geotransform: [...info.geoTransform],
    crs: info.coordinateSystem?.wkt ?? null,
    pixelType,
    colorInterpretation,
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
  const ot = frame.pixelType === 'UInt16' ? 'UInt16' : 'Byte';
  const tr = await gdal.translate([
    '-of', 'ENVI', '-ot', ot,
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
    pixelType: frame.pixelType,
    geotransform: windowGeotransform(frame, win),
    crs: frame.crs,
    checksum: checksumOf(bands),
  };
}
