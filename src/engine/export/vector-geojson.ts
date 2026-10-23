/**
 * 矢量 → GeoJSON（供前端 MapLibre 直接消费）。
 *
 * 用 ogr2ogr 在**内存与磁盘之间**转换：先落到临时文件再读回来。
 * （GDAL 没有"输出到 stdout"的干净选项，和 ENVI 读像素时遇到的是同一类限制。）
 */
import { join } from 'node:path';
import { tools, type GdalTools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';

export interface VectorToGeoJsonOptions {
  /** 矢量文件绝对路径 */
  readonly path: string;
  /** 目标坐标系；默认与源一致（MapLibre 用 EPSG:4326） */
  readonly targetCrs?: string;
  /** 只出这几个字段；不给就全部 */
  readonly fields?: readonly string[];
  /** 要素数上限，防止一次性吐太多 */
  readonly limit?: number;
}

export interface VectorToGeoJsonResult {
  readonly geojson: unknown;
  readonly featureCount: number;
  readonly truncated: boolean;
}

export class VectorConvertError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'VectorConvertError';
    this.stderr = stderr;
  }
}

/**
 * 把矢量转成 GeoJSON 对象。
 */
export async function vectorToGeoJson(
  loc: GdalLocation,
  options: VectorToGeoJsonOptions,
): Promise<VectorToGeoJsonResult> {
  const gdal: GdalTools = tools(loc);
  const { mkdtempSync, readFileSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const outDir = mkdtempSync(join(tmpdir(), 'cartouche-geojson-'));
  const out = join(outDir, 'out.geojson');

  const args: string[] = ['-f', 'GeoJSON'];
  if (options.targetCrs) args.push('-t_srs', options.targetCrs);
  // ⚠️ `-select` 只能给**一次**（逗号分隔多个字段）：
  //    重复给 GDAL 会报 `Duplicate argument -select`，多列时整个转换失败。
  //    （2026-10-23 实测；本仓库的矢量读写层也踩过同一个坑。）
  if (options.fields && options.fields.length > 0) {
    args.push('-select', options.fields.join(','));
  }
  if (options.limit !== undefined && options.limit > 0) args.push('-limit', String(options.limit));
  // ⚠️ ogr2ogr 的参数顺序是 **dst 在前、src 在后**（与 ogrinfo 相反）。
  //    写反了会把目标当成数据源去打开，报 "Unable to open datasource <目标>"。
  args.push(out, options.path);

  const res = await gdal.ogr2ogr(args);
  if (!res.ok) {
    rmSync(outDir, { recursive: true, force: true });
    throw new VectorConvertError(`矢量转 GeoJSON 失败：${options.path}`, res.stderr);
  }
  if (!existsSync(out)) {
    rmSync(outDir, { recursive: true, force: true });
    throw new VectorConvertError(`转换命令成功但没有产出文件：${options.path}`, res.stderr);
  }

  const raw = readFileSync(out, 'utf8');
  rmSync(outDir, { recursive: true, force: true });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VectorConvertError(`产出的 GeoJSON 不是合法 JSON：${options.path}`, raw.slice(0, 200));
  }

  const featureCount = Array.isArray((parsed as { features?: unknown[] }).features)
    ? (parsed as { features: unknown[] }).features.length
    : 0;

  return {
    geojson: parsed,
    featureCount,
    truncated: options.limit !== undefined && options.limit > 0 && featureCount >= options.limit,
  };
}
