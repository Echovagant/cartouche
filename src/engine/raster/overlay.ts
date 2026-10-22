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
 * ⚠️ 两个前提，缺一不可：
 *   1. 窗口文件必须**北向上**（正 NS 分辨率的南向上源，gdalbuildvrt 会直接拒绝）；
 *   2. 窗口必须与原图落在**同一像元网格**上（像元大小一致、原点相差整数个像元）。
 */
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { tools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';

export async function overlayWindowOntoRaster(
  loc: GdalLocation,
  originalAbsPath: string,
  windowAbsPath: string,
  outAbsPath: string,
): Promise<void> {
  const gdal = tools(loc);
  const tmp = mkdtempSync(join(tmpdir(), 'cartouche-overlay-'));
  const vrt = join(tmp, 'overlay.vrt');

  // 顺序要紧：靠后的源在重叠位置胜出，所以窗口放在最后。
  const vrtRes = await gdal.buildVrt(['-overwrite', vrt, originalAbsPath, windowAbsPath]);
  if (!vrtRes.ok) {
    throw new Error(
      `合成 VRT 失败：${originalAbsPath}\n${vrtRes.stderr}\n` +
      '若原图不是北向上（正 NS 分辨率），VRT 合成不支持，请先转成北向上。',
    );
  }

  const outRes = await gdal.translate(['-of', 'GTiff', vrt, outAbsPath]);
  if (!outRes.ok) {
    throw new Error(`合成输出失败：${outAbsPath}\n${outRes.stderr}`);
  }
}
