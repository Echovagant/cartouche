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
 *
 * ## GeoPackage：一个文件里的多个图层
 *
 * GPKG 看着是"一个文件"，其实是 **SQLite 容器**，一个文件里可以有多个图层。
 * 这跟 Shapefile 有两处根本不同：
 *
 *  1. **写回不能整文件换掉**。整文件换掉 = 同一文件里其它图层全没了，
 *     那是删数据，不是写回。这里改成 **只替换写的那一层**：
 *     先把原文件整份拷成工作副本，在副本上用
 *     `ogr2ogr -update -overwrite -nln <图层名>` 只动那一层，
 *     核验通过再原子替换回去。其它图层在副本里**一个字节都没动**。
 *  2. **伴随文件（-wal/-journal）要一起管**。SQLite 的预写日志里可能有
 *     还没并回主库的数据（只备份主库 = 丢数据）；
 *     而新主库旁边留着旧 -wal，文件会**整个读不出来**（实测）。
 *
 * 另外 `ogr2ogr -overwrite` 会把被替换的图层挪到**图层列表末尾**
 * —— 引擎读多图层容器读的是第一个图层，顺序一变，下次读到的就是别的图层了。
 * 所以写完要把 `gpkg_contents` 的顺序改回原样（见 restoreGpkgLayerOrder）。
 */
import { copyFileSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { tools } from '../gdal/runner.ts';
import { replaceFileAtomically } from '../gdal/writeback.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';
import { makeTempDir, timestamp, toRelPathChecked, GPKG_SIDECAR_SUFFIXES } from './paths.ts';
import { probeLayer, sameSrs, srsMatchesWkt, epsgOf, parseLayerInfo } from './read.ts';
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
  if (lower.endsWith('.gpkg')) return 'gpkg';
  throw new VectorError(
    `写回只支持 .shp、.geojson 与 .gpkg，这个文件是 ${basename(path)}（换个格式再试）`,
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

/**
 * 目标文件旁边现存的那套数据文件（工作区相对路径）。
 *
 * GPKG 的"一套"是：主库 + SQLite 伴随文件（-wal/-journal/-shm）。
 * 它们是同一个数据库的组成部分，备份与回滚必须一起算进去。
 */
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
      : format === 'gpkg'
        // GPKG 的伴随文件是紧跟完整文件名的：'a.gpkg-wal'，不是 'a-wal'
        ? [ownSuffix, ...GPKG_SIDECAR_SUFFIXES.map((s) => `${ownSuffix}${s}`)]
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
 * GPKG 的图层顺序由 `gpkg_contents` 的 rowid 决定（实测：改 rowid 后
 * `ogrinfo -al` 的列出顺序跟着变；按表名排是另一回事 —— 实测枚举顺序跟的是 rowid）。
 *
 * ## 为什么需要这一步
 *
 * `ogr2ogr -overwrite` 是"删掉旧表重建"：重建出来的新表在 `gpkg_contents` 里
 * 排到了**最后**。实测：写回"多面"之后，图层顺序从
 * `多面,多线,带高程` 变成了 `多线,带高程,多面`。
 *
 * 引擎读 GeoPackage 读的是**第一个**图层（见 read.ts 的 `readFeatures`）。
 * 顺序一变，用户下次打开读到的就是别的图层了 ——
 * 看起来像"写回把数据写到了另一个图层上"，实际是顺序被改了。
 *
 * ## 怎么改
 *
 * 先把原始行号记进一张临时表，再整体抬高，最后按原行号落位 ——
 * 直接逐个改会撞 rowid 唯一约束。
 * 改完实测 `PRAGMA integrity_check` = ok、`foreign_key_check` 无输出，
 * 且不会留下 -wal（SQLite 每次事务结束都会自己清掉）。
 */
async function restoreGpkgLayerOrder(
  loc: GdalLocation,
  path: string,
  originalOrder: readonly string[],
): Promise<void> {
  // 先把现有行号整体抬高：目标行号是 1..N，会与现有行号撞车，
  // 而 rowid 是唯一约束 —— 抬高之后落位才不会撞。
  await runGpkgSql(loc, path, 'UPDATE gpkg_contents SET rowid = rowid + 1000000');
  // 再按**原始顺序**逐个落位。
  //
  // ⚠️ 这里必须用**写回之前**拍下来的顺序，不能用当前的顺序：
  // -overwrite 已经把被替换的那层挪到了末尾，照当前顺序还原等于还原成乱序。
  for (let i = 0; i < originalOrder.length; i += 1) {
    const name = originalOrder[i]!.replace(/'/g, "''");
    await runGpkgSql(loc, path, `UPDATE gpkg_contents SET rowid = ${i + 1} WHERE table_name = '${name}'`);
  }
}

/** 对 GeoPackage 跑一条 SQLite 语句（写：改表结构与元数据）。 */
async function runGpkgSql(loc: GdalLocation, path: string, sql: string): Promise<void> {
  const res = await tools(loc).ogrInfo(['-q', '-dialect', 'SQLite', '-sql', sql, path]);
  if (!res.ok) {
    throw new VectorError(`改 GeoPackage 内部结构失败（${basename(path)}）`, res.stderr);
  }
}

/** GPKG 里一层的概况：要素数与列名。 */
interface GpkgLayerSummary {
  readonly name: string;
  readonly featureCount: number;
  readonly fields: readonly string[];
}

/**
 * 一次 `ogrinfo -so -al` 拿到**所有**图层的要素数与列名。
 *
 * 为什么不用 read.ts 的 `parseLayerInfo`：它只留第一个图层的细节
 * （后面的图层只记名字），而写回要逐层核对"别的图层有没有被动过"。
 */
function parseGpkgLayerSummaries(stdout: string): GpkgLayerSummary[] {
  const out: GpkgLayerSummary[] = [];
  let cur: { name: string; featureCount: number; fields: string[] } | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const named = /^Layer name:\s*(.+)$/.exec(line);
    if (named) {
      cur = { name: named[1]!.trim(), featureCount: 0, fields: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const counted = /^Feature Count:\s*(\d+)/.exec(line);
    if (counted) {
      cur.featureCount = Number(counted[1]);
      continue;
    }
    // 字段行长这样："名称: String (0.0)"。
    // 排除掉 Geometry:/Extent:/Layer SRS WKT: 这些同样是"名字: 值"的行。
    const field = /^([^:]+):\s+[A-Za-z0-9]+\s*\(/.exec(line);
    if (field) cur.fields.push(field[1]!.trim());
  }
  return out;
}

/** 探一个指定图层的细节（要素数、列、坐标系、几何列名、FID 列名）。 */
async function probeGpkgLayer(
  loc: GdalLocation,
  path: string,
  layerName: string,
): Promise<LayerInfo & { geometryColumn: string; fidColumn: string }> {
  const res = await tools(loc).ogrInfo(['-so', path, layerName]);
  if (!res.ok) {
    throw new VectorError(
      `读不了这个 GeoPackage 的图层「${layerName}」（${basename(path)}）`,
      res.stderr,
    );
  }
  const info = parseLayerInfo(res.stdout);
  const geometryColumn = /^Geometry Column = (.+)$/m.exec(res.stdout)?.[1]?.trim() ?? 'geom';
  const fidColumn = /^FID Column = (.+)$/m.exec(res.stdout)?.[1]?.trim() ?? 'fid';
  return { ...info, geometryColumn, fidColumn };
}

/**
 * 列出 GeoPackage 里**所有**图层（按文件里的存放顺序），每层带要素数与列名。
 *
 * 为什么不能只看第一个图层：GeoPackage 一个文件里可以有多个图层，
 * 写回只能动其中一层 —— 其余的必须原封不动地留着，所以要逐层拍快照。
 */
async function probeGpkgLayers(
  loc: GdalLocation,
  path: string,
): Promise<GpkgLayerSummary[]> {
  const res = await tools(loc).ogrInfo(['-so', '-al', path]);
  if (!res.ok) {
    throw new VectorError(`读不了这个 GeoPackage：${basename(path)}`, res.stderr);
  }
  return parseGpkgLayerSummaries(res.stdout);
}

/**
 * 写回一个 GeoPackage：**只替换指定的那一层，同一文件里的其它图层原封不动**。
 *
 * ## 为什么不是"整文件换掉"
 *
 * GeoPackage 一个文件里可以有多个图层。整文件换掉 = 别的图层全没了 —— 那是删数据。
 * 所以走的是"就地更新那一层"：
 *   1. 把原文件（连同 SQLite 伴随文件）整份拷成工作副本；
 *   2. 在副本上 `ogr2ogr -update -overwrite -nln <图层名>`，只动那一层
 *      —— 实测：其它图层的要素、字段、空间索引都原样不动；
 *   3. 核对（要素数、字段、坐标系、其它图层还在）；
 *   4. 备份原文件 → 原子替换 → 再核对一次，不过就回滚。
 *
 * ## 三个必须处理的坑（都是实测出来的）
 *
 * 1. **图层顺序**：`-overwrite` 会把被替换的图层挪到 gpkg_contents 的**最后**。
 *    引擎读的是第一个图层，顺序变了下次读到的就是别的图层 → 写完要还原顺序。
 * 2. **伴随文件**：GPKG 底层是 SQLite，旁边可能有 `-wal`/`-journal`。
 *    -wal 里可能有**还没并回主库**的数据（只备份主库 = 丢数据）；
 *    而新主库旁边留着旧 -wal，文件会**整个读不出来**（实测 malformed database schema）。
 *    所以备份与替换都得把它们算进去。
 * 3. **空图层**：0 个要素写回时中间 GeoJSON 里没有字段定义，
 *    ogr2ogr 会造出零字段的空图层 —— 字段定义丢了。必须挡住。
 *
 * @throws {VectorError} 转换失败、备份失败、替换失败、回滚失败、写完校验不过。
 */
async function writeGpkgFeatures(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  options: WriteFeaturesOptions,
  targetRel: string,
  targetAbs: string,
): Promise<WriteFeaturesResult> {
  const gdal = tools(loc);
  const existed = existsSync(targetAbs);

  // ── 源状态：有哪些图层、每层长什么样 ──────────────────────────
  // 写回只动一层，其余的层必须原样留着 —— 所以先把整个容器的快照拍下来。
  const beforeLayers = existed ? await probeGpkgLayers(loc, targetAbs) : [];
  // 写哪一层：显式指定优先；不指定就写第一层（与读路径一致，见 read.ts 的 readFeatures）
  const layerName = options.layerName ?? beforeLayers[0]?.name ?? '';
  if (!layerName) {
    throw new VectorError(
      `写回中止：这个 GeoPackage 里没有图层可写（${targetRel}）`,
    );
  }
  if (options.layerName && !beforeLayers.some((l) => l.name === options.layerName)) {
    throw new VectorError(
      `写回中止：这个 GeoPackage 里没有「${options.layerName}」这一层` +
        `（有：${beforeLayers.map((l) => l.name).join('、')}）`,
    );
  }
  const sourceLayer = existed
    ? await probeGpkgLayer(loc, targetAbs, layerName)
    : null;
  const otherLayersBefore = beforeLayers.filter((l) => l.name !== layerName);

  const tempDir = makeTempDir(targetAbs);
  const tempGeoJson = join(tempDir, `input-${randomBytes(6).toString('hex')}.geojson`);
  // 工作副本与目标**同名**：SQLite 的伴随文件（-wal）按主文件名派生，
  // 名字不一致的话 SQLite 认不出旁边那份日志。
  const workGpkg = join(tempDir, basename(targetAbs));

  try {
    writeFileSync(tempGeoJson, featuresToGeoJson(options.features), 'utf8');

    // ── 1) 工作副本：原文件 + 它的伴随文件 ─────────────────────
    if (existed) {
      copyFileSync(targetAbs, workGpkg);
      // -wal / -journal 里可能有还没并回主库的数据：只搬主库等于丢数据。
      for (const suffix of GPKG_SIDECAR_SUFFIXES) {
        const src = `${targetAbs}${suffix}`;
        if (existsSync(src)) copyFileSync(src, `${workGpkg}${suffix}`);
      }
    }

    // ── 2) 只替换那一层 ────────────────────────────────────────
    const args: string[] = ['-f', 'GPKG'];
    if (existed) {
      // -update：往已存在的库里写（GeoPackage 驱动要求目标已存在，
      //   新建时不能用它 —— 实测：Unable to open existing output datasource）
      args.push('-update');
      // -overwrite：这一层有就替换掉，没有就建出来
      args.push('-overwrite');
      // -nln：写到哪一层。少了它，ogr2ogr 会按源 GeoJSON 的层名新建一层，
      //   原文件里同名的那一层反而没被动过（实测：写回了但读到的还是旧数据）
      args.push('-nln', layerName);
      // 几何列名与 FID 列名跟原库保持一致：
      // 换名会让外部按列名写的 SQL 失效（ArcGIS 的某些工具就是这么用的）
      if (sourceLayer) {
        args.push('-lco', `GEOMETRY_NAME=${sourceLayer.geometryColumn}`);
        args.push('-lco', `FID=${sourceLayer.fidColumn}`);
      }
    } else {
      // 新建：图层名用文件名（去掉扩展名）
      args.push('-nln', layerName || basename(targetAbs).replace(/\.[^.]+$/, ''));
    }
    if (options.srsWkt) {
      // 显式指定要写成的坐标系：坐标已经是这个坐标系的值，标签也得跟着换
      args.push('-a_srs', options.srsWkt);
    } else if (sourceLayer?.srsWkt) {
      // 只贴标签不重投影：坐标原样搬过去，坐标系标签原样带过去
      args.push('-a_srs', sourceLayer.srsWkt);
    }
    // ⚠️ ogr2ogr 的参数顺序是 **dst 在前、src 在后**
    args.push(workGpkg, tempGeoJson);

    const res = await gdal.ogr2ogr(args);
    if (!res.ok) {
      throw new VectorError(`写不进去：${targetRel}（GDAL 转换失败）`, res.stderr);
    }
    if (!existsSync(workGpkg)) {
      throw new VectorError(`写回失败：转换命令跑完了但没产出文件（${targetRel}）`, res.stderr);
    }

    // ── 3) 还原图层顺序 ────────────────────────────────────────
    // -overwrite 把被替换的图层挪到了最后；引擎读的是第一个图层，
    // 顺序错了下次读到的就是别的图层。改的是工作副本，出错也只是丢弃副本。
    if (existed) {
      await restoreGpkgLayerOrder(
        loc,
        workGpkg,
        beforeLayers.map((l) => l.name),
      );
    }

    // ── 4) 替换前的核对（**必须在动原文件之前**）──────────────
    const afterLayers = await probeGpkgLayers(loc, workGpkg);
    const written = afterLayers.find((l) => l.name === layerName);
    if (!written) {
      throw new VectorError(
        `写回中止：写完之后找不到「${layerName}」这一层。原数据一个字节都没动。`,
      );
    }
    // 字段数不能比源文件少（空图层写回会丢字段定义）
    if (sourceLayer && sourceLayer.fields.length > 0 && written.fields.length < sourceLayer.fields.length) {
      throw new VectorError(
        `写回中止：写出来的「${layerName}」只有 ${written.fields.length} 列，原图层有 ${sourceLayer.fields.length} 列 —— 字段定义丢了。` +
          `原数据一个字节都没动。` +
          `（这一层没有要素时最容易撞上：写回时没有要素可参照，字段定义会跟着丢。` +
          `先给它加一条要素再改，或者把这一层单独导出来处理。）`,
      );
    }
    if (written.featureCount !== options.features.length) {
      throw new VectorError(
        `写回中止：写出来的「${layerName}」有 ${written.featureCount} 个要素，写进去的是 ${options.features.length} 个。原数据一个字节都没动。`,
      );
    }
    // 别的图层必须一字不差
    for (const before of otherLayersBefore) {
      const now = afterLayers.find((l) => l.name === before.name);
      if (!now) {
        throw new VectorError(
          `写回中止：「${before.name}」这一层不见了。原数据一个字节都没动。`,
        );
      }
      if (now.featureCount !== before.featureCount) {
        throw new VectorError(
          `写回中止：「${before.name}」这一层的要素数从 ${before.featureCount} 变成了 ${now.featureCount}。原数据一个字节都没动。`,
        );
      }
      if (now.fields.join('|') !== before.fields.join('|')) {
        throw new VectorError(
          `写回中止：「${before.name}」这一层的字段变了。原数据一个字节都没动。`,
        );
      }
    }
    // 坐标系不能丢
    if (sourceLayer && !options.srsWkt) {
      const writtenInfo = await probeGpkgLayer(loc, workGpkg, layerName);
      if (!sameSrs(sourceLayer, writtenInfo)) {
        throw new VectorError(
          '写回中止：坐标系变了（投影丢了）。原数据一个字节都没动。',
        );
      }
    }

    // ── 5) 备份（主库 + 伴随文件）──────────────────────────────
    // 备份放在**目录**里：主库和它的 -wal 是一套，摊平成散文件容易漏掉 -wal，
    // 拿回来的东西打不开。
    const backupRel = `${targetRel}.bak.${options.label ?? timestamp()}`;
    const oldFiles = await existingDataFiles(store, targetRel, 'gpkg');
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

    // ── 6) 原子替换 ────────────────────────────────────────────
    // GPKG 只有一个主文件，所以"替换"是一次 rename —— 比 Shapefile 那一组文件简单。
    // 但伴随文件必须一起处理：新主库旁边留着旧 -wal，文件会整个读不出来。
    const removed: string[] = [];
    const touched: string[] = [];
    try {
      // 先把旧伴随文件挪走（备份里已有一份）：它们属于**旧**主库，
      // 留在新主库旁边就是给 SQLite 喂错日志。
      for (const rel of oldFiles) {
        if (rel === targetRel) continue;
        await store.remove(rel);
        removed.push(rel);
      }
      await replaceFileAtomically(store, {
        target: targetRel,
        tempPath: workGpkg,
        // 备份由上面整组做：这里再各自备一份，备份会散成几个文件，回滚时容易漏
        backup: false,
      });
      touched.push(targetRel);
    } catch (err) {
      await rollback(store, backupRel, oldFiles, touched, backupDone);
      throw new VectorError(
        `写回失败，已经回滚到原样（${targetRel}）：${(err as Error).message}`,
        '',
        err,
      );
    }

    // ── 7) 写完核对 ────────────────────────────────────────────
    try {
      const finalLayers = await probeGpkgLayers(loc, targetAbs);
      const finalWritten = finalLayers.find((l) => l.name === layerName);
      if (!finalWritten) {
        throw new VectorError(`写完之后找不到「${layerName}」这一层`);
      }
      if (finalWritten.featureCount !== options.features.length) {
        throw new VectorError(
          `写回后要素数不对：写进去 ${options.features.length} 条，读回来 ${finalWritten.featureCount} 条`,
        );
      }
      for (const before of otherLayersBefore) {
        const now = finalLayers.find((l) => l.name === before.name);
        if (!now) {
          throw new VectorError(`写完之后「${before.name}」这一层不见了`);
        }
        if (now.featureCount !== before.featureCount || now.fields.join('|') !== before.fields.join('|')) {
          throw new VectorError(`写完之后「${before.name}」这一层的内容变了`);
        }
      }
      return {
        backupPath: backupDone ? backupRel : null,
        files: [targetRel],
        removed,
        fieldNames: finalWritten.fields,
        featureCount: finalWritten.featureCount,
        layerName,
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
  if (format === 'gpkg') {
    return writeGpkgFeatures(loc, store, options, targetRel, targetAbs);
  }
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
      args.push('-lco', `ENCODING=${options.encoding ?? 'UTF-8'}`);
    }
    if (options.srsWkt) {
      // 显式指定要写成的坐标系：坐标已经是这个坐标系的值，标签也得跟着换。
      // 不给 srsWkt 时用 -a_srs 原样保留源坐标系（见文件开头的说明）。
      args.push('-a_srs', options.srsWkt);
    } else if (sourceInfo?.srsWkt) {
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

    // ── 1.5) 字段数不能比源文件少（**必须在替换之前**查）────────────
    //
    // 为什么放在这里：写回后的核对（要素数、坐标系）过了之后，
    // 字段名对不上只能由调用方发现 —— 那时文件已经被换掉了，
    // 而调用方只能说「原数据没被改坏」，其实已经改了。
    //
    // 实测（2026-10-24，空图层）：0 个要素写回时，中间 GeoJSON 里没有字段定义，
    // ogr2ogr 造出**零字段、几何类型退化成 Line String** 的空图层，
    // 要素数核对 0===0 通过、坐标系也没变 —— 于是坏文件被替换掉了。
    //
    // 比源文件少列 = 字段定义丢了 = 数据损坏，必须在这里挡住。
    if (sourceInfo && sourceInfo.fields.length > 0) {
      const producedInfo = await probeLayer(loc, tempOut);
      if (producedInfo.fields.length < sourceInfo.fields.length) {
        throw new VectorError(
          `写回中止：写出来的文件只有 ${producedInfo.fields.length} 列，原文件有 ${sourceInfo.fields.length} 列 —— 字段定义丢了。` +
            `原数据一个字节都没动。` +
            `（这一层没有要素时最容易撞上：写回时没有要素可参照，字段定义会跟着丢。` +
            `先给它加一条要素再改，或者把这一层单独导出来处理。）`,
        );
      }
    }

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
      if (sourceInfo && !options.srsWkt && !sameSrs(sourceInfo, after)) {
        throw new VectorError(
          '写回后坐标系变了（投影丢了）：已经回滚，原数据的坐标系保持不变',
        );
      }
      // 指定了目标坐标系时，要核对的是"写成了要的那个"，不是"跟原来一样"
      if (options.srsWkt && !srsMatchesWkt(after, options.srsWkt)) {
        throw new VectorError(
          `写回后坐标系与要求的不一致（要 EPSG:${epsgOf(options.srsWkt) ?? '自定义'}）：已经回滚`,
        );
      }
      return {
        backupPath: backupDone ? backupRel : null,
        files: producedRel,
        removed,
        fieldNames: after.fields.map((f) => f.name),
        featureCount: after.featureCount,
        // Shapefile/GeoJSON 只有一个图层：它的图层名就是文件名（去扩展名）
        layerName: after.layerName,
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
