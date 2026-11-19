/**
 * 矢量整层重写的体积保护。
 *
 * 字段改名、重编码、按条件改属性、删要素、空间连接、重投影这些写操作，
 * 实现上都是「整层要素读进内存 → 改 → 整层写回」。数据到 GB 级时，
 * 读这一半就会撞 GDAL 超时甚至耗尽内存，用户点完确认只能白等几分钟。
 *
 * 例外：GeoPackage / Shapefile 的字段改名改的是元数据（SQLite 改列 /
 * 只改 .dbf 头，见 stream-rename.ts），不读要素，因此不受这里的上限约束。
 *
 * 所以超过阈值一律**当场拒绝**并给出下一步：先拆分或导出，再改小文件。
 * 阈值与按需瓦片的分界一致（512 MB）：再大就不是"桌面内存里改一改"的量级。
 *
 * 目录型数据源（FileGDB）拿不到单个文件体积，不做拦截 —— 宁可让真实错误
 * 带着原因出来，也不因为"量不出来"就误伤。
 */
import { statSync } from 'node:fs';
import { VectorError } from './types.ts';

/** 整层重写的体积上限（字节） */
export const MAX_REWRITE_BYTES = 512 * 1024 * 1024;

/** 体积超限时的说明；没超返回 null（纯函数，便于测试） */
export function rewriteSizeError(size: number, action = '整层重写'): string | null {
  if (!Number.isFinite(size) || size <= MAX_REWRITE_BYTES) return null;
  const sizeText =
    size >= 1073741824 ? `${(size / 1073741824).toFixed(1)} GB` : `${Math.round(size / 1048576)} MB`;
  return `图层有 ${sizeText}，超过 512 MB 的${action}暂不支持；请先拆分或导出后再处理。`;
}

/** 文件体积（字节）；拿不到或者不是普通文件（目录型数据源等）返回 null */
export function fileSizeBytes(absPath: string): number | null {
  try {
    const st = statSync(absPath);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * 图层的实际体量。
 *
 * Shapefile 的几何与属性分在 .shp / .dbf 两个文件里：只看 .shp 会漏掉
 * 「几何不大、属性表巨大」的图层，而整层读写恰恰会被这种图层拖垮。
 * GeoPackage 的 -wal 里也可能压着大量还没并回主库的页，一并算进去。
 */
export function layerSizeBytes(absPath: string): number | null {
  const own = fileSizeBytes(absPath);
  if (/\.shp$/i.test(absPath)) {
    const dbf = fileSizeBytes(absPath.replace(/\.shp$/i, '.dbf'));
    if (own === null) return dbf;
    if (dbf === null) return own;
    return Math.max(own, dbf);
  }
  if (/\.gpkg$/i.test(absPath)) {
    const wal = fileSizeBytes(`${absPath}-wal`);
    if (own === null) return wal;
    if (wal === null) return own;
    return own + wal;
  }
  return own;
}

/** 体积超限就抛错；拿不到体积（目录型数据源等）不拦 */
export function assertRewriteSize(absPath: string, action = '整层重写'): void {
  const size = layerSizeBytes(absPath);
  if (size === null) return;
  const error = rewriteSizeError(size, action);
  if (error) throw new VectorError(error);
}
