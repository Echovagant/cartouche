/**
 * `vector.recode`：把属性表的编码换一种（GBK ↔ UTF-8 ↔ LATIN1）。
 *
 * **这个 op 是编码转换，不是"按对照表换值"。**
 *
 * 为什么它重要：国内交回来的成果数据，属性表里常常是 GBK。
 * ArcGIS Pro 打开时按 .cpg 或系统默认编码解读，解读不对就是满屏乱码，
 * 而 Pro 自己不会说"我猜错了" —— 用户只能看到一堆问号，
 * 很难判断是数据坏了还是显示错了。
 *
 * ## 源编码怎么定
 *
 * 1. 用户给了 `from` → 就用用户的（显式指定就是用户在做判断）；
 * 2. 没给或写 auto → 先读 .cpg 标记；没有 .cpg 就按字节猜；
 * 3. 猜不出来 → **报错**，不猜一个默认值接着走。
 *    猜错的后果是"转完之后中文变成另一批汉字"，用户要到下次打开文件才发现。
 *
 * ## 转完必须回读核对
 *
 * 写完再按目标编码读回来，逐条比对属性值：值变了就是转坏了。
 * 这一步不能省 —— DBF 的编码转换是最容易"看起来成功、其实全错"的操作。
 */
import { readFeatures } from './read.ts';
import { writeFeatures } from './write.ts';
import { toRelPathChecked } from './paths.ts';
import { readStringParam } from './params.ts';
import {
  SUPPORTED_ENCODINGS,
  detectEncoding,
  normalizeEncoding,
  type SupportedEncoding,
} from './encoding.ts';
import { valuesMatch } from './field-names.ts';
import { VectorError } from './types.ts';
import type { OpValueResult } from '../ops/executor.ts';
import type { VectorOpDeps } from './query.ts';

/** 解出来的文本里混进了替换字符 —— 说明这一串字节不是按这个编码写的。 */
function hasMojibake(values: readonly unknown[]): boolean {
  return values.some((v) => typeof v === 'string' && v.includes('\uFFFD'));
}

/** 执行 vector.recode。
 *
 * @throws {VectorError} 目标不存在、不是 Shapefile、编码认不出来、转完回读对不上。
 */
export async function runVectorRecode(
  params: Readonly<Record<string, unknown>>,
  deps: VectorOpDeps,
  dryRun = false,
): Promise<OpValueResult> {
  const rawTarget = readStringParam(params, 'target');
  if (rawTarget === undefined) {
    throw new Error('缺少参数 target（要转编码的图层，dataset:// 开头）');
  }
  const targetRel = toRelPathChecked(rawTarget, 'target');

  const rawTo = readStringParam(params, 'to');
  if (rawTo === undefined) {
    throw new Error(`缺少参数 to（目标编码：${SUPPORTED_ENCODINGS.join(' / ')}）`);
  }
  const to = normalizeEncoding(rawTo);
  if (to === null) {
    throw new Error(
      `参数 to 只能是 ${SUPPORTED_ENCODINGS.join(' / ')}，实为「${rawTo}」`,
    );
  }

  const rawFrom = readStringParam(params, 'from');
  const rawMarker = params['writeEncodingMarker'];
  let writeMarker = true;
  if (rawMarker !== undefined && rawMarker !== null) {
    if (typeof rawMarker !== 'boolean') {
      throw new Error('参数 writeEncodingMarker 必须是布尔值');
    }
    writeMarker = rawMarker;
  }

  if (!(await deps.store.exists(targetRel))) {
    throw new Error(`目标不存在，无法转编码：${targetRel}`);
  }
  if (!/\.shp$/i.test(targetRel)) {
    throw new Error(
      `编码问题只出在 Shapefile 的属性表（DBF）上；这个文件是 ${targetRel}` +
        (/\.geojson$|\.json$/i.test(targetRel)
          ? '（GeoJSON 按规范就是 UTF-8，没有编码可转）'
          : '（不是 .shp）'),
    );
  }
  const targetAbs = deps.store.resolve(targetRel);

  // ── 源编码 ─────────────────────────────────────────────────────
  let from: SupportedEncoding;
  let fromSource: 'param' | 'cpg' | 'probe' = 'param';
  let note: string | undefined;
  if (rawFrom === undefined || rawFrom.trim().toLowerCase() === 'auto') {
    const detected = detectEncoding(targetAbs);
    from = detected.encoding;
    fromSource = detected.source;
    note = detected.note;
  } else {
    const normalized = normalizeEncoding(rawFrom);
    if (normalized === null) {
      throw new Error(
        `参数 from 只能是 ${SUPPORTED_ENCODINGS.join(' / ')} 或 auto，实为「${rawFrom}」`,
      );
    }
    from = normalized;
  }

  // ── 按源编码读出来 ─────────────────────────────────────────────
  const source = await readFeatures(deps.loc, { path: targetAbs, encoding: from });
  const sourceValues = source.features.map((f) => Object.values(f.properties));
  if (hasMojibake(sourceValues.flat())) {
    throw new VectorError(
      `按 ${from} 解出来的属性表里有乱码（出现了替换字符），说明这个文件不是 ${from} 编码。` +
        '请显式给 from 指定真实编码。',
    );
  }

  const summaryBase =
    `${from} → ${to}` +
    (fromSource === 'cpg' ? '（源编码取自 .cpg 标记）' : fromSource === 'probe' ? '（源编码是按字节探测出来的）' : '');

  if (dryRun) {
    return {
      kind: 'value',
      summary:
        `将转属性表编码：${summaryBase}（${source.features.length} 条要素）` +
        (note ? `（${note}）` : '') +
        '（预演：没有写盘）',
      data: {
        target: targetRel,
        from,
        to,
        featureCount: source.features.length,
        fields: source.fields,
        writeEncodingMarker: writeMarker,
        ...(note ? { note } : {}),
        dryRun: true,
      },
    };
  }

  // ── 写回（按目标编码） ─────────────────────────────────────────
  const write = await writeFeatures(deps.loc, deps.store, {
    target: targetRel,
    features: source.features,
    encoding: to,
  });

  // ── .cpg 标记 ──────────────────────────────────────────────────
  // 契约里 writeEncodingMarker=false 的意思是"别写 .cpg"。
  // GDAL 在给了 ENCODING 时一定会写 .cpg，所以这里只能写完再删 ——
  // 删之前先确认写回本身是成功的（writeFeatures 内部已经核过要素数与坐标系）。
  const cpgRel = targetRel.replace(/\.shp$/i, '.cpg');
  let markerRemoved = false;
  if (!writeMarker) {
    try {
      if (await deps.store.exists(cpgRel)) {
        await deps.store.remove(cpgRel);
        markerRemoved = true;
      }
    } catch (err) {
      throw new VectorError(
        `转码写回成功，但按要求删除 .cpg 标记失败（${cpgRel}）：${(err as Error).message}。` +
          `数据已经转成 ${to}，备份在 ${write.backupPath ?? '（没有）'}`,
      );
    }
  }

  // ── 回读核对：中文不能变成乱码 ────────────────────────────────
  const after = await readFeatures(deps.loc, { path: targetAbs, encoding: to });
  const afterValues = after.features.map((f) => Object.values(f.properties));
  if (hasMojibake(afterValues.flat())) {
    throw new VectorError(
      `转码后按 ${to} 回读，属性表里出现了乱码（替换字符）：这次转换没有成功。` +
        `备份在 ${write.backupPath ?? '（没有）'}`,
    );
  }
  for (let i = 0; i < after.features.length && i < source.features.length; i += 1) {
    const before = source.features[i]!.properties;
    const now = after.features[i]!.properties;
    for (const key of Object.keys(before)) {
      if (!valuesMatch(before[key], now[key] ?? null)) {
        throw new VectorError(
          `转码后属性值对不上（第 ${i + 1} 条要素的「${key}」：转码前 ${JSON.stringify(before[key])}，` +
            `转码后 ${JSON.stringify(now[key] ?? null)}）。备份在 ${write.backupPath ?? '（没有）'}`,
        );
      }
    }
  }

  const caveats: string[] = [];
  if (note) caveats.push(note);
  if (from === to) {
    caveats.push('源编码与目标编码相同，属性表按同样的编码重写了一遍');
  }
  if (markerRemoved) {
    caveats.push(
      '按要求没有留 .cpg 标记：下次打开这个图层时软件会按默认编码解读，中文可能显示为乱码',
    );
  }

  const summary =
    `已转属性表编码：${summaryBase}（${source.features.length} 条要素，回读核对通过）` +
    (caveats.length > 0 ? `（${caveats.join('；')}）` : '');

  return {
    kind: 'value',
    summary,
    data: {
      target: targetRel,
      from,
      to,
      featureCount: source.features.length,
      fields: after.fields,
      writeEncodingMarker: writeMarker,
      ...(markerRemoved ? { encodingMarkerRemoved: true } : {}),
      ...(caveats.length > 0 ? { caveats } : {}),
      backupPath: write.backupPath,
    },
  };
}
