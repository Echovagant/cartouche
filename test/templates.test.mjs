import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { TemplateRegistry, builtinTemplates } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'templates', 'registry.ts')).href
);

const schema = JSON.parse(readFileSync(join(root, 'src', 'engine', 'ops.schema.json'), 'utf8'));
const declaredOps = new Set(schema.$defs.operation.properties.op.enum);

test('内置模板覆盖 10 个以上高频操作', () => {
  assert.ok(builtinTemplates.length >= 10, `实际 ${builtinTemplates.length} 个`);
  const ids = builtinTemplates.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, '模板 id 不能重复');
});

test('每个模板的 op 都在操作计划 Schema 中声明过', () => {
  for (const t of builtinTemplates) {
    assert.ok(declaredOps.has(t.op), `模板 ${t.id} 的 op "${t.op}" 未在 Schema 中声明`);
  }
});

test('每个模板都有标题、说明与参数定义', () => {
  for (const t of builtinTemplates) {
    assert.ok(t.title && t.title.length > 0, `${t.id} 缺 title`);
    assert.ok(t.description && t.description.length > 0, `${t.id} 缺 description`);
    assert.ok(Array.isArray(t.params), `${t.id} 缺 params`);
  }
});

test('build 产出符合 Schema 必填字段的操作计划', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  const plan = registry.build('batch-set-attr', {
    target: 'dataset://parcel.shp',
    where: "状态 = '待核查'",
    set: { 状态: '已核查' },
  });
  assert.equal(plan.op, 'feature.setAttributes');
  assert.equal(plan.params.target, 'dataset://parcel.shp');
  assert.deepEqual(plan.params.set, { 状态: '已核查' });
});

test('build 缺少必填参数时抛错并指出缺哪个', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  assert.throws(
    () => registry.build('batch-set-attr', { target: 'dataset://a.shp' }),
    /where|set/,
  );
});

test('build 传入未知参数时抛错（防止模型幻觉字段）', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  assert.throws(
    () =>
      registry.build('batch-set-attr', {
        target: 'dataset://a.shp',
        where: 'x = 1',
        set: { a: 1 },
        瞎写的字段: 'x',
      }),
    /瞎写的字段/,
  );
});

test('build 参数类型不符时抛错', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  assert.throws(
    () =>
      registry.build('export-image', {
        target: 'dataset://a.tff',
        format: 'png',
        dpi: '三百',
      }),
    /dpi/,
  );
});

test('必填参数的合法假值（false / 0）不算缺失', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  const plan = registry.build('erase-markup', {
    target: 'dataset://a.tff',
    region: 'layer://markup',
    keepAnnotations: false,
  });
  assert.equal(plan.params.keepAnnotations, false);

  // 0 同样是合法值：容差为 0 表示"不吸附"
  const plan2 = registry.build('repair-geometry', {
    target: 'dataset://land.shp',
    rules: ['self-intersection'],
    snapTolerance: 0,
  });
  assert.equal(plan2.params.snapTolerance, 0);
});

test('必填参数真的缺失时仍然报错（不能被假值逻辑放过去）', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  assert.throws(
    () => registry.build('repair-geometry', { target: 'dataset://land.shp', rules: ['self-intersection'] }),
    /snapTolerance/,
  );
});

test('每个模板的示例都能构建出操作计划', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  for (const t of builtinTemplates) {
    assert.ok(t.example, `${t.id} 缺 example`);
    const plan = registry.build(t.id, t.example);
    assert.equal(plan.op, t.op, `${t.id} 构建出的 op 不匹配`);
    assert.ok(plan.params && typeof plan.params === 'object', `${t.id} 未产出 params`);
  }
});

test('build 未登记的模板 id 抛错', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  assert.throws(() => registry.build('no-such-template', {}), /no-such-template/);
});

test('列表接口能按关键词检索模板（AI 侧选模板用）', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  const hits = registry.search('裁切');
  assert.ok(hits.length >= 1, '应能搜到裁切相关模板');
  const ids = hits.map((t) => t.id);
  assert.ok(ids.includes('clip-by-layer'), ids.join(','));
});

test('检索不到时返回空数组而不是抛错', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  assert.deepEqual(registry.search('完全不相干的词zzz'), []);
});

test('list 返回给 AI 用的精简描述（含 op 与必填项）', () => {
  const registry = new TemplateRegistry(builtinTemplates);
  const list = registry.list();
  assert.equal(list.length, builtinTemplates.length);
  const first = list.find((t) => t.id === 'batch-set-attr');
  assert.ok(first);
  assert.equal(first.op, 'feature.setAttributes');
  assert.ok(first.required.length > 0, '应列出必填参数名');
});
