/**
 * 「加载动画」设置项的契约（2026-11-16 用户要求：可自主控制每次打开项目时是否有加载动画）。
 *
 * 钉住四件事：
 *   1. 偏好模块存在且只有三态（always / first-visit / never），默认值 first-visit；
 *   2. 设置页真的提供了这三态的选择控件；
 *   3. **首帧零闪屏**：`never` 必须靠 layout 的内联脚本 + CSS 属性选择器在渲染前隐藏，
 *      不能只靠 JS（静态导出会把启动屏标记预渲染进 HTML，只靠 JS 会先闪一下）；
 *   4. 打开项目时的加载态：**文字提示始终在**，灭掉的只是动效。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const pref = read('web', 'app', 'canvas', 'project', 'useBootAnimation.ts');
const settings = read('web', 'app', 'canvas', 'workbench', 'SettingsModal.tsx');
const layout = read('web', 'app', 'layout.tsx');
const css = read('web', 'app', 'globals.css');
const boot = read('web', 'app', 'canvas', 'BootCinematic.tsx');
const loading = read('web', 'app', 'canvas', 'ProjectLoading.tsx');
const workbench = read('web', 'app', 'canvas', 'CanvasWorkbench.tsx');

describe('加载动画设置', () => {
  test('偏好模块：三态 + 默认 first-visit', () => {
    assert.match(pref, /export type BootAnimationMode = 'always' \| 'first-visit' \| 'never';/);
    assert.match(pref, /cartouche\.boot\.animation/, '要有独立的存储键');
    assert.match(
      pref,
      /return 'first-visit';/,
      '默认值是 first-visit（首访完整、回头客缩短）',
    );
  });

  test('设置页提供三态选择控件', () => {
    assert.match(settings, /BOOT_MODES/, '设置页要列出三态');
    for (const mode of ['always', 'first-visit', 'never']) {
      assert.ok(settings.includes(`'${mode}'`) || settings.includes(mode), `缺 ${mode} 选项`);
    }
    assert.match(settings, /role="radiogroup"/, '用 radiogroup 语义（键盘可用）');
    assert.match(settings, /setBootAnimationMode\(bootMode\)/, '保存时要写进偏好');
  });

  test('never 模式首帧零闪屏：内联脚本 + CSS 属性选择器', () => {
    assert.match(
      layout,
      /cartouche\.boot\.animation/,
      'layout 的内联脚本要读这个键（跑在 hydration 之前）',
    );
    assert.match(layout, /data-boot/, '要写 <html data-boot="off">');
    assert.match(
      css,
      /html\[data-boot='off'\][\s\S]*?\.boot-screen[\s\S]*?display:\s*none/,
      'CSS 要在渲染前把启动屏藏掉（否则静态导出会闪一下）',
    );
  });

  test('BootCinematic 读偏好：never 直接跳过，always 不做回头客加速', () => {
    assert.match(boot, /readBootAnimationMode\(\)/, '要读用户的加载动画偏好');
    assert.match(
      boot,
      /mode === 'never'[\s\S]{0,400}?onRevealRef\.current\(\)/,
      "never 要直接跳过动画并把接力棒交给工作台",
    );
    assert.match(
      boot,
      /if \(mode !== 'always'\)[\s\S]{0,240}?fast = last > 0/,
      "always 模式下不做回头客加速（用户要的是每次都完整看）",
    );
  });

  test('打开项目时的加载态：文字始终在，动效可关', () => {
    assert.match(loading, /正在读取/, '必须有文字提示（大文件要读几十秒）');
    assert.match(
      loading,
      /animated[\s\S]*?boot-pulse/,
      '呼吸光带受 animated 开关控制',
    );
    assert.match(
      workbench,
      /bootMode !== 'never' && !prefersReducedMotion\(\)/,
      '动效开关要同时听「加载动画」设置与系统的减弱动效',
    );
  });

  test('加载进度有并发保护（旧请求不能盖掉新请求的状态）', () => {
    assert.match(workbench, /loadingSeqRef/, '要有序号做并发保护');
    assert.match(
      workbench,
      /finally[\s\S]{0,200}?setLayerLoading\(null\)/,
      '无论怎么退出都要撤掉遮罩（不能卡住界面）',
    );
  });
});
