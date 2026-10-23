/**
 * `feature.delete`：按条件删除要素。
 *
 * 对应 ArcGIS Pro 的「按属性删除要素」。Pro 里删要素是不可撤销的一步，
 * 用户点错了就是少了一行数据；这里把**先看一眼会删掉哪些**做成预演，
 * 并且写回走 vector/write.ts 的 writeFeatures（整组备份 + 原子替换 + 失败回滚），
 * 删错了还能从备份里拿回来。
 *
 * `keep` 的四个取值（契约里的枚举）：
 *  - none（默认）：命中的全删；
 *  - first：留第一条（按图层里的顺序，即文件里的第几条），其余删掉；
 *  - last：留最后一条，其余删掉；
 *  - largest：留"最大"的那条（面看面积、线看长度、点算 0），其余删掉。
 *
 * 为什么 largest 不看属性值：契约里没有"按哪个字段比大小"这一项，
 * 而要素本身的大小是唯一不依赖额外参数的客观量纲。
 * 它只比大小、不比绝对值，所以坐标系是米还是英尺都不影响名次。
 */
import type { OpValueResult } from '../ops/executor.ts';
import { probeLayer, readFeatures } from '../vector/read.ts';
import { writeFeatures } from '../vector/write.ts';
import { toRelPathChecked } from '../vector/paths.ts';
import { VectorError, type FeatureRecord } from '../vector/types.ts';
import type { VectorOpDeps } from '../vector/query.ts';
import {
  columnTypeChanges,
  compileWhere,
  fieldNamesHint,
  matchIndexes,
  requireString,
  sameValue,
} from './common.ts';
import { geometryKind, geometryKindLabel, planarArea, planarLength } from './measure.ts';

/** 契约里 keep 的全部取值。 */
const KEEP_MODES: readonly string[] = ['none', 'first', 'last', 'largest'];

/** 保留哪一条的说明（写进报告与确认卡）。 */
interface KeptInfo {
  readonly featureIndex: number;
  readonly reason: string;
}

/**
 * 执行 feature.delete。
 *
 * @throws {VectorError} 参数不对、图层打不开、条件命中 0 条、
 *                      按 keep 规则其实一条也删不掉、会把图层删空、写回或写后校验不过。
 */
export async function runFeatureDelete(
  params: Readonly<Record<string, unknown>>,
  deps: VectorOpDeps,
  /** 预演：只算不写（确认卡上那一下"会删掉几条"）。 */
  dryRun = false,
): Promise<OpValueResult> {
  const rawTarget = requireString(params, 'target', '要删要素的图层，dataset:// 开头');
  const targetRel = toRelPathChecked(rawTarget, 'target');
  const where = requireString(params, 'where', '筛选条件（SQL 或人话）');

  const rawKeep = params['keep'];
  // ⚠️ 给错了类型不能当默认值处理：
  //    keep 写成数字 5 时如果默默当成 none，命中的要素会被全删 —— 那是最坏的一种错。
  if (rawKeep !== undefined && rawKeep !== null && typeof rawKeep !== 'string') {
    throw new VectorError(
      `参数 keep 只能是 ${KEEP_MODES.join(' / ')}，实为 ${JSON.stringify(rawKeep)}`,
    );
  }
  const keep = typeof rawKeep === 'string' && rawKeep.trim() !== '' ? rawKeep : 'none';
  if (!KEEP_MODES.includes(keep)) {
    throw new VectorError(
      `参数 keep 只能是 ${KEEP_MODES.join(' / ')}，实为「${keep}」`,
    );
  }

  const abs = deps.store.resolve(targetRel);
  const info = await probeLayer(deps.loc, abs);
  const whereNode = compileWhere(where, info.fields);

  const read = await readFeatures(deps.loc, { path: abs });
  const hits = matchIndexes(read.features, whereNode);
  if (hits.length === 0) {
    // ⚠️ 0 条命中不是"成功地什么都没删"——用户会以为数据已经清理过了。
    throw new VectorError(
      `条件没有命中任何要素（0 条命中）：「${where}」。` +
        `这一层一共 ${read.features.length} 条要素，一条都没删。` +
        `可能是条件太严，也可能是字段名写错了（这一层的列有：${fieldNamesHint(info.fields)}）。`,
    );
  }

  /* ── 按 keep 规则决定删哪些、留哪条 ─────────────────────────── */
  let deleteIndexes: number[];
  let kept: KeptInfo | null = null;
  if (keep === 'none') {
    deleteIndexes = [...hits];
  } else if (keep === 'first') {
    const keepIndex = hits[0]!;
    deleteIndexes = hits.slice(1);
    kept = { featureIndex: keepIndex + 1, reason: 'keep=first：保留图层里的第一条' };
  } else if (keep === 'last') {
    const keepIndex = hits[hits.length - 1]!;
    deleteIndexes = hits.slice(0, -1);
    kept = { featureIndex: keepIndex + 1, reason: 'keep=last：保留图层里的最后一条' };
  } else {
    // keep=largest：比要素本身的大小。
    // ⚠️ 比较口径必须统一：面积和长度不是一回事，
    //    拿"面 900 m²"和"线 5000 m"比大小是胡比。
    //    所以先看这批要素里有没有面：有就一律按面积比（线、点算 0），
    //    没有面只有线就按长度比，全是点则没有大小之分（下面报错）。
    const kinds = hits.map((i) => geometryKind(read.features[i]!.geometry));
    const hasArea = kinds.includes('area');
    const hasLine = kinds.includes('line');
    if (!hasArea && !hasLine) {
      throw new VectorError(
        `条件命中的 ${hits.length} 条要素全是点要素或没有几何，没有大小之分，keep=largest 判不出来。` +
          `改用 keep=first / keep=last，或者 keep=none 全删。`,
      );
    }
    const metric = hasArea ? planarArea : planarLength;
    const metricName = hasArea ? '面积' : '长度';
    let best = hits[0]!;
    let bestSize = -1;
    for (const idx of hits) {
      const size = metric(read.features[idx]!.geometry, `第 ${idx + 1} 条要素`);
      if (size > bestSize) {
        bestSize = size;
        best = idx;
      }
    }
    if (bestSize <= 0) {
      // 比不出大小：面面积全是 0（退化面），或本来就只有点
      throw new VectorError(
        hasArea
          ? `条件命中的 ${hits.length} 条要素里，面要素的面积都是 0，比不出哪条最大。` +
            `换用 keep=first / keep=last，或者 keep=none 全删。`
          : `条件命中的 ${hits.length} 条要素全是点要素或没有几何，没有大小之分，keep=largest 判不出来。` +
            `改用 keep=first / keep=last，或者 keep=none 全删。`,
      );
    }
    deleteIndexes = hits.filter((i) => i !== best);
    kept = {
      featureIndex: best + 1,
      reason:
        `keep=largest：保留最大的那条（${geometryKindLabel(read.features[best]!.geometry)}，` +
        `${metricName} ${bestSize}）`,
    };
  }

  if (deleteIndexes.length === 0) {
    throw new VectorError(
      `条件命中 ${hits.length} 条，但按 keep=${keep} 的规则要留下 1 条 —— 实际一条也删不掉。` +
        `换个条件，或把 keep 改成 none。`,
    );
  }
  if (deleteIndexes.length === read.features.length) {
    // ⚠️ 删空图层会把属性表的字段定义一起弄丢：
    //    写回是"把要素写出去"，一条不剩就没有字段可写（实测：写出来的是一张没有列的表）。
    //    与其悄悄把用户的表结构清空，不如在这里说清楚。
    throw new VectorError(
      `这个条件会删掉图层里的全部 ${read.features.length} 条要素（等于清空图层）。` +
        `引擎不写空的属性表（字段定义会一起丢），所以这一步停下了。` +
        `想留一部分就加 keep（first / last / largest），想清空请直接新建一个空图层。`,
    );
  }

  const deleteSet = new Set(deleteIndexes);
  const nextFeatures: FeatureRecord[] = read.features.filter((_, i) => !deleteSet.has(i));

  /* ── 预演 ───────────────────────────────────────────────────── */
  if (dryRun) {
    return {
      kind: 'value',
      summary:
        `将删掉 ${deleteIndexes.length} 条要素（命中 ${hits.length} 条，共 ${read.features.length} 条）` +
        (kept ? `；${kept.reason}（第 ${kept.featureIndex} 条）` : '') +
        '（预演：没有写盘）',
      data: {
        target: targetRel,
        where,
        keep,
        matched: hits.length,
        deleted: deleteIndexes.length,
        remaining: nextFeatures.length,
        total: read.features.length,
        ...(kept ? { kept } : {}),
        dryRun: true,
      },
    };
  }

  /* ── 写回 ───────────────────────────────────────────────────── */
  const write = await writeFeatures(deps.loc, deps.store, {
    target: targetRel,
    features: nextFeatures,
  });

  /* ── 写完核对：条数对不对，剩下的要素有没有被改坏 ───────────── */
  const after = await readFeatures(deps.loc, { path: abs });
  if (after.features.length !== nextFeatures.length) {
    throw new VectorError(
      `写回之后要素数不对：应该剩 ${nextFeatures.length} 条，读回来 ${after.features.length} 条。` +
        `备份在 ${write.backupPath ?? '（没有）'}`,
    );
  }
  let mismatched = 0;
  let firstProblem: string | null = null;
  for (let i = 0; i < after.features.length; i += 1) {
    const before = nextFeatures[i]!.properties;
    const got = after.features[i]!.properties;
    for (const key of Object.keys(before)) {
      if (sameValue(before[key], got[key] ?? null)) continue;
      mismatched += 1;
      if (firstProblem === null) {
        firstProblem =
          `第 ${i + 1} 条要素的「${key}」：原来 ${JSON.stringify(before[key] ?? null)}，` +
          `写回去 ${JSON.stringify(got[key] ?? null)}`;
      }
    }
  }
  if (mismatched > 0) {
    throw new VectorError(
      `写回之后剩下的要素属性对不上（${mismatched} 处不一致，例：${firstProblem}）。` +
        `备份在 ${write.backupPath ?? '（没有）'}`,
    );
  }

  // 列的类型有没有变：写回是把整层重写一遍，删掉几条要素可能让某一列
  // 从小数列变成整数列（Shapefile 按值推断类型）。这属于格式的规则，
  // 但必须说出来 —— 不说就是"报告与文件对不上"。
  const afterInfo = await probeLayer(deps.loc, abs);
  const typeNotes = columnTypeChanges(info.fields, afterInfo.fields);

  return {
    kind: 'value',
    summary:
      `已删掉 ${deleteIndexes.length} 条要素（命中 ${hits.length} 条，共 ${read.features.length} 条）` +
      (kept ? `；${kept.reason}（第 ${kept.featureIndex} 条）` : '') +
      `，剩下 ${nextFeatures.length} 条` +
      (typeNotes.length > 0 ? `（${typeNotes.join('；')}）` : ''),
    data: {
      target: targetRel,
      where,
      keep,
      matched: hits.length,
      deleted: deleteIndexes.length,
      remaining: nextFeatures.length,
      total: read.features.length,
      backupPath: write.backupPath,
      ...(kept ? { kept } : {}),
      ...(typeNotes.length > 0 ? { typeNotes } : {}),
    },
  };
}
