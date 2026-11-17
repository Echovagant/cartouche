/**
 * 栅格写回格式表：**按源格式写回**，而不是一律产出 GeoTIFF。
 *
 * 为什么要有这张表：以前写回统一走 `gdal_translate -of GTiff`，
 * 一个 HFA 的 .img 改完就会变成"扩展名还是 .img、字节却是 GeoTIFF"的坏文件 ——
 * ArcGIS 按 HFA 去解析，直接打不开。与其把文件改坏，不如当时就拒绝。
 *
 * 现在对能安全写回的格式按原驱动落盘，并把这套数据由哪些文件组成一并列清楚：
 * 栅格不是"一个文件"，AAIGrid 有 .prj、EHdr 有 .hdr/.prj、PNG 的坐标系在 .aux.xml 里 ——
 * 主文件换了、伴随文件没换，ArcGIS 打开时就会定位错位或坐标系丢失。
 *
 * 只收录**真实数据实测能往返**的格式；VRT 是虚拟菜谱，不在此列（它本身不含像素）。
 */
import { extname } from 'node:path';
import type { PixelType } from './pixels.ts';

/** 一种可写回的栅格格式。 */
export interface RasterWriteFormat {
  /** GDAL 驱动短名（`gdalinfo -json` 的 driverShortName） */
  readonly driver: string;
  /** `gdal_translate -of` 的取值 */
  readonly of: string;
  /** 该格式认可的扩展名（小写，含点） */
  readonly extensions: readonly string[];
  /** 是否只能单波段（AAIGrid 的硬限制） */
  readonly singleBand: boolean;
  /** 该格式能表示的像素类型；null = 本引擎支持的类型都能表示 */
  readonly pixelTypes: readonly PixelType[] | null;
  /** 能否表示带旋转的仿射参数（gt[2]/gt[4] ≠ 0） */
  readonly supportsRotation: boolean;
  /** gdaladdo 能否给它建外部金字塔（需要可更新能力） */
  readonly supportsOverviews: boolean;
  /**
   * 按**主名**（不含扩展名）派生的伴随文件后缀。
   *
   * 例：EHdr 的 `.hdr` 与 `.prj` 是 `base.bil` → `base.hdr` / `base.prj`。
   * 只列本格式自己的后缀 —— 混进别的格式的后缀会在同目录有同名数据时误删别人的文件。
   */
  readonly stemSuffixes: readonly string[];
  /** 按**完整文件名**派生的伴随文件后缀（如 `.aux.xml`、`.ovr`） */
  readonly fileSuffixes: readonly string[];
}

/**
 * 可写回的格式。
 *
 * 像素类型限制来自驱动本身：PNG 只有 8/16 位无符号（Float32 根本写不进去）；
 * AAIGrid 是单波段 ASCII 网格，多波段源必须明确拒绝而不是只写第一波段。
 */
const RASTER_WRITE_FORMATS: Readonly<Record<string, RasterWriteFormat>> = Object.freeze({
  GTiff: {
    driver: 'GTiff',
    of: 'GTiff',
    // .tff 是国内工程里常见的 GeoTIFF 别名扩展名，沿用既有支持
    extensions: ['.tif', '.tiff', '.tff'],
    singleBand: false,
    pixelTypes: null,
    supportsRotation: true,
    supportsOverviews: true,
    // GeoTIFF 沿用既有约定：写回只替换主文件，不动旁边已有的 .aux.xml/.ovr
    // （已有 .ovr 时 ensureOverviews 会报 already-exists，不重建）
    stemSuffixes: [],
    fileSuffixes: [],
  },
  HFA: {
    driver: 'HFA',
    of: 'HFA',
    extensions: ['.img'],
    singleBand: false,
    pixelTypes: null,
    supportsRotation: true,
    supportsOverviews: true,
    // Erdas 的金字塔还有旧式 .rrd/.aux，留在旁边会被当成新内容的金字塔
    stemSuffixes: ['.rrd', '.aux'],
    fileSuffixes: ['.aux.xml', '.ovr'],
  },
  AAIGrid: {
    driver: 'AAIGrid',
    of: 'AAIGrid',
    extensions: ['.asc'],
    singleBand: true,
    pixelTypes: null,
    // ASCII 网格头只有 xllcorner/yllcorner/cellsize，装不下旋转
    supportsRotation: false,
    // CreateCopy-only 驱动：gdaladdo 需要可更新访问，建不了外部金字塔
    supportsOverviews: false,
    stemSuffixes: ['.prj', '.stx'],
    fileSuffixes: ['.aux.xml', '.ovr'],
  },
  EHdr: {
    driver: 'EHdr',
    of: 'EHdr',
    extensions: ['.bil'],
    singleBand: false,
    pixelTypes: null,
    // ENVI 头没有旋转字段
    supportsRotation: false,
    supportsOverviews: false,
    // .hdr 是数据的一部分（没有它 .bil 只是一段裸字节），必须整组换
    stemSuffixes: ['.hdr', '.prj', '.rrd', '.aux', '.stx'],
    fileSuffixes: ['.aux.xml', '.ovr'],
  },
  PNG: {
    driver: 'PNG',
    of: 'PNG',
    extensions: ['.png'],
    singleBand: false,
    // PNG 规范只有 8/16 位无符号整数
    pixelTypes: ['Byte', 'UInt16'],
    supportsRotation: true,
    supportsOverviews: false,
    stemSuffixes: ['.pgw', '.wld', '.prj', '.stx'],
    fileSuffixes: ['.aux.xml', '.ovr'],
  },
});

/** 按驱动名取格式；不认识返回 null（由调用方给出明确错误）。 */
export function writeFormatForDriver(driver: string): RasterWriteFormat | null {
  return RASTER_WRITE_FORMATS[driver] ?? null;
}

/** 扩展名是否是这个格式认可的（`.tif` / `.tiff` 都算 GeoTIFF）。 */
export function extensionMatches(spec: RasterWriteFormat, path: string): boolean {
  return spec.extensions.includes(extname(path).toLowerCase());
}

/**
 * 这套数据在目标旁边可能存在的**全部文件**（工作区相对路径）。
 *
 * 只认本格式自己的命名规则：`base.tif` 的写回**不能**把 `base.prj` 算进来 ——
 * 那多半是同目录下 `base.shp` 的坐标系文件，删掉就是毁别人的数据。
 */
export function managedFilesOf(targetRel: string, spec: RasterWriteFormat): string[] {
  // 统一成正斜杠：HTTP 流程里出现过反斜杠路径（见 vector/write.ts 的同类注释）
  const norm = targetRel.split('\\').join('/');
  const dirRel = norm.slice(0, Math.max(0, norm.lastIndexOf('/')));
  const name = norm.slice(norm.lastIndexOf('/') + 1);
  const stem = name.replace(/\.[^.]+$/, '');
  const names = new Set<string>([name]);
  for (const suffix of spec.fileSuffixes) names.add(`${name}${suffix}`);
  for (const suffix of spec.stemSuffixes) names.add(`${stem}${suffix}`);
  return [...names].map((n) => (dirRel ? `${dirRel}/${n}` : n));
}

/** 仿射参数里有没有旋转项（AAIGrid / EHdr 装不下）。 */
export function hasRotation(gt: readonly number[] | null): boolean {
  if (!gt || gt.length < 6) return false;
  return Math.abs(gt[2] ?? 0) > 1e-12 || Math.abs(gt[4] ?? 0) > 1e-12;
}

/** 两个 nodata 值是否等价（null 表示没有 nodata）。 */
export function sameNodata(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Object.is(a, b) || Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * `-a_nodata` 的取值文本。
 *
 * NaN 是浮点栅格常见的 nodata，必须写成 `nan` 而不是当"没有 nodata"跳过 ——
 * 跳过的后果是空白区变成参与渲染的真实像元（实测 GDAL 3.13.3 认 `nan`）。
 */
export function nodataArgument(value: number): string {
  return Number.isNaN(value) ? 'nan' : String(value);
}
