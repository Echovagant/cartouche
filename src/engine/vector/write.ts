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
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, sep } from 'node:path';
import { tools } from '../gdal/runner.ts';
import { replaceFileAtomically, replaceFileGroupAtomically } from '../gdal/writeback.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';
import { makeTempDir, timestamp, toRelPathChecked, GPKG_SIDECAR_SUFFIXES } from './paths.ts';
import { probeLayer, sameSrs, srsMatchesWkt, epsgOf, parseLayerInfo } from './read.ts';
import {
  VectorError,
  type FeatureRecord,
  type LayerField,
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
  // 归一成 / 再取目录：调用方可能传来 Windows 反斜杠路径
  // （2026-11-14 实测事故：HTTP 流程的 target 是 path.relative() 的反斜杠产物，
  //   这里只认 / 导致 dirRel 变成空串，写回产物全部落到了工作区根目录顶层）。
  const norm = rel.split(sep).join('/');
  const slash = norm.lastIndexOf('/');
  return slash >= 0 ? norm.slice(0, slash) : '';
}

/** 按扩展名判断写回格式。认不出来就报错，不猜。 */
export function formatForPath(path: string): VectorWriteFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith('.shp')) return 'shapefile';
  if (lower.endsWith('.geojson') || lower.endsWith('.json')) return 'geojson';
  if (lower.endsWith('.gpkg')) return 'gpkg';
  if (lower.endsWith('.gdb')) return 'gdb';
  if (lower.endsWith('.gml')) return 'gml';
  if (lower.endsWith('.kml')) return 'kml';
  throw new VectorError(
    `写回只支持 .shp、.geojson、.gpkg、.gdb、.gml 与 .kml，这个文件是 ${basename(path)}（换个格式再试）`,
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
export async function existingDataFiles(
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
        : format === 'gml'
          // GML 的 .xsd 与 .gfs 都按主名派生：a.gml → a.xsd / a.gfs
          ? [ownSuffix, '.xsd', '.gfs']
          : format === 'gdb'
            // FileGDB 是目录，不按文件粒度处理
            ? []
            : format === 'kml'
              // KML 是单个文件（.kmz 不在写回范围内）
              ? [ownSuffix]
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
function parseLayerSummaries(stdout: string): GpkgLayerSummary[] {
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
    // 字段行长这样："名称: String (0.0)"；Date/Time/DateTime 没有宽度，只写「名字: 类型」。
    // 排除掉 Geometry:/Extent:/Layer SRS WKT: 这些同样是"名字: 值"的行。
    const field = /^([^:]+):\s+[A-Za-z0-9]+\s*\(/.exec(line);
    if (field) {
      cur.fields.push(field[1]!.trim());
      continue;
    }
    const bare = /^([^:]+):\s+(String|Integer64|Integer|Real|Date|Time|DateTime|Binary)\s*$/.exec(line);
    if (bare && !/^(Geometry|Extent|Layer SRS WKT|Data axis)/.test(line)) {
      cur.fields.push(bare[1]!.trim());
    }
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
  return parseLayerSummaries(res.stdout);
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

/* ────────────────────────── FileGDB（.gdb） ────────────────────────── */

/**
 * FileGDB 里一个图层的完整信息。
 *
 * 比通用的 LayerInfo 多三项：FID 列名、几何列名、几何类型。
 * 重建目录时必须原样带上 FID / 几何列名 —— 换名会让外部按列名写的 SQL 失效。
 *
 * 字段故意做成 LayerInfo 的超集：`sameSrs` / `srsMatchesWkt` 可以直接吃。
 */
interface VectorLayerDetail extends LayerInfo {
  /** 图层名（与 layerName 同值，读起来短一些） */
  readonly name: string;
  /** 字段定义（带宽度），重建层结构时用它保住原类型 */
  readonly fieldDefs: readonly VrtField[];
  readonly fidColumn: string | null;
  readonly geometryColumn: string | null;
  readonly geometryType: string | null;
}

/** 往 OGR VRT 里写的一个字段定义。 */
interface VrtField {
  readonly name: string;
  /** OGR 字段类型名：String / Integer / Integer64 / Real / Date … */
  readonly type: string;
  /** 字符串宽度；0 / 缺省表示不限 */
  readonly width?: number;
}

/** 从 `ogrinfo -so` 输出里拆字段定义（带宽度，OGR 字段类型名照抄）。 */
function parseFieldDefs(stdout: string): VrtField[] {
  // Date/Time/DateTime 这类字段没有 `(宽度)`，只写「名字: 类型」
  const BARE = /^(.+?):\s+(String|Integer64|Integer|Real|Date|Time|DateTime|Binary)\s*$/;
  const out: VrtField[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (/^(Geometry|Extent|Data axis)/.test(line)) continue;
    const m = /^(.+?):\s+([A-Za-z0-9]+)\s*\(([\d.]+)\)/.exec(line);
    if (m) {
      const name = m[1]!.trim();
      const width = Number(m[3]);
      out.push({
        name,
        type: m[2]!,
        ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      });
      continue;
    }
    const bare = BARE.exec(line);
    if (bare) out.push({ name: bare[1]!.trim(), type: bare[2]! });
  }
  return out;
}

/** 按要素值推断一个新列的类型（只对新加的列用；原有列用原定义）。 */
function inferFieldType(features: readonly FeatureRecord[], name: string): string {
  let sawNumber = false;
  let sawReal = false;
  let sawText = false;
  for (const f of features) {
    const v = f.properties[name];
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') {
      sawNumber = true;
      if (!Number.isInteger(v)) sawReal = true;
    } else if (typeof v === 'boolean') {
      sawNumber = true;
    } else {
      sawText = true;
    }
  }
  if (sawText) return 'String';
  if (sawReal) return 'Real';
  if (sawNumber) return 'Integer';
  return 'String';
}

/**
 * 这次写回要用哪些列：**原有列用原定义**（类型与宽度都不漂），新列按值推断。
 *
 * 加列 / 改列名时如果直接把 GeoJSON 丢给 ogr2ogr，GDAL 会按值重新猜类型 ——
 * 一整列都是整数的 Real 列会被写成 Integer（实测）。用 VRT 把类型钉死就没有这个漂移。
 */
function fieldTypesForWrite(
  sourceFields: readonly VrtField[],
  features: readonly FeatureRecord[],
  dropFieldNames: readonly string[] = [],
): VrtField[] {
  const dropped = new Set(dropFieldNames.map((n) => n.toLowerCase()));
  const seen = new Set<string>();
  const out: VrtField[] = [];
  for (const f of sourceFields) {
    if (seen.has(f.name)) continue;
    // 只有调用方明确说"这一列被改名/删掉了"才去掉；
    // 要素里没有这一列也可能是整列为空，那种情况要留住列（界面上的表结构不能平白少一列）。
    if (dropped.has(f.name.toLowerCase())) continue;
    seen.add(f.name);
    out.push(f);
  }
  for (const f of features) {
    for (const key of Object.keys(f.properties)) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: key, type: inferFieldType(features, key) });
    }
  }
  return out;
}

/** XML 文本转义（字段名 / 路径里可能有 & < > "）。 */
function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** SQL 标识符加引号（图层名 / 列名里可能有空格或引号）。 */
function sqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** ogrinfo 的几何类型名 → OGR VRT 的 wkb 名；认不出来就不钉（交给 GDAL 推断）。 */
function geometryTypeToWkb(name: string | null): string | null {
  if (!name) return null;
  const map: Readonly<Record<string, string>> = {
    'Point': 'wkbPoint',
    'Line String': 'wkbLineString',
    'Polygon': 'wkbPolygon',
    'Multi Point': 'wkbMultiPoint',
    'Multi Line String': 'wkbMultiLineString',
    'Multi Polygon': 'wkbMultiPolygon',
    'Geometry Collection': 'wkbGeometryCollection',
  };
  return map[name] ?? null;
}

/**
 * 写一份 OGR VRT，把字段类型（与宽度）钉死，再让 ogr2ogr 从它建目标层。
 *
 * `src` 只给**要素里确实有**的字段：像 GML 的 `gml_id` 这种特殊列在源里没有同名属性，
 * 写 `<Field src="gml_id">` 会让 GDAL 直接报 "Unable to find source field"。
 */
function buildSchemaVrt(opts: {
  readonly vrtPath: string;
  readonly sourceAbs: string;
  readonly sourceLayer: string;
  readonly layerName: string;
  readonly fields: readonly VrtField[];
  readonly geometryType: string | null;
  /** 源要素里实际存在的字段名（0 要素时为空集） */
  readonly sourceFields: ReadonlySet<string>;
}): void {
  const lines = [
    '<OGRVRTDataSource>',
    `  <OGRVRTLayer name="${xmlEscape(opts.layerName)}">`,
    `    <SrcDataSource relativeToVRT="0">${xmlEscape(opts.sourceAbs)}</SrcDataSource>`,
    `    <SrcLayer>${xmlEscape(opts.sourceLayer)}</SrcLayer>`,
  ];
  const wkb = geometryTypeToWkb(opts.geometryType);
  if (wkb) lines.push(`    <GeometryType>${wkb}</GeometryType>`);
  for (const f of opts.fields) {
    const width = f.width ? ` width="${f.width}"` : '';
    const src = opts.sourceFields.has(f.name) ? ` src="${xmlEscape(f.name)}"` : '';
    lines.push(
      `    <Field name="${xmlEscape(f.name)}" type="${xmlEscape(f.type)}"${width}${src}/>`,
    );
  }
  lines.push('  </OGRVRTLayer>', '</OGRVRTDataSource>', '');
  writeFileSync(opts.vrtPath, lines.join('\n'), 'utf8');
}

/** 这一批要素里实际出现过哪些字段名。 */
function presentFieldNames(features: readonly FeatureRecord[]): Set<string> {
  const names = new Set<string>();
  for (const f of features) for (const key of Object.keys(f.properties)) names.add(key);
  return names;
}

/** 一个图层的几何类型（ogrinfo 的说法，如 “Multi Polygon”）；读不到就是 null。 */
async function layerGeometryType(
  loc: GdalLocation,
  path: string,
  layerName: string,
): Promise<string | null> {
  const res = await tools(loc).ogrInfo(['-ro', '-so', path, layerName]);
  if (!res.ok) return null;
  return /^Geometry: (.+)$/m.exec(res.stdout)?.[1]?.trim() ?? null;
}

/** 探一个 FileGDB 图层的细节（FID/几何列名、字段、坐标系、要素数）。 */
async function probeLayerDetail(
  loc: GdalLocation,
  path: string,
  layerName: string,
): Promise<VectorLayerDetail> {
  const res = await tools(loc).ogrInfo(['-ro', '-so', path, layerName]);
  if (!res.ok) {
    throw new VectorError(
      `读不了这个 FileGDB 的图层「${layerName}」（${basename(path)}）`,
      res.stderr,
    );
  }
  const info = parseLayerInfo(res.stdout);
  const srsWkt = info.srsWkt ?? null;
  return {
    ...info,
    name: layerName,
    layerName,
    layerNames: [layerName],
    srsWkt,
    epsg: srsWkt ? epsgOf(srsWkt) : null,
    fieldDefs: parseFieldDefs(res.stdout),
    fidColumn: /^FID Column = (.+)$/m.exec(res.stdout)?.[1]?.trim() ?? null,
    geometryColumn: /^Geometry Column = (.+)$/m.exec(res.stdout)?.[1]?.trim() ?? null,
    geometryType: /^Geometry: (.+)$/m.exec(res.stdout)?.[1]?.trim() ?? null,
  };
}

/**
 * 按文件里的存放顺序列出 FileGDB 的所有图层（逐层带上细节）。
 *
 * 顺序必须保住：引擎读多图层容器读的是**第一个**图层，
 * 顺序一变，下次打开读到的就是别的层了。OpenFileGDB 的 `-overwrite`
 * 会把被替换的层挪到最后（实测），所以这里根本不用它，改成整库重建。
 */
async function probeLayerDetails(loc: GdalLocation, path: string): Promise<VectorLayerDetail[]> {
  const res = await tools(loc).ogrInfo(['-ro', '-so', '-al', path]);
  if (!res.ok) {
    throw new VectorError(`读不了这个 FileGDB：${basename(path)}`, res.stderr);
  }
  const names = parseLayerSummaries(res.stdout).map((l) => l.name);
  const out: VectorLayerDetail[] = [];
  for (const name of names) out.push(await probeLayerDetail(loc, path, name));
  return out;
}

/** 字段签名（名字 + 类型），用于核对"别的图层一个字段都没变"。 */
function fieldSignature(fields: readonly LayerField[]): string {
  return fields.map((f) => `${f.name}:${f.type}`).join('|');
}

/**
 * FileGDB 的占用检测。
 *
 * ArcGIS 打开 FileGDB 时会在目录里留 `.lock` 文件；文件在别处被打开时，
 * Windows 上整目录 rename 也会失败（那时由调用方翻译成"被占用"）。
 */
async function assertGdbWritable(store: WorkspaceAdapter, targetRel: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await store.list(targetRel);
  } catch {
    names = [];
  }
  const locks = names.filter((n) => /\.lock$/i.test(n));
  if (locks.length > 0) {
    throw new VectorError(
      `这个 FileGDB 正在被占用（检测到锁文件：${locks.join('、')}）。` +
        '可能是 ArcGIS 打开着它，先关掉再改。',
    );
  }
}

/** 把目录 rename 转成读得懂的"被占用"错误。 */
function gdbRenameError(err: unknown, targetRel: string, what: string): VectorError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
    return new VectorError(
      `写回中止：${what}时目录被占用（${targetRel}）。` +
        '可能是 ArcGIS 或资源管理器正打开着这个 FileGDB，关掉再试。',
      '',
      err,
    );
  }
  return new VectorError(
    `写回中止：${what}失败（${targetRel}）：${(err as Error).message}`,
    '',
    err,
  );
}

/** 备份目录名：与其它格式同一口径，撞名时补随机后缀。 */
async function uniqueBackupRel(
  store: WorkspaceAdapter,
  targetRel: string,
  label?: string,
): Promise<string> {
  const base = `${targetRel}.bak.${label ?? timestamp()}`;
  // FileGDB 的备份是整个目录：以 .gdb 结尾才可以直接用 ArcGIS / GDAL 打开
  const candidate = targetRel.toLowerCase().endsWith('.gdb') ? `${base}.gdb` : base;
  if (!(await store.exists(candidate))) return candidate;
  return targetRel.toLowerCase().endsWith('.gdb')
    ? `${base}.${randomBytes(3).toString('hex')}.gdb`
    : `${base}.${randomBytes(3).toString('hex')}`;
}

/**
 * 核对重建出来的 FileGDB 与预期一致。
 *
 * 三条都是硬要求：
 *   - 图层顺序原样（顺序变了，引擎下次读到的就是别的层）；
 *   - 目标层要素数与写进去的一致；
 *   - 其它图层的要素数、字段名与类型一个不差。
 */
function assertGdbRewrite(
  beforeLayers: readonly VectorLayerDetail[],
  afterLayers: readonly VectorLayerDetail[],
  layerName: string,
  expectedCount: number,
  srsWkt: string | undefined,
): void {
  if (afterLayers.length !== beforeLayers.length) {
    throw new VectorError(
      `写回中止：重建出来的 FileGDB 有 ${afterLayers.length} 个图层，原来有 ${beforeLayers.length} 个。`,
    );
  }
  for (let i = 0; i < beforeLayers.length; i += 1) {
    if (afterLayers[i]!.name !== beforeLayers[i]!.name) {
      throw new VectorError(
        `写回中止：图层顺序变了（第 ${i + 1} 层原来是「${beforeLayers[i]!.name}」，` +
          `现在是「${afterLayers[i]!.name}」）。`,
      );
    }
  }
  const before = beforeLayers.find((l) => l.name === layerName);
  const after = afterLayers.find((l) => l.name === layerName);
  if (!before || !after) {
    throw new VectorError(`写回中止：重建之后找不到「${layerName}」这一层。`);
  }
  if (after.featureCount !== expectedCount) {
    throw new VectorError(
      `写回中止：写出来的「${layerName}」有 ${after.featureCount} 个要素，写进去的是 ${expectedCount} 个。`,
    );
  }
  if (before.fields.length > 0 && after.fields.length < before.fields.length) {
    throw new VectorError(
      `写回中止：写出来的「${layerName}」只有 ${after.fields.length} 列，原来有 ${before.fields.length} 列 —— 字段定义丢了。`,
    );
  }
  for (const other of beforeLayers) {
    if (other.name === layerName) continue;
    const now = afterLayers.find((l) => l.name === other.name);
    if (!now) {
      throw new VectorError(`写回中止：「${other.name}」这一层不见了。`);
    }
    if (now.featureCount !== other.featureCount) {
      throw new VectorError(
        `写回中止：「${other.name}」这一层的要素数从 ${other.featureCount} 变成了 ${now.featureCount}。`,
      );
    }
    if (fieldSignature(now.fields) !== fieldSignature(other.fields)) {
      throw new VectorError(
        `写回中止：「${other.name}」这一层的字段变了（名字或类型不一致）。`,
      );
    }
  }
  const crsOk = srsWkt ? srsMatchesWkt(after, srsWkt) : sameSrs(before, after);
  if (!crsOk) {
    throw new VectorError('写回中止：坐标系变了（投影丢了）。');
  }
}

/**
 * 写回一个 FileGDB：**整库重建 + 整目录替换**。
 *
 * 为什么不能像 GeoPackage 那样直接 `-overwrite` 目标层：OpenFileGDB 的
 * `-overwrite` 会把被替换的图层挪到目录末尾（实测），而引擎读的是第一个图层 ——
 * 顺序一变，下次打开读到的就是别的层。
 *
 * 为什么也不走"清空 + append"的就地路线（试过，被实测否掉）：
 * `ogrinfo -dialect SQLITE -sql 'DELETE FROM …'` 删 1420 行要 **22.6 秒**，
 * 而整库重建同样数据只要 **2.4 秒** —— 看起来更省的那条路实际更慢。
 * 所以保留重建：按原顺序逐层建，目标层用 VRT 钉住字段类型，其它层原样复制。
 */
async function writeGdbFeatures(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  options: WriteFeaturesOptions,
  targetRel: string,
  targetAbs: string,
): Promise<WriteFeaturesResult> {
  const gdal = tools(loc);
  if (!existsSync(targetAbs)) {
    throw new VectorError(`写回中止：这个 FileGDB 不存在（${targetRel}）`);
  }

  const beforeLayers = await probeLayerDetails(loc, targetAbs);
  if (beforeLayers.length === 0) {
    throw new VectorError(`写回中止：这个 FileGDB 里没有图层可写（${targetRel}）`);
  }
  const layerName = options.layerName ?? beforeLayers[0]!.name;
  if (!beforeLayers.some((l) => l.name === layerName)) {
    throw new VectorError(
      `写回中止：这个 FileGDB 里没有「${layerName}」这一层` +
        `（有：${beforeLayers.map((l) => l.name).join('、')}）`,
    );
  }
  const beforeLayer = beforeLayers.find((l) => l.name === layerName)!;

  await assertGdbWritable(store, targetRel);

  const tempDir = makeTempDir(targetAbs);
  const buildAbs = join(tempDir, basename(targetAbs));
  const tempGeoJson = join(tempDir, `input-${randomBytes(6).toString('hex')}.geojson`);
  const schemaVrt = join(tempDir, 'schema.vrt');
  try {
    writeFileSync(tempGeoJson, featuresToGeoJson(options.features), 'utf8');
    // 用 VRT 把字段类型钉死：原有列照原定义，新列按值推断。
    // 直接把 GeoJSON 丢给 ogr2ogr 的话，一整列都是整数的 Real 列会被重猜成 Integer。
    buildSchemaVrt({
      vrtPath: schemaVrt,
      sourceAbs: tempGeoJson,
      sourceLayer: basename(tempGeoJson).replace(/\.[^.]+$/, ''),
      layerName,
      fields: fieldTypesForWrite(
        beforeLayer.fieldDefs,
        options.features,
        options.dropFieldNames,
      ),
      geometryType: beforeLayer.geometryType,
      sourceFields: presentFieldNames(options.features),
    });

    // ── 1) 按原顺序逐层重建 ────────────────────────────────────
    for (let i = 0; i < beforeLayers.length; i += 1) {
      const layer = beforeLayers[i]!;
      const isTarget = layer.name === layerName;
      // 第一层用 -f 建库，后续层用 -update 追加（不带 -update 会把整库重建成空的）
      const base = i === 0
        ? ['-f', 'OpenFileGDB', '-nln', layer.name]
        : ['-update', '-nln', layer.name];
      // FID / 几何列名跟原库一致：换名会让外部按列名写的 SQL 失效
      if (layer.fidColumn) base.push('-lco', `FID=${layer.fidColumn}`);
      if (layer.geometryColumn) base.push('-lco', `GEOMETRY_NAME=${layer.geometryColumn}`);

      if (isTarget) {
        // GeoJSON 总是声明成 4326，必须用 -a_srs 把真正的坐标系贴回去
        const crs = options.srsWkt ?? beforeLayer.srsWkt;
        const created = await gdal.ogr2ogr([
          ...base,
          ...(crs ? ['-a_srs', crs] : []),
          buildAbs, schemaVrt,
        ]);
        if (!created.ok) {
          throw new VectorError(
            `写回中止：重建「${layer.name}」失败（${targetRel}）`,
            created.stderr,
          );
        }
      } else {
        const res = await gdal.ogr2ogr([...base, buildAbs, targetAbs, layer.name]);
        if (!res.ok) {
          throw new VectorError(
            `写回中止：复制「${layer.name}」这一层失败（${targetRel}）`,
            res.stderr,
          );
        }
      }
    }


    // ── 2) 换目录之前先核对新库 ────────────────────────────────
    const built = await probeLayerDetails(loc, buildAbs);
    assertGdbRewrite(beforeLayers, built, layerName, options.features.length, options.srsWkt);

    // ── 3) 整目录替换（原目录改名当备份）──────────────────────
    const backupRel = await uniqueBackupRel(store, targetRel, options.label);
    try {
      await store.rename(targetRel, backupRel);
    } catch (err) {
      throw gdbRenameError(err, targetRel, '备份原目录');
    }
    try {
      await store.rename(buildAbs, targetRel);
    } catch (err) {
      // 新目录进不去：把原目录挪回来，数据回到原样
      await store.rename(backupRel, targetRel).catch(() => {});
      throw gdbRenameError(err, targetRel, '把新目录放到目标位置');
    }

    // ── 4) 落地后再核对一次；不过就从备份退回 ─────────────────
    try {
      const finalLayers = await probeLayerDetails(loc, targetAbs);
      assertGdbRewrite(beforeLayers, finalLayers, layerName, options.features.length, options.srsWkt);
      const finalTarget = finalLayers.find((l) => l.name === layerName)!;
      return {
        backupPath: backupRel,
        files: [targetRel],
        removed: [],
        fieldNames: finalTarget.fields.map((f) => f.name),
        featureCount: finalTarget.featureCount,
        layerName,
      };
    } catch (err) {
      try {
        await store.remove(targetRel);
        await store.rename(backupRel, targetRel);
      } catch (rollbackErr) {
        throw new VectorError(
          `写回后校验没通过，回滚也失败了：备份在 ${backupRel}，请从备份里手工恢复` +
            `（${(rollbackErr as Error).message}）`,
          '',
          err,
        );
      }
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

/* ────────────────────────────── GML ────────────────────────────── */

/**
 * 读源 GML 根元素的应用命名空间与前缀。
 *
 * GML 写器默认用 `ogr` + `http://ogr.maptools.org/`；沿用它自己的命名空间，
 * 下游按命名空间解析的工具才不会因为"换了个命名空间"认不出来。
 */
function readGmlNamespace(absPath: string): { prefix: string; uri: string } | null {
  try {
    const head = readFileSync(absPath, 'utf8').slice(0, 8192);
    const root = /<([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*[\s>]/.exec(head);
    const prefix = root?.[1];
    if (!prefix || /^(gml|xsi|xml|xlink)$/i.test(prefix)) return null;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const decl = new RegExp(`xmlns:${escaped}="([^"]+)"`).exec(head);
    return decl ? { prefix, uri: decl[1]! } : null;
  } catch {
    return null;
  }
}

/**
 * 写回一个 GML：重新生成主文件；`.xsd` 只在字段结构变化时才重写，整组替换。
 *
 * 为什么不能原地更新：GML 驱动不支持 `-update`（实测：Unable to open existing
 * output datasource），只能重新 CreateCopy 一份。
 *
 * **字段结构没变时，原 `.xsd` 保持字节不变**：改属性、改节点、增删要素、换坐标系
 * 都不该让"数据说明书"跟着变。只有加列/改列名/删列才重新生成 XSD。
 *
 * 多图层 GML 直接拒绝：GML 驱动写不出"一个文件里多个图层"，
 * 强行写只会留下第一层，其余层静默消失。
 */
async function writeGmlFeatures(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  options: WriteFeaturesOptions,
  targetRel: string,
  targetAbs: string,
): Promise<WriteFeaturesResult> {
  const gdal = tools(loc);
  const existed = existsSync(targetAbs);
  const sourceInfo = existed ? await probeLayer(loc, targetAbs) : null;

  if (sourceInfo && sourceInfo.layerNames.length > 1) {
    throw new VectorError(
      `写回中止：这个 GML 里有 ${sourceInfo.layerNames.length} 个图层` +
        `（${sourceInfo.layerNames.join('、')}），GML 驱动不能把多个图层写回同一个文件。` +
        '请先在 GIS 软件里拆成单图层再改。',
    );
  }
  const layerName =
    options.layerName ?? sourceInfo?.layerName ?? basename(targetAbs).replace(/\.[^.]+$/, '');
  if (options.layerName && sourceInfo && !sourceInfo.layerNames.includes(options.layerName)) {
    throw new VectorError(
      `写回中止：这个 GML 里没有「${options.layerName}」这一层` +
        `（有：${sourceInfo.layerNames.join('、')}）`,
    );
  }

  const tempDir = makeTempDir(targetAbs);
  try {
    const geoJson = join(tempDir, `input-${randomBytes(6).toString('hex')}.geojson`);
    writeFileSync(geoJson, featuresToGeoJson(options.features), 'utf8');

    // 与 GDB 同一条思路：先用 VRT 把字段类型钉死，再让 ogr2ogr 建 GML。
    // 直接吃 GeoJSON 会把 Integer64 猜成 Integer（实测），XSD 里的类型也跟着变。
    const schemaVrt = join(tempDir, 'schema.vrt');
    const geometryType = sourceInfo
      ? await layerGeometryType(loc, targetAbs, sourceInfo.layerName)
      : null;
    buildSchemaVrt({
      vrtPath: schemaVrt,
      sourceAbs: geoJson,
      sourceLayer: basename(geoJson).replace(/\.[^.]+$/, ''),
      layerName,
      fields: fieldTypesForWrite(
        (sourceInfo?.fields ?? []).map((f) => ({ name: f.name, type: f.type })),
        options.features,
        options.dropFieldNames,
      ),
      geometryType,
      sourceFields: presentFieldNames(options.features),
    });

    // 字段结构没变（只改属性/几何/增删要素/换坐标系）：原 .xsd 一个字节不动。
    // 用户真实会抱怨的是"改个名字，说明书也被重写"；说明书只在列变了的时候才该变。
    const sourceNames = new Set((sourceInfo?.fields ?? []).map((f) => f.name));
    const hasNewFields = [...presentFieldNames(options.features)].some((n) => !sourceNames.has(n));
    const schemaUnchanged =
      sourceInfo !== null &&
      options.features.length > 0 &&
      (options.dropFieldNames?.length ?? 0) === 0 &&
      !hasNewFields;

    // 与目标同名：.xsd 与 XML 里的 schemaLocation 都按主名派生
    const outMain = join(tempDir, basename(targetAbs));
    const args = ['-f', 'GML', '-nln', layerName];
    if (options.srsWkt) {
      // 重投影：坐标已经是新坐标系的值，标签也得跟着换
      args.push('-a_srs', options.srsWkt);
    } else if (sourceInfo?.srsWkt) {
      // 只贴标签不重投影：坐标原样搬过去，坐标系标签原样带过去
      args.push('-a_srs', sourceInfo.srsWkt);
    }
    if (existed) {
      // 沿用源文件的命名空间/前缀（GDAL 默认会写成 ogr / ogr.maptools.org）
      const ns = readGmlNamespace(targetAbs);
      if (ns) args.push('-dsco', `TARGET_NAMESPACE=${ns.uri}`, '-dsco', `PREFIX=${ns.prefix}`);
    }
    args.push(outMain, schemaVrt);

    const res = await gdal.ogr2ogr(args);
    if (!res.ok) {
      throw new VectorError(`写不进去：${targetRel}（GML 生成失败）`, res.stderr);
    }
    if (!existsSync(outMain)) {
      throw new VectorError(`写回失败：转换命令跑完了但没产出文件（${targetRel}）`, res.stderr);
    }
    const xsdAbs = outMain.replace(/\.gml$/i, '.xsd');
    if (!existsSync(xsdAbs)) {
      throw new VectorError(
        `写回失败：GML 没有同时产出结构文件 .xsd（${targetRel}）；` +
          '没有它，有些软件会按"无字段"打开。',
        res.stderr,
      );
    }
    if (schemaUnchanged) {
      const sourceXsdAbs = targetAbs.replace(/\.gml$/i, '.xsd');
      if (existsSync(sourceXsdAbs)) {
        // 用原文件覆盖刚生成的 XSD：字节级不变，下游按原说明书校验时不会因为"换了说明书"失败
        copyFileSync(sourceXsdAbs, xsdAbs);
      }
    }

    // 换盘之前先核对：要素数、字段定义、坐标系、图层名
    const after = await probeLayer(loc, outMain);
    if (after.featureCount !== options.features.length) {
      throw new VectorError(
        `写回中止：写出来的 GML 有 ${after.featureCount} 个要素，写进去的是 ${options.features.length} 个。`,
      );
    }
    if (sourceInfo && sourceInfo.fields.length > 0 && after.fields.length < sourceInfo.fields.length) {
      throw new VectorError(
        `写回中止：写出来的 GML 只有 ${after.fields.length} 列，原文件有 ${sourceInfo.fields.length} 列 —— 字段定义丢了。`,
      );
    }
    if (after.layerName !== layerName) {
      throw new VectorError(
        `写回中止：写出来的图层名是「${after.layerName}」，不是原来的「${layerName}」。`,
      );
    }
    const crsOk = options.srsWkt
      ? srsMatchesWkt(after, options.srsWkt)
      : (!sourceInfo || sameSrs(sourceInfo, after));
    if (!crsOk) {
      throw new VectorError('写回中止：坐标系变了（投影丢了）。');
    }

    const produced = [basename(outMain), basename(xsdAbs)];
    const managed = await existingDataFiles(store, targetRel, 'gml');
    const { backupPath, files, removed } = await replaceFileGroupAtomically(store, {
      target: targetRel,
      tempDir,
      produced,
      managed,
      ...(options.label ? { label: options.label } : {}),
    });

    return {
      backupPath,
      files,
      removed,
      fieldNames: after.fields.map((f) => f.name),
      featureCount: after.featureCount,
      layerName: after.layerName,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/* ────────────────────────────── KML ────────────────────────────── */

/**
 * 读源 KML 每个要素的样式：id → OGR_STYLE。
 *
 * 用 `-nlt NONE` 只导出属性、不带几何：1420 个面的 KML，带几何要 2.4MB，
 * 不带几何只要 150KB（实测）。读不到就返回空表，样式退回默认，不影响数据写回。
 */
async function readKmlStyles(
  loc: GdalLocation,
  path: string,
  layerName: string,
  tempDir: string,
): Promise<Map<string, string>> {
  const out = join(tempDir, `styles-${randomBytes(4).toString('hex')}.geojson`);
  const res = await tools(loc).ogr2ogr([
    '-f', 'GeoJSON', '-nlt', 'NONE', out, path,
    '-sql', `SELECT "id", OGR_STYLE FROM ${sqlIdent(layerName)}`,
  ]);
  const styles = new Map<string, string>();
  if (!res.ok || !existsSync(out)) return styles;
  try {
    const json = JSON.parse(readFileSync(out, 'utf8')) as {
      features?: { properties?: Record<string, unknown> }[];
    };
    for (const feature of json.features ?? []) {
      const id = feature.properties?.id;
      const style = feature.properties?.OGR_STYLE;
      if (typeof id === 'string' && typeof style === 'string' && style !== '') {
        styles.set(id, style);
      }
    }
  } catch {
    // 样式是锦上添花：解析失败就按默认样式写
  }
  return styles;
}

/**
 * 写回一个 KML：重新生成单文件，**多图层按原顺序重建**。
 *
 * 约束来自 KML 规范与 LIBKML 驱动的行为，不是我们的取舍：
 *  - **坐标只能是 WGS84**：LIBKML 写入时会把源坐标系转回 4326（实测 3857 源转回来
 *    坐标正确）。所以 KML 不能当作"重投影到别的坐标系"的载体，那种请求直接拒绝。
 *  - **0 要素**：KML 没有独立表结构，写空会丢全部字段定义，直接拒绝。
 *  - 属性列与 KML 内置字段（Name / description …）重名时，驱动会自动加后缀
 *    （实测 NAME → NAME2）—— 值不丢，但列名会变，这是 KML 的结构决定的。
 *  - 被改的那一层样式**按要素 id 从源 KML 带回**（改属性/改节点后颜色线宽不变）；
 *    新增要素没有原样式，按默认样式写。没改的层原样从源 KML 复制（样式跟着走）。
 */
async function writeKmlFeatures(
  loc: GdalLocation,
  store: WorkspaceAdapter,
  options: WriteFeaturesOptions,
  targetRel: string,
  targetAbs: string,
): Promise<WriteFeaturesResult> {
  const gdal = tools(loc);
  const existed = existsSync(targetAbs);
  const beforeLayers = existed ? await probeLayerDetails(loc, targetAbs) : [];

  if (options.srsWkt) {
    const wanted = epsgOf(options.srsWkt);
    if (wanted !== null && wanted !== 4326) {
      throw new VectorError(
        `KML 只能是 WGS84（EPSG:4326），不能写成 EPSG:${wanted}。` +
          '要换投影请用 GeoPackage / Shapefile / FileGDB。',
      );
    }
  }
  if (options.features.length === 0) {
    throw new VectorError(
      'KML 没有独立的表结构文件，写成 0 个要素会丢掉全部字段定义。' +
        '这一层至少要保留一条要素；要清空请直接删掉这个 KML。',
    );
  }

  const layerName =
    options.layerName ?? beforeLayers[0]?.name ?? basename(targetAbs).replace(/\.[^.]+$/, '');
  if (options.layerName && beforeLayers.length > 0 && !beforeLayers.some((l) => l.name === layerName)) {
    throw new VectorError(
      `写回中止：这个 KML 里没有「${layerName}」这一层` +
        `（有：${beforeLayers.map((l) => l.name).join('、')}）`,
    );
  }
  const targetBefore = beforeLayers.find((l) => l.name === layerName) ?? null;

  const tempDir = makeTempDir(targetAbs);
  try {
    // 按要素 id 把源 KML 的样式带回来：改属性/改节点后颜色线宽不变；新要素用默认
    let featuresForWrite = options.features;
    if (targetBefore && targetBefore.fieldDefs.some((f) => f.name.toLowerCase() === 'id')) {
      const styles = await readKmlStyles(loc, targetAbs, layerName, tempDir);
      if (styles.size > 0) {
        featuresForWrite = options.features.map((f) => {
          const id = f.properties.id;
          const style = typeof id === 'string' ? styles.get(id) : undefined;
          return style ? { ...f, properties: { ...f.properties, OGR_STYLE: style } } : f;
        });
      }
    }

    const geoJson = join(tempDir, `input-${randomBytes(6).toString('hex')}.geojson`);
    writeFileSync(geoJson, featuresToGeoJson(featuresForWrite), 'utf8');

    // 与 GML/GDB 同一条思路：VRT 钉住字段类型，再由 LIBKML 建 KML
    const schemaVrt = join(tempDir, 'schema.vrt');
    buildSchemaVrt({
      vrtPath: schemaVrt,
      sourceAbs: geoJson,
      sourceLayer: basename(geoJson).replace(/\.[^.]+$/, ''),
      layerName,
      fields: fieldTypesForWrite(
        targetBefore?.fieldDefs ?? [],
        featuresForWrite,
        options.dropFieldNames,
      ),
      // KML 读出来是 "Unknown (any)"，钉不住；交给要素自己推断
      geometryType: null,
      sourceFields: presentFieldNames(featuresForWrite),
    });

    const outMain = join(tempDir, basename(targetAbs));
    // 按原顺序重建所有图层：目标层用 VRT，其它层原样从源 KML 复制（样式跟着走）
    for (let i = 0; i < beforeLayers.length; i += 1) {
      const layer = beforeLayers[i]!;
      const isTarget = layer.name === layerName;
      const base = i === 0
        ? ['-f', 'LIBKML', '-nln', layer.name]
        : ['-update', '-nln', layer.name];
      const crs = options.srsWkt ?? layer.srsWkt;
      const args = isTarget
        ? [...base, ...(crs ? ['-a_srs', crs] : []), outMain, schemaVrt]
        : [...base, outMain, targetAbs, layer.name];
      const res = await gdal.ogr2ogr(args);
      if (!res.ok) {
        throw new VectorError(
          `写不进去：${targetRel}（KML 生成失败：${layer.name}）`,
          res.stderr,
        );
      }
    }
    if (beforeLayers.length === 0) {
      // 新建 KML：只有目标层
      const args = ['-f', 'LIBKML', '-nln', layerName];
      if (options.srsWkt) args.push('-a_srs', options.srsWkt);
      args.push(outMain, schemaVrt);
      const res = await gdal.ogr2ogr(args);
      if (!res.ok) {
        throw new VectorError(`写不进去：${targetRel}（KML 生成失败）`, res.stderr);
      }
    }
    if (!existsSync(outMain)) {
      throw new VectorError(`写回失败：转换命令跑完了但没产出文件（${targetRel}）`);
    }

    // ── 核对：层序、目标层要素/字段、其它层原样 ──────────────────
    const afterLayers = await probeLayerDetails(loc, outMain);
    if (beforeLayers.length > 0) {
      if (afterLayers.length !== beforeLayers.length) {
        throw new VectorError(
          `写回中止：写出来的 KML 有 ${afterLayers.length} 个图层，原来有 ${beforeLayers.length} 个。`,
        );
      }
      for (let i = 0; i < beforeLayers.length; i += 1) {
        if (afterLayers[i]!.name !== beforeLayers[i]!.name) {
          throw new VectorError(
            `写回中止：图层顺序变了（第 ${i + 1} 层原来是「${beforeLayers[i]!.name}」，` +
              `现在是「${afterLayers[i]!.name}」）。`,
          );
        }
      }
    } else if (afterLayers.length !== 1 || afterLayers[0]!.name !== layerName) {
      throw new VectorError(`写回中止：写出来的 KML 图层不是「${layerName}」。`);
    }
    const afterTarget = afterLayers.find((l) => l.name === layerName);
    if (!afterTarget) {
      throw new VectorError(`写回中止：写完之后找不到「${layerName}」这一层。`);
    }
    if (afterTarget.featureCount !== options.features.length) {
      throw new VectorError(
        `写回中止：写出来的 KML 有 ${afterTarget.featureCount} 个要素，写进去的是 ${options.features.length} 个。`,
      );
    }
    if (targetBefore && targetBefore.fields.length > 0 && afterTarget.fields.length < targetBefore.fields.length) {
      throw new VectorError(
        `写回中止：写出来的 KML 只剩 ${afterTarget.fields.length} 列，原文件有 ${targetBefore.fields.length} 列 —— 字段定义丢了。`,
      );
    }
    // KML 一定是 4326：这里核对的是"驱动真的把它当 WGS84 写了"
    if (afterTarget.epsg !== null && afterTarget.epsg !== 4326) {
      throw new VectorError(`写回中止：KML 的坐标系是 EPSG:${afterTarget.epsg}，不是 WGS84。`);
    }
    if (beforeLayers.length > 0) {
      for (const other of beforeLayers) {
        if (other.name === layerName) continue;
        const now = afterLayers.find((l) => l.name === other.name)!;
        if (now.featureCount !== other.featureCount) {
          throw new VectorError(
            `写回中止：「${other.name}」这一层的要素数从 ${other.featureCount} 变成了 ${now.featureCount}。`,
          );
        }
        if (fieldSignature(now.fields) !== fieldSignature(other.fields)) {
          throw new VectorError(`写回中止：「${other.name}」这一层的字段变了。`);
        }
      }
    }

    const { backupPath } = await replaceFileAtomically(store, {
      target: targetRel,
      tempPath: outMain,
      ...(options.label ? { label: options.label } : {}),
    });

    return {
      backupPath,
      files: [targetRel],
      removed: [],
      fieldNames: afterTarget.fields.map((f) => f.name),
      featureCount: afterTarget.featureCount,
      layerName: afterTarget.name,
    };
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
  if (format === 'gdb') {
    return writeGdbFeatures(loc, store, options, targetRel, targetAbs);
  }
  if (format === 'gml') {
    return writeGmlFeatures(loc, store, options, targetRel, targetAbs);
  }
  if (format === 'kml') {
    return writeKmlFeatures(loc, store, options, targetRel, targetAbs);
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
