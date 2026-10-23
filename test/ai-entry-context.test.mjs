/**
 * 画布 → AI 工作台的上下文契约测试。
 *
 * 盯住的是三件事：
 *   1. **带过去的上下文能原样取回来** —— 编码不能吃掉中文、空格、`&`；
 *   2. **缺参数不会崩** —— 直接打开 AI 页（没有画布上下文）时要退回空上下文；
 *   3. **没有项目根就说清为什么点不了** —— 按钮灰着必须带理由。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => pathToFileURL(join(root, 'web', 'app', 'ai', p)).href;

const {
  EMPTY_ENTRY_CONTEXT,
  aiEntryBasePath,
  buildAiEntryHref,
  buildAiEntryQuery,
  describeAiEntry,
  parseAiEntryQuery,
} = await import(web('entryContext.ts'));

/** 画布上的真实情形：中文项目名 + 中文路径 + 空格 */
const CONTEXT = {
  root: 'D:\\工作区\\演示 项目\\2026 改图',
  projectName: '演示项目',
  layerId: 'layer-1',
  layerName: '底图.tff',
  layerCount: 3,
  fromCanvas: true,
};

test('上下文编码后能原样取回来（中文、空格、& 都不掉）', () => {
  const query = buildAiEntryQuery(CONTEXT).toString();
  const back = parseAiEntryQuery(query);
  assert.equal(back.root, CONTEXT.root);
  assert.equal(back.projectName, CONTEXT.projectName);
  assert.equal(back.layerId, CONTEXT.layerId);
  assert.equal(back.layerName, CONTEXT.layerName);
  assert.equal(back.layerCount, CONTEXT.layerCount);
  assert.equal(back.fromCanvas, true);
});

test('带 & 与 = 的路径不会被查询串截断', () => {
  const ctx = { ...CONTEXT, root: 'D:\\a&b=c\\项目' };
  const back = parseAiEntryQuery(buildAiEntryQuery(ctx).toString());
  assert.equal(back.root, 'D:\\a&b=c\\项目');
});

test('直接打开 AI 页（没有上下文）退回空上下文，不报错', () => {
  const back = parseAiEntryQuery('');
  assert.deepEqual(back, EMPTY_ENTRY_CONTEXT);
  assert.equal(back.fromCanvas, false);
  assert.equal(back.root, null);
  assert.equal(parseAiEntryQuery('?').fromCanvas, false);
  assert.equal(parseAiEntryQuery('??').root, null);
});

test('查询串带不带前导问号都能读', () => {
  const query = buildAiEntryQuery(CONTEXT).toString();
  assert.equal(parseAiEntryQuery(`?${query}`).root, CONTEXT.root);
  assert.equal(parseAiEntryQuery(query).root, CONTEXT.root);
});

test('入口地址：静态产物用相对路径，开发模式用绝对路由', () => {
  assert.equal(aiEntryBasePath(false), 'ai.html');
  assert.equal(aiEntryBasePath(true), '/ai');

  const href = buildAiEntryHref(CONTEXT, aiEntryBasePath(false));
  assert.ok(href.startsWith('ai.html?'), href);
  assert.ok(href.includes('root='), href);

  // 没有上下文时不带查询串（地址栏干净）
  assert.equal(buildAiEntryHref(EMPTY_ENTRY_CONTEXT, 'ai.html'), 'ai.html');
});

test('没有项目根就说清为什么点不了', () => {
  const blocked = describeAiEntry(EMPTY_ENTRY_CONTEXT);
  assert.equal(blocked.enabled, false);
  assert.ok(blocked.reason.includes('项目'), blocked.reason);

  const ok = describeAiEntry(CONTEXT);
  assert.equal(ok.enabled, true);
  assert.equal(ok.reason, '');
  assert.ok(ok.summary.includes('演示项目'), ok.summary);
  assert.ok(ok.summary.includes('底图.tff'), ok.summary);
  assert.ok(ok.summary.includes('3 个图层'), ok.summary);
});
