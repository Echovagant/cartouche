/**
 * 坐标系的识别、比较与"本机认不认得"。
 *
 * 为什么单独一个文件：重投影 op 要判断三件事 —— 目标 CRS 能不能被本机解析、
 * 它与源 CRS 是不是同一个、对齐图层的 CRS 是不是就是目标 CRS。
 * 这三件事的判断口径必须一致：两处各判一次就会出现
 * 「这边说能转、那边说转不了」。
 */
import { runTool } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';
import { epsgOf } from './read.ts';

/** 一个坐标系的身份：能认出 EPSG 码就用码，认不出退回 WKT 逐字比。 */
export interface CrsIdentity {
  readonly epsg: number | null;
  readonly wkt: string | null;
}

/** 由 WKT 与已知的 EPSG 码归一出一个身份。 */
export function crsIdentity(wkt: string | null, epsg?: number | null): CrsIdentity {
  const code = epsg ?? (wkt ? epsgOf(wkt) : null);
  return { epsg: code ?? null, wkt: wkt ?? null };
}

/** 两个坐标系是不是同一个。 */
export function crsEqual(a: CrsIdentity, b: CrsIdentity): boolean {
  if (a.epsg !== null && b.epsg !== null) return a.epsg === b.epsg;
  if (!a.wkt || !b.wkt) return false;
  return normalizeWkt(a.wkt) === normalizeWkt(b.wkt);
}

/** WKT 归一：去掉空白与大小写差异（同一套坐标系的两种写法要判成同一个）。 */
export function normalizeWkt(wkt: string): string {
  return wkt.replace(/\s+/g, '').toUpperCase();
}

/** 给人看的坐标系名字。 */
export function crsLabel(identity: CrsIdentity): string {
  if (identity.epsg !== null) return `EPSG:${identity.epsg}`;
  if (identity.wkt) {
    const m = /^\s*(?:GEOGCS|PROJCS)\s*\[\s*"([^"]+)"/i.exec(identity.wkt);
    if (m) return `${m[1]}（自定义坐标系）`;
    return '自定义坐标系';
  }
  return '未知坐标系';
}

/**
 * 从 CRS 写法（"EPSG:4326" 或一整段 WKT）里认出身份。
 *
 * 只认 "EPSG:<数字>" 这一种简写；其余一律当成 WKT —— 猜错的后果是
 * 「按错误的坐标系去转，坐标全错」，所以宁可当成 WKT 交给 PROJ 判。
 */
export function crsIdentityFromSpec(spec: string): CrsIdentity {
  const trimmed = spec.trim();
  const m = /^EPSG:(\d+)$/i.exec(trimmed);
  if (m) return { epsg: Number(m[1]), wkt: null };
  return { epsg: epsgOf(trimmed), wkt: trimmed };
}

/** 本机对某个 CRS 写法的支持情况。 */
export type CrsSupport =
  /** PROJ 认得 */
  | 'ok'
  /** PROJ 明确认不出（crs not found 之类） */
  | 'unparsable'
  /** 判不了（这台机器上没装 projinfo 之类工具） */
  | 'unknown';

/**
 * 问 PROJ：这个 CRS 写法认不认得。
 *
 * 用 projinfo 而不是直接靠 ogr2ogr 报错，是为了让**错误发生在动手之前**：
 * 转换失败时 ogr2ogr 已经建出了半个输出文件，用户看到的是一堆残留。
 * 先探一次，认不出就当场报错，一个字节都不写。
 *
 * ⚠️ 工具不存在时（不是 PROJ 认不出）要区分开：execFile 报 ENOENT 时
 * stdout/stderr 都是空的，与「跑了但什么都没输出」长得一样，
 * 这里按"判不了"处理，让后续 ogr2ogr 的错误去兜底。
 */
export async function probeCrsSupport(loc: GdalLocation, spec: string): Promise<CrsSupport> {
  const res = await runTool(loc, `projinfo${loc.exeSuffix}`, [spec]);
  if (res.ok) return 'ok';
  if (res.stdout === '' && res.stderr === '') return 'unknown';
  return 'unparsable';
}

/**
 * 把 PROJ 的报错翻译成一句用户看得懂的话。
 *
 * 为什么需要翻译：GDAL 原话是 "PROJ: proj_create_from_database: crs not found: EPSG:0"，
 * 用户看不出是自己写错了还是软件缺东西。这里点名说是**这个坐标系本机解析不了**，
 * 并给出可替换的写法。
 */
export function explainCrsFailure(spec: string, stderr: string): string {
  const raw = `${stderr}`.trim();
  if (/crs not found|Failed to process SRS|Invalid projection|crs not found/i.test(raw)) {
    return (
      `坐标系「${spec}」本机的 PROJ 解析不了（找不到这个坐标系定义）。` +
      '换一个本机认识的写法，例如 EPSG:4490、EPSG:4547，或直接给一段完整的 WKT。'
    );
  }
  return `转换到坐标系「${spec}」失败：${raw || '（GDAL 没有给出原因）'}`;
}
