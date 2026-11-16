/**
 * 图例面板的契约（2026-11-16 用户裁定）。
 *
 * 裁定内容：**图例不要画在"直接编辑图像的画布区域"上**。
 * 既然要显示在那一带，就让它是**另一个层级**（独立 DOM，不是画布像素），
 * 并且用户能**自主调整位置与透明度**。
 *
 * 这三条都是"看起来对、实际会退化"的点，所以钉在源码上：
 *   ① preview 态不能画图例（画进画布 = 回到老毛病）；
 *   ② 面板要是独立 DOM 且层级高于画布；
 *   ③ 位置与透明度可调，且要记住（存本机）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const sheet = read('web', 'app', 'canvas', 'sheet.ts');
const mapCanvas = read('web', 'app', 'canvas', 'MapCanvas.tsx');
const panel = read('web', 'app', 'canvas', 'LegendPanel.tsx');

describe('图例：不在画布上，且位置与透明度可调', () => {
  test('preview 态不画图例（导出照旧）', () => {
    assert.match(
      sheet,
      /if \(geometry\.legendVisible && !options\.preview\)/,
      '屏幕预览不能画图例',
    );
    assert.doesNotMatch(
      sheet,
      /ctx\.scale\(0\.72, 0\.72\)/,
      '不要再有"预览时缩小图例"那条分支',
    );
    assert.match(
      mapCanvas,
      /legend: \[\],[\s\S]{0,120}?preview: true/,
      '预览态传给 drawSheet 的图例必须是空',
    );
  });

  test('导出仍然带图例（出图版式不能少东西）', () => {
    // exportJpeg 走的是非 preview 的 drawSheet
    assert.match(
      mapCanvas,
      /scaleDenominator: pdfScaleDenominator[\s\S]{0,200}?legend: legend\(\)/,
      '导出路径要照旧传图例',
    );
  });

  test('面板是独立 DOM，层级高于画布', () => {
    assert.match(mapCanvas, /<LegendPanel items=\{legend\(\)\} containerRef=\{stageRootRef\} \/>/, '要挂面板');
    assert.match(panel, /className="absolute z-20/, '面板要绝对定位且层级高于画布');
    // 画布本身是 absolute inset-0（同一容器里），面板靠 z-20 压过它
    assert.match(
      mapCanvas,
      /<canvas[\s\S]{0,160}?className="pointer-events-none absolute inset-0"/,
      '画布是 absolute inset-0',
    );
    assert.match(
      panel,
      /className="absolute z-20/,
      '面板同为 absolute，但 z-20 高于画布（画布无 z-index）',
    );
  });

  test('位置可拖动并记住（存本机）', () => {
    assert.match(panel, /onPointerDown/, '要能拖');
    assert.match(panel, /onPointerMove/, '拖动时要更新位置');
    assert.match(panel, /cartouche\.legend\.panel\.v1/, '位置与透明度要存起来');
    assert.match(panel, /localStorage\.setItem/, '要真的写 localStorage');
  });

  test('透明度可调并记住', () => {
    assert.match(panel, /type="range"/, '要有透明度滑杆');
    assert.match(panel, /opacity: state\.opacity/, '透明度要作用在面板上');
    assert.match(panel, /aria-label="图例透明度"/, '滑杆要有无障碍标签');
  });

  test('图例条目是图层名（不带扩展名）', () => {
    assert.match(
      mapCanvas,
      /name: layer\.name\.replace\(\/\\\.\[\^\.\/\\\\\]\+\$\/, ''\)/,
      '图例显示图层名，不显示 .tif/.geojson 这类文件名后缀',
    );
  });
});
