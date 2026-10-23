/**
 * 编辑工具的可用性判定（纯函数，不碰 React，也不碰网络）。
 *
 * 为什么单独抽一个文件：
 *   四个工具的"能不能用"**不是同一条规则**，以前却被压成了**一个**全局字符串：
 *     查看：永远可用；
 *     画笔 / 框选：要把屏幕坐标换算成栅格的**原生像元**；
 *     调色：引擎侧是整幅逐像元调整（raster.adjustLevels），**跟坐标系无关**。
 *   压成一个字符串的后果很直接：栅格不是 4326 时「调色」被一起禁用了——
 *   CGCS2000 3 度带（国内最常见的底图）整层一笔都画不了，连调色都用不上。
 *
 * 判定放在纯函数里，是为了能被 node --test 直接测：
 * 这里错一次，界面上就是"按钮灰着，但说不清为什么"。
 */

import type { EditTool } from './types';

/** 四个工具各自的不可用原因（null = 可用） */
export type ToolBlockedReasons = Readonly<Record<EditTool, string | null>>;

/** 判定需要的输入（只取用得上的那几项） */
export interface EditAvailabilityInput {
  /** 有没有被编辑的栅格（false = 还没选栅格图层） */
  readonly hasTarget: boolean;
  /** 栅格网格是不是正在读 */
  readonly gridLoading: boolean;
  /** 栅格网格的读取错误 */
  readonly gridError: string | null;
  /** 有没有拿到栅格网格 */
  readonly hasGrid: boolean;
  /**
   * 栅格是不是经纬度坐标。
   *
   * 由调用方用 `editGeometry.isWgs84Grid` 判定后传进来——
   * "什么算 4326"只有那一个判据（引擎给的 `crs.is4326`），这里不再自己猜一遍。
   */
  readonly gridIsWgs84: boolean;
  /** 栅格有没有坐标系信息（引擎探查出来的结论） */
  readonly gridHasCrs: boolean;
}

/** 没选栅格图层 */
export const NO_TARGET_REASON = '先选一个栅格图层';

/** 栅格网格还在读 */
export const GRID_LOADING_REASON = '正在读取栅格网格…';

/** 栅格网格没拿到 */
export const GRID_MISSING_REASON = '还没有拿到栅格网格';

/**
 * 栅格**完全没有坐标系**时的说法（画笔与框选共用一条）。
 *
 * 只剩这一种情况会挡住画笔/框选：**没有坐标系**，就不知道该把经纬度
 * 换算到哪个坐标系里去。
 *
 * 而"坐标系不是 4326"**不再挡**了：换算由引擎做
 * （`POST /api/raster/pixels` 里做投影 + 仿射反算），
 * CGCS2000 3 度带这类投影坐标系的底图照样能画。
 */
export const NO_CRS_REASON =
  '该图层没有坐标系信息，屏幕坐标换算不到原生像元，画笔/框选暂不可用';

/**
 * 算出四个工具各自的不可用原因。
 *
 * 注意「调色」这条：它只要求**有一个栅格图层**，
 * 不看坐标系、不等栅格网格——引擎侧的调色是整幅逐像元算的，用不到网格。
 */
export function computeBlockedReasons(input: EditAvailabilityInput): ToolBlockedReasons {
  const { hasTarget, gridLoading, gridError, hasGrid, gridIsWgs84, gridHasCrs } = input;

  // 查看：永远可用。没有栅格时也要能回到浏览模式。
  const view: string | null = null;

  // 调色：只要有栅格图层就能用，与坐标系无关。
  const levels: string | null = hasTarget ? null : NO_TARGET_REASON;

  // 画笔与框选：要把屏幕坐标换算成原生像元。
  // 换算由引擎做（任何投影坐标系都行），只有"压根没有坐标系"才换不了。
  let geometry: string | null = null;
  if (!hasTarget) {
    geometry = NO_TARGET_REASON;
  } else if (gridLoading) {
    geometry = GRID_LOADING_REASON;
  } else if (gridError) {
    geometry = `读取栅格网格失败：${gridError}`;
  } else if (!hasGrid) {
    geometry = GRID_MISSING_REASON;
  } else if (!gridHasCrs && !gridIsWgs84) {
    geometry = NO_CRS_REASON;
  }

  return { view, brush: geometry, box: geometry, levels };
}

/**
 * 工具条上某个按钮要不要置灰。
 *
 * 当前选中的工具永远不置灰——不然用户点了没反应，就再也点不回来了。
 */
export function isToolDisabled(
  reasons: ToolBlockedReasons,
  toolId: EditTool,
  currentTool: EditTool,
): boolean {
  return toolId !== currentTool && reasons[toolId] !== null;
}
