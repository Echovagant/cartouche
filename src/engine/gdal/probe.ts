/**
 * 数据集探查：把 GDAL 的输出归一化成引擎内部的数据集描述。
 *
 * 核心结论来自 实测：
 *  - GTiff 驱动**不会**自动读取同名 .prj 侧车（只认内嵌 GeoTIFF keys / .aux.xml）
 *  - 但同名 .tfw 世界文件会被自动关联并生效
 *  - Shapefile 驱动**会**读取同名 .prj
 * 所以"这个数据集有没有坐标系"必须以 GDAL 实际解析结果为准，不能看文件存不存在。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tools, type GdalTools } from './runner.ts';
import type { GdalLocation } from './env.ts';

export interface CrsInfo {
  readonly present: boolean;
  readonly wkt?: string;
  readonly epsg?: number;
  readonly authority?: string;
  readonly source: 'embedded' | 'sidecar' | 'none';
}

export interface RasterInfo {
  readonly kind: 'raster';
  readonly path: string;
  readonly driver: string;
  readonly width: number;
  readonly height: number;
  readonly bandCount: number;
  /**
   * 每个波段的类型（'Byte' / 'UInt16' …），拿不到时给 '未知'。
   *
   * 为什么要单独带：交差报告是给 GIS 同事看的，"有 3 个波段"说不清数值范围。
   * 8 位与 16 位的数值含义完全不同，对方必须一眼看出这张图是哪种位深。
   */
  readonly bandTypes: readonly string[];
  readonly crs: CrsInfo;
  readonly geotransform: number[] | null;
  readonly origin: [number, number] | null;
  readonly pixelSize: [number, number] | null;
  readonly nodata: number | null;
  /** 存在但 GDAL 未必会读的世界文件 */
  readonly sidecars: {
    readonly worldFile: string | null;
    readonly prj: string | null;
    readonly auxXml: string | null;
  };
}

export interface VectorFieldInfo {
  readonly name: string;
  readonly type: string;
}

export interface VectorInfo {
  readonly kind: 'vector';
  readonly path: string;
  readonly driver: string;
  readonly layerName: string;
  readonly featureCount: number;
  readonly crs: CrsInfo;
  readonly fields: VectorFieldInfo[];
  readonly geometryType: string | null;
  readonly encoding: string | null;
  readonly sidecars: {
    readonly prj: string | null;
    readonly cpg: string | null;
  };
}

export type DatasetInfo = RasterInfo | VectorInfo;

export interface ProbeError {
  readonly message: string;
  readonly raw: string;
}

/** 找出同名伴随文件 */
function findSidecars(path: string): {
  worldFile: string | null;
  prj: string | null;
  auxXml: string | null;
  cpg: string | null;
} {
  const dir = dirname(path);
  const base = path.slice(dir.length + 1);
  const stem = base.replace(/\.[^.]+$/, '');
  const tryExt = (exts: string[]): string | null => {
    for (const ext of exts) {
      const p = join(dir, `${stem}${ext}`);
      if (existsSync(p)) return p;
    }
    return null;
  };
  return {
    worldFile: tryExt(['.tfw', '.wld', '.tifw', '.jgw']),
    prj: tryExt(['.prj']),
    auxXml: tryExt(['.aux.xml']),
    cpg: tryExt(['.cpg']),
  };
}

/**
 * 判断这个数据集的坐标是不是**经纬度**（4326 口径）。
 *
 * 为什么需要这个判断：出图时引擎把栅格重投影到 4326，而 geotransform
 * 始终是**源坐标系**的。两边不在同一个空间时，前端拿着经纬度去按
 * geotransform 反算原生像元，位置一定是错的 —— 而且错得很像对的。
 *
 * 判据按可靠性从高到低：
 *   1. EPSG 代码就是 4326；
 *   2. WKT 里认得出 WGS 84（WKT1 的 GEOGCS["WGS 84"]、WKT2 的 GEOGCRS["WGS 84"]、
 *      以及 "WGS_1984" 这类别名）；
 *   3. **完全没有 CRS**：这时看 geotransform 说话 —— 像元步长是"度"量级
 *      （小于 1）且原点落在经纬度范围内，就按 4326 处理。
 *
 * 第 3 条是启发式，但它和引擎出图时的约定一致（无投影就当 4326 用），
 * 而且这类文件本来就会被体检规则 V-RCS 判为"缺坐标系"的阻断项 ——
 * 宁可在这里按 4326 给出可用的编辑能力，也不能让工具直接瘫掉。
 */
export function isLongitudeLatitude(crs: CrsInfo, geotransform: readonly number[] | null): boolean {
  if (crs.epsg === 4326) return true;
  if (crs.authority && /^EPSG:4326$/i.test(crs.authority)) return true;
  if (crs.wkt && /WGS[ _]?84|WGS_1984/i.test(crs.wkt)) return true;

  if (crs.present) return false; // 有 CRS 但不是 4326 → 不能按经纬度换算

  // 没有 CRS：按 geotransform 的形状推断
  if (!geotransform) return false;
  const [ox, pw, , oy] = geotransform;
  if (ox === undefined || pw === undefined || oy === undefined) return false;
  if (!Number.isFinite(ox) || !Number.isFinite(pw) || !Number.isFinite(oy)) return false;
  if (Math.abs(pw) >= 1) return false; // 像元有 1 度那么大？那不是经纬度口径
  return ox >= -180 && ox <= 180 && oy >= -90 && oy <= 90;
}

function parseCrs(raw: unknown, source: CrsInfo['source']): CrsInfo {
  if (!raw || typeof raw !== 'object') return { present: false, source: 'none' };
  const obj = raw as Record<string, unknown>;
  const wkt = typeof obj.wkt === 'string' ? obj.wkt : undefined;
  const id = typeof obj.id === 'string' ? obj.id : undefined;
  if (!wkt && !id) return { present: false, source: 'none' };
  const epsgMatch = id?.match(/^EPSG:(\d+)$/);
  return {
    present: true,
    ...(wkt ? { wkt } : {}),
    ...(epsgMatch ? { epsg: Number(epsgMatch[1]) } : {}),
    ...(id ? { authority: id } : {}),
    source,
  };
}

/** 探查一个数据集，先按栅格试，失败再按矢量试。 */
export async function probeDataset(
  loc: GdalLocation,
  path: string,
): Promise<{ dataset: DatasetInfo | null; error: ProbeError | null }> {
  const gdal = tools(loc);
  const sidecars = findSidecars(path);

  const info = await gdal.info(path, ['-json']);
  if (info.ok) {
    try {
      const j = JSON.parse(info.stdout) as Record<string, unknown>;
      const size = (j.size as [number, number] | undefined) ?? [0, 0];
      const bands = Array.isArray(j.bands) ? (j.bands as unknown[]) : [];
      const crs = parseCrs(j.coordinateSystem, 'embedded');
      const gt = Array.isArray(j.geoTransform) ? (j.geoTransform as number[]) : null;
      const nodataRaw = (bands[0] as Record<string, unknown> | undefined)?.noDataValue;
      const nodata = typeof nodataRaw === 'number' ? nodataRaw : null;
      // 波段类型来自 gdalinfo -json 的 bands[].type（'Byte' / 'UInt16' …）。
      // 取不到就写「未知」：猜一个类型比不写更危险 —— 报告会把猜错的值照抄给 GIS 同事。
      const bandTypes = bands.map((b) => {
        const t = (b as Record<string, unknown> | undefined)?.type;
        return typeof t === 'string' && t.length > 0 ? t : '未知';
      });
      return {
        dataset: {
          kind: 'raster',
          path,
          driver: String(j.driverShortName ?? 'GTiff'),
          width: size[0],
          height: size[1],
          bandCount: bands.length,
          bandTypes,
          crs,
          geotransform: gt,
          origin: gt && gt.length >= 6 ? [gt[0] ?? 0, gt[3] ?? 0] : null,
          pixelSize: gt && gt.length >= 6 ? [gt[1] ?? 0, gt[5] ?? 0] : null,
          nodata,
          sidecars: {
            worldFile: sidecars.worldFile,
            prj: sidecars.prj,
            auxXml: sidecars.auxXml,
          },
        },
        error: null,
      };
    } catch {
      // JSON 解析失败 → 走文本解析兜底
    }
  }

  const ogr = await gdal.ogrInfo(['-json', '-so', '-al', path]);
  if (ogr.ok) {
    try {
      const j = JSON.parse(ogr.stdout) as Record<string, unknown>;
      const layers = Array.isArray(j.layers) ? (j.layers as Record<string, unknown>[]) : [];
      const layer = layers[0];
      if (layer) {
        const fields = Array.isArray(layer.fields)
          ? (layer.fields as Record<string, unknown>[]).map((f) => ({
              name: String(f.name ?? ''),
              type: String(f.type ?? ''),
            }))
          : [];
        const geomFields = Array.isArray(layer.geometryFields)
          ? (layer.geometryFields as Record<string, unknown>[])
          : [];
        const crs = parseCrs(
          layer.spatialRef ?? geomFields[0]?.coordinateSystem,
          sidecars.prj ? 'sidecar' : 'embedded',
        );
        return {
          dataset: {
            kind: 'vector',
            path,
            driver: String(j.driverShortName ?? 'ESRI Shapefile'),
            layerName: String(layer.name ?? ''),
            featureCount: Number(layer.featureCount ?? 0),
            crs,
            fields,
            geometryType: geomFields[0] ? String(geomFields[0].type ?? '') : null,
            encoding: sidecars.cpg ? await readCpg(sidecars.cpg) : null,
            sidecars: { prj: sidecars.prj, cpg: sidecars.cpg },
          },
          error: null,
        };
      }
    } catch {
      // 落到错误处理
    }
  }

  return {
    dataset: null,
    error: {
      message: '无法读取该数据集（GDAL 未识别其格式，或文件被占用）',
      raw: `${info.stderr}\n${info.stdout}\n${ogr.stderr}`.trim(),
    },
  };
}

async function readCpg(path: string): Promise<string | null> {
  try {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(path, 'utf8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** 读取驱动清单，判断某个格式是否可写 */
export async function listDrivers(loc: GdalLocation): Promise<{ name: string; readWrite: boolean }[]> {
  const gdal = tools(loc);
  const res = await gdal.ogrInfo(['--formats']);
  const out: { name: string; readWrite: boolean }[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s+-\s+(raster|vector)?\s*-\s*\(([^)]*)\)/);
    if (!m || !m[1] || !m[3]) continue;
    out.push({ name: m[1], readWrite: m[3].includes('w') });
  }
  return out;
}
