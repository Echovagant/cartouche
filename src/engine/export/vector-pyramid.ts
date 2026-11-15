/**
 * 矢量视口金字塔（分块加载工程第二阶段）。
 *
 * 为什么要有它：视口裁剪（-clipdst，第一阶段）救了「打不开」，救不了「每次都要
 * 全量解析」—— 对原始大文件做 -clipdst，无论视口多小都要把**整个文件**解析一遍，
 * 几何病态的数据一次要分钟级（vector-geojson.ts 顶部的性能边界注释）。
 * 金字塔把这份代价变成**一次性预付**：按数据集预建粗/中/细三级简化缓存，
 * 此后每次视口加载都从小缓存文件里裁 —— 毫秒级。
 *
 * 简化用 ogr2ogr -simplify（GEOS），容差按**数据范围对角线**的比例定 ——
 * 同一比例在不同尺度的数据上含义自洽：
 *   coarse = diag/1024（z ≤ 7，洲/国家级视野）
 *   mid    = diag/8192（z 8~11，城市级视野）
 *   fine   = diag/32768（z ≥ 12，街区级视野）
 * 每级都先换算到 EPSG:4326 再简化，容差单位就是度。
 *
 * 缓存位置：**数据文件旁边**的 `.cartouche/pyramid/`（工具状态；.cartouche
 * 已被 fs/list 与前端加载路径双重隐藏，项目文件夹整体拷走缓存跟着走）。
 * 缓存键 = 绝对路径 + mtime + size 的 sha1 —— 源数据一变键就变，
 * 陈旧缓存自然失联（不会被读出来），留着也只占磁盘不碍事。
 *
 * 什么数据建金字塔没意义（levels 返回空，调用方退回原始裁剪，不报错）：
 *   - 源文件本来就不大（< 12MB）：裁剪本身已经够快；
 *   - 多图层容器：GeoJSON 输出驱动是单图层的，逐层建缓存是第二阶段的后续；
 *   - 点层 / 本就稀疏的数据：-simplify 不减重，级与级大小趋同，纯浪费磁盘。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { tools, type GdalTools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';
import { probeLayer } from '../vector/read.ts';
import { datasetExtent } from './dataset-extent.ts';

export type PyramidLevelName = 'coarse' | 'mid' | 'fine';

export interface PyramidLevel {
  readonly name: PyramidLevelName;
  /** 简化容差（度，EPSG:4326 单位） */
  readonly tolerance: number;
  readonly bytes: number;
  /** 该级简化后的顶点总数（与源比、与相邻级比才知道有没有真的减重） */
  readonly vertices: number;
  /** 该级适用的最高 zoom；fine 为 Infinity（任何更高级别都用它兜底） */
  readonly zoomMax: number;
}

export interface PyramidBuildResult {
  readonly hash: string;
  readonly dir: string;
  readonly levels: readonly PyramidLevel[];
  /** levels 为空时的说明（为什么没建成 / 建了没意义） */
  readonly note?: string;
  /** true = 缓存已存在，本次没有重新构建 */
  readonly cached?: boolean;
}

export interface PyramidInfo {
  readonly hash: string;
  readonly dir: string;
  readonly levels: readonly PyramidLevel[];
}

/** 容差档位：diag 除数与适用 zoom 上限（从粗到细） */
const TIERS: ReadonlyArray<{ name: PyramidLevelName; div: number; zoomMax: number }> = [
  { name: 'coarse', div: 1024, zoomMax: 7 },
  { name: 'mid', div: 8192, zoomMax: 11 },
  { name: 'fine', div: 32768, zoomMax: Number.POSITIVE_INFINITY },
];

/** 源小于这个体积就不值得建金字塔（裁剪本身毫秒级） */
const MIN_PYRAMID_BYTES = 12 * 1024 * 1024;
/** 单级缓存的上限：金字塔是为了「小而快」，太大反而失去意义（128MB 闸之下留余量） */
const MAX_LEVEL_BYTES = 96 * 1024 * 1024;
/** 简化后的级顶点数不比基准小 15% 以上 = 这一级没减重（点层/稀疏数据） */
const LEVEL_USELESS_RATIO = 0.85;
/** 超过这个体积就不整读源数顶点（内存代价太大），改用级间对比做减重判定 */
const VERTEX_BASELINE_MAX_BYTES = 160 * 1024 * 1024;

/** 数一份要素集里的坐标总数（所有几何类型，嵌套展平） */
function countVertices(features: readonly unknown[]): number {
  let n = 0;
  const walk = (geom: unknown): void => {
    if (geom == null || typeof geom !== 'object') return;
    const g = geom as { type?: string; coordinates?: unknown; geometries?: unknown[] };
    switch (g.type) {
      case 'Point':
        n += 1;
        break;
      case 'LineString':
      case 'MultiPoint':
        n += Array.isArray(g.coordinates) ? g.coordinates.length : 0;
        break;
      case 'Polygon':
      case 'MultiLineString':
        if (Array.isArray(g.coordinates)) {
          for (const ring of g.coordinates as unknown[][]) n += ring.length;
        }
        break;
      case 'MultiPolygon':
        if (Array.isArray(g.coordinates)) {
          for (const poly of g.coordinates as unknown[][]) {
            for (const ring of poly as unknown[][]) n += ring.length;
          }
        }
        break;
      case 'GeometryCollection':
        for (const sub of g.geometries ?? []) walk(sub);
        break;
    }
  };
  for (const feature of features) {
    walk((feature as { geometry?: unknown })?.geometry);
  }
  return n;
}

/** 缓存目录：<数据文件所在目录>/.cartouche/pyramid */
function pyramidDirFor(absPath: string): string {
  return join(dirname(absPath), '.cartouche', 'pyramid');
}

/** 缓存键：绝对路径 + mtime + size —— 源一变键就变，陈旧缓存自然失联 */
function hashOf(absPath: string): string {
  const stat = statSync(absPath);
  return createHash('sha1')
    .update(`${absPath}\u0000${stat.mtimeMs}\u0000${stat.size}`)
    .digest('hex');
}

/**
 * 查现成的金字塔缓存。没有 / 键不匹配（源已变更）/ 文件缺了 → null 或剔除残级。
 * 不做任何转换，纯读 —— geojson 路由每个视口请求都会调它，必须便宜。
 */
export function findPyramid(absPath: string): PyramidInfo | null {
  const dir = pyramidDirFor(absPath);
  let hash: string;
  try {
    hash = hashOf(absPath);
  } catch {
    return null; // 源文件都没了
  }
  const manifestPath = join(dir, `${hash}.json`);
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      hash?: string;
      levels?: PyramidLevel[];
    };
    if (parsed.hash !== hash || !Array.isArray(parsed.levels)) return null;
    const levels = parsed.levels.filter(
      (l) => l != null && typeof l.name === 'string' && existsSync(join(dir, `${hash}-${l.name}.geojson`)),
    );
    return { hash, dir, levels };
  } catch {
    return null;
  }
}

/** 按 zoom 选级：从粗到细找第一个 zoom ≤ zoomMax 的级；没有返回 null（走原始裁剪） */
export function pyramidLevelForZoom(
  levels: readonly PyramidLevel[],
  zoom: number,
): PyramidLevel | null {
  for (const level of levels) {
    if (zoom <= level.zoomMax) return level;
  }
  return null;
}

/** 正在构建的构建过程（按 hash 去重：同一个源的并发构建只跑一份） */
const inFlight = new Map<string, Promise<PyramidBuildResult>>();

/**
 * 建立金字塔（幂等）：已有缓存直接返回；正在构建的并发调用共享同一份过程。
 * 多图层容器与小文件返回空 levels —— 这是「没意义」而不是「失败」。
 */
export async function buildVectorPyramid(
  loc: GdalLocation,
  options: { path: string },
): Promise<PyramidBuildResult> {
  const absPath = options.path;
  const hash = hashOf(absPath);
  const dir = pyramidDirFor(absPath);
  const manifestPath = join(dir, `${hash}.json`);
  if (existsSync(manifestPath)) {
    const info = findPyramid(absPath);
    if (info) return { ...info, cached: true };
  }
  const pending = inFlight.get(hash);
  if (pending) return pending;
  const task = buildInternal(loc, absPath, hash, dir);
  inFlight.set(hash, task);
  try {
    return await task;
  } finally {
    inFlight.delete(hash);
  }
}

async function buildInternal(
  loc: GdalLocation,
  absPath: string,
  hash: string,
  dir: string,
): Promise<PyramidBuildResult> {
  const gdal: GdalTools = tools(loc);
  const rawBytes = statSync(absPath).size;
  if (rawBytes < MIN_PYRAMID_BYTES) {
    return {
      hash,
      dir,
      levels: [],
      note: `源文件 ${ (rawBytes / 1048576).toFixed(1) } MB，视口裁剪本身够快，无需金字塔`,
    };
  }

  // 多图层容器不建（GeoJSON 驱动单图层；逐层缓存留作后续）
  const info = await probeLayer(loc, absPath);
  if (info.layerNames.length > 1) {
    return {
      hash,
      dir,
      levels: [],
      note: `多图层容器（${info.layerNames.length} 层）暂不支持金字塔，视口加载仍走原始裁剪`,
    };
  }

  // 容差锚点：数据范围对角线（4326 度）
  let diag = 0;
  try {
    const ext = await datasetExtent(loc, { path: absPath });
    diag = Math.hypot(ext.bbox[2] - ext.bbox[0], ext.bbox[3] - ext.bbox[1]);
  } catch {
    diag = 0;
  }
  if (!(diag > 0)) {
    return { hash, dir, levels: [], note: '拿不到有效数据范围，无法定简化容差' };
  }

  const workDir = mkdtempSync(join(tmpdir(), 'cartouche-pyramid-'));

  // 顶点基线：**字节比不是可靠的减重信号** —— GeoJSON 输出器的浮点精度通常比源
  // 文件宽（源 6 位小数、输出可能 15 位），顶点删掉一半字节也不见小（实测教训：
  // 抖动折线 560k 顶点删到 537k，字节比仍有 0.96）。数顶点才数得清。
  // 源太大就不整读（内存代价 > 收益），退化成只看级间对比。
  let rawVertices: number | null = null;
  if (rawBytes <= VERTEX_BASELINE_MAX_BYTES) {
    try {
      const parsed = JSON.parse(readFileSync(absPath, 'utf8')) as { features?: unknown[] };
      rawVertices = countVertices(Array.isArray(parsed.features) ? parsed.features : []);
    } catch {
      rawVertices = null;
    }
  }

  try {
    mkdirSync(dir, { recursive: true });
    const levels: PyramidLevel[] = [];
    let prevVertices = rawVertices ?? Number.POSITIVE_INFINITY;
    for (const tier of TIERS) {
      const tolerance = diag / tier.div;
      const out = join(workDir, `${tier.name}.geojson`);
      const res = await gdal.ogr2ogr(
        ['-f', 'GeoJSON', '-t_srs', 'EPSG:4326', '-simplify', String(tolerance), out, absPath],
        { timeoutMs: 600_000 },
      );
      if (!res.ok || !existsSync(out)) continue;
      const bytes = statSync(out).size;
      if (bytes > MAX_LEVEL_BYTES) continue;
      // 病态几何简化后可能产出空集：空级不进金字塔
      let parsed: { features?: unknown[] };
      try {
        parsed = JSON.parse(readFileSync(out, 'utf8')) as { features?: unknown[] };
      } catch {
        continue;
      }
      const features = Array.isArray(parsed.features) ? parsed.features : [];
      if (features.length === 0) continue;
      const vertices = countVertices(features);
      // 没意义的级不进金字塔：
      //   - 与**源**比（有基线时）：顶点没少 15% → 简化没用（点层/本就稀疏的源）；
      //   - 与**上一级**比：顶点几乎相等（±5% 内）→ 这一级没提供任何新细节，
      //     装它只是重复磁盘。细级顶点**天然比粗级多**（更有细节），那是好事；
      //     判据必须是「几乎没变」而不是「变多了」—— 2026-11-16 实测教训：
      //     第一版 ≥98% 规则把大线源的 mid/fine 全误杀（62k vs 20k 也算"变多"）。
      if (rawVertices !== null && vertices > rawVertices * LEVEL_USELESS_RATIO) continue;
      const nearlySame = vertices >= prevVertices * 0.95 && vertices <= prevVertices * 1.05;
      if (nearlySame) continue;
      writeFileSync(join(dir, `${hash}-${tier.name}.geojson`), readFileSync(out));
      prevVertices = vertices;
      levels.push({ name: tier.name, tolerance, bytes, vertices, zoomMax: tier.zoomMax });
    }

    // 即使空也要写 manifest：没意义的源每次重建是分钟级浪费，写下来即短路
    writeFileSync(
      join(dir, `${hash}.json`),
      JSON.stringify(
        { path: absPath, hash, rawVertices, builtAt: new Date().toISOString(), levels },
        null,
        2,
      ),
    );
    return {
      hash,
      dir,
      levels,
      ...(levels.length === 0
        ? { note: '简化后没有更小的层级（点层或稀疏数据），视口加载走原始裁剪' }
        : {}),
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
