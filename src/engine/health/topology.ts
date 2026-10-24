/**
 * 拓扑级检查：自相交、面重叠、几何有效性。
 *
 * ── 为什么走 SpatiaLite ──
 * 这三件事要判的是 OGC 意义上的几何有效性，纯手写要写一整套鲁棒的多边形
 * 有效性判定（自相交、环套环、退化、洞在外壳外……），而且写错了很难发现。
 * GDAL 的 SQLite 方言在编进 SpatiaLite 时能直接调 GEOS 的判定函数，
 * 实测（本机 GDAL 3.13）`ST_IsValid` / `ST_IsValidReason` / `ST_Intersection` 都可用。
 *
 * ── 关键约束：查不了就必须说查不了 ──
 * SpatiaLite 不是 GDAL 的必需组件，别人的 GDAL 可能没编进去。
 * 所以这里的每一步都要能落到一个明确的「没查成」状态上，
 * 由上层如实写进报告 —— 绝不能让「没查」在报告里长得像「查过、没问题」。
 *
 * ── 要素对应关系 ──
 * SQL 侧拿不到源图层的 FID（SQLite 方言不提供 FID 列），
 * 所以用 `ROW_NUMBER() OVER (ORDER BY rowid) - 1` 造一个 0 起的行号，
 * 再按**源顺序**与扫描到的要素一一对应。
 * 两边都是同一个图层按同一顺序遍历，对应关系成立；
 * 数量对不上时（截断口径不一致）就只报数量、不报要素号，不硬凑。
 */
import { tools } from '../gdal/runner.ts';
import type { GdalLocation } from '../gdal/env.ts';
import type { CheckStatus, Finding } from './types.ts';

/** 几何列名候选：Shapefile 方言给 GEOMETRY，GPKG 给 geom */
const GEOMETRY_COLUMNS = ['GEOMETRY', 'geom'] as const;

/**
 * 面重叠是两两比较，代价 O(n²)。要素太多时不做 —— 与其让体检卡住，
 * 不如明说「没查」。
 */
export const OVERLAP_MAX_FEATURES = 500;

/**
 * 拓扑检查（几何有效性 / 自相交）的要素数上限。
 *
 * 为什么要有这个上限：GDAL 的 SQLite 方言在执行 SQL 前会把**整个图层**
 * 灌进一个临时 SQLite 库，代价与**要素总数**成正比，而不是与 SQL 里的
 * LIMIT 成正比。实测：9.6 万个要素的线图层，单这一条查询就要 3.6 秒，
 * 加上重叠检查一共十几秒 —— 体检会卡在那儿。
 *
 * 超过上限就不查，并如实写明「没查」。这比让用户等十几秒、或默默截断
 * 只查一部分却报告成"查过了"要好。
 */
export const TOPOLOGY_MAX_FEATURES = 20000;

/** 最多报多少对重叠 */
const OVERLAP_MAX_PAIRS = 200;

/**
 * 算重叠时，重叠面积至少要占**较小那个面**的多少，才算「真重叠」。
 *
 * 为什么不能只看「面积 > 0」：两个相邻的面共享一条边界时，
 * 边界上的顶点不共点，交集就会留下一条极细的缝（sliver），
 * 面积是几平米甚至更小，但相对整片面（几十平方公里）根本不值一提。
 * 实测公开样本（GADM 中国省级，37 个面）里，73 对相邻面都因为这种缝被判成重叠 ——
 * 那不是数据问题，是判据太粗。
 *
 * 取 0.1%：真正的重复数字化 / 数据错误造成的重叠，比例都在百分之几以上；
 * 而边界缝隙的占比在百万分之几量级，两者分得很开。
 */
const OVERLAP_MIN_RATIO = 0.001;

export interface TopologyInput {
  readonly loc: GdalLocation;
  readonly path: string;
  readonly layerName: string;
  /** 与扫描同源、按源顺序排好的要素 id */
  readonly featureIds: readonly (string | number | null)[];
  /** 扫描上限：拓扑查询也只查这么多 */
  readonly limit: number;
  /** 图层的要素总数（用来判断这套检查值不值得跑） */
  readonly totalFeatureCount: number;
  /** 是否要查面重叠（只有面图层才查） */
  readonly checkOverlap: boolean;
  /** 已被其它规则点名过的要素 id —— 同一个事实不报两遍 */
  readonly alreadyFlagged: ReadonlySet<string>;
}

export interface TopologyOutcome {
  readonly findings: Finding[];
  /** 几何有效性（自相交等）这一族的执行状态 */
  readonly validity: { readonly status: CheckStatus; readonly reason?: string };
  /** 面重叠的执行状态 */
  readonly overlap: { readonly status: CheckStatus; readonly reason?: string };
}

/* ───────────────────── CSV ───────────────────── */

/** 解析 ogr2ogr 的 CSV 输出（GDAL 用 \r\n 换行，字段里的逗号用双引号包住） */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 取表头之后的数据行，并按表头名字取列 */
function rowsByHeader(text: string): Record<string, string>[] {
  const rows = parseCsv(text).filter((r) => r.length > 0);
  const header = rows[0];
  if (!header) return [];
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((name, i) => {
      obj[name] = r[i] ?? '';
    });
    return obj;
  });
}

/* ───────────────────── SQL ───────────────────── */

/** 标识符加引号（SQLite 用双引号，内部双引号要写成两个） */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 在 SQLITE 方言下跑一条查询，返回 CSV 文本 */
async function runSql(
  loc: GdalLocation,
  path: string,
  sql: string,
): Promise<{ ok: true; csv: string } | { ok: false; error: string }> {
  const gdal = tools(loc);
  const res = await gdal.ogr2ogr([
    '-f', 'CSV',
    '/vsistdout/',
    '-dialect', 'SQLITE',
    '-sql', sql,
    path,
  ]);
  if (!res.ok) {
    const raw = `${res.stderr}\n${res.stdout}`.trim();
    return { ok: false, error: raw || `ogr2ogr 退出码 ${res.code}` };
  }
  return { ok: true, csv: res.stdout };
}

/** 探测这台机器的 GDAL 有没有编进 SpatiaLite */
async function probeSpatialite(loc: GdalLocation, path: string): Promise<{ ok: boolean; version?: string; error?: string }> {
  const res = await runSql(loc, path, 'SELECT spatialite_version() AS v');
  if (!res.ok) return { ok: false, error: res.error };
  const rows = rowsByHeader(res.csv);
  const v = rows[0]?.['v'];
  if (!v) return { ok: false, error: 'SpatiaLite 版本查询没有返回结果' };
  return { ok: true, version: v };
}

/**
 * 判断一条错误是不是「SpatiaLite 没编进来」。
 *
 * 口径要窄：只认「函数不存在 / 提到 spatialite」这类明确信号。
 * 把 "sqlite3_prepare_v2" 也算进来是不行的 —— 任何 SQL 错误都带这句话，
 * 那样会把「数据打不开」误报成「本机没装 SpatiaLite」，原因写错比不写更糟。
 */
function looksLikeNoSpatialite(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes('no such function') ||
    lower.includes('spatialite') ||
    lower.includes('mod_spatialite')
  );
}

/* ───────────────────── 主流程 ───────────────────── */

export async function runTopologyChecks(input: TopologyInput): Promise<TopologyOutcome> {
  const { loc, path, layerName } = input;
  const layer = quoteIdent(layerName);

  // 要素太多时直接不查：SQLite 方言要把整层灌进临时库，代价与要素总数成正比。
  // 不查就说"没查"，不能让体检卡在那儿，也不能截断一部分却报成"查过了"。
  if (input.totalFeatureCount > TOPOLOGY_MAX_FEATURES) {
    const reason =
      `图层有 ${input.totalFeatureCount} 个要素，超过拓扑检查上限 ${TOPOLOGY_MAX_FEATURES}` +
      '（这一套检查要把整层灌进临时数据库，代价与要素总数成正比），本次未检查自相交、面重叠与几何有效性';
    return {
      findings: [],
      validity: { status: 'skipped', reason },
      overlap: { status: 'skipped', reason },
    };
  }

  // 1) 找一个可用的几何列名
  let geometryColumn: string | null = null;
  let lastError = '';
  for (const col of GEOMETRY_COLUMNS) {
    const sql =
      `SELECT ROW_NUMBER() OVER (ORDER BY rowid) - 1 AS rid, ` +
      `ST_IsValid(${col}) AS ok, ST_IsValidReason(${col}) AS why ` +
      `FROM ${layer} LIMIT ${Math.max(1, input.limit)}`;
    const res = await runSql(loc, path, sql);
    if (res.ok) {
      geometryColumn = col;
      break;
    }
    lastError = res.error;
    // 「没有这一列」才换下一个候选；其它错误（SpatiaLite 缺失等）先记下来。
    if (!/no such column/i.test(res.error)) break;
  }

  if (!geometryColumn) {
    // 分不清是「没有 SpatiaLite」还是「SQL 写错了」时，用一条最小 SQL 探一下，
    // 把原因说准 —— 报告里写「查不了」必须写清「为什么查不了」，
    // 更不能把「数据打不开」写成「本机没装 SpatiaLite」。
    const probe = await probeSpatialite(loc, path);
    const probeError = probe.error ?? lastError;
    let reason: string;
    if (probe.ok) {
      reason = `本机 GDAL 的 SQLite 方言没有可用的几何列，无法做拓扑级检查（${lastError.slice(0, 160)}）`;
    } else if (looksLikeNoSpatialite(probeError)) {
      reason =
        '本机 GDAL 未启用 SpatiaLite，拓扑级检查（自相交、面重叠、几何有效性）无法执行' +
        `（${probeError.slice(0, 160)}）`;
    } else {
      reason = `拓扑级检查无法执行：${probeError.slice(0, 160)}`;
    }
    return {
      findings: [],
      validity: { status: 'skipped', reason },
      overlap: { status: 'skipped', reason },
    };
  }

  const validitySql =
    `SELECT ROW_NUMBER() OVER (ORDER BY rowid) - 1 AS rid, ` +
    `ST_IsValid(${geometryColumn}) AS ok, ST_IsValidReason(${geometryColumn}) AS why ` +
    `FROM ${layer} LIMIT ${Math.max(1, input.limit)}`;
  const validityRes = await runSql(loc, path, validitySql);
  if (!validityRes.ok) {
    const reason = looksLikeNoSpatialite(validityRes.error)
      ? `本机 GDAL 未启用 SpatiaLite（${validityRes.error.slice(0, 160)}），拓扑级检查无法执行`
      : `拓扑检查执行失败：${validityRes.error.slice(0, 160)}`;
    return {
      findings: [],
      validity: { status: 'skipped', reason },
      overlap: { status: 'skipped', reason },
    };
  }

  const rows = rowsByHeader(validityRes.csv);
  const selfIntersect: string[] = [];
  const invalid: string[] = [];
  const reasons = new Map<string, string>();
  for (const row of rows) {
    const rid = Number(row['rid']);
    if (!Number.isFinite(rid)) continue;
    const okRaw = (row['ok'] ?? '').trim();
    // 空几何的 ST_IsValid 返回 NULL（CSV 里是空串），不是 0。
    // 空几何由 V-GEOM-001 报，这里跳过 —— 同一个事实不报两遍。
    if (okRaw !== '0' && okRaw !== '1') continue;
    const why = (row['why'] ?? '').trim();
    const id = featureIdAt(input, rid);
    if (okRaw === '1') continue;
    if (/self-?intersection/i.test(why)) {
      selfIntersect.push(id);
      reasons.set(id, why);
    } else {
      invalid.push(id);
      reasons.set(id, why);
    }
  }

  const findings: Finding[] = [];
  if (selfIntersect.length > 0) {
    findings.push({
      ruleId: 'V-GEOM-003',
      severity: 'error',
      title: '存在自相交的面',
      detail:
        `${selfIntersect.length} 个面的边界自己跟自己相交` +
        (reasons.get(selfIntersect[0]!) ? `，例如 ${reasons.get(selfIntersect[0]!)}` : '') +
        '。这类面在 ArcGIS 里能显示，但做拓扑检查、拼接、裁切时会报错或切出错误结果。',
      affectedCount: selfIntersect.length,
      samples: selfIntersect.slice(0, 5),
      hint: '用"修复几何"操作处理；修复会改变形状，请确认业务上可以接受。',
    });
  }
  if (invalid.length > 0) {
    // 已经由「零面积面 / 零长度线」点过名的要素不再重复报 ——
    // 同一个毛病报两遍，只会让错误条数虚高。
    const fresh = invalid.filter((id) => !input.alreadyFlagged.has(id));
    if (fresh.length > 0) {
      findings.push({
        ruleId: 'V-GEOM-009',
        severity: 'error',
        title: '存在不符合几何有效性要求的面',
        detail:
          `${fresh.length} 个要素没有通过几何有效性检查` +
          (reasons.get(fresh[0]!) ? `，例如要素 ${fresh[0]}：${reasons.get(fresh[0]!)}` : '') +
          '。',
        affectedCount: fresh.length,
        samples: fresh.slice(0, 5),
        hint: '用"修复几何"操作处理。',
      });
    }
  }

  /* 面重叠 */
  let overlapStatus: CheckStatus = 'checked';
  let overlapReason: string | undefined;
  if (!input.checkOverlap) {
    overlapStatus = 'not-applicable';
    overlapReason = '该图层不是面图层，不存在面重叠问题';
  } else if (input.featureIds.length > OVERLAP_MAX_FEATURES) {
    overlapStatus = 'skipped';
    overlapReason = `要素数 ${input.featureIds.length} 超过两两比较上限 ${OVERLAP_MAX_FEATURES}，未检查面重叠`;
  } else {
    const pairs = await findOverlaps(loc, path, layer, geometryColumn, input.limit);
    if (!pairs.ok) {
      overlapStatus = 'skipped';
      overlapReason = `面重叠检查执行失败：${pairs.error.slice(0, 160)}`;
    } else if (pairs.pairs.length > 0) {
      const ids = pairs.pairs.map((p) => `${featureIdAt(input, p.a)} 与 ${featureIdAt(input, p.b)}`);
      findings.push({
        ruleId: 'V-GEOM-004',
        severity: 'warn',
        title: '同一图层里存在互相重叠的面',
        detail:
          `有 ${pairs.pairs.length} 对面互相压在一起` +
          (ids[0] ? `，例如要素 ${ids[0]}` : '') +
          `（重叠面积占较小那个面的 ${(pairs.pairs[0]!.ratio * 100).toFixed(2)}%）。` +
          '重叠面在统计面积时会被重复计算，按面筛选也会命中两层。',
        affectedCount: pairs.pairs.length,
        samples: ids.slice(0, 5),
        hint: '确认这些面是否应当合并；如属重复数字化，清理掉多余的那个。',
      });
    }
  }

  return {
    findings,
    validity: { status: 'checked' },
    overlap: { status: overlapStatus, ...(overlapReason ? { reason: overlapReason } : {}) },
  };
}

/** 行号 → 源要素 id（数量对不上时退回行号，绝不硬凑） */
function featureIdAt(inp: TopologyInput, rid: number): string {
  const id = inp.featureIds[rid];
  return id === undefined || id === null ? `#${rid}` : String(id);
}

/**
 * 找互相重叠的面。
 *
 * 两两比较是 O(n²)，所以先按包围盒筛一遍（便宜的 ST_MinX/ST_MaxX 比较），
 * 只有真正可能相交的两对才去算交叠面积。
 * 参与比较的几何要求本身有效 —— 无效几何喂给 GEOS 会抛异常，
 * 整个查询就废了，所以这里先卡一道 `ok = 1`。
 */
async function findOverlaps(
  loc: GdalLocation,
  path: string,
  layer: string,
  geometryColumn: string,
  limit: number,
): Promise<{ ok: true; pairs: { a: number; b: number; area: number; ratio: number }[] } | { ok: false; error: string }> {
  const sub = `SELECT ROW_NUMBER() OVER (ORDER BY rowid) - 1 AS rid, ${geometryColumn} AS g, ` +
    `ST_IsValid(${geometryColumn}) AS ok, ST_Area(${geometryColumn}) AS ar FROM ${layer} LIMIT ${Math.max(1, limit)}`;
  const sql =
    `WITH v AS (${sub}) ` +
    'SELECT a.rid AS a_rid, b.rid AS b_rid, ST_Area(ST_Intersection(a.g, b.g)) AS ov, ' +
    'a.ar AS a_area, b.ar AS b_area ' +
    'FROM v a JOIN v b ON a.rid < b.rid AND a.ok = 1 AND b.ok = 1 ' +
    'AND ST_MinX(a.g) <= ST_MaxX(b.g) AND ST_MaxX(a.g) >= ST_MinX(b.g) ' +
    'AND ST_MinY(a.g) <= ST_MaxY(b.g) AND ST_MaxY(a.g) >= ST_MinY(b.g) ' +
    'AND ST_Area(ST_Intersection(a.g, b.g)) > 0 ' +
    `LIMIT ${OVERLAP_MAX_PAIRS}`;
  const res = await runSql(loc, path, sql);
  if (!res.ok) return { ok: false, error: res.error };
  const pairs: { a: number; b: number; area: number; ratio: number }[] = [];
  for (const row of rowsByHeader(res.csv)) {
    const a = Number(row['a_rid']);
    const b = Number(row['b_rid']);
    const area = Number(row['ov']);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (!Number.isFinite(area) || area <= 0) continue;
    const aArea = Number(row['a_area']);
    const bArea = Number(row['b_area']);
    const smaller = Math.min(aArea, bArea);
    // 退化面（面积为 0）之间的"重叠"没有比例可言，不报
    if (!Number.isFinite(smaller) || smaller <= 0) continue;
    const ratio = area / smaller;
    if (ratio < OVERLAP_MIN_RATIO) continue;
    pairs.push({ a, b, area, ratio });
  }
  return { ok: true, pairs };
}
