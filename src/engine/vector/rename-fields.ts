/**
 * `vector.renameFields`：改字段名（值不动）。
 *
 * 对应 ArcGIS Pro 的"字段名"编辑。听起来只是改个名字，实际有两个坑：
 *
 *  1. **Shapefile 的列名最多 10 字节**。超出的部分 GDAL 会截断，
 *     并在 stderr 留一条 "Normalized/laundered field name" 的 Warning ——
 *     **退出码还是 0**。所以「更新编号」写进去会变成「更新编?」。
 *     用户以为改成了想要的名字，下次按新名字查就查不到。
 *     所以这里报的是**文件里实际存在的列名**，不是用户要求的名字。
 *  2. **重名会被静默覆盖**。把 A 改成 B，而 B 这一列本来就在，
 *     后果是用户的数据被顶掉。所以重名当场报错，不猜用户想保留哪一个。
 */
import { probeLayer, readFeatures } from './read.ts';
import { writeFeatures } from './write.ts';
import { toRelPathChecked } from './paths.ts';
import { readAliasObjectParam, readStringParam } from './params.ts';
import { assertValidFieldName, displayFieldName, findWrittenField, valuesMatch } from './field-names.ts';
import { encodingForWriteback } from './encoding.ts';
import { VectorError, type FeatureRecord } from './types.ts';
import type { OpValueResult } from '../ops/executor.ts';
import type { VectorOpDeps } from './query.ts';

/** 一条改名：请求的名字与文件里实际存在的名字。 */
interface RenamePlan {
  /** 用户写的旧名 */
  readonly requestedFrom: string;
  /** 图层里实际的旧名（大小写可能与用户写的不一样） */
  readonly from: string;
  /** 用户要的新名 */
  readonly requestedTo: string;
  /** 写进文件之后的实际列名（截断后才确定，所以写回之前是空的） */
  actualTo?: string;
}

/**
 * 执行 vector.renameFields。
 *
 * @throws {VectorError} 旧列不存在、新名不合法、与已有列重名、写回校验不过。
 */
export async function runVectorRenameFields(
  params: Readonly<Record<string, unknown>>,
  deps: VectorOpDeps,
  dryRun = false,
): Promise<OpValueResult> {
  const rawTarget = readStringParam(params, 'target');
  if (rawTarget === undefined) {
    throw new Error('缺少参数 target（要改字段名的图层，dataset:// 开头）');
  }
  const targetRel = toRelPathChecked(rawTarget, 'target');

  // mapping 是契约里的键名；renames 是同一个意思的另一种写法，只给一个才合法
  const alias = readAliasObjectParam(params, ['mapping', 'renames']);
  if (alias === undefined) {
    throw new Error('缺少参数 mapping（形如 {"旧字段名": "新字段名"}）');
  }
  const mapping = alias.value;
  const entries = Object.entries(mapping);
  if (entries.length === 0) {
    throw new Error('参数 mapping 是空的：没有要改名的字段');
  }

  if (!(await deps.store.exists(targetRel))) {
    throw new Error(`目标不存在，无法改字段名：${targetRel}`);
  }
  const targetAbs = deps.store.resolve(targetRel);
  const info = await probeLayer(deps.loc, targetAbs);
  const existing = info.fields.map((f) => f.name);

  // ── 逐条校验 ───────────────────────────────────────────────────
  const plans: RenamePlan[] = [];
  for (const [rawFrom, rawTo] of entries) {
    if (typeof rawTo !== 'string') {
      throw new Error(`参数 mapping 里「${rawFrom}」的新名字必须是字符串`);
    }
    const from = existing.find((n) => n.toLowerCase() === rawFrom.trim().toLowerCase());
    if (!from) {
      throw new VectorError(
        `这个图层里没有「${rawFrom}」这一列（这一层的列有：${existing.join('、') || '（一列都没有）'}）`,
      );
    }
    assertValidFieldName(rawTo);
    plans.push({ requestedFrom: rawFrom, from, requestedTo: rawTo });
  }

  // 重名检查：改完之后所有列名必须互不相同。
  // 口径是"改完之后的最终名单" —— 所以 A→B、B→C 这种接力改名是允许的，
  // 而 A→B（B 不改）会撞名，必须报错。
  const renamedFrom = new Set(plans.map((p) => p.from.toLowerCase()));
  const finalNames = [
    ...existing.filter((n) => !renamedFrom.has(n.toLowerCase())),
    ...plans.map((p) => p.requestedTo),
  ];
  const seen = new Map<string, string>();
  for (const name of finalNames) {
    const key = name.toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined) {
      throw new VectorError(
        `改名之后会有两列同名：「${prev}」与「${name}」。` +
          '与已有列重名会被静默覆盖（原数据就没了），所以没有继续。',
      );
    }
    seen.set(key, name);
  }

  // ── 改名（值不动） ─────────────────────────────────────────────
  const source = await readFeatures(deps.loc, { path: targetAbs });
  const renamed: FeatureRecord[] = source.features.map((f) => {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(f.properties)) {
      const plan = plans.find((p) => p.from.toLowerCase() === key.toLowerCase());
      properties[plan ? plan.requestedTo : key] = value;
    }
    return { properties, geometry: f.geometry };
  });

  const planText = plans
    .map((p) => `${p.from} → ${p.requestedTo}`)
    .join('、');

  if (dryRun) {
    return {
      kind: 'value',
      summary:
        `将改名 ${plans.length} 个字段：${planText}（共 ${source.features.length} 条要素，值不动）` +
        '（预演：没有写盘）',
      data: {
        target: targetRel,
        mapping: Object.fromEntries(plans.map((p) => [p.from, p.requestedTo])),
        renamed: plans.map((p) => ({ from: p.from, to: p.requestedTo })),
        featureCount: source.features.length,
        fieldNames: finalNames,
        dryRun: true,
      },
    };
  }

  // ── 写回 ───────────────────────────────────────────────────────
  const write = await writeFeatures(deps.loc, deps.store, {
    target: targetRel,
    features: renamed,
    // 改名不该顺手把 GBK 的属性表换成 UTF-8
    encoding: encodingForWriteback(targetAbs),
  });

  // ── 写回后核对：列在不在、实际叫什么、值有没有变 ───────────────
  const writtenNames = write.fieldNames;
  for (const plan of plans) {
    const actual = findWrittenField(writtenNames, plan.requestedTo);
    if (!actual) {
      throw new VectorError(
        `写回之后没有找到「${plan.requestedTo}」这一列（文件里现在有：${writtenNames
          .map(displayFieldName)
          .join('、') || '（一列都没有）'}）。` +
          `原数据没有被改坏，备份在 ${write.backupPath ?? '（没有）'}`,
      );
    }
    plan.actualTo = actual;
  }

  const after = await readFeatures(deps.loc, { path: targetAbs });
  for (let i = 0; i < after.features.length && i < renamed.length; i += 1) {
    for (const plan of plans) {
      const want = renamed[i]!.properties[plan.requestedTo];
      const got = after.features[i]!.properties[plan.actualTo as string] ?? null;
      if (!valuesMatch(want, got)) {
        throw new VectorError(
          `写回之后这一列的值对不上（第 ${i + 1} 条要素，原值 ${JSON.stringify(want)}，` +
            `写回去是 ${JSON.stringify(got)}）。原数据的其它列没有被改坏，` +
            `备份在 ${write.backupPath ?? '（没有）'}`,
        );
      }
    }
  }

  const caveats: string[] = [];
  for (const plan of plans) {
    if (plan.actualTo !== plan.requestedTo) {
      caveats.push(
        `「${plan.requestedTo}」在文件里实际是「${displayFieldName(plan.actualTo as string)}」` +
          '（Shapefile 的列名最多 10 字节，超出的部分被截断了）',
      );
    }
  }

  const summary =
    `已改名 ${plans.length} 个字段：${plans
      .map((p) => `${p.from} → ${displayFieldName(p.actualTo ?? p.requestedTo)}`)
      .join('、')}` +
    `（${source.features.length} 条要素，值未变）` +
    (caveats.length > 0 ? `（${caveats.join('；')}）` : '');

  return {
    kind: 'value',
    summary,
    data: {
      target: targetRel,
      mapping: Object.fromEntries(
        plans.map((p) => [p.from, displayFieldName(p.actualTo ?? p.requestedTo)]),
      ),
      renamed: plans.map((p) => ({
        from: p.from,
        requestedTo: p.requestedTo,
        to: displayFieldName(p.actualTo ?? p.requestedTo),
        truncated: p.actualTo !== p.requestedTo,
      })),
      featureCount: source.features.length,
      fieldNames: writtenNames.map(displayFieldName),
      ...(caveats.length > 0 ? { caveats } : {}),
      backupPath: write.backupPath,
    },
  };
}
