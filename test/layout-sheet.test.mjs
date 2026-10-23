/**
 * 出图排版（SP-5a）的测试。
 *
 * 三条主线：
 *   1. **换算**：格网间隔按"图上厘米"输入 → 地面米数 → 规整到好看的档位；
 *      经纬网的纬向步长按当前纬度算，保证图上近似正方。
 *   2. **向后兼容**：默认版式画出来的东西必须与改动前一模一样。
 *      这里把改动前的调用序列钉成金标准（记录于 2026-10-23，改动前的那一版），
 *      差一条调用就算失败 —— "看着差不多"不算数。
 *   3. **模板往返**：存 → 列 → 读，内容相等；目录不存在、文件坏了都要有明确说法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = (p) => pathToFileURL(join(root, 'web', 'app', 'canvas', p)).href;

const sheet = await import(web('sheet.ts'));
const types = await import(web('layout/types.ts'));
const presets = await import(web('layout/presets.ts'));
const store = await import(web('layout/template-store.ts'));

/* ── 画布桩 ──────────────────────────────────────────────── */

/** 记录调用序列的 2D 上下文桩 */
function recorder() {
  const calls = [];
  const state = {};
  const round = (n) => (Number.isFinite(n) ? Number(n.toFixed(4)) : String(n));
  const push = (op, args) => {
    calls.push(
      `${op}(${args.map((a) => (typeof a === 'number' ? round(a) : JSON.stringify(a))).join(',')})`,
    );
  };
  const ctx = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v) {
      state.fillStyle = v;
      calls.push(`fillStyle=${JSON.stringify(v)}`);
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v) {
      state.strokeStyle = v;
      calls.push(`strokeStyle=${JSON.stringify(v)}`);
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(v) {
      state.lineWidth = v;
      calls.push(`lineWidth=${round(v)}`);
    },
    get font() {
      return state.font;
    },
    set font(v) {
      state.font = v;
      calls.push(`font=${JSON.stringify(v)}`);
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(v) {
      state.textAlign = v;
      calls.push(`textAlign=${JSON.stringify(v)}`);
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(v) {
      state.textBaseline = v;
      calls.push(`textBaseline=${JSON.stringify(v)}`);
    },
    save() {
      calls.push('save()');
    },
    restore() {
      calls.push('restore()');
    },
    beginPath() {
      calls.push('beginPath()');
    },
    closePath() {
      calls.push('closePath()');
    },
    moveTo(x, y) {
      push('moveTo', [x, y]);
    },
    lineTo(x, y) {
      push('lineTo', [x, y]);
    },
    fill() {
      calls.push('fill()');
    },
    stroke() {
      calls.push('stroke()');
    },
    fillRect(x, y, w, h) {
      push('fillRect', [x, y, w, h]);
    },
    strokeRect(x, y, w, h) {
      push('strokeRect', [x, y, w, h]);
    },
    fillText(t, x, y, max) {
      push('fillText', [t, x, y, max]);
    },
    measureText(t) {
      return { width: String(t).length * 5 };
    },
    setTransform() {},
  };
  return { ctx, calls };
}

/** 一组固定的出图参数（与改动前的回归用例一致） */
const BASE_OPTIONS = {
  width: 1200,
  height: 800,
  dpi: 96,
  title: '图签 Cartouche 出图',
  operator: '张三',
  producedAt: '2026-10-23 21:30:00',
  metersPerPixel: 0.5,
  legend: [
    { name: '建筑物', color: '#2f6f5e' },
    { name: '道路', color: '#b08d57' },
  ],
};

/* ── 1. 换算 ─────────────────────────────────────────────── */

test('格网间隔：图上 10 cm @ 1:1800 → 地面 180 m（教程 034 集的口径）', () => {
  assert.equal(sheet.groundMetersForInterval(10, 1800), 180);
  // 图上 1 cm @ 1:500 → 5 m
  assert.equal(sheet.groundMetersForInterval(1, 500), 5);
  // 不给比例尺分母或间隔不合法时返回 0，而不是 NaN
  assert.equal(sheet.groundMetersForInterval(10, 0), 0);
  assert.equal(sheet.groundMetersForInterval(0, 1800), 0);
});

test('格网间隔规整到 10/20/50/100/200/500 m 或 1/2/5 km', () => {
  assert.equal(sheet.niceGridStep(180), 200);
  assert.equal(sheet.niceGridStep(9), 10);
  assert.equal(sheet.niceGridStep(1200), 1000);
  assert.equal(sheet.niceGridStep(4000), 5000);
  assert.equal(sheet.niceGridStep(300), 200);
  // 规整后的值必须落在约定的档位上
  const ladder = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  for (const raw of [3, 17, 63, 180, 340, 700, 1500, 4300]) {
    assert.ok(ladder.includes(sheet.niceGridStep(raw)), `${raw} → ${sheet.niceGridStep(raw)}`);
  }
});

test('经纬网：纬向步长按当前纬度算，图上近似正方', () => {
  const atEquator = sheet.latitudeStepFor(0.01, 0);
  const at60 = sheet.latitudeStepFor(0.01, 60);
  // 赤道附近：纬向步长 ≈ 经向步长（×经纬度的长度差）
  assert.ok(Math.abs(atEquator - 0.01 * 1.0068) < 1e-9);
  // 60 度：纬向步长约按 cos(60°) 收缩
  assert.ok(Math.abs(at60 - 0.01 * 0.5 * 1.0068) < 1e-9);
  assert.ok(at60 < atEquator);
});

test('经纬网：0.001° 步长在 1:500 下，图上的间距是能读的范围（10~60 cm）', () => {
  const meters = 0.001 * 111320 * Math.cos((30 * Math.PI) / 180);
  const onPaperCm = (meters / 500) * 100;
  assert.ok(onPaperCm > 10 && onPaperCm < 60, `实际 ${onPaperCm.toFixed(1)} cm`);
});

/* ── 2. 向后兼容：默认版式 = 改动前的视觉 ────────────────── */

test('默认版式画出来的调用序列与改动前逐条一致（金标准）', () => {
  const { ctx, calls } = recorder();
  sheet.drawSheet(ctx, BASE_OPTIONS);
  assert.deepEqual(calls, GOLDEN_96DPI);
});

test('不传版式（走旧参数）与显式传默认版式，画出来的东西完全相同', () => {
  const a = recorder();
  sheet.drawSheet(a.ctx, BASE_OPTIONS);
  const b = recorder();
  sheet.drawSheet(b.ctx, { ...BASE_OPTIONS, layout: types.DEFAULT_LAYOUT });
  assert.deepEqual(a.calls, b.calls);
});

test('默认版式的图廓、比例尺、标题栏参数就是旧版那几个常量', () => {
  assert.deepEqual(types.DEFAULT_LAYOUT.frame, {
    outerGap: 6,
    innerGap: 4,
    outerWidth: 1.6,
    innerWidth: 0.6,
  });
  // 旧版的比例尺：黑白分段 + 单位自动换算 + 在左下
  assert.equal(types.DEFAULT_LAYOUT.scaleBar.style, 'alternating');
  assert.equal(types.DEFAULT_LAYOUT.scaleBar.unit, 'auto');
  assert.equal(types.DEFAULT_LAYOUT.scaleBar.position, 'left');
  // 旧版没有格网
  assert.equal(types.DEFAULT_LAYOUT.graticule.enabled, false);
});

/* ── 3. 参数确实生效 ─────────────────────────────────────── */

test('改图廓偏移与线宽，图框跟着变', () => {
  const base = recorder();
  sheet.drawSheet(base.ctx, BASE_OPTIONS);
  const changed = recorder();
  sheet.drawSheet(changed.ctx, {
    ...BASE_OPTIONS,
    layout: {
      ...types.DEFAULT_LAYOUT,
      frame: { outerGap: 12, innerGap: 6, outerWidth: 2.4, innerWidth: 1 },
    },
  });
  assert.notDeepEqual(base.calls, changed.calls);
  // 外线：旧版 6px@96dpi，新版 12px@96dpi
  assert.ok(base.calls.includes('strokeRect(6,6,1188,788)'));
  assert.ok(changed.calls.includes('strokeRect(12,12,1176,776)'));
});

test('改图例位置，图例挪到另一栏', () => {
  const left = recorder();
  sheet.drawSheet(left.ctx, BASE_OPTIONS);
  const right = recorder();
  sheet.drawSheet(right.ctx, {
    ...BASE_OPTIONS,
    layout: {
      ...types.DEFAULT_LAYOUT,
      legend: { ...types.DEFAULT_LAYOUT.legend, position: 'right' },
    },
  });
  // 旧版图例在左栏（x=18）；挪到右栏后 x 变成标题栏那一侧
  assert.ok(left.calls.includes('fillRect(18,694.5,240,53)'));
  assert.ok(!right.calls.includes('fillRect(18,694.5,240,53)'));
});

test('改比例尺样式与单位，标注跟着变', () => {
  // 默认（自动换算）：50 m 的刻度条标 "50 m"
  const auto = recorder();
  sheet.drawSheet(auto.ctx, BASE_OPTIONS);
  assert.ok(auto.calls.some((c) => c.startsWith('fillText("50 m"')));

  // 单位改成千米：同一根刻度条标 "0.1 km"
  const km = recorder();
  sheet.drawSheet(km.ctx, {
    ...BASE_OPTIONS,
    layout: {
      ...types.DEFAULT_LAYOUT,
      scaleBar: { unit: 'km', style: 'line', position: 'left' },
    },
  });
  assert.ok(km.calls.some((c) => c.startsWith('fillText("0.1 km"')), km.calls.join('|'));
  assert.ok(!km.calls.some((c) => c.startsWith('fillText("50 m"')));

  // 样式改成细线：不再有分段色块
  const line = recorder();
  sheet.drawSheet(line.ctx, {
    ...BASE_OPTIONS,
    layout: {
      ...types.DEFAULT_LAYOUT,
      scaleBar: { unit: 'auto', style: 'line', position: 'left' },
    },
  });
  const alternating = recorder();
  sheet.drawSheet(alternating.ctx, BASE_OPTIONS);
  assert.ok(
    alternating.calls.filter((c) => c.startsWith('fillRect(')).length >
      line.calls.filter((c) => c.startsWith('fillRect(')).length,
    '分段样式比细线样式多画几个色块',
  );
});

test('标题栏字段可配：多出的字段各占一格，图名仍占标题区', () => {
  const calls = recorder();
  sheet.drawSheet(calls.ctx, {
    ...BASE_OPTIONS,
    layout: {
      ...types.DEFAULT_LAYOUT,
      titleBlock: {
        position: 'bottom-right',
        fields: { title: '', unit: '测绘单位', crs: 'CGCS2000', producedAt: '', operator: '', reviewer: '王审核' },
      },
    },
  });
  const text = calls.calls.join('\n');
  assert.ok(text.includes('fillText("测绘单位"'));
  assert.ok(text.includes('fillText("CGCS2000"'));
  assert.ok(text.includes('fillText("王审核"'));
  // 字段多了要加行分隔线
  assert.ok(calls.calls.filter((c) => c.startsWith('moveTo(')).length >= 4);
});

test('图例：条目可显隐、可换色、背景与边框可配', () => {
  const layout = {
    ...types.DEFAULT_LAYOUT,
    legend: {
      items: [
        { name: '甲', color: '#112233', visible: true, outline: '#445566' },
        { name: '乙', color: '#778899', visible: false },
      ],
      position: 'left',
      background: 'rgba(255,255,255,0.5)',
      border: '#334455',
    },
  };
  const calls = recorder();
  sheet.drawSheet(calls.ctx, { ...BASE_OPTIONS, layout });
  const text = calls.calls.join('\n');
  assert.ok(text.includes('fillStyle="rgba(255,255,255,0.5)"'), '背景色按版式来');
  assert.ok(text.includes('strokeStyle="#334455"'), '边框色按版式来');
  assert.ok(text.includes('strokeStyle="#445566"'), '色块描边用条目自己的描边色');
  assert.ok(text.includes('fillText("甲"'));
  assert.ok(!text.includes('fillText("乙"'), 'visible=false 的条目不画');
});

test('图例横排（位置 = 底）：条目并排成一行', () => {
  const layout = {
    ...types.DEFAULT_LAYOUT,
    legend: {
      items: [
        { name: '甲', color: '#112233' },
        { name: '乙', color: '#778899' },
      ],
      position: 'bottom',
    },
  };
  const geometry = sheet.computeSheetGeometry(
    { ...BASE_OPTIONS, layout },
    layout,
    { metersPerPixel: BASE_OPTIONS.metersPerPixel, extent: { minX: 0, minY: 0, maxX: 1, maxY: 1 } },
    1,
  );
  assert.equal(geometry.legendHorizontal, true);
  // 横排只有一行的高度（竖排是"标题 + 每条一行"）
  const vertical = sheet.computeSheetGeometry(
    { ...BASE_OPTIONS, layout: { ...layout, legend: { ...layout.legend, position: 'left' } } },
    { ...layout, legend: { ...layout.legend, position: 'left' } },
    { metersPerPixel: BASE_OPTIONS.metersPerPixel, extent: { minX: 0, minY: 0, maxX: 1, maxY: 1 } },
    1,
  );
  assert.ok(geometry.legend.h < vertical.legend.h, '横排比竖排矮');
});

test('标题栏位置可配：挪到左下', () => {
  const calls = recorder();
  sheet.drawSheet(calls.ctx, {
    ...BASE_OPTIONS,
    layout: {
      ...types.DEFAULT_LAYOUT,
      titleBlock: { position: 'bottom-left', fields: types.DEFAULT_LAYOUT.titleBlock.fields },
    },
  });
  // 旧版标题栏在右下（x=862）
  assert.ok(!calls.calls.includes('fillRect(862,712,320,70)'));
  assert.ok(calls.calls.some((c) => c.startsWith('fillRect(18,712,320,70)')));
});

/* ── 4. 格网 ─────────────────────────────────────────────── */

test('当前生效的版式生效：画布侧只认 drawSheet 这一个入口', () => {
  sheet.setActiveSheetState({
    layout: {
      ...types.DEFAULT_LAYOUT,
      frame: { outerGap: 20, innerGap: 4, outerWidth: 1.6, innerWidth: 0.6 },
    },
  });
  try {
    const { ctx, calls } = recorder();
    sheet.drawSheet(ctx, BASE_OPTIONS);
    assert.ok(calls.includes('strokeRect(20,20,1160,760)'), '图廓应当按当前版式画');
  } finally {
    sheet.setActiveSheetState(null);
  }
});

test('格网用当下的视野：视野给的是提供器，平移后要跟着变', () => {
  const layout = {
    ...types.DEFAULT_LAYOUT,
    graticule: { enabled: true, kind: 'geographic', interval: 0.01, showLabels: true },
  };
  // 提供器返回的范围一变，格线的位置就得跟着变
  let bbox = [120.3, 30.52, 120.32, 30.54];
  sheet.setActiveSheetState({
    layout,
    viewport: () => ({ bbox, width: 1200, height: 800 }),
  });
  try {
    const first = recorder();
    sheet.drawSheet(first.ctx, BASE_OPTIONS);
    bbox = [120.5, 30.52, 120.52, 30.54];
    const second = recorder();
    sheet.drawSheet(second.ctx, BASE_OPTIONS);
    assert.notDeepEqual(first.calls, second.calls, '视野变了，格线也该跟着变');
    assert.ok(first.calls.some((c) => c.startsWith('moveTo(')), '应当画出格线');
  } finally {
    sheet.setActiveSheetState(null);
  }
});

test('格网：经纬网画出经线与纬线，并标 E / N', () => {
  const layout = {
    ...types.DEFAULT_LAYOUT,
    graticule: { enabled: true, kind: 'geographic', interval: 0.01, showLabels: true },
  };
  const geometry = sheet.computeGraticule(
    layout,
    {
      metersPerPixel: 0.5,
      scaleDenominator: 500,
      extent: { minX: 120.3, minY: 30.52, maxX: 120.32, maxY: 30.54 },
    },
    { width: 1200, height: 800 },
    { x: 10, y: 10, w: 1180, h: 780 },
  );
  assert.ok(geometry.lines.length > 0, '该有格网线');
  assert.ok(geometry.labels.length > 0, '该有标注');
  assert.ok(geometry.labels.every((l) => /^[EN] /.test(l.text)), '标注以 E / N 开头');
  // 经线是竖的、纬线是横的
  assert.ok(geometry.lines.some((l) => l.x1 === l.x2));
  assert.ok(geometry.lines.some((l) => l.y1 === l.y2));
});

test('格网：公里网按图上厘米换算成地面米数来排线', () => {
  const layout = {
    ...types.DEFAULT_LAYOUT,
    graticule: { enabled: true, kind: 'kilometer', interval: 10, showLabels: true },
  };
  // 1:1800、0.5 m/px → 10 cm 图上 = 180 m 地面 ≈ 规整到 200 m → 400 px 一步
  const geometry = sheet.computeGraticule(
    layout,
    {
      metersPerPixel: 0.5,
      scaleDenominator: 1800,
      extent: { minX: 120.3, minY: 30.52, maxX: 120.32, maxY: 30.54 },
    },
    { width: 1200, height: 800 },
    { x: 10, y: 10, w: 1180, h: 780 },
  );
  const verticals = geometry.lines.filter((l) => l.x1 === l.x2);
  assert.ok(verticals.length >= 2, '至少两条经线');
  // 相邻经线的间距 = 200 m ÷ 0.5 m/px = 400 px
  const gap = verticals[1].x1 - verticals[0].x1;
  assert.ok(Math.abs(gap - 400) < 1e-6, `实际间距 ${gap} px`);
  // 标注写的是距图幅左下角的距离（步长不到 1 km 就写米，不写 0.2 km —— 那是把 200 m 说成两倍）
  assert.ok(geometry.labels.some((l) => l.text === '200 m'), geometry.labels.map((l) => l.text).join('|'));
  assert.ok(!geometry.labels.some((l) => l.text.includes('km')));
});

test('格网：间隔不合法或范围缺失时不出格网（也不糊弄）', () => {
  const layout = {
    ...types.DEFAULT_LAYOUT,
    graticule: { enabled: true, kind: 'geographic', interval: 0.01, showLabels: true },
  };
  const bad = sheet.computeGraticule(
    layout,
    { metersPerPixel: 0.5, extent: { minX: 0, minY: 0, maxX: 0, maxY: 0 } },
    { width: 1200, height: 800 },
    { x: 10, y: 10, w: 1180, h: 780 },
  );
  assert.equal(bad.lines.length, 0);
});

test('格网：线太多时自动放大步长，不糊成一片', () => {
  const layout = {
    ...types.DEFAULT_LAYOUT,
    graticule: { enabled: true, kind: 'geographic', interval: 0.0001, showLabels: true },
  };
  const geometry = sheet.computeGraticule(
    layout,
    {
      metersPerPixel: 0.5,
      extent: { minX: 120.0, minY: 30.0, maxX: 121.0, maxY: 31.0 },
    },
    { width: 1200, height: 800 },
    { x: 10, y: 10, w: 1180, h: 780 },
  );
  const verticals = geometry.lines.filter((l) => l.x1 === l.x2);
  assert.ok(verticals.length <= sheet.MAX_GRATICULE_LINES + 1, `实际 ${verticals.length} 条`);
});

/* ── 5. 页幅 ─────────────────────────────────────────────── */

test('页幅：A3 / A4 × 横 / 竖 四个组合的尺寸与像素换算', () => {
  assert.deepEqual(types.pageSizeMm({ kind: 'A4', orientation: 'landscape' }), {
    width: 297,
    height: 210,
  });
  assert.deepEqual(types.pageSizeMm({ kind: 'A4', orientation: 'portrait' }), {
    width: 210,
    height: 297,
  });
  assert.deepEqual(types.pageSizeMm({ kind: 'A3', orientation: 'landscape' }), {
    width: 420,
    height: 297,
  });
  assert.deepEqual(types.pageSizeMm({ kind: 'A3', orientation: 'portrait' }), {
    width: 297,
    height: 420,
  });
  // 96 DPI 下 A4 横向 ≈ 1123 × 794 px
  const px = types.pageSizePx({ kind: 'A4', orientation: 'landscape' }, 96);
  assert.equal(px.width, 1123);
  assert.equal(px.height, 794);
});

/* ── 6. 版式校验：坏了要说清楚，不许拿默认值糊弄 ────────── */

test('版式校验：字段缺失或类型不对，指出是哪一处', () => {
  const broken = JSON.parse(JSON.stringify(types.DEFAULT_LAYOUT));
  delete broken.graticule.interval;
  assert.throws(
    () => types.normalizeLayout(broken),
    (err) => err instanceof types.LayoutError && /graticule\.interval/.test(err.message),
  );

  const badKind = JSON.parse(JSON.stringify(types.DEFAULT_LAYOUT));
  badKind.page.kind = 'A2';
  assert.throws(
    () => types.normalizeLayout(broken === null ? badKind : badKind),
    (err) => err instanceof types.LayoutError && /page\.kind/.test(err.message),
  );
});

test('版式：不是合法 JSON 时报清楚是哪个文件坏了', () => {
  assert.throws(
    () => types.parseLayout('{ 这不是 JSON', '模板「x」'),
    (err) => err instanceof types.LayoutError && /模板「x」/.test(err.message),
  );
});

test('版式：逐字段修改走 merge，改一个字段不动其它字段', () => {
  const next = types.mergeLayout(types.DEFAULT_LAYOUT, { graticule: { enabled: true } });
  assert.equal(next.graticule.enabled, true);
  assert.equal(next.graticule.kind, types.DEFAULT_LAYOUT.graticule.kind);
  assert.equal(next.frame.outerGap, types.DEFAULT_LAYOUT.frame.outerGap);
});

test('内置模板：三个必备模板都在，且都能通过校验', () => {
  const names = presets.BUILTIN_TEMPLATES.map((t) => t.name);
  for (const required of ['1-500-地形图-A3横向', '1-1000-地形图-A3横向', 'A4-横-简版']) {
    assert.ok(names.includes(required), `缺少内置模板 ${required}`);
  }
  for (const preset of presets.BUILTIN_TEMPLATES) {
    const normalized = types.normalizeLayout(preset.layout);
    assert.deepEqual(normalized, preset.layout, `${preset.name} 不是一份合法的版式`);
  }
  // 1:500 模板：格网 10 cm、图廓偏移 10 mm、标题栏带单位与坐标系
  const t500 = presets.findBuiltinTemplate('1-500-地形图-A3横向');
  assert.equal(t500.layout.graticule.kind, 'kilometer');
  assert.equal(t500.layout.graticule.interval, 10);
  assert.ok(Math.abs(t500.layout.frame.outerGap - 37.8) < 0.01);
  assert.equal(t500.layout.titleBlock.fields.crs, 'CGCS2000');
  assert.ok('reviewer' in t500.layout.titleBlock.fields);
});

/* ── 7. 模板存取 ─────────────────────────────────────────── */

/** 一个假的引擎：按 /api/fs/* 的契约存取文件 */
function fakeEngine({ workspaceRoot, projectRoot, files = new Map() }) {
  const joinPath = (base, rel) =>
    `${base.replace(/\\/g, '/').replace(/\/+$/, '')}/${rel.replace(/\\/g, '/')}`;
  const requests = [];

  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    requests.push({ url: String(url), method: init?.method ?? 'GET' });
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (parsed.pathname === '/api/health') {
      return json({ ok: true, workspaceRoot });
    }
    if (parsed.pathname === '/api/fs/list') {
      const dir = joinPath(projectRoot, parsed.searchParams.get('path') ?? '');
      const entries = [...files.keys()]
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1))
        .filter((p) => !p.includes('/'));
      return json({ entries });
    }
    if (parsed.pathname === '/api/fs/read') {
      const abs = joinPath(projectRoot, parsed.searchParams.get('path') ?? '');
      const content = files.get(abs);
      if (content === undefined) return json({ error: 'not_found' }, 404);
      return new Response(content, { status: 200 });
    }
    if (parsed.pathname === '/api/fs/write') {
      const body = new Uint8Array(init?.body ?? []);
      const sep = body.indexOf(0);
      const path = new TextDecoder().decode(body.subarray(0, sep));
      const content = new TextDecoder().decode(body.subarray(sep + 1));
      files.set(joinPath(workspaceRoot, path), content);
      return json({ ok: true, size: content.length });
    }
    if (parsed.pathname === '/api/fs/remove') {
      const path = new TextDecoder().decode(new Uint8Array(init?.body ?? []));
      files.delete(joinPath(workspaceRoot, path));
      return json({ ok: true });
    }
    if (parsed.pathname === '/api/fs/rename') {
      const [from, to] = new TextDecoder()
        .decode(new Uint8Array(init?.body ?? []))
        .split('\n');
      files.set(joinPath(workspaceRoot, to), files.get(joinPath(workspaceRoot, from)));
      files.delete(joinPath(workspaceRoot, from));
      return json({ ok: true });
    }
    return json({ error: 'not_found' }, 404);
  };

  return { fetchImpl, files, requests };
}

test('模板往返：存 → 列 → 读，内容相等', async () => {
  store.resetWorkspaceRootCache();
  const workspaceRoot = 'D:/Projects/demo';
  const projectRoot = 'D:/Projects/demo/任务A';
  const engine = fakeEngine({ workspaceRoot, projectRoot });
  const options = { base: 'http://engine', fetchImpl: engine.fetchImpl };

  const layout = presets.findBuiltinTemplate('1-500-地形图-A3横向').layout;
  await store.saveTemplate(projectRoot, '我的模板', layout, options);

  // 文件确实落在项目目录里
  assert.ok(
    engine.files.has(`${projectRoot}/.cartouche/templates/我的模板.json`),
    [...engine.files.keys()].join('|'),
  );

  const names = await store.listTemplates(projectRoot, options);
  assert.deepEqual(names, ['我的模板']);

  const back = await store.loadTemplate(projectRoot, '我的模板', options);
  assert.deepEqual(back, layout);

  // 写接口不认 root：路径是相对工作区根的，存完还要读回来核对
  const write = engine.requests.find((r) => r.url.includes('/api/fs/write'));
  assert.ok(write, '应当发过一次写请求');
});

test('模板：目录还不存在时列出的是空表，不是报错', async () => {
  store.resetWorkspaceRootCache();
  const engine = fakeEngine({
    workspaceRoot: 'D:/Projects/demo',
    projectRoot: 'D:/Projects/demo/任务A',
  });
  const names = await store.listTemplates('D:/Projects/demo/任务A', {
    base: 'http://engine',
    fetchImpl: engine.fetchImpl,
  });
  assert.deepEqual(names, []);
});

test('模板：文件坏了要说清楚是哪个模板坏了', async () => {
  store.resetWorkspaceRootCache();
  const workspaceRoot = 'D:/Projects/demo';
  const projectRoot = 'D:/Projects/demo/任务A';
  const files = new Map([
    [`${projectRoot}/.cartouche/templates/坏模板.json`, '{ 这不是 JSON'],
  ]);
  const engine = fakeEngine({ workspaceRoot, projectRoot, files });
  await assert.rejects(
    () =>
      store.loadTemplate(projectRoot, '坏模板', {
        base: 'http://engine',
        fetchImpl: engine.fetchImpl,
      }),
    (err) => err instanceof types.LayoutError && /坏模板/.test(err.message),
  );
});

test('模板：模板名里有路径分隔符要挡住（路径穿越）', () => {
  assert.throws(() => store.assertTemplateName('../../evil'), types.LayoutError);
  assert.throws(() => store.assertTemplateName('a/b'), types.LayoutError);
  assert.throws(() => store.assertTemplateName(''), types.LayoutError);
  assert.equal(store.assertTemplateName('  1-500 地形图 '), '1-500 地形图');
});

test('模板：项目不在引擎的工作区根之下时明说存不进去（不静默写到别处）', async () => {
  store.resetWorkspaceRootCache();
  const engine = fakeEngine({
    workspaceRoot: 'D:/workspace',
    projectRoot: 'E:/别的盘/任务A',
  });
  await assert.rejects(
    () =>
      store.saveTemplate(
        'E:/别的盘/任务A',
        'x',
        types.DEFAULT_LAYOUT,
        { base: 'http://engine', fetchImpl: engine.fetchImpl },
      ),
    (err) => err instanceof types.LayoutError && /工作区根/.test(err.message),
  );
  // 一次写请求都不该发出去（不能先写了再发现落错地方）
  assert.equal(engine.requests.filter((r) => r.url.includes('/api/fs/write')).length, 0);
});

/* ── 8. 同一模板连出 10 张图，零手调 ────────────────────── */

test('同一套版式连出 10 张：版面（框/图例/标题栏/比例尺）完全一致', () => {
  const layout = presets.findBuiltinTemplate('1-500-地形图-A3横向').layout;
  const geometries = [];
  for (let i = 0; i < 10; i += 1) {
    const options = {
      ...BASE_OPTIONS,
      title: `图幅 ${i + 1}`,
      producedAt: `2026-10-23 21:${String(30 + i).padStart(2, '0')}:00`,
      layout,
    };
    const content = {
      metersPerPixel: options.metersPerPixel,
      extent: { minX: 120.3 + i * 0.001, minY: 30.52, maxX: 120.32 + i * 0.001, maxY: 30.54 },
    };
    geometries.push(sheet.computeSheetGeometry(options, layout, content, 1));
  }
  const first = geometries[0];
  for (const g of geometries) {
    assert.deepEqual(g.frame, first.frame);
    assert.deepEqual(g.title, first.title);
    assert.deepEqual(g.legend, first.legend);
    assert.deepEqual(g.scale, first.scale);
  }
});

test('同一套版式连出 10 张：除本次内容外，绘制调用完全一致', () => {
  const layout = presets.findBuiltinTemplate('1-500-地形图-A3横向').layout;
  const logs = [];
  for (let i = 0; i < 10; i += 1) {
    const { ctx, calls } = recorder();
    sheet.drawSheet(ctx, {
      ...BASE_OPTIONS,
      title: `图幅 ${i + 1}`,
      operator: `制图 ${i + 1}`,
      producedAt: `2026-10-23 21:${String(30 + i).padStart(2, '0')}:00`,
      layout,
    });
    // 把本次内容相关的文字抹掉，其余应当一字不差
    logs.push(
      calls
        .map((c) => c.replace(/图幅 \d+/g, '<图名>').replace(/制图 \d+/g, '<制图人>'))
        .map((c) => c.replace(/2026-10-23 21:\d\d:00/g, '<出图时间>')),
    );
  }
  for (const log of logs) {
    assert.deepEqual(log, logs[0]);
  }
});

/* ── 金标准（改动前录下的调用序列） ───────────────────────── */

const GOLDEN_96DPI = [
  "save()",
  "textBaseline=\"alphabetic\"",
  "save()",
  "strokeStyle=\"#1c1a16\"",
  "lineWidth=1.6",
  "strokeRect(6,6,1188,788)",
  "lineWidth=0.6",
  "strokeRect(10,10,1180,780)",
  "restore()",
  "save()",
  "fillStyle=\"rgba(255,255,255,0.88)\"",
  "fillRect(18,694.5,240,53)",
  "strokeStyle=\"#1c1a16\"",
  "lineWidth=1",
  "strokeRect(18,694.5,240,53)",
  "fillStyle=\"#1c1a16\"",
  "textBaseline=\"middle\"",
  "textAlign=\"left\"",
  "font=\"bold 9.5px \\\"Microsoft YaHei\\\", \\\"PingFang SC\\\", \\\"Hiragino Sans GB\\\", \\\"Source Han Sans SC\\\", sans-serif\"",
  "fillText(\"图例\",24,703,)",
  "font=\"normal 9px \\\"Microsoft YaHei\\\", \\\"PingFang SC\\\", \\\"Hiragino Sans GB\\\", \\\"Source Han Sans SC\\\", sans-serif\"",
  "fillStyle=\"#2f6f5e\"",
  "fillRect(24,715,14,8)",
  "strokeStyle=\"#1c1a16\"",
  "lineWidth=0.5",
  "strokeRect(24,715,14,8)",
  "fillStyle=\"#1c1a16\"",
  "fillText(\"建筑物\",44,719,208)",
  "fillStyle=\"#b08d57\"",
  "fillRect(24,730,14,8)",
  "strokeStyle=\"#1c1a16\"",
  "lineWidth=0.5",
  "strokeRect(24,730,14,8)",
  "fillStyle=\"#1c1a16\"",
  "fillText(\"道路\",44,734,208)",
  "restore()",
  "save()",
  "fillStyle=\"#1c1a16\"",
  "font=\"normal 9.5px \\\"Microsoft YaHei\\\", \\\"PingFang SC\\\", \\\"Hiragino Sans GB\\\", \\\"Source Han Sans SC\\\", sans-serif\"",
  "textAlign=\"left\"",
  "textBaseline=\"alphabetic\"",
  "fillText(\"1:1 890\",18,765,)",
  "fillStyle=\"#1c1a16\"",
  "fillRect(18,769,25,7)",
  "strokeStyle=\"#1c1a16\"",
  "lineWidth=0.6",
  "strokeRect(18,769,25,7)",
  "fillStyle=\"#ffffff\"",
  "fillRect(43,769,25,7)",
  "strokeStyle=\"#1c1a16\"",
  "lineWidth=0.6",
  "strokeRect(43,769,25,7)",
  "fillStyle=\"#1c1a16\"",
  "fillRect(68,769,25,7)",
  "strokeStyle=\"#1c1a16\"",
  "lineWidth=0.6",
  "strokeRect(68,769,25,7)",
  "fillStyle=\"#ffffff\"",
  "fillRect(93,769,25,7)",
  "strokeStyle=\"#1c1a16\"",
  "lineWidth=0.6",
  "strokeRect(93,769,25,7)",
  "fillStyle=\"#1c1a16\"",
  "font=\"normal 9px \\\"Microsoft YaHei\\\", \\\"PingFang SC\\\", \\\"Hiragino Sans GB\\\", \\\"Source Han Sans SC\\\", sans-serif\"",
  "fillText(\"50 m\",124,776,)",
  "restore()",
  "save()",
  "fillStyle=\"rgba(255,255,255,0.88)\"",
  "fillRect(862,712,320,70)",
  "strokeStyle=\"#1c1a16\"",
  "lineWidth=1.1",
  "strokeRect(862,712,320,70)",
  "beginPath()",
  "moveTo(862,751.2)",
  "lineTo(1182,751.2)",
  "moveTo(1022,751.2)",
  "lineTo(1022,782)",
  "stroke()",
  "fillStyle=\"#1c1a16\"",
  "textBaseline=\"middle\"",
  "font=\"bold 14px \\\"Microsoft YaHei\\\", \\\"PingFang SC\\\", \\\"Hiragino Sans GB\\\", \\\"Source Han Sans SC\\\", sans-serif\"",
  "textAlign=\"center\"",
  "fillText(\"图签 Cartouche 出图\",1022,731.6,312)",
  "font=\"normal 8.5px \\\"Microsoft YaHei\\\", \\\"PingFang SC\\\", \\\"Hiragino Sans GB\\\", \\\"Source Han Sans SC\\\", sans-serif\"",
  "textAlign=\"left\"",
  "fillText(\"出图时间\",868,759.6,)",
  "font=\"normal 9.5px \\\"Microsoft YaHei\\\", \\\"PingFang SC\\\", \\\"Hiragino Sans GB\\\", \\\"Source Han Sans SC\\\", sans-serif\"",
  "fillText(\"2026-10-23 21:30:00\",868,773.6,148)",
  "font=\"normal 8.5px \\\"Microsoft YaHei\\\", \\\"PingFang SC\\\", \\\"Hiragino Sans GB\\\", \\\"Source Han Sans SC\\\", sans-serif\"",
  "textAlign=\"left\"",
  "fillText(\"操作人\",1028,759.6,)",
  "font=\"normal 9.5px \\\"Microsoft YaHei\\\", \\\"PingFang SC\\\", \\\"Hiragino Sans GB\\\", \\\"Source Han Sans SC\\\", sans-serif\"",
  "fillText(\"张三\",1028,773.6,148)",
  "restore()",
  "save()",
  "fillStyle=\"#1c1a16\"",
  "beginPath()",
  "moveTo(1168,36)",
  "lineTo(1158,56)",
  "lineTo(1168,50)",
  "lineTo(1178,56)",
  "closePath()",
  "fill()",
  "font=\"bold 11px \\\"Microsoft YaHei\\\", \\\"PingFang SC\\\", \\\"Hiragino Sans GB\\\", \\\"Source Han Sans SC\\\", sans-serif\"",
  "textAlign=\"center\"",
  "textBaseline=\"alphabetic\"",
  "fillText(\"N\",1168,30,)",
  "restore()",
  "restore()"
];
