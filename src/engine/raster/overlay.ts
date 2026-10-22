/**
 * 把"改好的窗口"叠回原图，产出一个完整的新文件。
 *
 * 原理：GDAL 的 VRT 合成在**重叠位置取靠后的源**。
 * 于是 `gdalbuildvrt 原图 窗口` + `gdal_translate` 就得到
 * "窗口覆盖原图、其余原样搬运"的结果 —— 且整个搬运过程由 GDAL 流式完成，
 * Node 内存里只有那一个窗口。
 *
 * 这条路线已实测（2026-10-22，GDAL 3.13.3）：
 *   gdalbuildvrt(full.tif, win.tif) → gdal_translate → 尺寸不变、窗口内被覆盖、窗口外原样。
 *
 * ⚠️ 为什么这里处处设防：GDAL 在下面这些情况下**不失败退出**，
 * 而是打一条 Warning、把那个源跳过，**退出码仍然是 0**（GDAL 3.13.3 实测）：
 *   - 南向上（正 NS 分辨率）的源 → "does not support positive NS resolution. Skipping <file>"
 *     被跳过的是原图时，整幅原图会被换成窗口那么大（实测 40×30 变成 8×6）；
 *   - 打不开的源 → "Can't open <file>. Skipping it"
 *     窗口被静默丢弃，产出等于原图，看着完全正常。
 * 只看退出码，这些"成功"会被当真结果，所以退出码之外还必须读 stderr。
 *
 * 另一半风险是 GDAL **不吭声地做错**：gdalbuildvrt 默认的输出范围是各源的**并集**、
 * 分辨率是各源分辨率的**平均值**。窗口没完全落在原图内时产出反而比原图大
 * （实测 44×30），窗口分辨率不一致时原图像素被重采样、就不再是"原样搬运"了。
 * 因此用 -te/-tr 把输出网格钉到原图上，并在合成后再核对一次产出。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tools, type ToolResult } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';
import { readRasterFrame } from './raw.ts';
import type { RasterFrame } from './window.ts';

/** 一幅栅格在地理坐标下的覆盖范围与像元大小 */
interface Grid {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  /** 像元宽（正数） */
  readonly pixelW: number;
  /** 像元高（正数） */
  readonly pixelH: number;
}

/** 相对容差比较：地理坐标动辄 1e-7 度量级，绝对容差不够用 */
function nearlyEqual(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * scale;
}

/** 是否是整数（允许浮点运算带来的末位误差） */
function isIntegerish(v: number): boolean {
  return Math.abs(v - Math.round(v)) <= 1e-6;
}

/**
 * 栅格的地理范围。
 *
 * 用两条边的最小/最大值来定范围，这样北向上（gt[5] < 0）与南向上（gt[5] > 0）
 * 都能算出正确的地理范围 —— 建 VRT 时要拿它算 -te，不能因为方向不对就整个失真。
 */
function gridOf(frame: RasterFrame): Grid {
  const gt = frame.geotransform;
  const x0 = gt[0] ?? 0;
  const y0 = gt[3] ?? 0;
  const x1 = x0 + frame.width * (gt[1] ?? 0);
  const y1 = y0 + frame.height * (gt[5] ?? 0);
  return {
    xmin: Math.min(x0, x1),
    xmax: Math.max(x0, x1),
    ymin: Math.min(y0, y1),
    ymax: Math.max(y0, y1),
    pixelW: Math.abs(gt[1] ?? 0),
    pixelH: Math.abs(gt[5] ?? 0),
  };
}

/** gt[5] 为正就是南向上（NS 分辨率为正），gdalbuildvrt 不支持这种源 */
function assertNorthUp(gt: readonly number[], label: string): void {
  if ((gt[5] ?? 0) > 0) {
    throw new Error(`${label}是南向上（正 NS 分辨率）的栅格；VRT 合成只支持北向上，请先把它转成北向上。`);
  }
}

/**
 * 提示语必须以 GDAL 原文为准。
 *
 * gdalbuildvrt 跳过源的原因不止一种，混成一句"最常见的原因是文件不存在"
 * 会把人引到错的方向上 —— 逐条按原文分派。
 */
function skipHint(raw: string): string {
  if (/positive NS resolution/i.test(raw)) {
    return '被跳过的那个源是南向上（正 NS 分辨率）的栅格；VRT 合成只支持北向上，请先把它转成北向上。';
  }
  if (/heterogeneous projection/i.test(raw)) {
    return '被跳过的那个源与另一个源的坐标系不一致；VRT 合成要求两个源在同一坐标系里，请先重投影。';
  }
  if (/heterogeneous band data type/i.test(raw)) {
    return '被跳过的那个源与另一个源的波段类型不一致（如 UInt16 对 Byte）；合成要求波段类型相同，请先统一。';
  }
  if (/heterogeneous band color interpretation/i.test(raw)) {
    return '被跳过的那个源与另一个源的颜色解释不一致（如 Red 对 Undefined）；合成要求颜色解释一致，请先统一。';
  }
  if (/can't open|cannot open/i.test(raw)) {
    return '被跳过的那个源打不开（文件不存在或不可读）；请按上面的 GDAL 原文检查路径。';
  }
  return '请按上面的 GDAL 原文处理被跳过的源。';
}

/**
 * gdalbuildvrt "跳过某个源"时是打一条 Warning 后继续、退出码仍是 0，
 * 只看退出码会把"整幅原图被换成窗口"当成成功，所以退出码之外还必须看 stderr/stdout。
 */
function assertVrtAccepted(res: ToolResult): void {
  const stderr = res.stderr.trim();
  const stdout = res.stdout.trim();
  const raw = `${stderr}\n${stdout}`;
  if (!res.ok) {
    throw new Error(`合成 VRT 失败：\n${raw}\n${skipHint(raw)}`);
  }
  // 诊断信息通常在 stderr，但两处都查一遍；报错时只把真正有诊断的那一段端出来，
  // 免得把 gdalbuildvrt 的进度条（0...10...20...）也塞进错误消息里。
  const evidence = /warning|skipping/i.test(stderr)
    ? stderr
    : (/warning|skipping/i.test(stdout) ? stdout : '');
  if (evidence) {
    throw new Error(
      `合成失败：某个源被跳过，产出会缺少它。\nGDAL 原文：${evidence}\n${skipHint(raw)}`,
    );
  }
}

/**
 * 窗口必须与原图落在同一个像元网格上、且完整落在原图范围内。
 * 这几条 GDAL 都不吭声（照样出图，只是位置或范围不对），所以只能自己核对。
 *
 * 调用前两侧都必须是北向上（assertNorthUp 先过），此时 ymax 就是上边缘。
 */
function assertWindowOntoGrid(original: RasterFrame, window: RasterFrame): void {
  const o = gridOf(original);
  const w = gridOf(window);

  if (!nearlyEqual(o.pixelW, w.pixelW) || !nearlyEqual(o.pixelH, w.pixelH)) {
    throw new Error(
      `窗口的像元大小（${w.pixelW}×${w.pixelH}）与原图（${o.pixelW}×${o.pixelH}）不一致：` +
      '合成会按平均分辨率重采样，原图像素就不再是原样搬运了。',
    );
  }

  // 原点必须落在原图的像元网格上（相差整数个像元），否则窗口会被悄悄挪半格
  const dx = (w.xmin - o.xmin) / o.pixelW;
  const dy = (o.ymax - w.ymax) / o.pixelH;
  if (!isIntegerish(dx) || !isIntegerish(dy)) {
    throw new Error(
      `窗口与原图不在同一像元网格上（原点横向偏移 ${dx} 个像元、纵向偏移 ${dy} 个像元，不是整数）。`,
    );
  }

  // 越界的话 gdalbuildvrt 要么悄悄裁掉窗口、要么把输出范围撑大
  const tol = Math.max(o.pixelW, o.pixelH) * 1e-6;
  if (w.xmin < o.xmin - tol || w.xmax > o.xmax + tol ||
      w.ymin < o.ymin - tol || w.ymax > o.ymax + tol) {
    throw new Error(
      `窗口超出原图范围：窗口覆盖 geo x∈[${w.xmin}, ${w.xmax}]、y∈[${w.ymin}, ${w.ymax}]，` +
      `原图只有 x∈[${o.xmin}, ${o.xmax}]、y∈[${o.ymin}, ${o.ymax}]；不能悄悄裁掉或扩出去。`,
    );
  }
}

/** gdalinfo -json 里关心的那几项 */
interface RasterMeta {
  readonly width: number;
  readonly height: number;
  readonly geotransform: readonly number[];
  readonly bandType: string | null;
  readonly bandCount: number;
}

async function readMeta(loc: GdalLocation, path: string): Promise<RasterMeta> {
  const res = await tools(loc).info(path, ['-json']);
  if (!res.ok) {
    throw new Error(`读取栅格信息失败：${path}\n${res.stderr}`);
  }
  const info = JSON.parse(res.stdout) as {
    size?: [number, number];
    geoTransform?: number[];
    bands?: { type?: string }[];
  };
  const width = info.size?.[0] ?? 0;
  const height = info.size?.[1] ?? 0;
  if (!width || !height || !info.geoTransform) {
    throw new Error(`栅格信息异常（缺少尺寸或仿射参数）：${path}`);
  }
  return {
    width,
    height,
    geotransform: info.geoTransform,
    bandType: info.bands?.[0]?.type ?? null,
    bandCount: info.bands?.length ?? 0,
  };
}

/**
 * 合成完再核对一次产出：尺寸、仿射、波段类型都必须与原图一致。
 * 这是最后一道闸门 —— 上面任何一处判断漏了，产出对不上就会在这里被抓住。
 */
async function assertOutputMatchesOriginal(
  loc: GdalLocation,
  originalAbsPath: string,
  outAbsPath: string,
): Promise<void> {
  const original = await readMeta(loc, originalAbsPath);
  const out = await readMeta(loc, outAbsPath);

  if (out.width !== original.width || out.height !== original.height) {
    throw new Error(
      `合成产出的尺寸（${out.width}×${out.height}）与原图（${original.width}×${original.height}）不一致。`,
    );
  }
  const bad = out.geotransform.findIndex(
    (v, i) => !nearlyEqual(v, original.geotransform[i] ?? Number.NaN),
  );
  if (bad >= 0) {
    throw new Error(
      `合成产出的仿射参数与原图不一致：第 ${bad} 项 产出 ${out.geotransform[bad]}，原图 ${original.geotransform[bad]}。`,
    );
  }
  if (out.bandType !== original.bandType) {
    throw new Error(
      `合成产出的波段类型（${out.bandType ?? '未知'}）与原图（${original.bandType ?? '未知'}）不一致。`,
    );
  }
  if (out.bandCount !== original.bandCount) {
    throw new Error(
      `合成产出的波段数（${out.bandCount}）与原图（${original.bandCount}）不一致。`,
    );
  }
}

/**
 * 把"改好的窗口"叠回原图，产出一个与原图同尺寸、同仿射、同波段类型的新文件。
 *
 * 先建 VRT 再核对网格：建 VRT 时 GDAL 会把"跳过了哪个源"直接写进 stderr，
 * 那条原文还指名道姓，比我们自己推断的原因更权威；
 * 网格错位、窗口越界这些 GDAL 不吭声的错，再由我们自己逐条核对。
 */
export async function overlayWindowOntoRaster(
  loc: GdalLocation,
  originalAbsPath: string,
  windowAbsPath: string,
  outAbsPath: string,
): Promise<void> {
  const gdal = tools(loc);
  const tmp = mkdtempSync(join(tmpdir(), 'cartouche-overlay-'));
  try {
    const original = await readRasterFrame(loc, originalAbsPath);
    const grid = gridOf(original);

    const vrt = join(tmp, 'overlay.vrt');
    // 顺序要紧：靠后的源在重叠位置胜出，所以窗口放在最后。
    // -te/-tr 把输出网格钉死到原图（默认取各源的并集与平均分辨率，会把原图撑大）。
    const vrtRes = await gdal.buildVrt([
      '-te', String(grid.xmin), String(grid.ymin), String(grid.xmax), String(grid.ymax),
      '-tr', String(grid.pixelW), String(grid.pixelH),
      '-overwrite', vrt, originalAbsPath, windowAbsPath,
    ]);
    assertVrtAccepted(vrtRes);

    // 方向与网格再独立核对一遍：万一将来 GDAL 不再对南向上的源发 Warning，
    // 这里也得把住，不能让它悄悄画出一张翻过来的图。
    assertNorthUp(original.geotransform, `原图 ${originalAbsPath}`);
    const window = await readRasterFrame(loc, windowAbsPath);
    assertNorthUp(window.geotransform, `窗口 ${windowAbsPath}`);
    assertWindowOntoGrid(original, window);

    // 不加 -ot：加了会把 16 位压成 8 位（实测 UInt16 会被压成 255）。
    const outRes = await gdal.translate(['-of', 'GTiff', vrt, outAbsPath]);
    if (!outRes.ok) {
      throw new Error(`合成输出失败：${outAbsPath}\n${outRes.stderr}`);
    }

    await assertOutputMatchesOriginal(loc, originalAbsPath, outAbsPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
