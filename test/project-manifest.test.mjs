import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { parseManifest, serializeManifest, newManifest, ManifestError, PROJECT_MANIFEST_VERSION } =
  await import(pathToFileURL(join(root, 'src', 'engine', 'project', 'manifest.ts')).href);

const enc = new TextEncoder();
const dec = new TextDecoder();

test('清单：新建的项目有版本、名字与空图层', () => {
  const m = newManifest('2026改图', '2026-10-21T08:00:00.000Z');
  assert.equal(m.version, PROJECT_MANIFEST_VERSION);
  assert.equal(m.name, '2026改图');
  assert.equal(m.layers.length, 0);
  assert.equal(m.operations.length, 0);
  assert.equal(m.sheet.title, '图签 Cartouche 出图');
});

test('清单：序列化后再解析，内容不变', () => {
  const m = {
    ...newManifest('2026改图', '2026-10-21T08:00:00.000Z'),
    sheet: { title: '出图', operator: '张三', page: 'A4-portrait', dpi: 300 },
    layers: [{ id: 'l1', kind: 'raster', path: '扫描件.tff', visible: true, opacity: 0.8 }],
    view: { center: [120.31, 30.53], zoom: 14.2 },
    operations: [{ at: '2026-10-21T09:00:00.000Z', op: 'raster.paint', target: '扫描件.tff', ok: true }],
  };
  const back = parseManifest(serializeManifest(m));
  assert.deepEqual(back, m);
});

test('清单：坏 JSON 报中文原因，不是英文解析错误', () => {
  assert.throws(() => parseManifest(enc.encode('{ 这不是 JSON')), (e) => {
    assert.ok(e instanceof ManifestError);
    assert.match(e.message, /项目清单/);
    return true;
  });
});

test('清单：版本高于引擎 → 明确报"更高版本创建"，不猜', () => {
  const raw = { version: 99, name: 'x', createdAt: '', updatedAt: '', sheet: {}, layers: [], operations: [] };
  assert.throws(() => parseManifest(enc.encode(JSON.stringify(raw))), /更高版本/);
});

test('清单：图层的 path 指向项目外（绝对路径或 ..）→ 拒绝', () => {
  const base = { version: 1, name: 'x', createdAt: '', updatedAt: '', sheet: { title: 't', operator: 'o', page: 'A4-landscape', dpi: 150 }, operations: [] };
  assert.throws(
    () => parseManifest(enc.encode(JSON.stringify({ ...base, layers: [{ id: 'l', kind: 'raster', path: 'C:/x.tff', visible: true, opacity: 1 }] }))),
    /项目外|相对路径/,
  );
  assert.throws(
    () => parseManifest(enc.encode(JSON.stringify({ ...base, layers: [{ id: 'l', kind: 'raster', path: '../x.tff', visible: true, opacity: 1 }] }))),
    /项目外|相对路径/,
  );
});

test('清单：opacity 超出 0~1 → 拒绝', () => {
  const base = { version: 1, name: 'x', createdAt: '', updatedAt: '', sheet: { title: 't', operator: 'o', page: 'A4-landscape', dpi: 150 }, operations: [] };
  assert.throws(
    () => parseManifest(enc.encode(JSON.stringify({ ...base, layers: [{ id: 'l', kind: 'raster', path: 'a.tff', visible: true, opacity: 1.5 }] }))),
    /透明度/,
  );
});

test('清单：缺 name → 拒绝', () => {
  const raw = { version: 1, createdAt: '', updatedAt: '', sheet: {}, layers: [], operations: [] };
  assert.throws(() => parseManifest(enc.encode(JSON.stringify(raw))), /项目名/);
});

/* ── 以下为计划之外的补充校验：把「错误文案要说清是什么 + 怎么办」和
      「往返不丢字段 / 不出现占位符」这几条钉死，避免以后改坏 ── */

const baseManifest = {
  version: 1,
  name: 'x',
  createdAt: '2026-10-21T08:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z',
  sheet: { title: 't', operator: 'o', page: 'A4-landscape', dpi: 150 },
  layers: [],
  operations: [],
};

test('清单：缺 version → 拒绝，且说清怎么办', () => {
  const raw = { name: 'x', createdAt: '', updatedAt: '', sheet: {}, layers: [], operations: [] };
  assert.throws(
    () => parseManifest(enc.encode(JSON.stringify(raw))),
    (e) => {
      assert.match(e.message, /version/);
      assert.match(e.message, /请/);
      return true;
    },
  );
});

test('清单：dpi 越界（非整数 / 超范围 / 非数字）→ 拒绝', () => {
  for (const dpi of [0, 1201, 150.5, '300']) {
    assert.throws(
      () => parseManifest(enc.encode(JSON.stringify({ ...baseManifest, sheet: { ...baseManifest.sheet, dpi } }))),
      /dpi/,
      `dpi=${String(dpi)} 应该被拒绝`,
    );
  }
});

test('清单：图层的 path 是子目录里的相对路径 → 允许', () => {
  const raw = { ...baseManifest, layers: [{ id: 'l1', kind: 'vector', path: '子目录/图.tff', visible: false, opacity: 0 }] };
  const m = parseManifest(enc.encode(JSON.stringify(raw)));
  assert.equal(m.layers.length, 1);
  assert.equal(m.layers[0].path, '子目录/图.tff');
  assert.equal(m.layers[0].kind, 'vector');
  assert.equal(m.layers[0].visible, false);
  assert.equal(m.layers[0].opacity, 0);
});

test('清单：往返不丢字段（含 view / impact / operations）', () => {
  const m = {
    ...newManifest('往返', '2026-10-21T08:00:00.000Z'),
    updatedAt: '2026-10-21T09:00:00.000Z',
    sheet: { title: '出图', operator: '张三', page: 'A4-portrait', dpi: 300 },
    layers: [
      { id: 'l1', kind: 'raster', path: 'a.tff', visible: true, opacity: 0.8 },
      { id: 'l2', kind: 'vector', path: 'b/图.tff', visible: false, opacity: 0 },
    ],
    view: { center: [120.31, 30.53], zoom: 14.2 },
    operations: [
      { at: '2026-10-21T09:00:00.000Z', op: 'raster.paint', target: 'a.tff', ok: true },
      { at: '2026-10-21T09:10:00.000Z', op: 'vector.style', target: 'b/图.tff', ok: false, impact: { changed: 3 } },
    ],
  };
  const back = parseManifest(serializeManifest(m));
  assert.deepEqual(back, m);
  assert.equal(back.operations[1].impact.changed, 3);
});

test('清单：错误文案里不出现 undefined / [object Object] 这类占位符', () => {
  // 每一项都带上「该被哪一条校验拦下」的关键词：
  // 少了它，某个用例可能因为更早的校验（layers / sheet）先报错而假通过。
  const cases = [
    ['页幅', { ...baseManifest, sheet: { ...baseManifest.sheet, page: {} } }],
    ['dpi', { ...baseManifest, sheet: { ...baseManifest.sheet, dpi: {} } }],
    ['visible', { ...baseManifest, layers: [{ id: 'l', kind: 'raster', path: 'a.tff', visible: 'yes', opacity: 1 }] }],
    ['透明度', { ...baseManifest, layers: [{ id: 'l', kind: 'raster', path: 'a.tff', visible: true, opacity: {} }] }],
    ['kind', { ...baseManifest, layers: [{ id: 'l', kind: {}, path: 'a.tff', visible: true, opacity: 1 }] }],
    ['相对路径', { ...baseManifest, layers: [{ id: 'l', kind: 'raster', path: {}, visible: true, opacity: 1 }] }],
    ['ok', { ...baseManifest, operations: [{ at: '2026-10-21T09:00:00.000Z', op: 'x', target: 'y', ok: {} }] }],
    ['impact', { ...baseManifest, operations: [{ at: '2026-10-21T09:00:00.000Z', op: 'x', target: 'y', ok: true, impact: [] }] }],
    ['view', { ...baseManifest, view: {} }],
    ['view.center', { ...baseManifest, view: { center: {}, zoom: 1 } }],
    ['view.zoom', { ...baseManifest, view: { center: [1, 2], zoom: {} } }],
  ];
  for (const [expect, raw] of cases) {
    let message = '';
    try {
      parseManifest(enc.encode(JSON.stringify(raw)));
      assert.fail('这个输入本该被拒绝：' + JSON.stringify(raw));
    } catch (e) {
      assert.ok(e instanceof ManifestError, '错误应是 ManifestError，实际：' + String(e));
      message = e.message;
    }
    assert.ok(message.includes(expect), `文案没有点到「${expect}」：${message}`);
    assert.ok(!message.includes('undefined'), '文案里出现 undefined：' + message);
    assert.ok(!message.includes('[object Object]'), '文案里出现 [object Object]：' + message);
    assert.ok(!message.includes('null'), '文案里出现 null：' + message);
  }
});

test('清单：序列化是带缩进的纯 JSON，能被人直接看懂', () => {
  const text = dec.decode(serializeManifest(newManifest('2026改图', '2026-10-21T08:00:00.000Z')));
  assert.match(text, /^\{\n {2}"version": 1,/);
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(JSON.parse(text).name, '2026改图');
});
