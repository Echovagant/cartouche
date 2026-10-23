/**
 * 矢量要素写回。
 *
 * ## 写回不是原子的，这是不打折的取舍
 *
 * Shapefile 是一个**数据集**，不是一个文件：`.shp/.shx/.dbf/.prj/.cpg` 五个文件
 * 缺一个就打不开，投影丢了更是隐蔽 —— 图层照常显示，只是坐标全错。
 *
 * 一组文件没法一次全换（文件系统没有"原子替换一组文件"这回事）。
 * 这里的选择是：**整组先备好，再逐个原子替换，换到一半失败就从备份恢复。**
 *
 *   1. 备份：把目标这套文件整份复制到 `<目标>.bak.<时间戳>/` 目录里
 *      （目录而不是散落的 .bak 文件 —— 散落的备份回滚时容易漏掉 .dbf，
 *      拿回来的东西打不开）；
 *   2. 替换：每个文件各自 rename 覆盖（同目录 → 同卷 → 真正的原子替换）；
 *   3. 回滚：任何一个环节出错，把备份里的文件逐个复制回去，
 *      并删掉这一轮新造出来的文件，数据回到原样；
 *   4. 收尾：清掉旧文件里这一轮没再产生的那些（例如源数据没有坐标系时的 .prj）——
 *      留着旧 .prj 等于对新数据撒谎。
 *
 * 代价：第 2 步中途失败时，磁盘上存在一个"换了几个文件"的瞬间。
 * 这个窗口无法消除（除非换格式），但第 3 步保证它**最终会被撤销**，
 * 而且备份始终完整可取。
 *
 * ## 坐标系必须原样带过去
 *
 * GeoJSON 按约定是 WGS84 经纬度，直接来回转会把投影改掉。
 * 这里把源图层的坐标系 WKT 取出来，写回时用 `-a_srs` 原样带上，
 * 写完再核一遍：坐标系变了就回滚并报错。
 */
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { tools } from '../gdal/runner.ts';
import { replaceFileAtomically } from '../gdal/writeback.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';
import { makeTempDir, timestamp, toRelPathChecked } from './paths.ts';
import { probeLayer, sameSrs } from './read.ts';
import {
  VectorError,
  type FeatureRecord,
  type LayerInfo,
  type VectorWriteFormat,
  type WriteFeaturesOptions,
  type WriteFeaturesResult,
} from './types.ts';

/**
 * Shapefile 的数据部件与索引文件。
 *
 * 为什么要把索引文件（.qix/.sbn…）也管起来：要素条数变了之后旧索引就是错的，
 * 留着会让 ArcGIS 读到错乱的结果。它们是可再生的缓存，删掉最干净。
 *
 * `.shp.xml` 不在表里 —— 那是 Esri 的元数据（用户写的说明），不该被写回顺手删掉。
 */
const SHAPEFILE_MANAGED_SUFFIXES: readonly string[] = [
  '.shp', '.shx', '.dbf', '.prj', '.cpg',
  '.qix', '.sbn', '.sbx', '.ain', '.aih', '.ixs', '.mxs', '.atx', '.fbn', '.fbx',
];

/** 相对路径的目录部分；根目录下的文件返回空串。 */
function dirOf(rel: string): string {
  const slash = rel.lastIndexOf('/');
  return slash >= 0 ? rel.slice(0, slash) : '';
}

/** 按扩展名判断写回格式。认不出来就报错，不猜。 */
export function formatForPath(path: string): VectorWriteFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith('.shp')) return 'shapefile';
  if (lower.endsWith('.geojson') || lower.endsWith('.json')) return 'geojson';
  throw new VectorError(
    `写回只支持 .shp 与 .geojson，这个文件是 ${basename(path)}（换个格式再试）`,
  );
}

/** 要素数组 → GeoJSON 文本。 */
export function featuresToGeoJson(features: readonly FeatureRecord[]): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: features.map((f) => {
      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(f.properties)) {
        // undefined 在 JSON 里会被整个丢掉，那一列就没了 —— 换成 null 才表示"这一列有但没值"
        properties[k] = v === undefined ? null : v;
      }
      return {
        type: 'Feature',
        properties,
        geometry: f.geometry
          ? { type: f.geometry.type, coordinates: f.geometry.coordinates }
          : null,
      };
    }),
  });
}

/** 目标文件旁边现存的那套数据文件（工作区相对路径）。 */
async function existingDataFiles(
  store: WorkspaceAdapter,
  targetRel: string,
  format: VectorWriteFormat,
): Promise<string[]> {
  const dirRel = dirOf(targetRel);
  const base = basename(targetRel);
  const stem = base.replace(/\.[^.]+$/, '');
  // 后缀按**目标文件自己的扩展名**算：'cities.json' 的备份不能漏掉它自己
  const ownSuffix = base.slice(stem.length).toLowerCase();
  const suffixes =
    format === 'shapefile'
      ? SHAPEFILE_MANAGED_SUFFIXES
      : [ownSuffix, '.geojson', '.json'].filter((s) => s !== '');
  let names: string[];
  try {
    names = await store.list(dirRel);
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (!lower.startsWith(`${stem.toLowerCase()}.`)) continue;
    if (!suffixes.some((s) => lower.endsWith(s))) continue;
    hits.push(dirRel ? `${dirRel}/${name}` : name);
  }
  return hits.sort();
}

/**
 * 把一套文件写回目标。
 *
 * @throws {VectorError} 转换失败、备份失败、替换失败、回滚失败、写完校验不过。
 */
export async function writeFeatures(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  options: WriteFeaturesOptions,
): Promise<WriteFeaturesResult> {
  const targetRel = toRelPathChecked(options.target, 'target');
  const targetAbs = store.resolve(targetRel);
  const format = options.format ?? formatForPath(targetAbs);
  const gdal = tools(loc);

  // 源数据（也就是将被覆盖的那个文件）的坐标系：写回时原样带过去
  let sourceInfo: LayerInfo | null = null;
  if (existsSync(targetAbs)) {
    sourceInfo = await probeLayer(loc, targetAbs);
  }

  const tempDir = makeTempDir(targetAbs);
  // 中间 GeoJSON 的名字要带随机尾巴：目标文件本身就叫 write.geojson 时，
  // 固定名字会跟输出撞在一起（输入被输出覆盖，读到的是自己）
  const tempGeoJson = join(tempDir, `input-${randomBytes(6).toString('hex')}.geojson`);
  const tempOut = join(tempDir, basename(targetAbs));

  try {
    writeFileSync(tempGeoJson, featuresToGeoJson(options.features), 'utf8');

    const args: string[] = ['-f', format === 'shapefile' ? 'ESRI Shapefile' : 'GeoJSON'];
    if (format === 'shapefile') {
      // 不给 ENCODING 时 Shapefile 驱动默认 ISO-8859-1，
      // 中文的列名会直接写失败（实测：Failed to create field name '列 名'）
      args.push('-lco', 'ENCODING=UTF-8');
    }
    if (sourceInfo?.srsWkt) {
      // 只贴标签不重投影：坐标原样搬过去，坐标系标签原样带过去
      args.push('-a_srs', sourceInfo.srsWkt);
    }
    // ⚠️ ogr2ogr 的参数顺序是 **dst 在前、src 在后**
    //    输出名必须与目标同名 —— Shapefile 的伴随文件靠"同名"被认出来
    args.push(tempOut, tempGeoJson);

    const res = await gdal.ogr2ogr(args);
    if (!res.ok) {
      throw new VectorError(`写不进去：${targetRel}（GDAL 转换失败）`, res.stderr);
    }
    if (!existsSync(tempOut)) {
      throw new VectorError(`写回失败：转换命令跑完了但没产出文件（${targetRel}）`, res.stderr);
    }

    const produced = readdirSync(tempDir).filter((n) => n !== basename(tempGeoJson));
    if (produced.length === 0) {
      throw new VectorError(`写回失败：没有产出任何文件（${targetRel}）`, res.stderr);
    }

    const dirRel = dirOf(targetRel);
    const producedRel = produced.map((n) => (dirRel ? `${dirRel}/${n}` : n));
    const oldFiles = await existingDataFiles(store, targetRel, format);

    // ── 1) 整组备份 ───────────────────────────────────────────────
    const backupRel = `${targetRel}.bak.${options.label ?? timestamp()}`;
    let backupDone = false;
    if (oldFiles.length > 0) {
      try {
        for (const rel of oldFiles) {
          await store.copy(rel, `${backupRel}/${basename(rel)}`);
        }
        backupDone = true;
      } catch (err) {
        throw new VectorError(
          `写回中止：备份原文件失败，没有动过任何数据（${targetRel}）`,
          String(err),
          err,
        );
      }
    }

    // ── 2) 逐个原子替换 ───────────────────────────────────────────
    const touched: string[] = [];
    try {
      for (const rel of producedRel) {
        const tempAbs = join(tempDir, basename(rel));
        await replaceFileAtomically(store, {
          target: rel,
          tempPath: tempAbs,
          // 备份由上面整组做：这里再各自备一份，备份会散成几个文件，回滚时容易漏
          backup: false,
        });
        touched.push(rel);
      }
    } catch (err) {
      await rollback(store, backupRel, oldFiles, touched, backupDone);
      throw new VectorError(
        `写回失败，已经回滚到原样（${targetRel}）：${(err as Error).message}`,
        '',
        err,
      );
    }

    // ── 3) 清掉这一轮没再产生的旧文件 ─────────────────────────────
    // 例如源数据没有坐标系时旧 .prj 还在 —— 留着它等于对新数据撒谎
    const stale = oldFiles.filter((rel) => !producedRel.includes(rel));
    const removed: string[] = [];
    for (const rel of stale) {
      try {
        await store.remove(rel);
        removed.push(rel);
      } catch {
        // 清不掉不算写回失败：它是旧索引/旧标记，不影响数据能不能打开
      }
    }

    // ── 4) 写完核对：打不开、条数不对、坐标系变了，都算写坏 ──────
    try {
      const after = await probeLayer(loc, targetAbs);
      if (after.featureCount !== options.features.length) {
        throw new VectorError(
          `写回后要素数不对：写进去 ${options.features.length} 条，读回来 ${after.featureCount} 条`,
        );
      }
      if (sourceInfo && !sameSrs(sourceInfo, after)) {
        throw new VectorError(
          '写回后坐标系变了（投影丢了）：已经回滚，原数据的坐标系保持不变',
        );
      }
      return {
        backupPath: backupDone ? backupRel : null,
        files: producedRel,
        removed,
        fieldNames: after.fields.map((f) => f.name),
        featureCount: after.featureCount,
      };
    } catch (err) {
      await rollback(store, backupRel, oldFiles, touched, backupDone);
      throw new VectorError(
        `写回后校验没通过，已经回滚到原样（${targetRel}）：${(err as Error).message}`,
        '',
        err,
      );
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * 回滚：把备份里的文件逐个复制回去，并删掉这一轮新造出来的文件。
 *
 * 为什么回滚也用 copy 而不是 rename：备份目录在同一个卷上，
 * 但 copy 不会把备份本身搬走 —— 回滚之后备份还在，用户还能再查一次。
 */
async function rollback(
  store: WorkspaceAdapter,
  backupRel: string,
  oldFiles: readonly string[],
  touched: readonly string[],
  backupDone: boolean,
): Promise<void> {
  if (backupDone) {
    for (const rel of oldFiles) {
      try {
        await store.copy(`${backupRel}/${basename(rel)}`, rel);
      } catch {
        // 回滚失败要让人知道：原样抛出去，上面会把它写进错误消息
        throw new Error(`回滚也失败了（${rel}）：备份在 ${backupRel}，请从备份里手工恢复`);
      }
    }
  }
  for (const rel of touched) {
    if (!oldFiles.includes(rel)) {
      try {
        await store.remove(rel);
      } catch {
        /* 删不掉就留着：它不参与旧数据的读取 */
      }
    }
  }
}

/** 给报告用：这个数据文件由哪些文件组成。 */
export function companionFiles(targetRel: string): string[] {
  const stem = targetRel.replace(/\.[^.]+$/, '');
  return SHAPEFILE_MANAGED_SUFFIXES.map((s) => `${stem}${s}`);
}
