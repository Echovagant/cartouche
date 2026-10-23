/**
 * 确认卡的像元闸门口径的测试。
 *
 * 盯住的是一条真踩过的坑（2026-10-24 浏览器实测）：
 * AI 页的一条操作计划走确认卡，而**非像元型 op（改属性那种）的像元数是 null**。
 * 原来的格式化函数直接在 null 上调 toLocaleString —— 整页被带崩成错误页，
 * 用户看到的是「This page couldn't load」，连"这次没改成"都看不出来。
 *
 * 这条测试盯两件事：
 *   1. null 不能崩（必须给一句人话，而不是假数字「0 / 0 像元」）；
 *   2. 正常数字的口径不能变（官网与画布共用同一个格式，官网在拿它对文案）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { formatPixelGate } = await import(
  pathToFileURL(join(root, 'web', 'app', 'motion', 'pixel-gate.ts')).href
);

test('像元口径：正常数字的格式不变', () => {
  assert.equal(
    formatPixelGate(165, 1200, 165 / 1200),
    '165 / 1,200 像元（13.8%）',
    '官网与画布共用这个格式，改了这里官网就在说谎',
  );
});

test('非像元型 op：像元数是 null 时不崩，也不给「0 / 0 像元」这种假数字', () => {
  const text = formatPixelGate(null, null, 0);
  assert.ok(text.length > 0, '不能是空串');
  assert.ok(!/0 \/ 0 像元/.test(text), `不能显示假数字：${text}`);
  assert.ok(/不按像元计/.test(text), `要说清这条不适用：${text}`);
});

test('只有一个数是 null 也要认（不能只判一个就放行）', () => {
  assert.ok(!/像元（/.test(formatPixelGate(10, null, 0)), 'total 为 null 时不能出像元行');
  assert.ok(!/像元（/.test(formatPixelGate(null, 100, 0)), 'affected 为 null 时不能出像元行');
});
