/**
 * 大影像的金字塔（overviews）。
 *
 * 为什么要有这一层：几 GB 的影像没有金字塔，缩放显示时每帧都要把整幅
 * 缩下去，界面会卡到不可用。金字塔应该由工具在建链路上**自动**建好，
 * 而不是让用户知道"还得去建个金字塔"——用户不知道这件事，影像就是不可用。
 *
 * ⚠️ 关键约束：必须带 -ro。
 *   gdaladdo 不加 -ro 会**就地重写原文件**：几 GB 的文件重写一次要很久，
 *   而且违反"原文件只被我们明确改动"的底线。
 *   加 -ro 后金字塔写在**外部** .ovr 文件里（原文件名后面加 .ovr），
 *   原文件一个字节都不动。
 */
import { existsSync, statSync } from 'node:fs';
import { tools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';

/** 超过这个大小才值得建金字塔（建金字塔本身要花时间与磁盘） */
export const DEFAULT_OVERVIEW_THRESHOLD_BYTES = 200 * 1024 * 1024;

/** 没建金字塔的原因。调用方靠它区分"要不要提示用户"，所以不能合并成一种。 */
export type OverviewSkipReason = 'not-found' | 'below-threshold' | 'already-exists';

/** 建金字塔的结果 */
export interface OverviewResult {
  /** 是否真的建出了金字塔 */
  readonly built: boolean;
  /** 外部 .ovr 的路径；没建出来且没有现成的就是 null */
  readonly ovrPath: string | null;
}

/** 按需建金字塔的结果 */
export interface EnsureOverviewResult extends OverviewResult {
  /** 没建的原因；建了就是 undefined */
  readonly skippedReason?: OverviewSkipReason;
}

/** 外部金字塔的路径：原文件名后面加 .ovr（GDAL 的约定） */
export function overviewPathOf(absPath: string): string {
  return `${absPath}.ovr`;
}

/** 已经有没有外部金字塔 */
export async function hasOverviews(absPath: string): Promise<boolean> {
  return existsSync(overviewPathOf(absPath));
}

/**
 * 强制建金字塔。
 *
 * 失败必须抛错：静默返回"没建成"，调用方就会拿着一张没有金字塔的影像
 * 继续走，症状会漂移到很远的地方（界面卡），那时已经查不出根因了。
 */
export async function buildOverviews(
  loc: GdalLocation,
  absPath: string,
): Promise<OverviewResult> {
  const gdal = tools(loc);
  // -ro：生成外部 .ovr，**原文件一个字节都不动**。
  // 不加 -ro 会就地重写原文件 —— 几 GB 的文件重写一次要很久，
  // 而且违反「原文件只被我们明确改动」的底线。
  const res = await gdal.buildOverviews(['-ro', '-r', 'average', absPath]);
  if (!res.ok) {
    // stderr 常常是空的（GDAL 有些错误只进 stdout），两种都带上，
    // 免得抛出一个没有线索的错误。
    const detail = [res.stderr.trim(), res.stdout.trim()].filter(Boolean).join('\n');
    throw new Error(`构建金字塔失败：${absPath}\n${detail}`);
  }
  const ovrPath = overviewPathOf(absPath);
  const built = existsSync(ovrPath);
  return { built, ovrPath: built ? ovrPath : null };
}

/**
 * 按需建金字塔：太小不建、已有不重复建。
 *
 * thresholdBytes 可注入：真造几 GB 的文件不现实，测试要用小阈值把
 * 一张小图当成"大图"来验这条链路。
 */
export async function ensureOverviews(
  loc: GdalLocation,
  absPath: string,
  options?: { readonly thresholdBytes?: number },
): Promise<EnsureOverviewResult> {
  const threshold = options?.thresholdBytes ?? DEFAULT_OVERVIEW_THRESHOLD_BYTES;
  let size = 0;
  try {
    size = statSync(absPath).size;
  } catch {
    // 文件不在：交给调用方决定是报错还是跳过，这里不替它做主
    return { built: false, ovrPath: null, skippedReason: 'not-found' };
  }
  if (size < threshold) {
    return { built: false, ovrPath: null, skippedReason: 'below-threshold' };
  }
  if (await hasOverviews(absPath)) {
    // 已有就回路径：调用方要靠它判断"金字塔已就绪"，而不是"这次没建"
    return { built: false, ovrPath: overviewPathOf(absPath), skippedReason: 'already-exists' };
  }
  const res = await buildOverviews(loc, absPath);
  return { built: res.built, ovrPath: res.ovrPath };
}
