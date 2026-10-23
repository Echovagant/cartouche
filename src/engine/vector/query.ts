/**
 * `vector.query`：按条件查属性。
 *
 * 这一步是"一句话出表"的入口：用户给一句条件（SQL 或人话都行），
 * 引擎读出符合条件的要素，把属性表交回去。
 *
 * 结果形状与非栅格型 op（dataset.open / dataset.healthCheck）一致：
 * `{ kind: 'value', summary, data }`。
 */
import type { GdalLocation } from '../gdal/env.ts';
import type { WorkspaceAdapter } from '../workspace/index.ts';
import type { OpValueResult } from '../ops/executor.ts';
import { readFeatures } from './read.ts';
import { toRelPathChecked } from './paths.ts';
import type { FeatureRecord } from './types.ts';

/** op 执行时拿到的环境（与 ops/executor.ts 的 ExecutorDeps 对齐）。 */
export interface VectorOpDeps {
  readonly loc: GdalLocation;
  readonly store: WorkspaceAdapter;
}

/** 读一个字符串参数；不给或给空串都算没给。 */
function readString(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** 读一个字符串数组参数。 */
function readStringArray(
  params: Readonly<Record<string, unknown>>,
  key: string,
): string[] | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error(`参数 ${key} 必须是数组`);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || x.trim() === '') {
      throw new Error(`参数 ${key} 里只能放非空字符串`);
    }
    out.push(x);
  }
  return out;
}

/**
 * 执行 vector.query。
 *
 * @throws {Error} 参数不对、图层打不开、条件里的列不存在。
 */
export async function runVectorQuery(
  params: Readonly<Record<string, unknown>>,
  deps: VectorOpDeps,
): Promise<OpValueResult> {
  const rawTarget = readString(params, 'target');
  if (rawTarget === undefined) throw new Error('缺少参数 target（要查的图层，dataset:// 开头）');
  const targetRel = toRelPathChecked(rawTarget, 'target');

  const where = readString(params, 'where');
  const fields = readStringArray(params, 'fields');

  const rawLimit = params['limit'];
  let limit: number | undefined;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit <= 0) {
      throw new Error(`参数 limit 必须是正整数，实为 ${JSON.stringify(rawLimit)}`);
    }
    limit = rawLimit;
  }

  const abs = deps.store.resolve(targetRel);
  const result = await readFeatures(deps.loc, {
    path: abs,
    ...(where ? { where } : {}),
    ...(fields ? { fields } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  const features: readonly FeatureRecord[] = result.features;
  const whereText = where ? `条件「${where}」` : '全部要素';

  return {
    kind: 'value',
    summary:
      `查到 ${result.featureCount} 条要素（${whereText}）` +
      (result.truncated ? `，共 ${result.totalCount} 条，只返回了前 ${result.featureCount} 条` : ''),
    data: {
      featureCount: result.featureCount,
      totalCount: result.totalCount,
      truncated: result.truncated,
      features: features.map((f) => ({ properties: f.properties, geometry: f.geometry })),
      target: targetRel,
      fields: result.fields,
      ...(where ? { where } : {}),
    },
  };
}
