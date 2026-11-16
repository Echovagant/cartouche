/**
 * 启动屏 BootCinematic 的源码契约。
 *
 * 为什么要有这个测试：2026-11-16 实测事故 —— 启动屏**从未运行过**，
 * 用户看到的是静态导出留下的浮空元素（滚轮数字/状态行挂在办公界面上）。
 * 根因是两处低级错：
 *   1. 状态行 mask 容器的 ref 忘了在 JSX 里挂 → effect 第一行判空早退；
 *   2. 屏幕容器漏了 `boot-screen` class → CSS 的 fixed/暗底/z-index 全没生效，
 *      绝对定位的子元素于是浮在工作台上。
 *
 * 这类"静默失效"没有运行时症状可查（页面照常渲染，只是动画没跑），
 * 只能靠源码断言钉住 —— 组件本身是 React，web 目录没有测试框架，
 * 所以这里读源码做结构断言。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(
  join(root, 'web', 'app', 'canvas', 'BootCinematic.tsx'),
  'utf8',
);
const css = readFileSync(join(root, 'web', 'app', 'globals.css'), 'utf8');

describe('启动屏 BootCinematic 契约', () => {
  test('屏幕容器必须带 boot-screen class（否则 fixed/暗底/z-index 全部失效）', () => {
    assert.match(
      src,
      /className="boot-screen"/,
      '屏幕容器漏了 boot-screen → 绝对定位子元素会浮在工作台上',
    );
    assert.match(src, /ref=\{screenRef\}/, '屏幕容器必须挂 screenRef');
  });

  test('状态行的两个 ref 都要在 JSX 里挂上（漏一个 = 整个动画静默不跑）', () => {
    assert.match(src, /ref=\{statusTextRef\}/, '状态文字必须挂 statusTextRef');
    assert.match(
      src,
      /ref=\{statusRvRef\}/,
      '状态行 mask 容器必须挂 statusRvRef —— 漏挂会让 effect 早退，动画从未运行',
    );
    assert.match(src, /ref=\{barRef\}/, '进度条必须挂 barRef');
  });

  test('effect 不得因为单个 ref 缺失就整体放弃（要有兜底来源）', () => {
    assert.match(
      src,
      /statusRvRef\.current\s*\?\?\s*statusText\?\.parentElement/,
      'statusRv 要有 parentElement 兜底，避免 ref 缺失时整段动画静默失效',
    );
  });

  test('rAF 保险线：引擎未就绪时按时间强制收场，不靠进度爬到顶', () => {
    assert.match(src, /FORCE_EXIT_AT/, '要有 FORCE_EXIT_AT 兜底');
    assert.match(
      src,
      /performance\.now\(\) - startedAt > FORCE_EXIT_AT/,
      '引擎未就绪且进度失速时必须按时间收场（后台标签 rAF 会被节流到 ~1fps）',
    );
  });

  test('CSS 侧：boot-screen 是 fixed 全屏 + 高 z-index，幕布高于启动屏', () => {
    assert.match(css, /\.boot-screen\s*\{[^}]*position:\s*fixed/s, '.boot-screen 必须 fixed');
    assert.match(css, /\.boot-screen\s*\{[^}]*inset:\s*0/s, '.boot-screen 必须 inset:0');
    assert.match(css, /\.boot-screen\s*\{[^}]*z-index:\s*9999/s, '.boot-screen 必须压在工作台之上');
    assert.match(css, /#boot-curtain-1\s*\{[^}]*z-index:\s*10000/s, '幕布要盖过启动屏');
    assert.match(css, /#boot-curtain-2\s*\{[^}]*z-index:\s*10001/s, '第二道幕布盖过第一道');
  });

  test('幕布退场后必须被移出渲染（display:none，不能只靠 scaleY(0)）', () => {
    assert.match(src, /curtain1\.style\.display = 'none'/, '退场后幕布要 display:none');
    assert.match(src, /curtain2\.style\.display = 'none'/, '退场后幕布要 display:none');
  });
});
