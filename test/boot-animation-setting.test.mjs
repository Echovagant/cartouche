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
const engineSettings = read('web', 'app', 'canvas', 'project', 'engineSettings.ts');
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
      /bootMode !== 'never' && reduceMotion === 'off'/,
      '动效开关要同时听「加载动画」设置与减弱动效（pending 按减弱处理）',
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

describe('加载动画设置的持久化（跨浏览器 / 跨访问地址）', () => {
  const server = read('server', 'src', 'settings.ts');
  const serverApp = read('server', 'src', 'app.ts');

  test('引擎是权威副本：设置落在本机配置目录，不是浏览器里', () => {
    assert.match(server, /settings\.json/, '要落盘到配置文件');
    assert.match(
      server,
      /LOCALAPPDATA|CARTOUCHE_CONFIG_DIR/,
      '落在本机配置目录（与 roots.json 同级）',
    );
    assert.match(server, /readSettings/, '要能读回来');
    assert.match(server, /writeSettings/, '要能写进去');
  });

  test('引擎有设置接口（GET 读 / PUT 写）', () => {
    assert.match(serverApp, /\/api\/settings/, '要有 /api/settings 路由');
    assert.match(serverApp, /readSettings\(\)/, 'GET 要读设置');
    assert.match(serverApp, /writeSettings\(/, 'PUT 要写设置');
  });

  test('前端：本地缓存 + 引擎同步，缺一不可', () => {
    assert.match(pref, /fetchEngineBootMode/, '要能向引擎问设置');
    assert.match(pref, /saveBootModeToEngine/, '保存时要同步到引擎');
    assert.match(
      engineSettings,
      /isEngineSettingsSynced/,
      '要记录"本地已与引擎核对过"',
    );
    assert.match(
      engineSettings,
      /cartouche\.settings\.synced/,
      '核对标记用独立存储键（与设置值分开）',
    );
  });

  test('启动决策链：问引擎（核对过用短超时），问不到就按本地', () => {
    assert.match(
      boot,
      /await fetchEngineSettings\(isEngineSettingsSynced\(\) \? 500 : 800\)/,
      '核对过 → 短超时问（毫秒级，不拖慢启动）；没核对过 → 给足时间',
    );
    assert.match(
      boot,
      /if \(!settings\)[\s\S]{0,160}?readBootAnimationMode\(\)/,
      '问不到引擎 → 按本地来（引擎没起也不能让用户看到错的设置）',
    );
  });

  test('问引擎期间启动屏是藏着的（跨浏览器首访零闪屏）', () => {
    assert.match(layout, /data-boot-pending/, '内联脚本要写"待定"标记');
    assert.match(
      css,
      /html\[data-boot-pending='1'\][\s\S]*?\.boot-screen[\s\S]*?display:\s*none/,
      '待定期间启动屏必须被藏住',
    );
  });

  test('设置页显示的是生效中的那一份（换浏览器后不能显示本地默认值）', () => {
    assert.match(
      settings,
      /fetchEngineSettings\(800\)\.then\(\(settings\) => \{[\s\S]{0,200}?setBootMode\(settings\.bootAnimation\)/,
      '设置页打开时要向引擎核对一次',
    );
    assert.match(settings, /saveBootModeToEngine\(bootMode\)/, '保存时要同步到引擎');
  });
});

describe('减弱动效（搬引擎 + 补齐判断点）', () => {
  const reduced = read('web', 'app', 'canvas', 'project', 'useReducedMotion.ts');
  const motion = read('web', 'app', 'canvas', 'CanvasMotion.tsx');
  const settingsModal = read('web', 'app', 'canvas', 'workbench', 'SettingsModal.tsx');
  const serverSettings = read('server', 'src', 'settings.ts');

  test('引擎侧存 reduceMotion', () => {
    assert.match(serverSettings, /reduceMotion\?: boolean/, '引擎设置要有这一项');
  });

  test('三层优先级：设置页覆盖 > 引擎 > 系统', () => {
    assert.match(
      reduced,
      /prefers-reduced-motion: reduce/,
      '系统设置仍是兜底',
    );
    assert.match(reduced, /fetchEngineSettings/, '要向引擎问');
    assert.match(
      reduced,
      /settings\.reduceMotion \? 'on' : 'off'/,
      '引擎的值要参与决策',
    );
    assert.match(
      reduced,
      /'pending'/,
      '要有 pending 态：还没问引擎时一律按"减弱"处理',
    );
  });

  test('CanvasMotion 的动效编排必须走统一判断（原来只看系统设置）', () => {
    // ⚠️ 2026-11-16 实测发现的既有 bug：CanvasMotion 四处都只看 matchMedia，
    //    用户在设置页勾了「减弱动效」也不起作用。
    assert.match(motion, /useReduceMotionDecision/, '要改用统一判断');
    const rawMatches = motion.match(/matchMedia\('\(prefers-reduced-motion: reduce\)'\)/g) ?? [];
    assert.equal(
      rawMatches.length,
      0,
      `CanvasMotion 里不该再有裸的 matchMedia 判断（还有 ${rawMatches.length} 处）`,
    );
    // 四个编排都要用决策
    const decisions = motion.match(/motion !== 'off'/g) ?? [];
    assert.ok(decisions.length >= 4, `四个编排都要按决策跳过（找到 ${decisions.length} 处）`);
  });

  test('启动屏：减弱动效开启时不播（启动屏本身就是动效）', () => {
    assert.match(
      boot,
      /mode === 'never' \|\| reduced/,
      '减弱动效时整个启动屏跳过',
    );
  });

  test('设置页：减弱动效的读写都走引擎', () => {
    assert.match(settingsModal, /saveEngineSettings\(\{ reduceMotion \}\)/, '保存要同步引擎');
    assert.match(
      settingsModal,
      /typeof settings\.reduceMotion === 'boolean'\) setReduceMotion\(settings\.reduceMotion\)/,
      '打开设置页要显示引擎上的值',
    );
  });

  test('本地有值时也要后台核对引擎（设置可能在别的浏览器里改过）', () => {
    // ⚠️ 2026-11-16 实测踩到：核对标记是永久的 → 引擎把减弱动效关掉后，
    //    本地缓存还停在"减弱"，启动屏就一直不播。
    assert.match(
      reduced,
      /void fetchEngineSettings\(\)\.then/,
      'hook 必须无条件问引擎（不因本地有值而跳过）',
    );
    assert.doesNotMatch(
      reduced,
      /if \(local\) \{[\s\S]{0,120}?return;/,
      '不能因为本地有值就提前 return（那正是旧 bug 的形状）',
    );
  });

  test('启动决策总是问一次引擎（别只信本地缓存）', () => {
    assert.match(
      boot,
      /await fetchEngineSettings\(isEngineSettingsSynced\(\) \? 500 : 800\)/,
      '启动屏要问引擎（本机毫秒级；引擎没起则超时回落本地）',
    );
    assert.doesNotMatch(
      boot,
      /isEngineSettingsSynced\(\)\)[\s\S]{0,80}?return \{ mode: readBootAnimationMode\(\)/,
      '不能因为"已核对过"就完全不信引擎',
    );
  });
});
