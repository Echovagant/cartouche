/**
 * 跨图层比较：坐标系是否一致、范围是否对得上、有没有整体平移。
 *
 * 这一族检查都需要一个**参照层**（契约里的 `reference` 参数）。
 * 没有参照层时，结论只能是「没查」—— 不能拿单层数据自己跟自己比，
 * 那报出来的「一致」是自说自话。
 */
import { tools } from '../gdal/runner.ts';
import { probeDataset, type CrsInfo, type DatasetInfo } from '../gdal/probe.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { CheckStatus, Finding } from './types.ts';
import type { Extent } from './scope.ts';

export interface ReferenceLayer {
  readonly path: string;
  readonly kind: 'raster' | 'vector';
  readonly layerName: string;
  readonly crs: CrsInfo;
  /** 范围（源坐标系下的 minX, minY, maxX, maxY） */
  readonly extent: Extent | null;
  readonly featureCount: number;
}

/** 两个坐标系是不是同一个 */
export function sameCrs(a: CrsInfo, b: CrsInfo): boolean {
  if (a.epsg !== undefined && b.epsg !== undefined) return a.epsg === b.epsg;
  if (a.wkt && b.wkt) return normalizeWkt(a.wkt) === normalizeWkt(b.wkt);
  return false;
}

/** WKT 归一：去掉空白与大小写差异（同一套坐标系的两种写法要判成同一个） */
function normalizeWkt(wkt: string): string {
  return wkt.replace(/\s+/g, '').toUpperCase();
}

/** 给人看的坐标系名字 */
export function crsLabelOf(crs: CrsInfo): string {
  if (!crs.present) return '无坐标系';
  if (crs.epsg !== undefined) return `EPSG:${crs.epsg}`;
  if (crs.authority) return crs.authority;
  return '自定义坐标系';
}

/**
 * 读参照层：坐标系、范围、要素数。
 *
 * 矢量范围取自 ogrinfo 的图层 extent（比逐要素算更准，不受扫描上限影响）；
 * 栅格范围由仿射参数推出。
 */
export async function loadReferenceLayer(
  loc: GdalLocation,
  path: string,
): Promise<{ layer: ReferenceLayer | null; error?: string }> {
  const { dataset, error } = await probeDataset(loc, path);
  if (!dataset) {
    return { layer: null, error: error?.message ?? '参照层打不开' };
  }
  const extent = await readExtent(loc, dataset);
  return {
    layer: {
      path,
      kind: dataset.kind,
      layerName: dataset.kind === 'vector' ? dataset.layerName : path,
      crs: dataset.crs,
      extent,
      featureCount: dataset.kind === 'vector' ? dataset.featureCount : 0,
    },
  };
}

async function readExtent(loc: GdalLocation, dataset: DatasetInfo): Promise<Extent | null> {
  if (dataset.kind === 'raster') {
    const { origin, pixelSize, width, height } = dataset;
    if (!origin || !pixelSize) return null;
    const x2 = origin[0] + pixelSize[0] * width;
    const y2 = origin[1] + pixelSize[1] * height;
    return [
      Math.min(origin[0], x2),
      Math.min(origin[1], y2),
      Math.max(origin[0], x2),
      Math.max(origin[1], y2),
    ];
  }
  const gdal = tools(loc);
  const res = await gdal.ogrInfo(['-json', '-so', '-al', dataset.path]);
  if (!res.ok) return null;
  try {
    const j = JSON.parse(res.stdout) as {
      layers?: {
        extent?: unknown;
        geometryFields?: { extent?: unknown }[];
      }[];
    };
    const layer = j.layers?.[0];
    if (!layer) return null;
    // ogrinfo 的 JSON 把范围放在**几何字段**里（geometryFields[0].extent），
    // 不在图层对象上；两处都试一遍，兼容不同 GDAL 版本的摆法。
    const ext = layer.geometryFields?.[0]?.extent ?? layer.extent;
    if (!Array.isArray(ext) || ext.length < 4) return null;
    const nums = ext.map((v) => Number(v));
    if (!nums.every((v) => Number.isFinite(v))) return null;
    return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
  } catch {
    return null;
  }
}

/* ───────────────────── 三条跨图层规则 ───────────────────── */

/**
 * V-CRS-002 坐标系与参照层不一致。
 *
 * 这是典型的**静默错误**：两层的坐标系不同却直接叠加，出来的图看着有东西，
 * 但位置全是错的；面积、长度也都算在不同的单位里。
 */
export function checkCrsMismatch(
  target: CrsInfo,
  reference: ReferenceLayer,
): { finding?: Finding; status: CheckStatus; reason?: string } {
  if (!target.present) {
    return { status: 'skipped', reason: '本图层没有坐标系，无法与参照层比较（缺坐标系的问题见 V-CRS-001）' };
  }
  if (!reference.crs.present) {
    return { status: 'skipped', reason: '参照层没有坐标系，无法比较' };
  }
  if (sameCrs(target, reference.crs)) {
    return { status: 'checked' };
  }
  return {
    status: 'checked',
    finding: {
      ruleId: 'V-CRS-002',
      severity: 'error',
      title: '与参照层的坐标系不一致',
      detail:
        `本图层是 ${crsLabelOf(target)}，参照层是 ${crsLabelOf(reference.crs)}。` +
        '两层的坐标不在同一个空间里，直接叠加、裁切、按位置关联的结果都是错的，' +
        '而界面上看不出来。',
      hint: '先用"重投影"把本图层转到参照层的坐标系，再做叠加或空间连接。',
    },
  };
}

/**
 * V-EXT-002 图层范围与参照层范围不重叠。
 *
 * 范围不重叠通常是上一条（坐标系不一致）的下游症状，
 * 但也可能只是两批数据根本不在一个地方 —— 所以措辞是「请确认」，不是「你错了」。
 */
export function checkExtentCompare(
  targetExtent: Extent | null,
  reference: ReferenceLayer,
): { finding?: Finding; status: CheckStatus; reason?: string } {
  if (!targetExtent) {
    return { status: 'skipped', reason: '本图层没有可用的范围（没有要素几何）' };
  }
  if (!reference.extent) {
    return { status: 'skipped', reason: '参照层的范围读不到，无法比较' };
  }
  const [aMinX, aMinY, aMaxX, aMaxY] = targetExtent;
  const [bMinX, bMinY, bMaxX, bMaxY] = reference.extent;
  const overlap =
    aMinX <= bMaxX && bMinX <= aMaxX && aMinY <= bMaxY && bMinY <= aMaxY;
  if (overlap) return { status: 'checked' };
  return {
    status: 'checked',
    finding: {
      ruleId: 'V-EXT-002',
      severity: 'warn',
      title: '与参照层的范围没有重叠',
      detail:
        `本图层范围 (${fmtNum(aMinX)}, ${fmtNum(aMinY)}) ~ (${fmtNum(aMaxX)}, ${fmtNum(aMaxY)})，` +
        `参照层范围 (${fmtNum(bMinX)}, ${fmtNum(bMinY)}) ~ (${fmtNum(bMaxX)}, ${fmtNum(bMaxY)})，两者不相交。`,
      hint: '若这两层本该在同一处，请先核对坐标系与数据来源；确实不在同一处属正常。',
    },
  };
}

/**
 * V-CRS-006 与参照层存在系统性偏移。
 *
 * 判据刻意收得很窄：**两层的范围大小几乎相同，但中心差了很远**。
 * 只有这种「形状一样、位置不同」才是整体平移的特征；
 * 两层大小不同只是覆盖范围不同，那是正常的数据差异，不能报成偏移。
 */
export function checkSystematicOffset(
  targetExtent: Extent | null,
  targetCrs: CrsInfo,
  reference: ReferenceLayer,
): { finding?: Finding; status: CheckStatus; reason?: string } {
  if (!targetExtent) {
    return { status: 'skipped', reason: '本图层没有可用的范围（没有要素几何）' };
  }
  if (!reference.extent) {
    return { status: 'skipped', reason: '参照层的范围读不到，无法比较' };
  }
  if (!targetCrs.present || !reference.crs.present) {
    return { status: 'skipped', reason: '有一侧缺坐标系，偏移量没有意义' };
  }
  if (!sameCrs(targetCrs, reference.crs)) {
    return { status: 'skipped', reason: '两层坐标系不同，偏移量没有意义（坐标系不一致见 V-CRS-002）' };
  }
  const [aMinX, aMinY, aMaxX, aMaxY] = targetExtent;
  const [bMinX, bMinY, bMaxX, bMaxY] = reference.extent;
  const sizeA = Math.max(aMaxX - aMinX, aMaxY - aMinY);
  const sizeB = Math.max(bMaxX - bMinX, bMaxY - bMinY);
  const span = Math.max(sizeA, sizeB);
  if (span <= 0) return { status: 'skipped', reason: '图层范围退化，无法判断偏移' };
  // 大小差异超过 2% → 这是两批不同范围的数据，不是同一份数据的平移
  if (Math.abs(sizeA - sizeB) / span > 0.02) {
    return { status: 'checked' };
  }
  const dx = (aMinX + aMaxX) / 2 - (bMinX + bMaxX) / 2;
  const dy = (aMinY + aMaxY) / 2 - (bMinY + bMaxY) / 2;
  const offset = Math.hypot(dx, dy);
  if (offset / span < 0.01) return { status: 'checked' };
  return {
    status: 'checked',
    finding: {
      ruleId: 'V-CRS-006',
      severity: 'warn',
      title: '与参照层存在系统性偏移',
      detail:
        `两层范围大小几乎相同（相差不到 2%），但中心相差 ${fmtNum(offset)}` +
        `（x 方向 ${fmtNum(dx)}，y 方向 ${fmtNum(dy)}，单位与坐标系一致）。` +
        '这种「形状一样、位置不同」是整体平移的特征。',
      hint: '若这两层本应是同一份数据，说明叠加时用错了坐标系或参数里带了平移量；请核对后再叠加。',
    },
  };
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.abs(n) >= 1e-4 && Math.abs(n) < 1e9 ? String(Math.round(n * 1e4) / 1e4) : n.toExponential(3);
}
