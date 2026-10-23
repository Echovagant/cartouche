/**
 * `vector.reproject`：把图层重投影到另一个坐标系。
 *
 * 对应 ArcGIS Pro 的"数据管理 → 投影工具"。这一步是 Pro 用户最容易踩坑的地方：
 * 投影没做、或者只改了坐标系标签没换坐标，图看起来"还是那样"，
 * 一叠加就整体偏移 —— 而 Pro 不会报错。
 *
 * ## 这个 op 的核心是"坐标真的换了"
 *
 * 实测钉死的 GDAL 语义：
 *  - `-t_srs` **真换坐标**；`-a_srs` **只贴标签**（源 x=500000 时，
 *    `-t_srs EPSG:4326` 得到 x≈2.99，`-a_srs EPSG:4326` 的 x 仍是 500000）。
 *    所以这里一律用 `-t_srs`。
 *  - ogr2ogr 出错**也可能返回退出码 0**，所以产出必须逐项核对
 *    （文件在不在、要素数对不对、坐标变没变），不能只看退出码。
 *
 * 因此写回之后要核对三件事：**坐标系变成目标 CRS、要素数不变、坐标真的变了**。
 * 第三条最容易漏 —— 只贴了标签的话，前两条都会"通过"，而数据是错的。
 *
 * ## alignTo 是什么
 *
 * 契约里 alignTo 的意思是"按另一个图层对齐"。它给两样东西：
 *  - **目标坐标系**：to 写 auto 时由它推导；
 *  - **目标网格**：对齐图层是栅格时，它的像元大小就是"一个像元"的尺度，
 *    用来核对转换残差（maxResidualPx）；它的范围用来核对重投影后的数据
 *    是不是真的落在这张图上。
 *
 * 对齐图层是矢量时没有像元网格，只有坐标系与范围 —— 这时给 maxResidualPx
 * 会直接报错，而不是悄悄跳过这道核对。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tools } from '../gdal/runner.ts';
import { gdalEnv } from '../gdal/env.ts';
import { probeDataset } from '../gdal/probe.ts';
import type { GdalLocation } from '../gdal/env.ts';
import { probeLayer, readFeatures } from './read.ts';
import { writeFeatures } from './write.ts';
import { makeTempDir, toRelPathChecked } from './paths.ts';
import { readNumberParam, readStringParam } from './params.ts';
import { encodingForWriteback } from './encoding.ts';
import {
  crsEqual,
  crsIdentity,
  crsIdentityFromSpec,
  crsLabel,
  explainCrsFailure,
  probeCrsSupport,
  type CrsIdentity,
} from './crs.ts';
import { VectorError, type FeatureRecord } from './types.ts';
import type { OpValueResult } from '../ops/executor.ts';
import type { VectorOpDeps } from './query.ts';

/** 契约里 resample 的取值全集。 */
const RESAMPLE_METHODS = ['nearest', 'bilinear', 'cubic'] as const;
type ResampleMethod = (typeof RESAMPLE_METHODS)[number];

/** 对齐图层给出的参照网格。 */
interface AlignGrid {
  readonly kind: 'raster' | 'vector';
  /** 栅格的像元大小（目标 CRS 的单位）；矢量没有 */
  readonly pixelSize: readonly [number, number] | null;
  /** 对齐图层的范围 */
  readonly extent: readonly [number, number, number, number] | null;
  readonly crs: CrsIdentity;
  /** 栅格还是矢量的说明，给报告看 */
  readonly label: string;
}

/** GeoJSON 的一个 feature → 引擎的要素形状。 */
function toFeatureRecord(raw: unknown): FeatureRecord {
  const obj = (raw ?? {}) as {
    properties?: Record<string, unknown> | null;
    geometry?: { type?: string; coordinates?: unknown } | null;
  };
  const properties = obj.properties ?? {};
  const geometry =
    obj.geometry && typeof obj.geometry.type === 'string'
      ? { type: obj.geometry.type, coordinates: obj.geometry.coordinates ?? null }
      : null;
  return { properties, geometry };
}

/** 递归找出第一个坐标点 [x, y]。 */
function firstVertex(features: readonly FeatureRecord[]): [number, number] | null {
  const walk = (node: unknown): [number, number] | null => {
    if (!Array.isArray(node) || node.length === 0) return null;
    const head = node[0];
    if (typeof head === 'number' && typeof node[1] === 'number') {
      return [head, node[1]];
    }
    for (const child of node) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  for (const f of features) {
    const hit = walk(f.geometry?.coordinates);
    if (hit) return hit;
  }
  return null;
}

/** 所有要素的范围。 */
function boundsOf(
  features: readonly FeatureRecord[],
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (node: unknown): void => {
    if (!Array.isArray(node) || node.length === 0) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const x = node[0] as number;
      const y = node[1] as number;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    for (const child of node) walk(child);
  };
  for (const f of features) walk(f.geometry?.coordinates);
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return [minX, minY, maxX, maxY];
}

/** 两个坐标点是不是同一个（相对误差 1e-12 以内当作相同）。 */
function samePoint(a: readonly [number, number], b: readonly [number, number]): boolean {
  const scale = Math.max(1, Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]));
  return Math.abs(a[0] - b[0]) <= 1e-12 * scale && Math.abs(a[1] - b[1]) <= 1e-12 * scale;
}

/** 栅格的仿射参数 → 范围。 */
function extentFromGeoTransform(
  gt: readonly number[],
  width: number,
  height: number,
): [number, number, number, number] | null {
  const [ox, px, rx, oy, ry, py] = gt;
  if (
    ox === undefined || px === undefined || rx === undefined ||
    oy === undefined || ry === undefined || py === undefined
  ) {
    return null;
  }
  const xs: number[] = [];
  const ys: number[] = [];
  const corners: Array<[number, number]> = [[0, 0], [width, 0], [0, height], [width, height]];
  for (const corner of corners) {
    const col = corner[0];
    const row = corner[1];
    xs.push(ox + col * px + row * rx);
    ys.push(oy + col * ry + row * py);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** 全部要素的第一个顶点（最多取前若干个，作为残差抽样的点）。 */
function sampleVertices(features: readonly FeatureRecord[], limit: number): [number, number][] {
  const out: [number, number][] = [];
  for (const f of features) {
    if (out.length >= limit) break;
    const hit = firstVertex([f]);
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * 用 gdaltransform 独立算一遍坐标变换的结果。
 *
 * 为什么要另开一条路：ogr2ogr 走的是"图层坐标变换"那条管线，
 * gdaltransform 走的是"点坐标变换"那条 —— 两者独立。
 * 拿它们的结果互相比对，才能发现"引擎以为转了、其实没转"这类问题。
 *
 * ⚠️ 这里没有走 gdal/runner.ts 的 runTool：那个封装不接受标准输入，
 * 而 gdaltransform 是从 stdin 读坐标的。环境变量仍用引擎自己的 gdalEnv，
 * 否则 PROJ 数据目录找不到、转换会静默失败。
 *
 * 返回 null 表示这条独立路径算不出来（工具没装、或源/目标 CRS 认不出）。
 */
async function transformPointsIndependently(
  loc: GdalLocation,
  fromSpec: string,
  toSpec: string,
  points: readonly (readonly [number, number])[],
): Promise<[number, number][] | null> {
  const exe = join(loc.binDir, `gdaltransform${loc.exeSuffix}`);
  return new Promise<[number, number][] | null>((resolve) => {
    let settled = false;
    const finish = (value: [number, number][] | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = execFile(
        exe,
        ['-s_srs', fromSpec, '-t_srs', toSpec],
        { env: gdalEnv(loc), encoding: 'utf8', windowsHide: true, timeout: 60_000 },
        (err, stdout) => {
          if (err) {
            finish(null);
            return;
          }
          const out: [number, number][] = [];
          for (const line of (stdout ?? '').trim().split(/\r?\n/)) {
            const parts = line.trim().split(/\s+/);
            const x = Number(parts[0]);
            const y = Number(parts[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
              finish(null);
              return;
            }
            out.push([x, y]);
          }
          finish(out);
        },
      );
      child.stdin?.end(`${points.map((p) => `${p[0]} ${p[1]}`).join('\n')}\n`);
    } catch {
      finish(null);
    }
  });
}

/**
 * 执行 vector.reproject。
 *
 * @throws {VectorError} 目标不存在、CRS 解析不了、要素数对不上、残差超限、写回校验不过。
 */
export async function runVectorReproject(
  params: Readonly<Record<string, unknown>>,
  deps: VectorOpDeps,
  dryRun = false,
): Promise<OpValueResult> {
  const rawTarget = readStringParam(params, 'target');
  if (rawTarget === undefined) {
    throw new Error('缺少参数 target（要重投影的图层，dataset:// 开头）');
  }
  const targetRel = toRelPathChecked(rawTarget, 'target');

  const rawTo = readStringParam(params, 'to');
  if (rawTo === undefined) {
    throw new Error('缺少参数 to（目标坐标系，如 EPSG:4490；写 auto 表示由 alignTo 推导）');
  }

  const rawOutput = readStringParam(params, 'output');
  const outputRel = rawOutput === undefined ? null : toRelPathChecked(rawOutput, 'output');

  const rawAlign = readStringParam(params, 'alignTo');
  const alignRel = rawAlign === undefined ? null : toRelPathChecked(rawAlign, 'alignTo');

  const rawResample = readStringParam(params, 'resample') ?? 'bilinear';
  if (!RESAMPLE_METHODS.includes(rawResample as ResampleMethod)) {
    throw new Error(
      `参数 resample 只能是 ${RESAMPLE_METHODS.join(' / ')}，实为「${rawResample}」`,
    );
  }
  const resample = rawResample as ResampleMethod;

  const rawMaxResidual = params['maxResidualPx'];
  let maxResidualPx: number | undefined;
  if (rawMaxResidual !== undefined && rawMaxResidual !== null) {
    const value = readNumberParam(params, 'maxResidualPx');
    if (value === undefined) {
      throw new Error(`参数 maxResidualPx 必须是数字，实为 ${JSON.stringify(rawMaxResidual)}`);
    }
    if (value < 0) {
      throw new Error(`参数 maxResidualPx 不能是负数，实为 ${value}`);
    }
    maxResidualPx = value;
  }

  if (!(await deps.store.exists(targetRel))) {
    throw new Error(`目标不存在，无法重投影：${targetRel}`);
  }
  const targetAbs = deps.store.resolve(targetRel);

  const sourceInfo = await probeLayer(deps.loc, targetAbs);
  if (!sourceInfo.srsWkt) {
    throw new VectorError(
      `源图层没有坐标系，不知道该从哪个坐标系转：${targetRel}（先给图层配好坐标系再来重投影）`,
    );
  }
  const sourceCrs = crsIdentity(sourceInfo.srsWkt, sourceInfo.epsg);

  // ── 对齐图层 ───────────────────────────────────────────────────
  let grid: AlignGrid | null = null;
  if (alignRel !== null) {
    if (!(await deps.store.exists(alignRel))) {
      throw new Error(`对齐图层不存在：${alignRel}`);
    }
    const alignAbs = deps.store.resolve(alignRel);
    const { dataset, error } = await probeDataset(deps.loc, alignAbs);
    if (!dataset) {
      throw new Error(`打不开对齐图层：${alignRel}（${error?.message ?? '未知原因'}）`);
    }
    if (dataset.kind === 'raster') {
      grid = {
        kind: 'raster',
        pixelSize: dataset.pixelSize,
        extent: dataset.geotransform
          ? extentFromGeoTransform(dataset.geotransform, dataset.width, dataset.height)
          : null,
        crs: crsIdentity(dataset.crs.wkt ?? null, dataset.crs.epsg ?? null),
        label: `栅格 ${dataset.width}×${dataset.height}`,
      };
    } else {
      const alignInfo = await probeLayer(deps.loc, alignAbs);
      const alignRead = await readFeatures(deps.loc, { path: alignAbs });
      grid = {
        kind: 'vector',
        pixelSize: null,
        extent: boundsOf(alignRead.features),
        crs: crsIdentity(alignInfo.srsWkt, alignInfo.epsg),
        label: `矢量 ${alignInfo.featureCount} 个要素`,
      };
    }
  }

  // ── 目标坐标系 ─────────────────────────────────────────────────
  const isAuto = rawTo.trim().toLowerCase() === 'auto';
  let targetSpec: string;
  if (isAuto) {
    if (grid === null) {
      throw new Error('to 写 auto 时必须给 alignTo（目标坐标系由对齐图层推导）');
    }
    if (grid.crs.epsg === null && !grid.crs.wkt) {
      throw new Error(`对齐图层没有坐标系，推导不出目标坐标系：${alignRel}`);
    }
    targetSpec = grid.crs.epsg !== null ? `EPSG:${grid.crs.epsg}` : (grid.crs.wkt as string);
  } else {
    targetSpec = rawTo.trim();
  }

  const support = await probeCrsSupport(deps.loc, targetSpec);
  if (support === 'unparsable') {
    throw new VectorError(
      `坐标系「${targetSpec}」本机的 PROJ 解析不了（找不到这个坐标系定义）。` +
        '换一个本机认识的写法，例如 EPSG:4490、EPSG:4547，或直接给一段完整的 WKT。',
    );
  }

  const targetIdentity = crsIdentityFromSpec(targetSpec);
  const caveats: string[] = [];
  if (grid !== null && !isAuto) {
    // 对齐要有同一个坐标系，否则"对齐"无从谈起。
    // 两边都认得出 EPSG 时按码比；只有一边认得时不硬比（WKT 的写法差异太大，
    // 逐字比会把同一个坐标系判成不同）—— 这种情况下要在结果里说清"没核对"。
    if (grid.crs.epsg !== null && targetIdentity.epsg !== null) {
      if (grid.crs.epsg !== targetIdentity.epsg) {
        throw new Error(
          `alignTo 的坐标系（${crsLabel(grid.crs)}）与目标坐标系（${crsLabel(targetIdentity)}）不一致；` +
            '对齐要求同一个坐标系。要按对齐图层走就把 to 写成 auto。',
        );
      }
    } else {
      caveats.push(
        `alignTo（${crsLabel(grid.crs)}）与目标坐标系（${crsLabel(targetIdentity)}）` +
          '没法逐项比对（其中一个是自定义坐标系），没有强制核对两者是否同一个',
      );
    }
  }

  // ── 转换 ───────────────────────────────────────────────────────
  const gdal = tools(deps.loc);
  const tempDir = makeTempDir(targetAbs);
  const tempGeoJson = join(tempDir, `reproject-${randomBytes(6).toString('hex')}.geojson`);

  let transformed: FeatureRecord[];
  let targetWkt: string | null;
  try {
    const res = await gdal.ogr2ogr([
      '-f', 'GeoJSON',
      '-t_srs', targetSpec,
      tempGeoJson,
      targetAbs,
    ]);
    if (!res.ok) {
      throw new VectorError(explainCrsFailure(targetSpec, res.stderr), res.stderr);
    }
    if (!existsSync(tempGeoJson)) {
      // ogr2ogr 出错也可能返回 0，所以产出必须自己看
      throw new VectorError(
        `转换命令跑完了但没产出文件：${targetRel}`,
        res.stderr,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(tempGeoJson, 'utf8'));
    } catch (err) {
      throw new VectorError(`转出来的 GeoJSON 不是合法 JSON：${targetRel}`, String(err));
    }
    const rawFeatures = Array.isArray((parsed as { features?: unknown[] }).features)
      ? (parsed as { features: unknown[] }).features
      : [];
    transformed = rawFeatures.map(toFeatureRecord);

    // 要素数必须与源一致：少一条就是数据没了
    if (transformed.length !== sourceInfo.featureCount) {
      throw new VectorError(
        `转换后要素数不对：源图层 ${sourceInfo.featureCount} 条，转出来 ${transformed.length} 条。` +
          '已中止，没有改动任何文件。',
        res.stderr,
      );
    }

    const targetInfo = await probeLayer(deps.loc, tempGeoJson);
    targetWkt = targetInfo.srsWkt;
    if (!targetWkt) {
      throw new VectorError(
        `转换后的数据读不出坐标系，写回去就成了"只有坐标没有坐标系"的坏数据：${targetRel}`,
        res.stderr,
      );
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  const targetCrs = crsIdentity(targetWkt, targetIdentity.epsg);
  const crsChanged = !crsEqual(sourceCrs, targetCrs);

  // ── 源坐标（写回前读，用于核对坐标真的变了） ────────────────────
  const sourceRead = await readFeatures(deps.loc, { path: targetAbs });
  const sourceVertex = firstVertex(sourceRead.features);
  const transformedVertex = firstVertex(transformed);

  // 只贴标签不改坐标，是这类操作最容易出的错 —— 在写盘之前就拦下来
  if (crsChanged && sourceVertex && transformedVertex && samePoint(sourceVertex, transformedVertex)) {
    throw new VectorError(
      `转换后坐标与原来一模一样：这次只换了坐标系标签，没有真的转换坐标。` +
        `已中止，没有改动任何文件（${targetRel}）。`,
    );
  }
  const coordinatesChanged = sourceVertex && transformedVertex
    ? !samePoint(sourceVertex, transformedVertex)
    : false;

  // ── 残差核对 ───────────────────────────────────────────────────
  let residualPx: number | undefined;
  let residualUnits: number | undefined;
  if (maxResidualPx !== undefined) {
    if (grid === null || grid.kind !== 'raster' || !grid.pixelSize) {
      throw new Error(
        'maxResidualPx 需要一个栅格图层来定"一个像元"多大：alignTo 现在指向的' +
          (grid === null ? '不是栅格（或者没给 alignTo）' : '是矢量（矢量没有像元网格）') +
          '。给 alignTo 一个栅格图层，或者去掉 maxResidualPx。',
      );
    }
    if (!sourceVertex || !transformedVertex) {
      throw new Error('图层里没有要素，算不出转换残差；无法核对 maxResidualPx，已中止。');
    }
    const fromSpec = sourceCrs.epsg !== null ? `EPSG:${sourceCrs.epsg}` : (sourceCrs.wkt as string);
    // 抽样多个要素的顶点一起比：只看一个点的话，局部算错会被漏掉
    const samples = sampleVertices(sourceRead.features, 32);
    const expected = await transformPointsIndependently(
      deps.loc,
      fromSpec,
      targetSpec,
      samples.length > 0 ? samples : [sourceVertex],
    );
    if (!expected || expected.length === 0) {
      throw new VectorError(
        '独立算一遍坐标变换的结果失败，无法核对转换残差；已中止，没有改动任何文件。',
      );
    }
    const px = Math.abs(grid.pixelSize[0]) || 1;
    const py = Math.abs(grid.pixelSize[1]) || 1;
    const actualSamples = sampleVertices(transformed, 32);
    for (let i = 0; i < expected.length; i += 1) {
      const actual = actualSamples[i];
      if (!actual) break;
      const dx = actual[0] - expected[i]![0];
      const dy = actual[1] - expected[i]![1];
      const units = Math.hypot(dx, dy);
      const pxResidual = Math.hypot(dx / px, dy / py);
      if (units > (residualUnits ?? 0)) residualUnits = units;
      if (pxResidual > (residualPx ?? 0)) residualPx = pxResidual;
    }
    if (residualPx === undefined) {
      throw new Error('图层里没有要素，算不出转换残差；无法核对 maxResidualPx，已中止。');
    }
    if (residualPx > maxResidualPx) {
      throw new VectorError(
        `转换残差 ${residualPx.toPrecision(6)} 像元，超出允许的 ${maxResidualPx} 像元` +
          `（偏差 ${(residualUnits ?? 0).toPrecision(6)} 个坐标单位）。已中止，没有改动任何文件。`,
      );
    }
  }

  // ── 与对齐网格的关系 ───────────────────────────────────────────
  let gridOverlap: number | null = null;
  if (grid?.extent) {
    const out = boundsOf(transformed);
    if (out) {
      const ox = Math.max(0, Math.min(out[2], grid.extent[2]) - Math.max(out[0], grid.extent[0]));
      const oy = Math.max(0, Math.min(out[3], grid.extent[3]) - Math.max(out[1], grid.extent[1]));
      const outArea = Math.max(1e-12, (out[2] - out[0]) * (out[3] - out[1]));
      gridOverlap = (ox * oy) / outArea;
    }
  }

  const caveatsExtra: string[] = [];
  if (!crsChanged) {
    caveatsExtra.push('目标坐标系与源相同，坐标值不会变（这是对的：没有可转的差异）');
  }
  if (grid && gridOverlap !== null && gridOverlap === 0) {
    caveatsExtra.push('重投影后的范围与对齐图层的范围没有重叠');
  }
  if (params['resample'] !== undefined && params['resample'] !== null) {
    caveatsExtra.push(
      `重采样方式 ${resample} 对矢量顶点不生效：顶点是按坐标变换精确移动的，` +
        '它只描述目标网格（栅格）的重采样方式',
    );
  }
  caveats.push(...caveatsExtra);

  const writeTargetRel = outputRel ?? targetRel;
  const fromLabel = crsLabel(sourceCrs);
  const toLabel = crsLabel(targetCrs);

  // ── 预演：算完了，但不写盘 ─────────────────────────────────────
  if (dryRun) {
    return {
      kind: 'value',
      summary:
        `将重投影 ${targetRel}：${fromLabel} → ${toLabel}` +
        `（${sourceInfo.featureCount} 个要素${coordinatesChanged ? '，坐标会真的转换' : '，坐标值不变'}）` +
        '（预演：没有写盘）',
      ...(outputRel ? { outputPath: outputRel } : {}),
      data: {
        target: targetRel,
        ...(outputRel ? { output: outputRel } : {}),
        to: targetSpec,
        fromCrs: fromLabel,
        toCrs: toLabel,
        ...(alignRel ? { alignTo: alignRel } : {}),
        ...(grid
          ? {
              grid: {
                kind: grid.kind,
                label: grid.label,
                ...(grid.pixelSize ? { pixelSize: grid.pixelSize } : {}),
                ...(grid.extent ? { extent: grid.extent } : {}),
                crs: crsLabel(grid.crs),
              },
            }
          : {}),
        resample,
        featureCount: sourceInfo.featureCount,
        coordinatesChanged,
        ...(residualPx !== undefined ? { residualPx } : {}),
        ...(residualUnits !== undefined ? { residualUnits } : {}),
        ...(gridOverlap !== null ? { gridOverlap } : {}),
        ...(caveats.length > 0 ? { caveats } : {}),
        dryRun: true,
      },
    };
  }

  // ── 写回 ───────────────────────────────────────────────────────
  const write = await writeFeatures(deps.loc, deps.store, {
    target: writeTargetRel,
    features: transformed,
    srsWkt: targetWkt ?? undefined,
    // 顺带把源编码带过去：重投影不该顺手把 GBK 的属性表换成 UTF-8
    encoding: encodingForWriteback(targetAbs),
  });

  // ── 写回后核对：坐标系、要素数、坐标真的变了 ───────────────────
  const writtenAbs = deps.store.resolve(writeTargetRel);
  const writtenInfo = await probeLayer(deps.loc, writtenAbs);
  if (writtenInfo.featureCount !== sourceInfo.featureCount) {
    throw new VectorError(
      `写回后要素数不对：写进去 ${sourceInfo.featureCount} 条，读回来 ${writtenInfo.featureCount} 条。` +
        `备份在 ${write.backupPath ?? '（没有）'}`,
    );
  }
  if (!crsEqual(crsIdentity(writtenInfo.srsWkt, writtenInfo.epsg), targetCrs)) {
    throw new VectorError(
      `写回后坐标系与要求的不一致（要 ${toLabel}，实际 ${crsLabel(crsIdentity(writtenInfo.srsWkt, writtenInfo.epsg))}）。` +
        `备份在 ${write.backupPath ?? '（没有）'}`,
    );
  }
  const writtenRead = await readFeatures(deps.loc, { path: writtenAbs });
  const writtenVertex = firstVertex(writtenRead.features);
  if (crsChanged && sourceVertex && writtenVertex && samePoint(sourceVertex, writtenVertex)) {
    throw new VectorError(
      `写回后坐标与原来完全一样：这次只换了坐标系标签，坐标并没有转换。` +
        `备份在 ${write.backupPath ?? '（没有）'}`,
    );
  }

  const summary =
    `${outputRel ? '已重投影并另存' : '已重投影'} ${writeTargetRel}：${fromLabel} → ${toLabel}` +
    `（${sourceInfo.featureCount} 个要素，坐标${coordinatesChanged ? '已转换' : '未变（目标与源坐标系相同）'}）` +
    (residualPx !== undefined ? `，转换残差 ${residualPx.toPrecision(4)} 像元` : '') +
    (caveats.length > 0 ? `（${caveats.join('；')}）` : '');

  return {
    kind: 'value',
    summary,
    ...(outputRel ? { outputPath: outputRel } : {}),
    data: {
      target: targetRel,
      ...(outputRel ? { output: outputRel } : {}),
      to: targetSpec,
      fromCrs: fromLabel,
      toCrs: toLabel,
      ...(alignRel ? { alignTo: alignRel } : {}),
      ...(grid
        ? {
            grid: {
              kind: grid.kind,
              label: grid.label,
              ...(grid.pixelSize ? { pixelSize: grid.pixelSize } : {}),
              ...(grid.extent ? { extent: grid.extent } : {}),
              crs: crsLabel(grid.crs),
            },
          }
        : {}),
      resample,
      featureCount: sourceInfo.featureCount,
      coordinatesChanged,
      ...(residualPx !== undefined ? { residualPx } : {}),
      ...(residualUnits !== undefined ? { residualUnits } : {}),
      ...(gridOverlap !== null ? { gridOverlap } : {}),
      ...(caveats.length > 0 ? { caveats } : {}),
      backupPath: write.backupPath,
    },
  };
}
