/**
 * 空间连接（按位置连接）的算法部分。
 *
 * ── op 契约（供主会话登记 `vector.spatialJoin` 时照抄，本文件不登记 op） ──
 *
 * op: `vector.spatialJoin`
 * params:
 *   - `target`（必填）：`dataset://<工作区相对路径>` —— 被连接、写入汇总值的目标图层
 *   - `source`（必填）：`dataset://<工作区相对路径>` —— 提供属性与几何的源图层
 *   - `relation`（必填）：`within` | `intersects` | `contains`
 *   - `aggregate`（可选，默认 `first`）：`first` | `count` | `sum` | `mean`
 *   - `fields?`：参与汇总的源字段
 *   - `fieldPrefix?`：汇总字段名前缀
 * result.data:
 *   - `matched`：匹配上至少一个源要素的目标要素个数
 *   - `unmatched`：没匹配上任何源要素的目标要素下标数组
 *   - `aggregates`：每个目标要素的汇总值对象数组（与目标要素同序；未匹配的为全 null）
 *
 * ── 三种关系的方向（最容易搞混的地方） ──
 *
 *   relation      判定              方向
 *   ───────────── ───────────────── ─────────────────────────────────
 *   within        目标 ⊆ 源          目标要素完全落在源要素内部
 *   intersects    目标 ∩ 源 ≠ ∅      不要求谁包含谁
 *   contains      源 ⊆ 目标          源要素完全落在目标要素内部（与 within 反向）
 *
 * 举例：目标图层是「学校」点，源图层是「学区」面。
 *   - `within`：落在某个学区内（点 ⊆ 面）→ 学校拿到该学区的属性。
 *   - `contains`：某个学区把所有学校都圈进去了（面 ⊇ 点）→ 学区拿到学校的属性。
 *   - `intersects`：点落在学区边界上、或学校正好压在学区的界线上也算。
 */
import {
  bboxOfNormalized,
  bboxPreFilter,
  containsNormalized,
  intersectsNormalized,
  normalizeGeometry,
} from '../geometry/index.ts';
import type { BBox, NormalizedGeometry } from '../geometry/index.ts';
import { SpatialJoinError } from './types.ts';
import type {
  FeatureLike,
  JoinAggregate,
  SpatialJoinOptions,
  SpatialJoinResult,
} from './types.ts';

/** `count` 汇总的字段名（可被 `fieldPrefix` 加前缀）。 */
export const JOIN_COUNT_FIELD = 'count';

interface JoinRow {
  readonly targetIndex: number;
  readonly sourceIndexes: readonly number[];
  readonly aggregates: Readonly<Record<string, number | string | null>>;
}

/** 几何不合法时把定位信息补上再抛，避免用户拿到一句「第 3 个要素坏了」却不知道是哪个图层。 */
function normalizeForJoin(geometry: unknown, label: string): NormalizedGeometry {
  try {
    return normalizeGeometry(geometry, label);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SpatialJoinError(`${label}不合法：${reason}`);
  }
}

/** 属性值转成汇总结果能承载的类型（number | string | null）。 */
function scalarize(value: unknown): number | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  try {
    const s: string | undefined = JSON.stringify(value);
    return typeof s === 'string' ? s : null;
  } catch {
    return String(value);
  }
}

/** 读属性；运行时容错（属性可能整个缺失）。 */
function propOf(feature: FeatureLike | undefined, name: string): unknown {
  const props = feature?.properties;
  if (!props) return undefined;
  return props[name];
}

/**
 * 空间连接：把目标要素按空间位置对上源要素，并汇总源属性。
 *
 * 纯函数：不碰文件、不碰 GDAL，同样的输入必然给出同样的输出。
 */
export function spatialJoin(
  targets: readonly FeatureLike[],
  sources: readonly FeatureLike[],
  options: SpatialJoinOptions,
): SpatialJoinResult {
  if (!Array.isArray(targets) || !Array.isArray(sources)) {
    throw new SpatialJoinError('空间连接的输入必须是要素数组');
  }
  if (!options || typeof options !== 'object') {
    throw new SpatialJoinError('空间连接缺少参数');
  }
  const relation = options.relation;
  if (relation !== 'within' && relation !== 'intersects' && relation !== 'contains') {
    throw new SpatialJoinError(
      `未知的空间关系：${String(relation)}（只支持 within / intersects / contains）`,
    );
  }
  const aggregate: JoinAggregate = options.aggregate ?? 'first';
  if (aggregate !== 'first' && aggregate !== 'count' && aggregate !== 'sum' && aggregate !== 'mean') {
    throw new SpatialJoinError(
      `未知的汇总方式：${String(aggregate)}（只支持 first / count / sum / mean）`,
    );
  }

  /* ── 源要素的几何与包围盒只算一遍 ──
     要素多时这是主要的耗时来源：每个目标要素都要对每个源要素问一次
     「包围盒有没有可能相交」，源包围盒算一次就够。 */
  const sourceGeoms: NormalizedGeometry[] = [];
  const sourceBoxes: BBox[] = [];
  for (let j = 0; j < sources.length; j++) {
    const feature = sources[j];
    if (!feature) throw new SpatialJoinError(`源图层第 ${j} 个要素缺失`);
    const geom = normalizeForJoin(feature.geometry, `源图层第 ${j} 个要素的几何`);
    sourceGeoms.push(geom);
    sourceBoxes.push(bboxOfNormalized(geom));
  }

  /* ── 汇总字段的选取 ──
     「数值字段」的判定：所有源要素里该字段的非空值都是有限数字。
     之所以要求「所有」而不是「至少一个」：字段类型必须对整层是确定的，
     否则同一个字段在 A 区算得出数字、在 B 区算不出，用户没法解释。 */
  const sourceFieldNames: string[] = [];
  for (const s of sources) {
    const props = s?.properties ?? {};
    for (const key of Object.keys(props)) {
      if (!sourceFieldNames.includes(key)) sourceFieldNames.push(key);
    }
  }
  const existsInSources = (name: string): boolean =>
    sources.some((s) => propOf(s, name) !== undefined);
  const isNumericField = (name: string): boolean => {
    for (const s of sources) {
      const v = propOf(s, name);
      if (v === null || v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    }
    return true;
  };

  const requested = options.fields ? [...options.fields] : sourceFieldNames;
  const aggregateFields: string[] = [];
  const skippedFields: string[] = [];
  if (aggregate === 'count') {
    // count 只产出一个计数字段，参与哪些源字段没有意义
  } else if (aggregate === 'first') {
    for (const name of requested) {
      if (existsInSources(name)) aggregateFields.push(name);
      else skippedFields.push(name);
    }
  } else {
    for (const name of requested) {
      if (existsInSources(name) && isNumericField(name)) aggregateFields.push(name);
      else skippedFields.push(name);
    }
  }

  const prefix = options.fieldPrefix ?? '';
  const countFieldName = `${prefix}${JOIN_COUNT_FIELD}`;

  const aggregateFor = (matched: readonly number[]): Record<string, number | string | null> => {
    const out: Record<string, number | string | null> = {};
    if (aggregate === 'count') {
      out[countFieldName] = matched.length === 0 ? null : matched.length;
      return out;
    }
    if (matched.length === 0) {
      // 没匹配上：字段名照给，值一律 null（缺测不是 0，也不是空字符串）
      for (const name of aggregateFields) out[`${prefix}${name}`] = null;
      return out;
    }
    if (aggregate === 'first') {
      const first = sources[matched[0] ?? 0];
      for (const name of aggregateFields) out[`${prefix}${name}`] = scalarize(propOf(first, name));
      return out;
    }
    for (const name of aggregateFields) {
      const values: number[] = [];
      for (const j of matched) {
        const v = propOf(sources[j], name);
        if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
      }
      if (values.length === 0) {
        // 一个有效数值都没有 → 缺测，不是 0
        out[`${prefix}${name}`] = null;
        continue;
      }
      let sum = 0;
      for (const v of values) sum += v;
      out[`${prefix}${name}`] = aggregate === 'sum' ? sum : sum / values.length;
    }
    return out;
  };

  const rows: JoinRow[] = [];
  const unmatched: number[] = [];
  for (let i = 0; i < targets.length; i++) {
    const feature = targets[i];
    if (!feature) throw new SpatialJoinError(`目标图层第 ${i} 个要素缺失`);
    const target = normalizeForJoin(feature.geometry, `目标图层第 ${i} 个要素的几何`);
    const targetBox = bboxOfNormalized(target);

    const matched: number[] = [];
    for (let j = 0; j < sourceGeoms.length; j++) {
      const sourceBox = sourceBoxes[j];
      const source = sourceGeoms[j];
      if (!sourceBox || !source) continue;
      // 包围盒是必要条件，先用它剪掉绝大多数不可能的候选
      if (!bboxPreFilter(relation, targetBox, sourceBox)) continue;
      const hit =
        relation === 'within'
          ? containsNormalized(source, target)
          : relation === 'contains'
            ? containsNormalized(target, source)
            : intersectsNormalized(target, source);
      if (hit) matched.push(j);
    }

    rows.push({ targetIndex: i, sourceIndexes: matched, aggregates: aggregateFor(matched) });
    if (matched.length === 0) unmatched.push(i);
  }

  return { rows, unmatched, skippedFields };
}

/**
 * op 的 `data` 形状。
 *
 * - `matched`：匹配上**至少一个**源要素的目标要素个数（不是匹配对数）。
 * - `unmatched`：没匹配上任何源要素的目标要素下标。
 * - `aggregates`：每个目标要素的汇总值对象数组，与目标要素同序；未匹配的是全 null。
 * - `skippedFields`：被跳过的源字段（在基础契约之外加的一项，为的是让
 *   「汇总值少了哪几列」有据可查）。
 */
export interface SpatialJoinOpData {
  readonly matched: number;
  readonly unmatched: readonly number[];
  readonly aggregates: ReadonlyArray<Readonly<Record<string, number | string | null>>>;
  readonly skippedFields: readonly string[];
}

/** 把连接结果整成 op 的 `data` 形状。 */
export function toOpData(result: SpatialJoinResult): SpatialJoinOpData {
  return {
    matched: result.rows.length - result.unmatched.length,
    unmatched: result.unmatched,
    aggregates: result.rows.map((row) => row.aggregates),
    skippedFields: result.skippedFields,
  };
}
