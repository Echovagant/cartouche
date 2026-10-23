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
 * 共同的安全链路：占用检测 → 备份 → 临时文件 → 原子替换 → 回读校验。
 */
import { randomBytes } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import { tools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';
import { replaceFileAtomically } from '../gdal/writeback.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';
import { readRasterPixels, writeRasterPixels, checksumOf, type RasterPixels } from './raw.ts';
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
   * true = 这是**预演**的结果，文件**没有**被写过。
   *
   * 确认卡要在动手之前就报出"会影响多少像元"，但那时还没落盘。
   * 所以预演走的是同一条计算路径，只是把写盘那一步去掉 ——
   * 否则预演给出的像元数是估的，和真执行对不上，确认卡就成了摆设。
   */
  readonly dryRun?: boolean;
}

export interface RasterDeps {
  readonly loc: GdalLocation;
  readonly store: WorkspaceAdapter;
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

export class RasterEditor {
  readonly #loc: GdalLocation;
  readonly #store: WorkspaceAdapter;

  constructor(deps: RasterDeps) {
    this.#loc = deps.loc;
    this.#store = deps.store;
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

  /** 像素级改动的通用流程：算 → 写临时文件 → 原子替换 → 回读校验 */
  async #applyPixels(
    op: string,
    target: string,
    mutate: (px: RasterPixels) => Uint8Array[],
    options?: { readonly dryRun?: boolean; readonly region?: PixelRegion },
  ): Promise<RasterOpResult> {
    const before = await this.#read(target);
    this.#assertWritebackSafe(target, before.driver);
    // 区域整个落在影像之外 → 逐像元的循环一个都不执行。
    // 与其让它变成「改了 0 像元还报成功」，不如在这里明确报错。
    if (options?.region && !regionHitsRaster(options.region, before.width, before.height)) {
      throw new Error(regionOffRasterMessage(options.region, before.width, before.height));
    }
    const newBands = mutate(before);

    // 受影响像元数**先算出来再决定写不写**：
    // 一个像元都没变还报成功，是最严重的一类缺陷 —— 用户以为改了，文件其实没动。
    // 预演与执行走的是同一段代码，所以两边的结论必然一致。
    const changed = countChangedPixels(before.bands[0], newBands[0]);
    if (changed === 0) {
      throw new Error(zeroImpactMessage(before.width, before.height, options?.region));
    }

    // 预演：算到这里就够了，像元数是**精确值**（不是估算），
    // 但不写盘、不备份、不替换 —— 确认卡要在用户点头之前什么都别动。
    if (options?.dryRun) {
      return {
        op,
        target: this.#abs(target),
        affectedPixels: changed,
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

    const temp = this.#tempPath(target, 'tmp.tif');
    await writeRasterPixels(this.#loc, temp, {
      width: before.width,
      height: before.height,
      bands: newBands,
      geotransform: before.geotransform,
      crs: before.crs,
    });
    const { backupPath } = await replaceFileAtomically(this.#store, { target, tempPath: temp });
    const after = await this.#read(target);

    let affected = 0;
    const a = before.bands[0];
    const b = after.bands[0];
    if (a && b) {
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) affected++;
    }

    return {
      op,
      target: this.#abs(target),
      affectedPixels: affected,
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
    };
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
    };
  }

  /** 擦除标注色块：有干净底图就从底图取像素，没有就用边界内插 */
  async erase(req: EraseRequest, options?: { readonly dryRun?: boolean }): Promise<RasterOpResult> {
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
  async replaceRegion(req: ReplaceRegionRequest, options?: { readonly dryRun?: boolean }): Promise<RasterOpResult> {
    const before = await this.#read(req.target);
    const source = await this.#read(req.source);

    if (source.width !== before.width || source.height !== before.height) {
      throw new Error('源图与目标图尺寸不一致，无法按像元替换；请先对齐两者');
    }
    if (!sameGeotransform(before.geotransform, source.geotransform)) {
      throw new Error('源图与目标图不在同一网格（仿射参数不同），请先重采样对齐');
    }

    const region = req.region ?? (req.bbox && before.geotransform
      ? geoToPixelRegion(req.bbox, before.geotransform)
      : undefined);
    if (!region) throw new Error('必须给出替换范围（region 或 bbox）');

    const alpha = buildAlphaMask(before.width, before.height, region, req.featherPx ?? 0);
    return this.#applyPixels(
      'raster.replaceRegion',
      req.target,
      (px) => blendBands(px.bands, source.bands, alpha, px.bandCount),
      {
        ...(options?.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
        // region 与 bbox 两条路最后都是像元区域，都要在写盘前跟影像对一下
        region,
      },
    );
  }

  /** 边界内插修补 */
  async inpaint(req: InpaintRequest, options?: { readonly dryRun?: boolean }): Promise<RasterOpResult> {
    const iterations = Math.max(1, Math.round((req.radiusPx ?? 4) * 2));
    return this.#applyPixels(
      'raster.inpaint',
      req.target,
      (px) => inpaintRegion(px.bands, px.width, px.height, px.bandCount, req.region, iterations),
      {
        ...(options?.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
        region: req.region,
      },
    );
  }

  /** 亮度 / 对比度调整 */
  async adjustLevels(req: { target: string } & LevelsOptions, options?: { readonly dryRun?: boolean }): Promise<RasterOpResult> {
    return this.#applyPixels('raster.adjustLevels', req.target, (px) => {
      const levels: LevelsOptions = {
        method: req.method ?? 'linear-stretch',
        ...(req.brightness !== undefined ? { brightness: req.brightness } : {}),
        ...(req.contrast !== undefined ? { contrast: req.contrast } : {}),
        ...(req.gamma !== undefined ? { gamma: req.gamma } : {}),
      };
      return adjustLevels(px.bands, levels);
    }, options);
  }

  /** 区域涂色 */
  async paint(req: PaintRequest, options?: { readonly dryRun?: boolean }): Promise<RasterOpResult> {
    const parsed = parseColor(req.color);
    return this.#applyPixels('raster.paint', req.target, (px) => {
      // 掩膜在区域里一个像元都没覆盖 → 这次不会改到任何东西。
      // 与其等它报「改了 0 像元」，不如把原因说清楚。
      if (req.mask && !maskHitsRegion(req.mask, req.region)) {
        throw new Error(
          `掩膜在区域内没有覆盖到任何像元（区域 ${describeRegion(req.region)}）：` +
            `这次不会改到任何像元`,
        );
      }
      let rgb: [number, number, number];
      if (parsed === 'sample-from-edge') {
        rgb = sampleEdgeColor(px, req.region) ?? [0, 0, 0];
      } else {
        rgb = parsed;
      }
      return px.bands.map((band, b) => {
        const out = Uint8Array.from(band);
        const value = rgb[Math.min(b, 2)]!;
        for (let y = 0; y < px.height; y++) {
          for (let x = 0; x < px.width; x++) {
            if (x >= req.region.minX && x < req.region.maxX && y >= req.region.minY && y < req.region.maxY) {
              // 有掩膜时按不透明度混合：mask=255 的效果与原来的硬写一致，
              // 所以加掩膜不会改变"纯矩形涂色"这条老路子的行为。
              // 掩膜是相对 region 的坐标，查表要减掉区域原点。
              const a = maskAlphaAtRegion(req.mask, req.region, x, y);
              if (a <= 0) continue;
              const idx = y * px.width + x;
              const old = out[idx] ?? 0;
              out[idx] = Math.round(old + (value - old) * a);
            }
          }
        }
        return out;
      });
    }, {
      ...(options?.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
      region: req.region,
    });
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

function sameGeotransform(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b || a.length < 6 || b.length < 6) return false;
  for (let i = 0; i < 6; i++) {
    if (Math.abs(a[i]! - b[i]!) > 1e-9) return false;
  }
  return true;
}

/** 前后两个波段里有几个像元不一样（第一波段为准 —— 报告里的影响像元数） */
function countChangedPixels(before: Uint8Array | undefined, after: Uint8Array | undefined): number {
  if (!before || !after) return 0;
  let changed = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed++;
  return changed;
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
