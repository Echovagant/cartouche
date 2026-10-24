/**
 * 栅格编辑内核。
 *
 * 两条技术路线，按操作性质选择：
 *  - **像素级**（擦除 / 区域替换 / 修补 / 提亮 / 涂色）：读原始像素 → 在 TS 里算 →
 *    经 ENVI 写回 GeoTIFF（保留仿射参数与坐标系）→ 原子替换原文件。
 *    好处：运算可单测、结果确定、区域外可做到逐像素零差异。
 *  - **GDAL 级**（裁切 / 重采样 / 拼接）：直接用 gdalwarp / gdalbuildvirt，
 *    产出新文件后原子替换。
 *
 * 像素级这条路线又有两种读法：
 *  - **窗口路径**（局部操作，给了区域）：只读操作区域那一块 —— 几 GB 的影像
 *    不会被整读进内存；改完的窗口用 VRT 叠回原图，其余像素由 GDAL 原样搬运。
 *  - **整图路径**（全局操作，如调色）：整读整图。
 * 两条路径都受体积上限约束（见 `RasterDeps.maxWindowBytes`）。
 *
 * 共同的安全链路：占用检测 → 磁盘余量 → 备份 → 临时文件 → 原子替换 → 回读校验。
 */
import { randomBytes } from 'node:crypto';
import { rmSync, statfsSync, statSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { tools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';
import { replaceFileAtomically } from '../gdal/writeback.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';
import {
  DEFAULT_OVERVIEW_THRESHOLD_BYTES,
  ensureOverviews,
  hasOverviews,
  overviewPathOf,
  type OverviewSkipReason,
} from './overview.ts';
import {
  readRasterPixels,
  readRasterFrame,
  readRasterWindow,
  writeRasterPixels,
  checksumOf,
  type RasterPixels,
  type RasterWindowPixels,
} from './raw.ts';
import {
  MAX_SAMPLE,
  BYTES_PER_SAMPLE,
  copyBand,
  pixelTypeFromGdal,
  readSample,
  writeSample,
  type PixelBand,
  type PixelType,
} from './pixels.ts';
import { queryRasterPixels, type PixelPoint, type PixelQueryResult } from './pixel-query.ts';
import {
  buildAlphaMask,
  describeRegion,
  geoToPixelRegion,
  maskAlphaAtRegion,
  maskHitsRegion,
  regionHitsRaster,
  regionOffRasterMessage,
  zeroImpactMessage,
  type GeoBounds,
  type PixelMask,
  type PixelRegion,
} from './mask.ts';
import { blendBands } from './blend.ts';
import { inpaintRegion } from './inpaint.ts';
import { adjustLevels, type LevelsOptions } from './levels.ts';
import { overlayWindowOntoRaster } from './overlay.ts';
import {
  localRegion,
  windowBytes,
  windowForRegion,
  type RasterFrame,
  type RasterWindow,
} from './window.ts';

export interface RasterOpResult {
  readonly op: string;
  readonly target: string;
  readonly outputPath?: string;
  readonly affectedPixels: number;
  readonly totalPixels: number;
  readonly checksumBefore: string;
  readonly checksumAfter: string;
  readonly backupPath: string | null;
  readonly verified: boolean;
  readonly width: number;
  readonly height: number;
  readonly bandCount: number;
  /**
   * 金字塔这一步的结果（写回之后建没建成）。
   *
   * 为什么单独带出来：金字塔建不起来**不影响**改图本身（不能因此判整次操作失败），
   * 但界面会因此"影像还是卡"，原因必须能查 —— 所以它跟着结果一路回到调用方。
   */
  readonly overview?: OverviewOutcome;
  /**
   * true = 这是**预演**的结果，文件**没有**被写过。
   *
   * 确认卡要在动手之前就报出"会影响多少像元"，但那时还没落盘。
   * 所以预演走的是同一条计算路径，只是把写盘那一步去掉 ——
   * 否则预演给出的像元数是估的，和真执行对不上，确认卡就成了摆设。
   */
  readonly dryRun?: boolean;
}

/**
 * 像素级编辑的通用选项。
 *
 * `outputPath` 是"另存为新文件"的引擎侧开关：给了它，新内容落到那个新路径，
 * **原文件一个字节都不动**（用户裁定 2026-10-22：默认直接改原文件，
 * 另给一个"另存为新文件"的按钮；按钮的界面在出图排版那一轮，不在本层）。
 */
export interface RasterEditOptions {
  readonly dryRun?: boolean;
  /** 给定则写到新文件，原文件不动（"另存为新文件"）；工作区相对路径 */
  readonly outputPath?: string;
}

export interface RasterDeps {
  readonly loc: GdalLocation;
  readonly store: WorkspaceAdapter;
  /**
   * 单个窗口允许的最大像素字节数，默认 256 MB。
   *
   * 为什么要有上限：窗口化解决的是"局部操作别把整图读进内存"，
   * 但窗口本身也可能很大（用户框住半个图）。没有上限时，
   * 一次局部操作照样能把几个 GB 读进内存 —— 那就只是把 OOM 推迟了一步。
   * 超限时明确报错，比默默 OOM 强。
   */
  readonly maxWindowBytes?: number;
  /**
   * 要求的最小可用磁盘字节数（作为下限；本次实际需求更大时按实际算）。默认 512 MB。
   *
   * 为什么要有这个下限：光看"这一次写得下吗"不够 ——
   * 把盘写满会让系统日志、临时目录、别的工程一起写不进去，
   * 故障就从"这一次操作失败"扩散成"整台机器都不正常"。
   */
  readonly minFreeBytes?: number;
  /**
   * 建金字塔的阈值：超过这个大小才值得建（建金字塔要花时间与磁盘）。默认 200MB。
   *
   * 阈值可注入：真造几 GB 的文件不现实，测试用小阈值把一张小图当成"大图"来验这条链路。
   */
  readonly overviewThresholdBytes?: number;
  /**
   * 建金字塔时要保留下来的磁盘余量下限（字节）。默认与 minFreeBytes 相同。
   *
   * 为什么要单列一个：写回的余量与建金字塔的余量是两笔不同的开销，
   * 分开量才能一处收紧而不牵连另一处。
   */
  readonly overviewMinFreeBytes?: number;
}

/** 默认保留下限：写回后磁盘至少还剩 512 MB */
const DEFAULT_MIN_FREE_BYTES = 512 * 1024 * 1024;

/**
 * 把字节数说成人看得懂的量。
 *
 * 报错信息是给人看的：直接甩 3145728 没人判断得出"这够不够"，
 * 换算成 MB / GB 才行。
 */
function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '未知大小';
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 5) return `${(bytes / 1024 ** 5).toFixed(2)} PB`;
  if (abs >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
  if (abs >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (abs >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} 字节`;
}

/**
 * 找出离 dir 最近的、确实存在的目录。
 *
 * 为什么需要往上找：另存为到一个**还不存在**的子目录时，
 * 直接 statfsSync(那个目录) 会 ENOENT —— 那是"目录还没建"，不是"查不了磁盘"。
 * 往上找到最近存在的祖先目录即可：新建目录与它的父目录必然同卷。
 */
function nearestExistingDir(dir: string): string {
  let cur = dir;
  for (;;) {
    if (existsSync(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

/**
 * 磁盘余量护栏。
 *
 * 为什么要有：写回时要写一份与原图同尺寸的临时文件。磁盘不够时，
 * 写到一半失败会留下半个文件 —— 用户的图件处于不明状态，比直接报错糟得多。
 *
 * 查的是**目标所在目录**的可用空间：临时文件与目标同目录（同卷），
 * 所以查目标所在目录就等于查临时文件所在的那个卷。
 *
 * @param absPath 目标所在路径（临时文件与目标同目录 => 同一卷）
 * @param neededBytes 本次实际需要的字节数
 * @param minFreeBytes 保留下限：可用空间要满足"实际需求"与"下限"里更大的那个
 * @param purpose 这笔空间是干什么用的：写回 / 建金字塔。
 *   报错里要说清是哪一笔 —— "磁盘不够"配一句"写回"的话，看的人会去找错的地方。
 * @param breakdown 需求的构成（人话）。给了就把"这份额度花在哪"一并说清，
 *   而不是只甩一个总数让人自己猜。
 */
export function assertFreeSpace(
  absPath: string,
  neededBytes: number,
  minFreeBytes = 0,
  purpose: '写回' | '建金字塔' = '写回',
  breakdown?: string,
): void {
  const dir = dirname(absPath);
  const probeDir = nearestExistingDir(dir);
  let available: number;
  try {
    const st = statfsSync(probeDir);
    // bavail = 留给普通用户可用的量（POSIX 语义）；Windows 上 bfree === bavail。
    available = st.bavail * st.bsize;
  } catch (err) {
    // 查不到余量时**不放行**：放行等于把"写到一半失败"的风险原样放回去。
    // 报错里带上原始原因，用户才分得清是"盘满了"还是"这个目录查不了"。
    throw new Error(
      `无法查询磁盘余量（${probeDir}）：${(err as Error).message}\n` +
        '为避免写到一半失败留下半个文件，本次操作已中止。' +
        '请确认该目录存在、且当前用户有访问权限。',
    );
  }

  const required = Math.max(neededBytes, minFreeBytes);
  if (available >= required) return;

  const where = probeDir === dir
    ? `目标所在磁盘（${dir}）`
    : `目标所在磁盘（${probeDir}；目标目录 ${dir} 还不存在，按它所在的卷算）`;
  const detail: string[] = [];
  if (breakdown) detail.push(breakdown);
  else detail.push(`本次实际需求 ${humanBytes(neededBytes)}`);
  if (minFreeBytes > 0) detail.push(`保留下限 ${humanBytes(minFreeBytes)}`);
  // 下限比实际需求还大时要说清是下限在起作用 ——
  // 不然「本次需要 8.00 PB（本次实际需求 6.0 MB）」这种话会让人以为算错了。
  const which = minFreeBytes > neededBytes ? '（受保留下限约束）' : '';
  throw new Error(
    `磁盘空间不足，无法安全${purpose}。\n` +
      `${where}当前可用 ${humanBytes(available)}；` +
      `本次${purpose}需要 ${humanBytes(required)}${which}（${detail.join('、')}）。\n` +
      (purpose === '建金字塔'
        ? '建金字塔要写一个 .ovr 旁挂文件；空间不够就会写到一半失败、留下半个文件，' +
          '这份金字塔还是坏的。\n'
        : '写回时会先写一份与原图同尺寸的临时文件；空间不够就会写到一半失败、留下半个文件，' +
          '用户手上的图件就处于不明状态。\n') +
      '建议：把工程换到可用空间更大的盘；或清理该盘上的旧文件腾出空间；或缩小操作范围。',
  );
}

/**
 * 写回这一步真正需要的磁盘空间。
 *
 * 为什么不能只按"一份整图"算：
 *   - **原地替换**：临时文件（未压缩整图）与**备份副本**（原文件的字节级拷贝）
 *     同时在盘上 —— 峰值是两份。只算一份的话，磁盘看着够，
 *     实际写到一半就满了，留下半个备份 + 半个临时文件，
 *     用户手上是两份残骸加一份完好的原文件，谁也不知道该信哪份。
 *   - **另存为**：临时文件直接 rename 到新路径，不复制；原文件也不备份
 *     （原文件没被改，备份它没有意义）—— 峰值只有一份。
 *
 * 备份按**原文件的真实大小**算，而不是未压缩尺寸：
 * 备份是原文件的字节级拷贝，用压缩后的真实大小才准 ——
 * 拿未压缩尺寸去估会把余量算得比实际紧（一份未压缩 10 GB、
 * 实际只有 300 MB 的压缩影像，备份只占 300 MB）。
 */
function writebackSpace(
  targetAbs: string,
  wholeBytes: number,
  copyMode: boolean,
): { readonly bytes: number; readonly detail: string } {
  if (copyMode) {
    return { bytes: wholeBytes, detail: `临时文件 ${humanBytes(wholeBytes)}` };
  }
  let backupBytes = 0;
  try {
    backupBytes = statSync(targetAbs).size;
  } catch {
    // 读不到大小（不存在 / 被独占）：按 0 算。
    // 目标真不存在时本来就没有备份；读不到也不该凭空拒绝一次合法操作 ——
    // 剩下的风险由 minFreeBytes 那个下限兜着。
    backupBytes = 0;
  }
  return {
    bytes: wholeBytes + backupBytes,
    detail: `临时文件 ${humanBytes(wholeBytes)} + 备份副本 ${humanBytes(backupBytes)}`,
  };
}

/**
 * 金字塔这一步的结果。
 *
 * 为什么要有这个类型：金字塔是"锦上添花"——用户的图改好了就是改好了。
 * 但金字塔没建起来的原因必须**留痕**，否则症状会漂移到很远的地方
 * （界面卡），那时已经查不出根因了。
 */
export interface OverviewOutcome {
  /** 是否真的建出了金字塔 */
  readonly built: boolean;
  /** .ovr 的路径；没建出来且没有现成的就是 null */
  readonly ovrPath: string | null;
  /** 没建的原因（文件不在 / 太小 / 已经有了） */
  readonly skippedReason?: OverviewSkipReason;
  /** 建的过程中出的问题（磁盘不够 / gdaladdo 报错） */
  readonly error?: string;
  /** 不是错误、但需要说明的事（例：命令成功却没有产出 .ovr） */
  readonly note?: string;
  /** 这次按原文件大小估算的金字塔占位（字节） */
  readonly estimatedBytes?: number;
}

/**
 * 按需建金字塔：带磁盘余量护栏，且**不抛错**。
 *
 * 与 overview.ts 的 ensureOverviews 差两件事：
 *  1. 建之前查磁盘余量 —— .ovr 要占地方，盘不够写到一半失败会留下半个文件；
 *  2. 失败不抛错，而是写进 outcome.error —— 用户的图已经改好了，
 *     不能因为金字塔没建起来把整次操作判成失败；但也不能静默吞掉。
 *
 * 磁盘余量按**原文件的 1 倍**估（刻意保守）：
 * 实测 .ovr 约为原图的 25%（512×512 的原图 262578 字节 → .ovr 65821 字节），
 * 但那个比例只对"未压缩的小图"成立 —— 压缩过的原图本身可能只有原始像元的十分之一，
 * 而金字塔是按**原始像元**降采样出来的，占原文件的比例可以远大于 25%。
 * 多留一倍空间只是晚一点建；少留就会写到一半失败，留下半个 .ovr。
 */
export async function ensureRasterOverviews(
  loc: GdalLocation,
  absPath: string,
  options?: {
    /** 超过这个大小才值得建；默认 200MB */
    readonly thresholdBytes?: number;
    /** 建金字塔时要保留下来的磁盘余量下限（字节） */
    readonly minFreeBytes?: number;
  },
): Promise<OverviewOutcome> {
  const threshold = options?.thresholdBytes ?? DEFAULT_OVERVIEW_THRESHOLD_BYTES;
  const minFreeBytes = options?.minFreeBytes ?? 0;
  let size = 0;
  try {
    size = statSync(absPath).size;
  } catch {
    return { built: false, ovrPath: null, skippedReason: 'not-found' };
  }
  // 先判"这次会不会真的建"：只有会建才值得查磁盘。
  // 判据与 ensureOverviews 用的是同一份阈值常量；这里重复一遍，
  // 是为了把磁盘检查放在构建**之前**（ensureOverviews 自己不做磁盘检查）。
  if (size < threshold) {
    return { built: false, ovrPath: null, skippedReason: 'below-threshold' };
  }
  if (await hasOverviews(absPath)) {
    return { built: false, ovrPath: overviewPathOf(absPath), skippedReason: 'already-exists' };
  }

  const estimatedBytes = size;
  try {
    assertFreeSpace(absPath, estimatedBytes, minFreeBytes, '建金字塔');
  } catch (err) {
    // 磁盘不够：金字塔建不了，但用户的图已经改好了 —— 记下原因，不抛
    return {
      built: false,
      ovrPath: null,
      error: (err as Error).message,
      estimatedBytes,
    };
  }

  try {
    const res = await ensureOverviews(loc, absPath, { thresholdBytes: threshold });
    if (!res.built) {
      // gdaladdo 退出码 0 却没有产出 .ovr：GDAL 对太小的影像不生成概览
      // （实测 512×512 起才有；256×256 会"成功"但什么也不产出）。
      // 这不是错误，但要说清楚，否则界面会一直等一个永远不来的金字塔。
      return {
        built: false,
        ovrPath: null,
        note: 'gdaladdo 执行成功但没有产出 .ovr（影像太小，GDAL 不为它生成概览）',
        estimatedBytes,
      };
    }
    return { built: true, ovrPath: res.ovrPath, estimatedBytes };
  } catch (err) {
    return {
      built: false,
      ovrPath: null,
      error: (err as Error).message,
      estimatedBytes,
    };
  }
}

/**
 * 一次像素编辑的上下文。
 *
 * 为什么需要它：走窗口路径时 mutate 拿到的是**窗口像素**，
 * 于是"整图像素坐标"的操作区域必须换算成"窗口内坐标"，
 * 否则涂色/修补会落在窗口的左上角，而不是用户框的那块地方。
 */
export interface PixelEditContext {
  /** 本次读的是窗口还是整图 */
  readonly win: RasterWindow | null;
  /** 影响区域在**窗口内**的坐标；整图路径下为 null */
  readonly localRegion: PixelRegion | null;
}

interface EraseRequest {
  readonly target: string;
  readonly region: PixelRegion;
  /** 干净底图；不给则用边界内插近似 */
  readonly source?: string;
}

interface ReplaceRegionRequest {
  readonly source: string;
  readonly target: string;
  readonly region?: PixelRegion;
  readonly bbox?: GeoBounds;
  readonly featherPx?: number;
}

interface InpaintRequest {
  readonly target: string;
  readonly region: PixelRegion;
  readonly radiusPx?: number;
}

interface PaintRequest {
  readonly target: string;
  readonly region: PixelRegion;
  /** '#RRGGBB' 或 [r,g,b]；'sample-from-edge' 表示从区域外沿取色 */
  readonly color: string | readonly number[];
  /** 自由形状掩膜（画笔）；与矩形区域是「与」的关系 */
  readonly mask?: PixelMask;
}

interface ClipRequest {
  readonly target: string;
  readonly bbox?: GeoBounds;
  /** 矢量裁切范围（工作区相对路径） */
  readonly clip?: string;
}

interface ResampleRequest {
  readonly target: string;
  readonly targetResolution?: number;
  readonly resampleMethod?: 'nearest' | 'bilinear' | 'cubic' | 'average';
}

interface MosaicRequest {
  readonly inputs: readonly string[];
  readonly output?: string;
  readonly overlap?: 'first' | 'last' | 'blend';
}

/** 经纬度 → 原生像元的换算请求（相对 store 的路径） */
export interface PixelQueryOpRequest {
  /** 目标栅格（相对 store 根） */
  readonly target: string;
  /** 待换算的点：[经度, 纬度]（EPSG:4326，经度在前） */
  readonly points: readonly (readonly [number, number])[];
  /** 允许点落在影像范围之外（默认不允许） */
  readonly allowOutside?: boolean;
}

function parseColor(color: string | readonly number[]): [number, number, number] | 'sample-from-edge' {
  if (typeof color === 'string') {
    if (color === 'sample-from-edge') return 'sample-from-edge';
    const hex = color.replace('#', '');
    if (hex.length !== 6) throw new Error(`颜色格式错误：${color}`);
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  if (color.length < 3) throw new Error('颜色至少要三个通道');
  return [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0];
}

/**
 * 像素级编辑按影像的像素类型走：8 位按 0..255，16 位按 0..65535。
 *
 * 运算层（blend / inpaint / levels / paint）已经改成按类型算，
 * 所以这里不再拦 16 位源 —— 拦着的话 16 位影像就只能看不能改。
 * 类型对不上的情况由运算层自己报错（比如拿 8 位底图去混 16 位覆盖图），
 * 错误信息里带着两个类型名，不做静默截断。
 */
export class RasterEditor {
  readonly #loc: GdalLocation;
  readonly #store: WorkspaceAdapter;
  /** 单个窗口（或整图）允许的最大像素字节数 */
  readonly #maxWindowBytes: number;
  /** 写回时磁盘至少要剩下的可用字节数 */
  readonly #minFreeBytes: number;
  /** 建金字塔的阈值：超过这个大小才值得建 */
  readonly #overviewThresholdBytes: number;
  /** 建金字塔时磁盘至少要剩下的可用字节数 */
  readonly #overviewMinFreeBytes: number;

  constructor(deps: RasterDeps) {
    this.#loc = deps.loc;
    this.#store = deps.store;
    this.#maxWindowBytes = deps.maxWindowBytes ?? 256 * 1024 * 1024;
    this.#minFreeBytes = deps.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
    this.#overviewThresholdBytes = deps.overviewThresholdBytes ?? DEFAULT_OVERVIEW_THRESHOLD_BYTES;
    this.#overviewMinFreeBytes = deps.overviewMinFreeBytes ?? this.#minFreeBytes;
  }

  /**
   * 写回之后的金字塔处理。
   *
   * 为什么放在写回之后：金字塔是**给新内容用的**，改之前的缩略图对新内容没有意义。
   * 为什么失败不抛：用户的图已经改好了，不能因为金字塔没建起来把整次操作判成失败；
   * 但原因要留在结果里（outcome.error），不能静默吞掉。
   */
  async #ensureOverviews(absPath: string): Promise<OverviewOutcome> {
    return ensureRasterOverviews(this.#loc, absPath, {
      thresholdBytes: this.#overviewThresholdBytes,
      minFreeBytes: this.#overviewMinFreeBytes,
    });
  }

  #abs(rel: string): string {
    return this.#store.resolve(rel);
  }

  /** 目标同目录下的临时文件路径（同卷 → rename 才是原子操作） */
  #tempPath(target: string, suffix: string): string {
    const abs = this.#abs(target);
    const dir = dirname(abs);
    const tag = randomBytes(4).toString('hex');
    return join(dir, `.${tag}.${suffix}`);
  }

  async #read(rel: string): Promise<RasterPixels> {
    return readRasterPixels(this.#loc, this.#abs(rel));
  }

  /**
   * 写回前的格式闸门。
   *
   * 写回统一走 `gdal_translate -of GTiff`（见 raw.ts），也就是**产出的一定是 GeoTIFF 字节**。
   * 如果原文件不是 GeoTIFF，就会出现"内容换了、扩展名没换"的坏结果：
   * 一个 HFA 的 .img 被写成 GeoTIFF，ArcGIS 按 HFA 去解析，直接打不开。
   *
   * 与其悄悄把文件改坏，不如在动手之前就拒绝，并把原因说清楚。
   * （2026-10-22 实测：.png / .img / .vrt 改完都会变成 GeoTIFF 字节。）
   */
  #assertWritebackSafe(target: string, driver: string): void {
    if (driver === 'GTiff') return;
    throw new Error(
      `这个文件是 ${driver} 格式，不能原样写回：写回时统一产出 GeoTIFF，` +
        `文件名却还是原来的扩展名，ArcGIS 打开会失败。` +
        `目前只有 GeoTIFF 族（.tff / .tif）支持改图；` +
        `这个文件请先转成 GeoTIFF 再改。`,
    );
  }

  /**
   * 一幅栅格的"计量信息"：尺寸、波段数、类型、颜色解释、仿射、坐标系、驱动名。
   *
   * 全部来自 gdalinfo，不读一个像素 —— 所以对几 GB 的影像也是毫秒级。
   */
  async #metaOf(absPath: string): Promise<RasterMeta> {
    const res = await tools(this.#loc).info(absPath, ['-json']);
    if (!res.ok) {
      throw new Error(`读取栅格信息失败：${absPath}\n${res.stderr}`);
    }
    const info = JSON.parse(res.stdout) as {
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
    return {
      width,
      height,
      bandCount,
      // 源类型不认识就报错：按 8 位处理会把 16 位静默压成 255
      pixelType: pixelTypeFromGdal(info.bands?.[0]?.type),
      colorInterpretation: (info.bands ?? []).map((b) => b.colorInterpretation ?? 'Undefined'),
      geotransform: info.geoTransform ? [...info.geoTransform] : null,
      crs: info.coordinateSystem?.wkt ?? null,
      driver: String(info.driverShortName ?? 'GTiff'),
    };
  }

  /**
   * 体积护栏：局部操作按窗口算；全局操作按整图算，超了就明确报错而不是 OOM。
   *
   * ⚠️ 字节宽度要按**像素类型**算：16 位影像一个样点 2 字节，
   * 按 1 字节算会把实际占用算少一半，护栏就形同虚设。
   */
  #assertWithinSizeLimit(neededBytes: number): void {
    if (neededBytes <= this.#maxWindowBytes) return;
    const mb = Math.round(neededBytes / 1024 / 1024);
    const limitMb = Math.round(this.#maxWindowBytes / 1024 / 1024);
    throw new Error(
      `该操作需要整幅影像（当前约 ${mb} MB，超过上限 ${limitMb} MB）。\n` +
      '局部操作请缩小范围；全局操作（调色/裁切/重采样/拼接）目前不支持超大影像。',
    );
  }

  /**
   * 像素级改动的通用流程：算 → 写临时文件 → 原子替换 → 回读校验。
   *
   * 两条路径，按操作性质选择：
   *  - **窗口路径**（给了 region）：只读操作区域那一块，算完写成独立的窗口文件，
   *    再用 VRT 合成叠回原图。Node 内存里只有窗口大小，与整图大小无关。
   *  - **整图路径**（没给 region）：调色这类全局操作，整读整图。
   *
   * 两条路径都受体积护栏约束 —— 整图路径也不能把几个 GB 读进内存。
   *
   * 给了 outputPath 就是"另存为新文件"：临时文件落在**新文件旁边**，
   * 最后落到新路径，原文件一个字节都不动。
   */
  async #applyPixels(
    op: string,
    target: string,
    mutate: (px: RasterPixels, ctx: PixelEditContext) => PixelBand[] | Promise<PixelBand[]>,
    options?: {
      readonly dryRun?: boolean;
      /** 影响区域（整图像素坐标）；给了就走窗口路径 */
      readonly region?: PixelRegion;
      /** 区域外扩的像元数（修补需要边界外的像素） */
      readonly marginPx?: number;
      /** 给定则写到新文件，原文件不动（"另存为新文件"） */
      readonly outputPath?: string;
    },
  ): Promise<RasterOpResult> {
    const region = options?.region;
    if (region) {
      return this.#applyPixelsOnWindow(
        op, target, mutate, region, options?.marginPx ?? 0, options?.dryRun ?? false,
        options?.outputPath,
      );
    }
    return this.#applyPixelsOnWhole(
      op, target, mutate, options?.dryRun ?? false, options?.outputPath,
    );
  }

  /** 整图路径：整读整图，在内存里算，再整图写回 */
  async #applyPixelsOnWhole(
    op: string,
    target: string,
    mutate: (px: RasterPixels, ctx: PixelEditContext) => PixelBand[] | Promise<PixelBand[]>,
    dryRun: boolean,
    outputPath: string | undefined,
  ): Promise<RasterOpResult> {
    // 体积护栏必须在**整读之前**判：整读几 GB 的影像就是 OOM，
    // 等读完再判断等于没有护栏。
    const meta = await this.#metaOf(this.#abs(target));
    // 整图的像素字节数：内存护栏（按整图）与磁盘护栏（按整图）都用它
    const wholeBytes = meta.width * meta.height * meta.bandCount * BYTES_PER_SAMPLE[meta.pixelType];
    this.#assertWithinSizeLimit(wholeBytes);

    const before = await this.#read(target);
    this.#assertWritebackSafe(target, before.driver);
    // 整图路径没有区域可校验（给了区域就走窗口路径），所以这里只保留 mutate 调用。
    // 区域整体落在影像之外的检查在窗口路径入口处（regionHitsRaster）。
    const newBands = await mutate(before, { win: null, localRegion: null });

    // ⚠️ 整图路径**不**在这里做零命中拦截：这里走的是全局操作（调色），
    // 图像本来就占满量程时调色就是个恒等变换，"数值没变"是合法结果，
    // 不是"没瞄准"。零命中的闸门在两处：
    //   - 区域型操作（涂色/修补/替换）在**窗口路径**里判，见 #applyPixelsOnWindow；
    //   - API 层（ops/executor.ts 的 verdictOf）对所有像素级操作统一判。
    // 用户看到的结论与以前一致：改了 0 像元一律算失败。

    // 预演：算到这里就够了，像元数是**精确值**（不是估算），
    // 但不写盘、不备份、不替换 —— 确认卡要在用户点头之前什么都别动。
    if (dryRun) {
      return {
        op,
        target: this.#abs(target),
        affectedPixels: countChanged(before.bands[0], newBands[0]),
        totalPixels: before.width * before.height,
        checksumBefore: before.checksum,
        checksumAfter: checksumOf(newBands),
        backupPath: null,
        // 预演没有回读校验这一说：文件根本没动
        verified: false,
        width: before.width,
        height: before.height,
        bandCount: before.bandCount,
        dryRun: true,
      };
    }

    // 另存为：临时文件落在**新文件旁边**，rename 才是同卷原子操作
    const dest = outputPath ?? target;
    // 磁盘余量护栏：临时文件与原图同尺寸 ⇒ 需求按**整图**算。
    // 放在写临时文件之前 —— 写下去才发现装不下，就只剩半个文件了。
    const need = writebackSpace(this.#abs(target), wholeBytes, Boolean(outputPath));
    assertFreeSpace(this.#abs(dest), need.bytes, this.#minFreeBytes, '写回', need.detail);
    const temp = this.#tempPath(dest, 'tmp.tif');
    await writeRasterPixels(this.#loc, temp, {
      width: before.width,
      height: before.height,
      bands: newBands,
      // 类型与颜色解释都从原图带过来：写回链路要按原类型落盘，
      // 颜色解释也必须保住，否则叠回原图时 gdalbuildvrt 会判异构而跳过窗口。
      pixelType: before.pixelType,
      colorInterpretation: before.colorInterpretation,
      geotransform: before.geotransform,
      crs: before.crs,
    });
    const { backupPath } = await replaceFileAtomically(
      this.#store,
      outputPath
        ? { target, tempPath: temp, mode: 'copy', outputPath }
        : { target, tempPath: temp },
    );
    // 回读校验读的是**落地的那个文件**：另存为时是新文件，不是原文件
    const after = await this.#read(dest);
    // 写回成功之后建金字塔：大影像没有金字塔，缩放显示会卡到不可用
    const overview = await this.#ensureOverviews(this.#abs(dest));

    return {
      op,
      target: this.#abs(target),
      // 另存为时 outputPath 是新文件；原地替换时不带这个字段
      ...(outputPath ? { outputPath: this.#abs(outputPath) } : {}),
      affectedPixels: countChanged(before.bands[0], after.bands[0]),
      totalPixels: before.width * before.height,
      checksumBefore: before.checksum,
      checksumAfter: after.checksum,
      backupPath,
      verified:
        after.width === before.width &&
        after.height === before.height &&
        after.bandCount === before.bandCount,
      width: after.width,
      height: after.height,
      bandCount: after.bandCount,
      overview,
    };
  }

  /**
   * 窗口路径：只读操作区域那一块。
   *
   * 完整链路：读整图信息 → 算窗口 → 体积护栏 → 读窗口像素 → 算新值 →
   * （预演到此为止）→ 写窗口 → 叠回原图 → 原子替换 → 回读校验（只读窗口）。
   *
   * ⚠️ 校验和口径：窗口路径下 checksumBefore / checksumAfter 都是**窗口范围**的校验和，
   * 不是整图的。两者必须同口径（都是窗口，或都是整图），
   * 否则确认卡上会出现两个没法比的数字。
   */
  async #applyPixelsOnWindow(
    op: string,
    target: string,
    mutate: (px: RasterPixels, ctx: PixelEditContext) => PixelBand[] | Promise<PixelBand[]>,
    region: PixelRegion,
    marginPx: number,
    dryRun: boolean,
    outputPath: string | undefined,
  ): Promise<RasterOpResult> {
    const abs = this.#abs(target);
    const meta = await this.#metaOf(abs);
    // 区域整个落在影像之外 → 逐像元的循环一个都不执行。
    // 与其让它变成「改了 0 像元还报成功」，不如在这里明确报错。
    // 这道闸门必须拦在**算窗口之前**：窗口一算出来就是空的，
    // 到那时给出的信息只剩「窗口是空的」，说不清是区域选错了还是图坏了。
    if (!regionHitsRaster(region, meta.width, meta.height)) {
      throw new Error(regionOffRasterMessage(region, meta.width, meta.height));
    }
    if (!meta.geotransform) {
      throw new Error(`栅格缺少仿射参数，无法定位窗口：${abs}`);
    }
    const frame: RasterFrame = {
      width: meta.width,
      height: meta.height,
      geotransform: meta.geotransform,
    };
    const win = windowForRegion(frame, region, marginPx);
    if (win.w <= 0 || win.h <= 0) {
      throw new Error(
        `操作区域落在影像之外：区域 x∈[${region.minX}, ${region.maxX}]、y∈[${region.minY}, ${region.maxY}]，` +
        `影像只有 ${frame.width}×${frame.height} 像元`,
      );
    }

    // 体积护栏：局部操作只按窗口算（整图的字节数在这里不参与判断）
    this.#assertWithinSizeLimit(
      windowBytes(win, meta.bandCount, BYTES_PER_SAMPLE[meta.pixelType]),
    );

    // 写回闸门：窗口路径产出的也是 GeoTIFF，非 GTiff 同样不能原样写回
    this.#assertWritebackSafe(target, meta.driver);

    // 只读窗口（不是整读）：Node 内存里只有窗口大小
    const before = await readRasterWindow(this.#loc, abs, win);
    const local = localRegion(win, region);
    const newBands = await mutate(
      windowAsPixels(before, meta),
      { win, localRegion: local },
    );

    // 零命中拦截：区域型操作一个像元都没改到 → 这次什么都不会发生。
    // 与其让它变成「改了 0 像元还报成功」，不如在这里明确报错，
    // 而且必须拦在**写盘之前** —— 不然文件会被重写一遍、还多出一份备份。
    // 预演与执行走的是同一段代码，两边的结论必然一致。
    const changed = countChanged(before.bands[0], newBands[0]);
    if (changed === 0) {
      throw new Error(zeroImpactMessage(frame.width, frame.height, region));
    }

    // 预演：算到这里就够了，不写盘、不备份、不替换
    if (dryRun) {
      return {
        op,
        target: abs,
        affectedPixels: changed,
        totalPixels: frame.width * frame.height,
        // 窗口口径的校验和（与执行后的口径一致）
        checksumBefore: before.checksum,
        checksumAfter: checksumOf(newBands),
        backupPath: null,
        verified: false,
        width: frame.width,
        height: frame.height,
        bandCount: meta.bandCount,
        dryRun: true,
      };
    }

    // 另存为：临时文件落在**新文件旁边**，rename 才是同卷原子操作
    const dest = outputPath ?? target;
    // ⚠️ 磁盘余量护栏：窗口化省的是**内存**，不是磁盘 ——
    // overlayWindowOntoRaster 产出的临时文件与原图**同尺寸**，
    // 所以需求按**整图**算；按窗口算会放行一个必然写满磁盘的操作。
    // 这与体积护栏（maxWindowBytes）语义不同：那个管内存、按窗口算；这个管磁盘、按整图算。
    const wholeBytes = frame.width * frame.height * meta.bandCount * BYTES_PER_SAMPLE[meta.pixelType];
    const need = writebackSpace(this.#abs(target), wholeBytes, Boolean(outputPath));
    assertFreeSpace(this.#abs(dest), need.bytes, this.#minFreeBytes, '写回', need.detail);
    const winTmp = this.#tempPath(dest, 'win.tif');
    const mergedTmp = this.#tempPath(dest, 'merged.tif');
    let backupPath: string | null = null;
    try {
      await writeRasterPixels(this.#loc, winTmp, {
        width: win.w,
        height: win.h,
        bands: newBands,
        // ⚠️ 少了 pixelType，16 位原图会写出一个 **Byte 窗口**，
        // 合成时 GDAL 判「heterogeneous band data type」直接把窗口跳过。
        // 少了 colorInterpretation 同理（ENVI 中转不带颜色解释，读回来是 Undefined）。
        pixelType: meta.pixelType,
        colorInterpretation: meta.colorInterpretation,
        // 窗口自身的仿射参数：原点平移到窗口左上角，像元大小不变
        geotransform: before.geotransform,
        // crs 必须继承原图的 —— 坐标系不一致时同样是「heterogeneous projection」跳过。
        crs: meta.crs,
      });

      // 叠回原图：产出与原图同尺寸、同仿射、同波段类型的完整文件
      await overlayWindowOntoRaster(this.#loc, abs, winTmp, mergedTmp);

      const replaced = await replaceFileAtomically(
        this.#store,
        outputPath
          ? { target, tempPath: mergedTmp, mode: 'copy', outputPath }
          : { target, tempPath: mergedTmp },
      );
      backupPath = replaced.backupPath;

      // 回读校验只读窗口：窗口外的像素不逐字节比对（那要读整个文件）
      // 另存为时校验的是**新文件**（原地替换时校验的是原文件）
      const verified = await this.#verifyWindow(dest, win, newBands, frame);
      // 写回成功之后建金字塔（另存为时建在**新文件**旁边：那是现在装着新内容的文件）
      const overview = await this.#ensureOverviews(this.#abs(dest));

      return {
        op,
        target: abs,
        // 另存为时 outputPath 是新文件；原地替换时不带这个字段
        ...(outputPath ? { outputPath: this.#abs(outputPath) } : {}),
        affectedPixels: countChanged(before.bands[0], newBands[0]),
        totalPixels: frame.width * frame.height,
        // 窗口口径的校验和：写进去的值与回读值已由 verifyWindow 逐样点证明相同
        checksumBefore: before.checksum,
        checksumAfter: checksumOf(newBands),
        backupPath,
        verified,
        width: frame.width,
        height: frame.height,
        bandCount: meta.bandCount,
        overview,
      };
    } finally {
      rmSync(winTmp, { force: true });
      rmSync(mergedTmp, { force: true });
    }
  }

  /**
   * 回读校验：窗口内逐样点比对 + 整图的尺寸与仿射参数没变。
   *
   * ⚠️ 窗口外的像素**不逐字节比对** —— 那要读整个文件，等于把窗口化的意义抹掉。
   * 窗口外的正确性由 VRT 合成语义保证（overlay 的用例已经钉住）。
   */
  async #verifyWindow(
    target: string,
    win: RasterWindow,
    expected: readonly PixelBand[],
    frame: RasterFrame,
  ): Promise<boolean> {
    const after = await readRasterWindow(this.#loc, this.#abs(target), win);
    for (let b = 0; b < expected.length; b++) {
      const got = after.bands[b];
      const want = expected[b];
      if (!got || !want) return false;
      if (got.length !== want.length) return false;
      for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) return false;
    }
    const afterFrame = await readRasterFrame(this.#loc, this.#abs(target));
    if (afterFrame.width !== frame.width || afterFrame.height !== frame.height) return false;
    for (let i = 0; i < 6; i++) {
      if (frame.geotransform[i] !== afterFrame.geotransform[i]) return false;
    }
    return true;
  }

  /** GDAL 级改动的通用流程：产临时文件 → 原子替换 → 回读校验 */
  async #applyGdal(
    op: string,
    target: string,
    produce: (temp: string) => Promise<void>,
  ): Promise<RasterOpResult> {
    const before = await this.#read(target);
    this.#assertWritebackSafe(target, before.driver);
    const temp = this.#tempPath(target, 'tmp.tif');
    await produce(temp);
    const { backupPath } = await replaceFileAtomically(this.#store, { target, tempPath: temp });
    const after = await this.#read(target);
    // 写回成功之后建金字塔（GDAL 级改动同样换了内容，金字塔要跟着新内容走）
    const overview = await this.#ensureOverviews(this.#abs(target));
    let affected = 0;
    const a = before.bands[0];
    const b = after.bands[0];
    if (a && b) {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) affected++;
    }
    return {
      op,
      target: this.#abs(target),
      affectedPixels: affected,
      totalPixels: before.width * before.height,
      checksumBefore: before.checksum,
      checksumAfter: after.checksum,
      backupPath,
      verified: after.width > 0 && after.height > 0,
      width: after.width,
      height: after.height,
      bandCount: after.bandCount,
      overview,
    };
  }

  /** 擦除标注色块：有干净底图就从底图取像素，没有就用边界内插 */
  async erase(req: EraseRequest, options?: RasterEditOptions): Promise<RasterOpResult> {
    if (req.source) {
      return this.replaceRegion({
        source: req.source,
        target: req.target,
        region: req.region,
        featherPx: 0,
      }, options);
    }
    return this.inpaint({ target: req.target, region: req.region, radiusPx: 4 }, options);
  }

  /** 用另一张图替换指定区域（可羽化过渡） */
  async replaceRegion(req: ReplaceRegionRequest, options?: RasterEditOptions): Promise<RasterOpResult> {
    const targetMeta = await this.#metaOf(this.#abs(req.target));
    const sourceMeta = await this.#metaOf(this.#abs(req.source));

    if (sourceMeta.width !== targetMeta.width || sourceMeta.height !== targetMeta.height) {
      throw new Error('源图与目标图尺寸不一致，无法按像元替换；请先对齐两者');
    }
    if (!sameGeotransform(targetMeta.geotransform, sourceMeta.geotransform)) {
      throw new Error('源图与目标图不在同一网格（仿射参数不同），请先重采样对齐');
    }

    const region = req.region ?? (req.bbox && targetMeta.geotransform
      ? geoToPixelRegion(req.bbox, targetMeta.geotransform)
      : undefined);
    if (!region) throw new Error('必须给出替换范围（region 或 bbox）');

    const featherPx = req.featherPx ?? 0;
    return this.#applyPixels(
      'raster.replaceRegion',
      req.target,
      async (px, ctx) => {
        // 掩膜要按**窗口尺寸**建，区域坐标换成窗口内坐标
        const local = ctx.localRegion ?? region;
        const alpha = buildAlphaMask(px.width, px.height, local, featherPx);
        // 覆盖图要与底图取同一块：窗口路径只读源图的同一窗口
        const overlay = ctx.win
          ? (await readRasterWindow(this.#loc, this.#abs(req.source), ctx.win)).bands
          : (await this.#read(req.source)).bands;
        return blendBands(px.bands, overlay, alpha, px.bandCount, px.pixelType);
      },
      // ⚠️ buildAlphaMask 的羽化是**向外**生长的（区域内 alpha=1，向外线性衰减到 0），
      // 窗口必须比区域多出 featherPx 的余量，否则窗口边缘会出现硬接缝。
      { ...options, region, marginPx: featherPx },
    );
  }

  /** 边界内插修补 */
  async inpaint(req: InpaintRequest, options?: RasterEditOptions): Promise<RasterOpResult> {
    const radiusPx = req.radiusPx ?? 4;
    const iterations = Math.max(1, Math.round(radiusPx * 2));
    return this.#applyPixels(
      'raster.inpaint',
      req.target,
      (px, ctx) => {
        const region = ctx.localRegion ?? req.region;
        return inpaintRegion(px.bands, px.width, px.height, px.bandCount, region, iterations, px.pixelType);
      },
      // ⚠️ 修补要用到区域**外**的边界像素（第一层填充就靠它们），
      // 窗口必须比区域多出一圈，否则窗口边缘会被当成边界，填出硬接缝。
      { ...options, region: req.region, marginPx: radiusPx },
    );
  }

  /** 亮度 / 对比度调整 */
  async adjustLevels(req: { target: string } & LevelsOptions, options?: RasterEditOptions): Promise<RasterOpResult> {
    return this.#applyPixels('raster.adjustLevels', req.target, (px) => {
      const levels: LevelsOptions = {
        method: req.method ?? 'linear-stretch',
        ...(req.brightness !== undefined ? { brightness: req.brightness } : {}),
        ...(req.contrast !== undefined ? { contrast: req.contrast } : {}),
        ...(req.gamma !== undefined ? { gamma: req.gamma } : {}),
      };
      return adjustLevels(px.bands, levels, px.pixelType);
    }, options);
  }

  /** 区域涂色 */
  async paint(req: PaintRequest, options?: RasterEditOptions): Promise<RasterOpResult> {
    const parsed = parseColor(req.color);
    // 'sample-from-edge' 要看区域**外面**的像元，窗口至少外扩一圈；
    // 否则窗口里根本没有区域外的像元可取（取不到色就只剩黑色）。
    const marginPx = parsed === 'sample-from-edge' ? 1 : 0;
    return this.#applyPixels('raster.paint', req.target, (px, ctx) => {
      // 掩膜在区域里一个像元都没覆盖 → 这次不会改到任何东西。
      // 与其等它报「改了 0 像元」，不如把原因说清楚。
      // 用的是**整图**区域（req.region）：掩膜的坐标本来就相对区域原点，
      // 与走整图路径还是窗口路径无关。
      if (req.mask && !maskHitsRegion(req.mask, req.region)) {
        throw new Error(
          `掩膜在区域内没有覆盖到任何像元（区域 ${describeRegion(req.region)}）：` +
            `这次不会改到任何像元`,
        );
      }
      // 窗口路径下 mutate 拿到的是窗口像素，区域与掩膜都得换算到窗口坐标系
      const region = ctx.localRegion ?? req.region;
      const type = px.pixelType;
      const maxValue = MAX_SAMPLE[type];
      let rgb: [number, number, number];
      if (parsed === 'sample-from-edge') {
        // 取色是从本图上取的，天然就是本图口径（16 位图上就是 0..65535），不用放大
        rgb = sampleEdgeColor(px, region) ?? [0, 0, 0];
      } else {
        // 取色器给的是 8 位口径的 RGB。16 位影像上按比例放大到 0..65535，
        // 否则涂上去的颜色只有 8 位量级，在 16 位图上几乎看不出来（等于没涂）。
        rgb = [
          (parsed[0] * maxValue) / 255,
          (parsed[1] * maxValue) / 255,
          (parsed[2] * maxValue) / 255,
        ];
      }
      return px.bands.map((band, b) => {
        // 复制原值：必须按**带自己的类型**拷。
        // `Uint8Array.from` 对 16 位带是逐元素截断（65535 → 255），
        // 对 32 位与浮点带更糟（负数直接变成天文数字）——
        // 那正是要消灭的静默数据损坏。
        const out = copyBand(band, type);
        const value = rgb[Math.min(b, 2)]!;
        for (let y = 0; y < px.height; y++) {
          for (let x = 0; x < px.width; x++) {
            if (x >= region.minX && x < region.maxX && y >= region.minY && y < region.maxY) {
              // 有掩膜时按不透明度混合：mask=255 的效果与原来的硬写一致，
              // 所以加掩膜不会改变"纯矩形涂色"这条老路子的行为。
              // 掩膜是**相对 region** 的坐标（掩膜宽高 = region 包围盒），
              // 查表要减掉区域原点。
              // 这里用的 region 是上面那句算出来的**窗口内**区域
              // （region = ctx.localRegion ?? req.region），
              // 所以整图路径与窗口路径用的是同一套换算 —— 不用再补窗口偏移。
              const a = maskAlphaAtRegion(req.mask, region, x, y);
              if (a <= 0) continue;
              const idx = y * px.width + x;
              const old = readSample(out, idx);
              writeSample(out, idx, old + (value - old) * a, type);
            }
          }
        }
        return out;
      });
    }, { ...options, region: req.region, marginPx });
  }

  /** 裁切（按地理范围或矢量范围） */
  async clip(req: ClipRequest): Promise<RasterOpResult> {
    const gdal = tools(this.#loc);
    return this.#applyGdal('raster.clip', req.target, async (temp) => {
      const args = ['-of', 'GTiff'];
      if (req.bbox) {
        args.push('-te', String(req.bbox.minX), String(req.bbox.minY), String(req.bbox.maxX), String(req.bbox.maxY));
      }
      if (req.clip) {
        args.push('-cutline', this.#abs(req.clip), '-crop_to_cutline');
      }
      args.push(this.#abs(req.target), temp);
      const res = await gdal.warp(args);
      if (!res.ok) throw new Error(`裁切失败：${res.stderr}`);
    });
  }

  /** 重采样（改变分辨率，保持范围） */
  async resample(req: ResampleRequest): Promise<RasterOpResult> {
    const gdal = tools(this.#loc);
    if (!req.targetResolution) throw new Error('必须给出目标分辨率');
    return this.#applyGdal('raster.resample', req.target, async (temp) => {
      const res = await gdal.warp([
        '-of', 'GTiff',
        '-tr', String(req.targetResolution), String(req.targetResolution),
        '-r', req.resampleMethod ?? 'nearest',
        this.#abs(req.target), temp,
      ]);
      if (!res.ok) throw new Error(`重采样失败：${res.stderr}`);
    });
  }

  /**
   * 经纬度 → 原生像元（只读，不碰文件）。
   *
   * 为什么不放在服务层：坐标换算要 GDAL 的仿射参数与 PROJ 的投影，
   * 那是引擎的活；放到服务层就会出现两份换算代码（前端一份、服务端一份），
   * 两份迟早走样。
   *
   * 4326 的栅格与投影坐标系的栅格走**同一条**路（引擎内部决定要不要做投影），
   * 调用方不必自己判断"这张图是不是经纬度"。
   */
  async queryPixels(req: PixelQueryOpRequest): Promise<PixelQueryResult> {
    return queryRasterPixels(this.#loc, {
      path: this.#abs(req.target),
      points: req.points,
      ...(req.allowOutside !== undefined ? { allowOutside: req.allowOutside } : {}),
    });
  }

  /** 拼接多幅为一幅 */
  async mosaic(req: MosaicRequest): Promise<RasterOpResult> {
    const gdal = tools(this.#loc);
    if (req.inputs.length < 2) throw new Error('拼接至少需要两幅影像');
    const output = req.output ?? `${basename(req.inputs[0]!, '.*')}-merged.tif`;

    const vrt = this.#tempPath(output, 'vrt');
    const built = await gdal.buildVrt(['-overwrite', vrt, ...req.inputs.map((i) => this.#abs(i))]);
    if (!built.ok) throw new Error(`拼接（建 VRT）失败：${built.stderr}`);

    const outAbs = this.#abs(output);
    const tr = await gdal.translate(['-of', 'GTiff', vrt, outAbs]);
    if (!tr.ok) throw new Error(`拼接（出图）失败：${tr.stderr}`);

    const px = await readRasterPixels(this.#loc, outAbs);
    return {
      op: 'raster.mosaic',
      target: outAbs,
      outputPath: outAbs,
      affectedPixels: px.width * px.height,
      totalPixels: px.width * px.height,
      checksumBefore: '',
      checksumAfter: px.checksum,
      backupPath: null,
      verified: px.width > 0 && px.height > 0,
      width: px.width,
      height: px.height,
      bandCount: px.bandCount,
    };
  }
}

function sameGeotransform(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (!a || !b || a.length < 6 || b.length < 6) return false;
  for (let i = 0; i < 6; i++) {
    if (Math.abs(a[i]! - b[i]!) > 1e-9) return false;
  }
  return true;
}

/** 一幅栅格的计量信息（全部来自 gdalinfo，不读像素） */
interface RasterMeta {
  readonly width: number;
  readonly height: number;
  readonly bandCount: number;
  readonly pixelType: PixelType;
  readonly colorInterpretation: readonly string[];
  /** [originX, pixelW, 0, originY, 0, pixelH]；没有投影信息的栅格为 null */
  readonly geotransform: readonly number[] | null;
  readonly crs: string | null;
  /** GDAL 驱动短名（GTiff / HFA / PNG …） */
  readonly driver: string;
}

/**
 * 两条带里有多少个样点不同。
 *
 * 吃的是 PixelBand（8 位与 16 位都适用）：16 位带上按元素比较同样成立，
 * 而只吃 Uint8Array 的写法在 16 位影像上根本编译不过。
 */
function countChanged(before: PixelBand | undefined, after: PixelBand | undefined): number {
  if (!before || !after) return 0;
  const n = Math.min(before.length, after.length);
  let changed = 0;
  for (let i = 0; i < n; i++) if (before[i] !== after[i]) changed++;
  return changed;
}

/**
 * 把窗口像素包装成与整图读同形的对象，让 mutate 不必关心走的是哪条路径。
 *
 * 颜色解释与驱动名来自整图：窗口是原图的一块，颜色解释自然是原图的。
 */
function windowAsPixels(win: RasterWindowPixels, meta: RasterMeta): RasterPixels {
  return {
    width: win.width,
    height: win.height,
    bandCount: win.bandCount,
    bands: win.bands,
    pixelType: win.pixelType,
    colorInterpretation: meta.colorInterpretation,
    geotransform: win.geotransform,
    crs: win.crs,
    driver: meta.driver,
    checksum: win.checksum,
  };
}

/** 从区域外沿取一个像元的颜色 */
function sampleEdgeColor(px: RasterPixels, region: PixelRegion): [number, number, number] | null {
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      const inside = x >= region.minX && x < region.maxX && y >= region.minY && y < region.maxY;
      if (inside) continue;
      const idx = y * px.width + x;
      return [
        px.bands[0]?.[idx] ?? 0,
        px.bands[1]?.[idx] ?? px.bands[0]?.[idx] ?? 0,
        px.bands[2]?.[idx] ?? px.bands[0]?.[idx] ?? 0,
      ];
    }
  }
  return null;
}
