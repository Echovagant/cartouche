/**
 * 标注避让：网格索引的正确性与密集场景耗时。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { placeLabelBoxes } = await import(
  pathToFileURL(join(root, 'web', 'app', 'canvas', 'label-layout.ts')).href
);

const box = (x, y, w = 40, h = 18) => ({ x1: x, y1: y, x2: x + w, y2: y + h });

test('标注避让：重叠的后者被拒绝，分开的都保留', () => {
  const accepted = placeLabelBoxes([box(0, 0), box(10, 5), box(200, 200)]);
  assert.deepEqual(accepted, [true, false, true]);
});

test('标注避让：边贴边不算重叠', () => {
  const accepted = placeLabelBoxes([box(0, 0, 40), box(40, 0, 40)]);
  assert.deepEqual(accepted, [true, true]);
});

test('标注避让：跨格子的框也能正确挡住', () => {
  // 两个框都横跨格子边界，且相互重叠
  const a = { x1: 60, y1: 60, x2: 140, y2: 80 };
  const b = { x1: 120, y1: 70, x2: 200, y2: 90 };
  assert.deepEqual(placeLabelBoxes([a, b]), [true, false]);
});

test('标注避让：5000 个同位框只留第一个，且不退化', () => {
  const boxes = Array.from({ length: 5000 }, () => box(100, 100));
  const t = performance.now();
  const accepted = placeLabelBoxes(boxes);
  const ms = performance.now() - t;
  assert.equal(accepted.filter(Boolean).length, 1);
  assert.ok(ms < 500, `5000 个框应在 500ms 内完成，实测 ${ms.toFixed(1)}ms`);
});

test('标注避让：1000 个分散框全部保留', () => {
  const boxes = [];
  for (let i = 0; i < 1000; i += 1) {
    boxes.push(box((i % 40) * 60, Math.floor(i / 40) * 40));
  }
  const accepted = placeLabelBoxes(boxes);
  assert.equal(accepted.filter(Boolean).length, 1000);
});
