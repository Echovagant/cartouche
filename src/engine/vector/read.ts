/**
 * 矢量要素读取。
 *
 * 链路：ogr2ogr 转 GeoJSON → 读回 JSON → 逐条求值。
 *
 * **为什么条件由引擎自己算，不交给 GDAL 的 `-where`：**
 *
 * 实测（GDAL 3.13）：
 *  1. GDAL 的通用 SQL 方言**没有** UPPER/LOWER/TRIM/LENGTH/ROUND/ABS/COALESCE
 *     （Undefined function 'UPPER' used）。人话条件里这些函数很常见，
 *     交给 GDAL 过滤会直接失败。
 *  2. GDAL 的 SQL 会把文字悄悄当数字比（`POP2020 > 'abc'` 不报错），
 *     而本项目要求"数字列和文字列比大小"必须报错并说清是哪一列。
 *     两套判定规则同时存在，用户看到的结论会自相矛盾。
 *  3. 人话那一层 GDAL 根本不认识。
 *
 * 所以：**引擎是唯一的判定者**。GDAL 只负责"把数据搬成 JSON"。
 * 代价是筛选在引擎侧做（整层要素要过一遍），换来的是判定口径只有一套、
 * 类型错误一定会被报出来。
 *
 * `-limit` 的用法也因此分两种：
 *  - 没有条件时直接交给 ogr2ogr（结果与引擎侧筛选完全等价）；
 *  - 有条件时不交给 ogr2ogr（先筛后限，否则限到的是"没筛之前的第 N 条"）。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';
import {
  evaluate,
  parseExpression,
  toSql,
  type ExprNode,
} from '../expression/index.ts';
import { makeTempDir } from './paths.ts';
import {
  VectorError,
  type FeatureRecord,
  type LayerField,
  type LayerInfo,
  type ReadFeaturesOptions,
  type ReadFeaturesResult,
} from './types.ts';

/**
 * 探一个图层的结构：列名、要素数、坐标系。
 *
 * 为什么要单独探：属性条件里写错列名时，报错要能列出"这个图层到底有哪些列"，
 * 只说"没有这一列"用户还是得自己去看属性表。
 */
export async function probeLayer(loc: GdalLocation, path: string): Promise<LayerInfo> {
  if (!existsSync(path)) {
    throw new VectorError(`打不开这个数据文件：${path}（文件不存在）`);
  }
  const gdal = tools(loc);
  const res = await gdal.ogrInfo(['-so', '-al', path]);
  if (!res.ok) {
    throw new VectorError(`读不了这个图层：${path}`, res.stderr);
  }
  return parseLayerInfo(res.stdout);
}

/** 把 ogrinfo -so -al 的输出拆成结构化信息。 */
export function parseLayerInfo(stdout: string): LayerInfo {
  const lines = stdout.split(/\r?\n/);
  let layerName = '';
  let featureCount = 0;
  const fields: LayerField[] = [];
  let srsWkt: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const nameMatch = /^Layer name:\s*(.+)$/.exec(line);
    if (nameMatch) {
      layerName = nameMatch[1]!.trim();
      continue;
    }
    const countMatch = /^Feature Count:\s*(\d+)/.exec(line);
    if (countMatch) {
      featureCount = Number(countMatch[1]);
      continue;
    }
    if (/^Layer SRS WKT:\s*$/.test(line)) {
      // WKT 是一整块：第一行顶格（"GEOGCRS["），后续行缩进，
      // 块尾是下一个顶格字段（"Data axis to CRS axis mapping: 2,1"）。
      // 按"有没有冒号"来判块尾比按缩进判稳 —— 缩进那套在第一行顶格时就断了。
      const block: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = lines[j]!;
        if (next.trim() === '') {
          if (block.length === 0) continue;
          break;
        }
        if (/^[A-Za-z][A-Za-z ]*:\s/.test(next)) break;
        block.push(next.trim());
      }
      const wkt = block.join(' ').trim();
      srsWkt = wkt === '' ? null : wkt;
      i = j - 1;
      continue;
    }
    const fieldMatch = /^(.+?):\s+([A-Za-z0-9]+)\s*\(/.exec(line);
    if (fieldMatch && !/^(Geometry|Extent|Metadata|Layer SRS WKT|Data axis)/.test(line)) {
      const name = fieldMatch[1]!.trim();
      if (name !== '') fields.push({ name, type: fieldMatch[2]! });
    }
  }

  return {
    layerName,
    featureCount,
    fields,
    srsWkt,
    epsg: srsWkt ? epsgOf(srsWkt) : null,
  };
}

/**
 * 从 WKT 里抠出 EPSG 码；抠不出就是 null（自定义坐标系很常见）。
 *
 * ⚠️ **必须取最后一个 ID["EPSG",N]**：
 * 投影坐标系的 WKT2 里，BASEGEOGCRS 自带的 ID（基准地理 CRS，如 4326）
 * 排在前面，投影 CRS 自己的 ID（如 3857 / 32631）在最后。
 * 取第一个的话，EPSG:3857 的图层会被报成 EPSG:4326 ——
 * 于是"两个图层坐标系是不是一样"的判断会把 3857 与 4326 当成同一个，
 * 写回时"坐标系没丢"的校验也就形同虚设。
 * （gdal/probe.ts 的 parseCrs 是同一口径，两处必须一致。）
 */
export function epsgOf(wkt: string): number | null {
  const ids = [...wkt.matchAll(/ID\s*\[\s*"EPSG"\s*,\s*(\d+)\s*\]/g)].map((m) => Number(m[1]));
  return ids.length > 0 ? ids[ids.length - 1]! : null;
}

/** 两个图层的坐标系是不是同一个。 */
export function sameSrs(a: LayerInfo, b: LayerInfo): boolean {
  if (a.epsg !== null && b.epsg !== null) return a.epsg === b.epsg;
  if (a.srsWkt === null && b.srsWkt === null) return true;
  if (a.srsWkt === null || b.srsWkt === null) return false;
  const norm = (w: string): string => w.replace(/\s+/g, '').toUpperCase();
  return norm(a.srsWkt) === norm(b.srsWkt);
}

/**
 * 一个图层的坐标系是不是就是这段 WKT 说的那个。
 *
 * 为什么单列一个函数：写回时要核对"写成了要求的那个坐标系"，
 * 而要求的那段 WKT 不是探查出来的（探查得到的是 GDAL 复读后的形式，
 * 两者在空白与拼写上可能不同）。所以先比 EPSG 码 —— 那是稳定的身份；
 * EPSG 认不出（自定义坐标系）时才退回逐字比 WKT。
 */
export function srsMatchesWkt(info: LayerInfo, wkt: string): boolean {
  const wanted = epsgOf(wkt);
  if (wanted !== null && info.epsg !== null) return wanted === info.epsg;
  if (info.srsWkt === null) return false;
  const norm = (w: string): string => w.replace(/\s+/g, '').toUpperCase();
  return norm(info.srsWkt) === norm(wkt);
}

/** 条件里的列名（用于提前报错：这一层根本没有这一列）。 */
export function referencedFields(node: ExprNode): string[] {
  const out: string[] = [];
  const walk = (n: ExprNode): void => {
    switch (n.kind) {
      case 'field':
        if (!out.includes(n.name)) out.push(n.name);
        break;
      case 'unary':
        walk(n.operand);
        break;
      case 'binary':
        walk(n.left);
        walk(n.right);
        break;
      case 'call':
        for (const a of n.args) walk(a);
        break;
      case 'in':
        walk(n.operand);
        for (const a of n.list) walk(a);
        break;
      case 'between':
        walk(n.operand);
        walk(n.low);
        walk(n.high);
        break;
      case 'like':
        walk(n.operand);
        walk(n.pattern);
        break;
      case 'isnull':
        walk(n.operand);
        break;
      default:
        break;
    }
  };
  walk(node);
  return out;
}

/** 条件在一条记录上是否成立。 */
export function matchesWhere(node: ExprNode, properties: Readonly<Record<string, unknown>>): boolean {
  const value = evaluate(node, properties);
  if (value === null) return false;
  if (typeof value !== 'boolean') {
    throw new VectorError(
      `条件要能分出真假（写成「大于」「并且」这类判断），不能只是一个值：算出来是 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** GeoJSON 的一个 feature → 引擎的要素形状。 */
function toFeatureRecord(raw: unknown): FeatureRecord {
  const obj = (raw ?? {}) as {
    properties?: Record<string, unknown> | null;
    geometry?: { type?: string; coordinates?: unknown } | null;
  };
  const properties = obj.properties ?? {};
  const geometry = obj.geometry && typeof obj.geometry.type === 'string'
    ? { type: obj.geometry.type, coordinates: obj.geometry.coordinates ?? null }
    : null;
  return { properties, geometry };
}

/**
 * 读要素。
 *
 * @throws {VectorError} 文件打不开、转换失败、条件里的列不存在。
 */
export async function readFeatures(
  loc: GdalLocation,
  options: ReadFeaturesOptions,
): Promise<ReadFeaturesResult> {
  const gdal = tools(loc);
  const path = options.path;

  const info = await probeLayer(loc, path);

  // 条件：SQL 或人话都行（人话先翻）
  let whereNode: ExprNode | null = null;
  if (options.where !== undefined && options.where.trim() !== '') {
    const sql = toSql(options.where);
    whereNode = parseExpression(sql);
    const missing = referencedFields(whereNode).filter(
      (name) => !info.fields.some((f) => f.name.toLowerCase() === name.toLowerCase()),
    );
    if (missing.length > 0) {
      const have = info.fields.map((f) => f.name).slice(0, 12).join('、');
      throw new VectorError(
        `条件里用到的列在这个图层里不存在：${missing.join('、')}（这一层的列有：${have}）`,
      );
    }
  }

  // 只读要的几列
  let select: string | undefined;
  if (options.fields && options.fields.length > 0) {
    for (const f of options.fields) {
      if (f.includes(',')) {
        throw new VectorError(`列名里不能带逗号（GDAL 的 -select 用逗号分隔）：${f}`);
      }
      if (!info.fields.some((x) => x.name.toLowerCase() === f.toLowerCase())) {
        const have = info.fields.map((x) => x.name).slice(0, 12).join('、');
        throw new VectorError(`这个图层里没有「${f}」这一列（这一层的列有：${have}）`);
      }
    }
    // -select 只能给一次、逗号分隔（实测：重复给会报 Duplicate argument -select）
    select = options.fields.join(',');
  }

  const tempDir = makeTempDir(path);
  const out = join(tempDir, 'read.geojson');
  try {
    const args: string[] = ['-f', 'GeoJSON'];
    if (options.encoding) {
      // 按 .cpg 之外的编码解读 DBF：属性表本来就是按另一种编码写的时候，
      // 不给这个就读出来是乱码（GDAL 的 open option，不是 layer option）。
      args.push('-oo', `ENCODING=${options.encoding}`);
    }
    if (select) args.push('-select', select);
    // 有条件时不在 GDAL 侧限量：限量要发生在筛选之后
    if (options.limit !== undefined && options.limit > 0 && whereNode === null) {
      args.push('-limit', String(options.limit));
    }
    // ⚠️ ogr2ogr 的参数顺序是 **dst 在前、src 在后**（与 ogrinfo 相反）
    args.push(out, path);

    const res = await gdal.ogr2ogr(args);
    if (!res.ok) {
      throw new VectorError(`读不了这个图层：${path}`, res.stderr);
    }
    if (!existsSync(out)) {
      throw new VectorError(`转换命令跑完了但没产出文件：${path}`, res.stderr);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(out, 'utf8'));
    } catch (err) {
      throw new VectorError(`转出来的 GeoJSON 不是合法 JSON：${path}`, String(err));
    }

    const rawFeatures = Array.isArray((parsed as { features?: unknown[] }).features)
      ? (parsed as { features: unknown[] }).features
      : [];

    let features = rawFeatures.map(toFeatureRecord);

    if (whereNode) {
      features = features.filter((f) => matchesWhere(whereNode!, f.properties));
    }

    // 有条件时 totalCount = 条件命中的条数（筛选是引擎做的，条数是准的）；
    // 没条件时 totalCount = 图层总条数（limit 只是没让它全读出来）
    const totalCount = whereNode ? features.length : Math.max(info.featureCount, features.length);
    const limit = options.limit !== undefined && options.limit > 0 ? options.limit : undefined;
    const truncated = limit !== undefined && totalCount > limit;
    if (limit !== undefined && features.length > limit) {
      features = features.slice(0, limit);
    }

    return {
      features,
      featureCount: features.length,
      totalCount,
      truncated,
      fields: info.fields.map((f) => f.name),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
