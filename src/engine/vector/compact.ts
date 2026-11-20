/**
 * `vector.compact`：压缩瘦身——把"删除"留下的残留真正从文件里清掉。
 *
 * 两种格式的"删除"在磁盘上留下的东西不一样：
 *  - Shapefile：feature.delete 只在 .dbf 上打删除标记（0x2A），文件体积不变，
 *    `ogrinfo -so` 的要素数仍按头里的记录数显示。压缩 = 让 GDAL 读一遍
 *    （被标记的记录它本来就不显示）重写出一套干净的 .shp/.shx/.dbf，
 *    再整组原子替换（伴随文件先换、主文件最后换，见 writeback.ts）。
 *  - GeoPackage：DELETE 只把页标成可复用，空间不还给操作系统。压缩 = VACUUM。
 *
 * 为什么 Shapefile 压缩不走手写 .shp/.shx 解析：重写索引要正确处理十几种
 * 形状类型与 Z/M 变体，风险高收益低；GDAL 的同格式拷贝就是这条路的成熟实现，
 * 字段定义（类型 / 宽度 / 精度）在拷贝时原样保留。
 *
 * 明确不做的事：
 *  - 不动 .shp.xml（那是用户写的元数据，管理名单里故意不含它，见 write.ts）；
 *  - .qix/.sbn 这类旧空间索引随整组清理一起消失（可再生的缓存，留着是错的）；
 *  - 没有删除标记 / 没有可回收空间时明确说"不需要"，不做无意义的重写。
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { OpValueResult } from '../ops/executor.ts';
import { tools } from '../gdal/runner.ts';
import { replaceFileGroupAtomically } from '../gdal/writeback.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';
import { probeLayer } from './read.ts';
import { toRelPathChecked } from './paths.ts';
import { VectorError } from './types.ts';
import { countActiveRecords, dbfPathOf, isShapefilePath, readDbfHeader } from './dbf.ts';
import {
  gpkgCheckpoint,
  gpkgCount,
  gpkgExec,
  gpkgQuery,
  touchGpkgLastChange,
} from './gpkg-native.ts';
import { requireString } from '../feature/common.ts';
import { existingDataFiles } from './write.ts';

/** DBF 编码 → GDAL 的 -lco ENCODING 取值（三种都在 GDAL 的识别表里） */
const GDAL_ENCODING: Record<string, string> = {
  GBK: 'GBK',
  'UTF-8': 'UTF-8',
  LATIN1: 'LATIN1',
};

/** 一组文件的字节合计（不存在按 0） */
function groupBytes(dirAbs: string, files: readonly string[]): number {
  let total = 0;
  for (const name of files) {
    try {
      total += statSync(join(dirAbs, name)).size;
    } catch {
      /* 文件不在就不计 */
    }
  }
  return total;
}

/** 格式化的字节数（报告用） */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 执行 vector.compact。
 *
 * @throws {VectorError} 格式不支持、Shapefile 组备份或替换失败、压缩后要素数不对。
 */
export async function runVectorCompact(
  params: Readonly<Record<string, unknown>>,
  deps: { loc: GdalLocation; store: WorkspaceAdapter },
  dryRun = false,
): Promise<OpValueResult> {
  const rawTarget = requireString(params, 'target', '要压缩的图层，dataset:// 开头');
  const targetRel = toRelPathChecked(rawTarget, 'target');
  const abs = deps.store.resolve(targetRel);
  const info = await probeLayer(deps.loc, abs);

  if (isShapefilePath(abs)) {
    return compactShapefile(deps, targetRel, abs, info, dryRun);
  }
  if (/\.gpkg$/i.test(abs)) {
    return compactGpkg(deps.loc, targetRel, abs, info, dryRun);
  }
  throw new VectorError(
    '压缩只支持 Shapefile 与 GeoPackage：' +
      'GeoJSON / KML / GML 的写回本来就是整层重写，不会留下删除残留；' +
      '栅格格式没有"删除标记"这回事。',
  );
}

/* ── Shapefile：GDAL 同格式重写 + 整组原子替换 ───────────────── */

async function compactShapefile(
  deps: { loc: GdalLocation; store: WorkspaceAdapter },
  targetRel: string,
  abs: string,
  info: {
    readonly featureCount: number;
    readonly layerName: string;
    readonly fields: readonly { readonly name: string }[];
  },
  dryRun: boolean,
): Promise<OpValueResult> {
  const header = readDbfHeader(abs, dbfPathOf(abs));
  const active = countActiveRecords(header, dbfPathOf(abs));
  const removed = header.recordCount - active;
  const dirAbs = dirname(abs);
  const stem = basename(abs).replace(/\.shp$/i, '');
  const oldNames = readdirSync(dirAbs).filter((name) =>
    name.toLowerCase().startsWith(`${stem.toLowerCase()}.`),
  );
  const beforeBytes = groupBytes(dirAbs, oldNames);

  if (removed <= 0) {
    const note =
      `没有删除标记（头里 ${header.recordCount} 条记录都是有效的），不需要压缩。` +
      '「文件变小」要靠删除后再压缩；没有删过东西的文件本来就是干净的。';
    return {
      kind: 'value',
      summary: note,
      data: {
        target: targetRel,
        compacted: false,
        recordCount: header.recordCount,
        activeCount: active,
        bytesBefore: beforeBytes,
        featureCount: info.featureCount,
        ...(dryRun ? { dryRun: true } : {}),
      },
    };
  }

  const encoding = GDAL_ENCODING[header.encoding] ?? 'UTF-8';
  if (dryRun) {
    return {
      kind: 'value',
      summary:
        `将重写一套干净的 .shp/.shx/.dbf：头里 ${header.recordCount} 条记录，` +
        `${removed} 条已标记删除，压完剩 ${active} 条；` +
        `现体积 ${fmtBytes(beforeBytes)}（整组备份后原子替换；字段定义原样保留）`,
      data: {
        target: targetRel,
        compacted: true,
        dryRun: true,
        recordCount: header.recordCount,
        activeCount: active,
        removedMarked: removed,
        bytesBefore: beforeBytes,
        encoding: header.encoding,
      },
    };
  }

  // 临时目录放在目标同目录（同卷才能整组 rename）；用完即删
  const hex = randomBytes(3).toString('hex');
  const tempDir = join(dirAbs, `.compact-${hex}`);
  mkdirSync(tempDir, { recursive: true });
  const tempShp = join(tempDir, `${stem}.shp`);
  try {
    const res = await tools(deps.loc).ogr2ogr([
      '-f',
      'ESRI Shapefile',
      '-lco',
      `ENCODING=${encoding}`,
      tempShp,
      abs,
    ]);
    if (!res.ok) {
      throw new VectorError(
        `GDAL 重写 Shapefile 失败：${res.stderr.split(/\r?\n/).filter(Boolean).pop() ?? '未知原因'}`,
        res.stderr,
      );
    }

    // 换之前先核对临时产物：列名与顺序一致、要素数等于有效记录数
    const tmpInfo = await probeLayer(deps.loc, tempShp);
    if (tmpInfo.featureCount !== active) {
      throw new VectorError(
        `压缩产物里是 ${tmpInfo.featureCount} 条要素，应为 ${active} 条；已停止，原文件未动。`,
      );
    }
    if (tmpInfo.fields.length !== info.fields.length) {
      throw new VectorError(
        `压缩产物的列数（${tmpInfo.fields.length}）与原图层（${info.fields.length}）不一致；` +
          '已停止，原文件未动。',
      );
    }
    for (let i = 0; i < info.fields.length; i += 1) {
      if (tmpInfo.fields[i]!.name !== info.fields[i]!.name) {
        throw new VectorError(
          `压缩产物的第 ${i + 1} 列是「${tmpInfo.fields[i]!.name}」，原图层是「${info.fields[i]!.name}」；` +
            '已停止，原文件未动。',
        );
      }
    }

    // .shp.xml 是用户元数据：拷进临时目录让它跟着整组替换活下来
    const metaSrc = join(dirAbs, `${stem}.shp.xml`);
    try {
      const { copyFileSync } = await import('node:fs');
      copyFileSync(metaSrc, join(tempDir, `${stem}.shp.xml`));
    } catch {
      /* 本来就没有元数据 */
    }

    const produced = readdirSync(tempDir);
    const managed = await existingDataFiles(deps.store, targetRel, 'shapefile');
    const { backupPath } = await replaceFileGroupAtomically(deps.store, {
      target: targetRel,
      tempDir,
      produced,
      managed,
      backup: true,
      label: 'compact',
    });

    // 换完核对：头里记录数 = 有效数（删除标记已清），要素数一致
    const afterHeader = readDbfHeader(abs, dbfPathOf(abs));
    if (afterHeader.recordCount !== active) {
      throw new VectorError(
        `压缩后 .dbf 头里的记录数是 ${afterHeader.recordCount}，应为 ${active}。备份在 ${backupPath ?? '（没有）'}`,
      );
    }
    const after = await probeLayer(deps.loc, abs);
    if (after.featureCount !== active) {
      throw new VectorError(
        `压缩后读回来 ${after.featureCount} 条要素，应为 ${active} 条。备份在 ${backupPath ?? '（没有）'}`,
      );
    }

    const afterNames = readdirSync(dirAbs).filter((name) =>
      name.toLowerCase().startsWith(`${stem.toLowerCase()}.`),
    );
    const afterBytes = groupBytes(dirAbs, afterNames);
    const freed = beforeBytes - afterBytes;
    const caveats: string[] = [
      `删除标记清掉 ${removed} 条（剩 ${active} 条）`,
      `体积 ${fmtBytes(beforeBytes)} → ${fmtBytes(afterBytes)}`,
      '字段定义与编码原样保留',
    ];
    if (freed <= 0) caveats.push('体积没有变化（删除的记录本来就少，或已经被别的工具清理过）');

    return {
      kind: 'value',
      summary:
        `已压缩：清掉 ${removed} 条删除标记，剩 ${active} 条要素；` +
        `体积 ${fmtBytes(beforeBytes)} → ${fmtBytes(afterBytes)}` +
        `（整组备份在 ${backupPath ?? '（没有）'}）`,
      data: {
        target: targetRel,
        compacted: true,
        recordCount: header.recordCount,
        activeCount: active,
        removedMarked: removed,
        bytesBefore: beforeBytes,
        bytesAfter: afterBytes,
        ...(freed > 0 ? { freed } : {}),
        featureCount: after.featureCount,
        backupPath: backupPath ?? undefined,
        removedFiles: oldNames.filter((n) => !afterNames.includes(n)),
      },
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/* ── GeoPackage：VACUUM ──────────────────────────────────────── */

async function compactGpkg(
  loc: GdalLocation,
  targetRel: string,
  abs: string,
  info: { readonly featureCount: number; readonly layerName: string },
  dryRun: boolean,
): Promise<OpValueResult> {
  // page_count × page_size：VACUUM 之前与之后各看一次，差值就是还给操作系统的空间
  const sizeRows = await gpkgQuery(
    loc,
    abs,
    'SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()',
  );
  const beforeBytes = Number(sizeRows[0]?.['n'] ?? 0);

  if (dryRun) {
    return {
      kind: 'value',
      summary:
        `将 VACUUM 整理 GeoPackage：现占 ${fmtBytes(beforeBytes)}；` +
        '删过要素的库能把空闲页还给操作系统（没删过就没有可回收的空间）',
      data: {
        target: targetRel,
        compacted: true,
        dryRun: true,
        bytesBefore: beforeBytes,
        featureCount: info.featureCount,
      },
    };
  }

  await gpkgExec(loc, abs, 'VACUUM');
  await gpkgCheckpoint(loc, abs);
  await touchGpkgLastChange(loc, abs, info.layerName);

  const afterRows = await gpkgQuery(
    loc,
    abs,
    'SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()',
  );
  const afterBytes = Number(afterRows[0]?.['n'] ?? 0);
  const afterCount = await gpkgCount(loc, abs, info.layerName);
  if (afterCount !== info.featureCount) {
    throw new VectorError(
      `压缩后要素数不对：原来 ${info.featureCount} 条，现在 ${afterCount} 条。`,
    );
  }

  const freed = beforeBytes - afterBytes;
  const caveats: string[] = [
    `体积 ${fmtBytes(beforeBytes)} → ${fmtBytes(afterBytes)}`,
  ];
  if (freed <= 0) caveats.push('没有可回收的空间（删掉的要素本来就不多）');

  return {
    kind: 'value',
    summary:
      `已 VACUUM：体积 ${fmtBytes(beforeBytes)} → ${fmtBytes(afterBytes)}，` +
      `${afterCount} 条要素原样都在（${caveats.join('；')}）`,
    data: {
      target: targetRel,
      compacted: true,
      bytesBefore: beforeBytes,
      bytesAfter: afterBytes,
      ...(freed > 0 ? { freed } : {}),
      featureCount: afterCount,
    },
  };
}
