/**
 * 失败文案与人话映射的测试。
 *
 * 盯住的是三件事：
 *   1. **每条失败都说得清下一步做什么** —— 光说"失败了"等于让用户自己猜；
 *   2. **密钥不许出现在任何一条面向用户的信息里** —— 密钥红线；
 *   3. **分类不串**：连不上模型 ≠ 密钥不对，两者给的下一步完全不同。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => pathToFileURL(join(root, 'web', 'app', 'ai', p)).href;

const {
  classifyPlanFailure,
  describePlanFailure,
  describePreviewFailure,
  describeExecuteFailure,
  describeZeroImpact,
  findZeroImpactOps,
  redactKeyLike,
} = await import(web('failures.ts'));

/** 假密钥：只在这个文件里用一次，不落盘、不进仓库 */
const FAKE_KEY = 'sk-test-0123456789abcdefghijklmnop'; // secret-scan:allow

/** 中文文案断言：既要有内容，也不能是英文异常或状态码 */
function assertHuman(text, label) {
  assert.ok(text && text.trim().length > 0, `${label} 不能为空`);
  assert.ok(/[一-龥]/.test(text), `${label} 必须是中文：${text}`);
  assert.ok(!/^HTTP\s\d+$/.test(text.trim()), `${label} 不能只甩状态码：${text}`);
}

/* ── 分类 ────────────────────────────────────────────────────── */

test('六类失败各自归到自己的类，不串', () => {
  assert.equal(classifyPlanFailure({ error: 'llm_not_configured', message: 'x', code: null }).kind, 'not_configured');
  assert.equal(classifyPlanFailure({ error: 'llm_unauthorized', message: 'x', code: 1004 }).kind, 'key');
  assert.equal(classifyPlanFailure({ error: 'llm_unreachable', message: 'x', code: null }).kind, 'network');
  assert.equal(classifyPlanFailure({ error: 'plan_schema_invalid', message: 'x', code: null }).kind, 'bad_plan');
  assert.equal(classifyPlanFailure({ error: 'plan_not_json', message: 'x', code: null }).kind, 'bad_plan');
  assert.equal(classifyPlanFailure({ error: 'op_not_supported', message: 'x', code: null }).kind, 'unsupported');
});

test('官方把密钥无效报成 1004 时，即使类别没对上也要认成密钥问题', () => {
  const failure = classifyPlanFailure({
    error: 'llm_http',
    message: 'authorized_error: invalid api key',
    code: 1004,
  });
  assert.equal(failure.kind, 'key');
});

/* ── 文案 ────────────────────────────────────────────────────── */

test('提议层每一类失败都给出结论、原因和下一步', () => {
  const kinds = ['not_configured', 'key', 'network', 'bad_plan', 'unsupported', 'unknown'];
  for (const kind of kinds) {
    const failure = { kind, message: '引擎给的原始原因', code: null };
    const human = describePlanFailure(failure);
    assertHuman(human.title, `${kind} 的标题`);
    assertHuman(human.detail, `${kind} 的原因`);
    assertHuman(human.next, `${kind} 的下一步`);
    // 下一步必须真的可执行：不能只是"再试一次"这种空话
    assert.ok(human.next.length >= 10, `${kind} 的下一步太短：${human.next}`);
  }
});

test('「还没配密钥」说清去哪儿配，「连不上」说清查网络 —— 两者的下一步不同', () => {
  const notConfigured = describePlanFailure({
    kind: 'not_configured',
    message: '还没有配置 API Key',
    code: null,
  });
  const network = describePlanFailure({
    kind: 'network',
    message: '连不上模型服务 https://api.minimax.cn/v1：fetch failed',
    code: null,
  });
  assert.ok(/密钥|Key/.test(notConfigured.next), notConfigured.next);
  assert.ok(/网络|代理|接入点|出网/.test(network.next), network.next);
  assert.notEqual(notConfigured.next, network.next);
});

test('预演失败说清是哪一条、为什么、怎么办', () => {
  const human = describePreviewFailure({
    op: 'raster.paint',
    index: 1,
    message: '找不到指定的数据文件',
  });
  assert.ok(human.title.includes('第 2 条'), human.title);
  assertHuman(human.detail, '预演失败的原因');
  assert.ok(/不执行|重新提议/.test(human.next), human.next);
});

test('执行失败按"文件被占用"这一类给出人话，并说明原文件没被改', () => {
  const human = describeExecuteFailure({
    op: 'raster.paint',
    message: '文件被占用，无法写入：底图.tff',
  });
  assert.ok(/占用/.test(human.title), human.title);
  // 标题不带 op 名：界面在旁边已经显示了 op，重复一遍会变成"raster.paint 「raster.paint」…"
  assert.ok(!/raster\.paint/.test(human.title), human.title);
  assert.ok(/ArcGIS|关掉|程序/.test(human.next), human.next);
  assert.ok(/原文件没有/.test(human.next), human.next);
});

test('执行失败还能认出 GDAL 的英文占用报错与找不到文件', () => {
  const locked = describeExecuteFailure({
    message: 'ERROR 4: Permission denied writing file',
  });
  assert.ok(/占用/.test(locked.title), locked.title);

  const missing = describeExecuteFailure({
    message: 'ERROR 4: No such file or directory',
  });
  assert.ok(/找不到/.test(missing.title), missing.title);

  const generic = describeExecuteFailure({
    message: '处理失败',
  });
  assert.ok(/写回|没能/.test(generic.title), generic.title);
  assertHuman(generic.next, '通用写回失败的下一步');
});

test('预演说改了 0 像元时，说清是哪里出了问题与怎么改', () => {
  const human = describeZeroImpact({
    op: 'raster.paint',
    index: 0,
    totalPixels: 1200,
  });
  assert.ok(/一个像元都没改到/.test(human.title), human.title);
  assert.ok(/1,200/.test(human.detail), human.detail);
  assert.ok(/框选|对齐/.test(human.next), human.next);
});

test('引擎把「一个像元都没改到」报成预演失败时，要说成 0 像元而不是「算不出来」', () => {
  // 引擎的原话（实测自 raster.paint 预演）：区域本来就已经是这个颜色
  const engineMessage =
    '这次改动一个像元都没改到（影像 40×30，区域 minX=2..maxX=12，minY=2..maxY=10）：没有任何像素发生变化，已中止，未做任何改动';
  const human = describePreviewFailure({ op: 'raster.paint', index: 0, message: engineMessage });
  assert.ok(/一个像元都没改到/.test(human.title), human.title);
  assert.ok(!/算不出影响面/.test(human.title), human.title);
  // 影像尺寸 40×30 = 1200 像元，要被读出来
  assert.ok(/1,200/.test(human.detail), human.detail);
  assert.ok(/框选|对齐/.test(human.next), human.next);
});

test('找出"一个像元都没改到"的那几条', () => {
  const previews = [
    { op: 'raster.paint', affectedPixels: 120, totalPixels: 1200 },
    { op: 'raster.erase', affectedPixels: 0, totalPixels: 1200 },
    { op: 'raster.inpaint', affectedPixels: 0, totalPixels: 800 },
  ];
  assert.deepEqual(findZeroImpactOps(previews), [1, 2]);
  assert.deepEqual(findZeroImpactOps([]), []);
  assert.deepEqual(findZeroImpactOps([{ op: 'x', affectedPixels: 1, totalPixels: 1 }]), []);
});

/* ── 密钥红线 ────────────────────────────────────────────────── */

test('文案里的密钥被抹掉：前端自己也不回显', () => {
  const masked = redactKeyLike(`请求失败：Authorization: Bearer ${FAKE_KEY}`);
  assert.ok(!masked.includes(FAKE_KEY), masked);
  assert.ok(masked.includes('***REDACTED***'), masked);

  assert.ok(!redactKeyLike(`key=${FAKE_KEY}`).includes(FAKE_KEY));
  assert.ok(!redactKeyLike(`eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc`).includes('eyJ'));
});

test('带密钥的引擎原始原因，经过文案化之后密钥不露面', () => {
  const human = describeExecuteFailure({
    op: 'raster.paint',
    message: `请求头 Authorization: Bearer ${FAKE_KEY} 被拒绝`,
  });
  const all = `${human.title}\n${human.detail}\n${human.next}`;
  assert.ok(!all.includes(FAKE_KEY), all);
});

test('正常的英文说明不会被误抹（别把界面打成马赛克）', () => {
  const text = '文件被占用，无法写入：底图.tff';
  assert.equal(redactKeyLike(text), text);
  assert.equal(redactKeyLike(''), '');
});
