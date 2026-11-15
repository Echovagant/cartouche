/**
 * 矢量 → GeoJSON（供前端 MapLibre 直接消费）。
 *
 * 用 ogr2ogr 在**内存与磁盘之间**转换：先落到临时文件再读回来。
 * （GDAL 没有"输出到 stdout"的干净选项，和 ENVI 读像素时遇到的是同一类限制。）
 *
 * 多图层容器（GeoPackage / KML / KMZ）：GeoJSON 输出驱动是**单图层**的，
 * 直接整文件转换会报 "Layer … cannot be created"（2026-11-15 实测：
 * 中国水系 kmz、双图层 gpkg 都死在这）。所以这里先探图层清单，
 * **逐层转换再合并**成一个 FeatureCollection —— 前端拿到的仍是"一个文件 = 一层地图"。
 */
import { join } from 'node:path';
import { tools, type GdalTools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';
import { probeLayer } from '../vector/read.ts';

/**
 * 矢量转 GeoJSON 的入参。
 *
 * targetCrs 默认与源一致，但前端 MapLibre 只认 EPSG:4326，
 * 传投影坐标系的源时必须显式给出目标坐标系。
 */
export interface VectorToGeoJsonOptions {
  /** 矢量文件绝对路径 */
  readonly path: string;
  /** 目标坐标系；默认与源一致（MapLibre 用 EPSG:4326） */
  readonly targetCrs?: string;
  /** 只出这几个字段；不给就全部 */
  readonly fields?: readonly string[];
  /** 要素数上限，防止一次性吐太多 */
  readonly limit?: number;
  /**
   * 视口裁剪（EPSG:4326 的 [minX, minY, maxX, maxY]）：
   * 只返回与该范围相交的要素，且几何**裁剪**到范围内（-clipsrc）。
   *
   * 给了它，超大图层就能按视口分块加载 —— 128 MB 体积闸拦下的那种文件
   * 也能以「每次一小块」的方式进画布（2026-11-15 分块加载工程第一阶段）。
   *
   * ⚠️ 性能边界（真实数据实测）：正常数据裁剪是毫秒级；但几何病态的数据
   * （3 个要素 140 MB 那种）裁一次要约 2 分钟（CPU 空转的 GEOS 退化路径）——
   * 那类数据的根治是预简化金字塔，见分块加载工程的后续阶段。
   */
  readonly bbox?: readonly [number, number, number, number];
  /**
   * 图层选择器：只转换这些图层（多图层容器用）。
   *
   * 不给 = 维持原语义（≤20 层全合并 / >20 层装第一个有内容的）。
   * 给了就按交集转换（保持文件内顺序）；选了文件里不存在的层名 →
   * **整体报错**而不是静默跳过 —— 用户明确点名的东西落了空，必须说出来。
   */
  readonly layers?: readonly string[];
}

/**
 * 转换结果。
 *
 * truncated 标出是否因为 limit 被截断：要素数正好等于 limit 时无法区分
 * "刚好这么多"和"被砍掉了"，所以宁可多标一次也不让人误以为数据是全的。
 *
 * skippedLayers：多图层源里**没能转换**的图层（几何太复杂超体积闸的、
 * 转换报错的）。有内容就不算失败，但跳过了什么必须说出来 —— 不静默。
 */
export interface VectorToGeoJsonResult {
  readonly geojson: unknown;
  readonly featureCount: number;
  readonly truncated: boolean;
  /** 多图层源的加载说明（只装了第一层、有几层没装之类） */
  readonly note?: string;
  readonly skippedLayers?: readonly string[];
  /** 实际装进来的图层名（多图层源或明确选层时才有） */
  readonly layers?: readonly string[];
}

/**
 * 矢量转换失败。
 *
 * 单独一个错误类型：转换失败有三种截然不同的原因（源打不开、驱动缺失、
 * 产出不是合法 JSON），上层要分别翻译成人话，不能一律报"转换失败"。
 */
export class VectorConvertError extends Error {
  readonly stderr: string;
  /**
   * 机器可读的失败原因（可选）。
   *
   * 'payload-too-large' = 撞了体积闸：前端据此**自动降级**成视口分块重试，
   * 而不是把"去 ArcGIS 里简化几何"这句给人看的建议原样甩给用户就完事。
   */
  readonly code?: string;
  constructor(message: string, stderr: string, code?: string) {
    super(message);
    this.name = 'VectorConvertError';
    this.stderr = stderr;
    if (code) this.code = code;
  }
}

/** 单次加载的体积上限：2026-11-15 实测 140 MB 会把引擎压垮，闸定在它之下 */
const MAX_LOAD_BYTES = 128 * 1024 * 1024;

/**
 * 把矢量转成 GeoJSON 对象。
 */
export async function vectorToGeoJson(
  loc: GdalLocation,
  options: VectorToGeoJsonOptions,
): Promise<VectorToGeoJsonResult> {
  const gdal: GdalTools = tools(loc);
  const { mkdtempSync, readFileSync, rmSync, existsSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const outDir = mkdtempSync(join(tmpdir(), 'cartouche-geojson-'));

  // 视口裁剪参数（bbox 给了就每层都带）：相交过滤 + 几何裁到范围内，
  // 超大图层「每次一小块」的引擎侧基础（分块加载工程第一阶段）。
  // ⚠️ 用 -clipdst（目标坐标系里裁）而不是 -clipsrc（源坐标系里裁）：
  //    bbox 永远是 4326 经纬度，源若是投影坐标系（如 CGCS2000 高斯克吕格），
  //    clipsrc 会拿经纬度数值去套米制坐标 → 一个要素都裁不出来
  //    （2026-11-15 实测：CN_MountainRanges 投影源 bbox 加载 0 要素）。
  //    clipdst 在重投影**之后**执行，任何源坐标系都正确。
  const clipArgs: string[] = [];
  if (options.bbox) {
    const [minX, minY, maxX, maxY] = options.bbox;
    clipArgs.push('-clipdst', String(minX), String(minY), String(maxX), String(maxY));
  }

  // 先探图层清单：单图层走原路（一次转换），多图层走「中间 GPKG」两阶段。
  // 探测本身很便宜（ogrinfo -so，几百毫秒），换来的是多图层容器不再整文件炸掉。
  let info = await probeLayer(loc, options.path);
  let convertSrc = options.path;

  /**
   * 多图层的两种量级，产品语义不同（2026-11-15 裁定）：
   *   - **≤ MERGE_MAX 层**：全部合并成一个 FeatureCollection ——
   *     双图层 gpkg 这种"两张图叠一张底图"就是用户想要的；
   *   - **> MERGE_MAX 层**：只加载**第一个有要素的图层**，其余说清楚。
   *     KML 文件夹汤（实测有 3450 层的中国水系 kmz）合并等于数据爆炸；
   *     图层选择器是将来 UI 的事，引擎先把行为钉住。
   */
  const MERGE_MAX = 20;

  // ⚠️ 多图层不能逐层从原始容器转：KML/KMZ 这类**每次打开都要解析整个文件**，
  //    N 个图层 = O(N×全文件) 解析 —— 2026-11-15 实测：中国水系 kmz 逐层转换
  //    跑了 20 分钟都没完。改成两阶段：
  //    阶段一：一次 ogr2ogr 把全部图层落进中间 GPKG（多图层容器，1 次解析）；
  //    阶段二：从 GPKG 逐层转 GeoJSON 再合并 —— SQLite 直接读，每层都便宜。
  let isMultiLayer = info.layerNames.length > 1;
  let note: string | null = null;
  if (isMultiLayer && info.layerNames.length > MERGE_MAX) {
    // 超大图层汤：只装第一层。不进中间 GPKG（3450 层的转换本身就是灾难），
    // 直接从原始容器逐层尝试，前几个图层里总有带要素的。
    note =
      `这个文件有 ${info.layerNames.length} 个图层，` +
      `超过了单次合并上限（${MERGE_MAX} 层），` +
      (options.layers?.length
        ? `本次按所选图层加载（试到有内容为止）。`
        : `只加载了第一个有内容的图层；其余图层要用时可以在 ArcGIS 里按需导出，或用图层选择器勾选加载。`);
    // 指定选层就按所选来（试到有内容为止）；没指定才默认试前 8 层
    const wantedNames = options.layers?.length
      ? options.layers.filter((name) => info.layerNames.includes(name))
      : info.layerNames.slice(0, 8);
    if (options.layers?.length && wantedNames.length === 0) {
      rmSync(outDir, { recursive: true, force: true });
      throw new VectorConvertError(
        `所选图层都不在这个文件里：${options.layers.join('、')}（文件实际有 ${info.layerNames.length} 个图层）`,
        '',
      );
    }
    const firstLayers = wantedNames;
    for (const layer of firstLayers) {
      const out = join(outDir, `single-${firstLayers.indexOf(layer)}.geojson`);
      const args: string[] = ['-f', 'GeoJSON', ...clipArgs];
      if (options.targetCrs) args.push('-t_srs', options.targetCrs);
      if (options.limit !== undefined && options.limit > 0) args.push('-limit', String(options.limit));
      args.push(out, options.path, layer);
      const res = await gdal.ogr2ogr(args, { timeoutMs: 600_000 });
      if (!res.ok || !existsSync(out) || statSync(out).size < 64) continue; // 空图层（几十字节）直接换下一个
      if (statSync(out).size > MAX_LOAD_BYTES) continue; // 该层超体积闸：换下一个
      const raw = readFileSync(out, 'utf8');
      let parsed: { features?: unknown[] };
      try {
        parsed = JSON.parse(raw) as { features?: unknown[] };
      } catch {
        continue;
      }
      const layerFeatures = Array.isArray(parsed.features) ? parsed.features : [];
      if (layerFeatures.length === 0) continue;
      rmSync(outDir, { recursive: true, force: true });
      return {
        geojson: { type: 'FeatureCollection', features: layerFeatures },
        featureCount: layerFeatures.length,
        truncated:
          options.limit !== undefined && options.limit > 0 && layerFeatures.length >= options.limit,
        note: note + ` 本次加载的图层：「${layer}」（${layerFeatures.length} 个要素）。`,
        layers: [layer],
      };
    }
    rmSync(outDir, { recursive: true, force: true });
    throw new VectorConvertError(
      `多图层文件里找不到有内容的图层：${options.path}（${info.layerNames.length} 个图层，试了前 ${firstLayers.length} 个）`,
      '',
    );
  }

  if (isMultiLayer) {
    const mid = join(outDir, 'mid.gpkg');
    const midArgs: string[] = ['-f', 'GPKG'];
    if (options.targetCrs) midArgs.push('-t_srs', options.targetCrs);
    midArgs.push(mid, options.path);
    const midRes = await gdal.ogr2ogr(midArgs, { timeoutMs: 600_000 });
    if (!midRes.ok) {
      rmSync(outDir, { recursive: true, force: true });
      throw new VectorConvertError(
        `多图层文件转中间容器失败：${options.path}（${info.layerNames.length} 个图层）：` +
          (midRes.stderr || '').slice(-300),
        midRes.stderr,
      );
    }
    convertSrc = mid;
    // 中间 GPKG 的图层清单可能与源不同（KML 目录伪图层会消失）
    info = await probeLayer(loc, convertSrc);
    isMultiLayer = info.layerNames.length > 1;
  }
  const allLayers = info.layerNames.length > 0 ? info.layerNames : [''];
  // 图层选择器：指定了就按交集转换（保持文件内顺序）；一个都没对上 → 整体报错，不静默
  const chosen = options.layers;
  const layers = chosen?.length ? allLayers.filter((name) => chosen.includes(name)) : allLayers;
  if (chosen?.length && layers.length === 0) {
    rmSync(outDir, { recursive: true, force: true });
    throw new VectorConvertError(
      `所选图层都不在这个文件里：${chosen.join('、')}` +
        `（文件实际图层：${allLayers.slice(0, 6).join('、')}${allLayers.length > 6 ? ' …' : ''}）`,
      '',
    );
  }

  const skippedLayers: string[] = [];
  const converted: string[] = [];
  const features: unknown[] = [];
  let totalBytes = 0;
  let truncated = false;
  let remaining = options.limit !== undefined && options.limit > 0 ? options.limit : Infinity;

  for (const layer of layers) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const out = join(outDir, `out-${layers.indexOf(layer)}.geojson`);
    const args: string[] = ['-f', 'GeoJSON', ...clipArgs];
    if (options.targetCrs) args.push('-t_srs', options.targetCrs);
    // ⚠️ `-select` 只能给**一次**（逗号分隔多个字段）：
    //    重复给 GDAL 会报 `Duplicate argument -select`，多列时整个转换失败。
    //    （2026-10-23 实测；本仓库的矢量读写层也踩过同一个坑。）
    //    ⚠️ 多图层逐层转换时**不传 -select**：各图层的字段表不一样，
    //    对 A 层合法的字段对 B 层可能是 "Identified field … not found" 级别的硬错。
    //    字段筛选交给合并后的前端属性表。
    if (options.limit !== undefined && options.limit > 0 && Number.isFinite(remaining)) {
      args.push('-limit', String(remaining));
    }
    // ⚠️ ogr2ogr 的参数顺序是 **dst 在前、src 在后**（与 ogrinfo 相反）。
    //    写反了会把目标当成数据源去打开，报 "Unable to open datasource <目标>"。
    //    多图层容器：图层名作为 src 之后的第一个位置参数（ ogr2ogr 的选层语法）。
    args.push(out, convertSrc);
    if (layer !== '') args.push(layer);

    // 大数据（整幅全国级矢量）转换可能远超默认 120 秒：转换给足 10 分钟。
    const res = await gdal.ogr2ogr(args, { timeoutMs: 600_000 });
    if (!res.ok) {
      // 多图层源：单层失败（比如 KML 的目录伪图层）跳过并记录，不拖垮整体；
      // 单图层源（或所有层都失败）按原样报错 —— 不静默。
      if (isMultiLayer && features.length + skippedLayers.length > 0) {
        skippedLayers.push(layer);
        continue;
      }
      if (isMultiLayer) {
        // 第一层就失败：多图层容器整体转换不了，先把这一层的错记下，继续试后面的层；
        // 若后面全都没产出，最后统一报错（见循环结束后）。
        skippedLayers.push(layer);
        continue;
      }
      rmSync(outDir, { recursive: true, force: true });
      // .json 的失败要单独说人话：不是所有 .json 都是 GeoJSON，
      // 工具自己的 project.json 就不是 —— 不提示的话用户会以为是转换器坏了。
      const hint = options.path.toLowerCase().endsWith('.json')
        ? '（不是所有 .json 都是 GeoJSON：只有带要素几何的 FeatureCollection 才能当图层加载）'
        : '';
      throw new VectorConvertError(`矢量转 GeoJSON 失败：${options.path}${hint}`, res.stderr);
    }
    if (!existsSync(out)) {
      if (isMultiLayer) {
        skippedLayers.push(layer);
        continue;
      }
      rmSync(outDir, { recursive: true, force: true });
      throw new VectorConvertError(`转换命令成功但没有产出文件：${options.path}`, res.stderr);
    }

    // 体积闸逐层累计：任何一层让总量越过上限就停，已合并的层照常返回 ——
    // 转换没问题就不该崩（140 MB 事故见 git 历史），把「为什么」和「怎么办」说清楚。
    totalBytes += statSync(out).size;
    if (totalBytes > MAX_LOAD_BYTES) {
      rmSync(outDir, { recursive: true, force: true });
      throw new VectorConvertError(
        `这个图层（${layer || options.path}）的几何太复杂：累计转出来 ${(totalBytes / 1048576).toFixed(0)} MB，` +
          `超过单次加载上限（${MAX_LOAD_BYTES / 1048576} MB）—— 整份读进内存会把引擎压垮。` +
          `请在 ArcGIS 里先简化（要素 → 简化几何）或裁剪出需要的范围再加载；` +
          `也可以先用 limit 参数预览前几条确认内容。`,
        res.stderr,
        'payload-too-large',
      );
    }

    const raw = readFileSync(out, 'utf8');
    let parsed: { features?: unknown[] };
    try {
      parsed = JSON.parse(raw) as { features?: unknown[] };
    } catch {
      if (isMultiLayer) {
        skippedLayers.push(layer);
        continue;
      }
      rmSync(outDir, { recursive: true, force: true });
      throw new VectorConvertError(`产出的 GeoJSON 不是合法 JSON：${options.path}`, raw.slice(0, 200));
    }
    const layerFeatures = Array.isArray(parsed.features) ? parsed.features : [];
    if (layerFeatures.length === 0) {
      // KML 的目录伪图层、空的属性图层：正常存在，静默跳过即可（没有"失败"可言）
      continue;
    }
    features.push(...layerFeatures);
    converted.push(layer);
    remaining -= layerFeatures.length;
  }

  rmSync(outDir, { recursive: true, force: true });

  if (features.length === 0 && skippedLayers.length >= layers.length) {
    // 一个要素都没拿到，且所有层都失败了：这是真失败，不是"部分成功"
    throw new VectorConvertError(
      `矢量转 GeoJSON 失败：${options.path}（${layers.length} 个图层全部转换失败）`,
      '',
    );
  }

  const featureCount = features.length;
  if (options.limit !== undefined && options.limit > 0 && featureCount >= options.limit) {
    truncated = true;
  }

  return {
    geojson: { type: 'FeatureCollection', features },
    featureCount,
    truncated,
    ...(note ? { note } : {}),
    ...(skippedLayers.length > 0 ? { skippedLayers } : {}),
    ...(converted.length > 1 || options.layers?.length ? { layers: converted } : {}),
  };
}
