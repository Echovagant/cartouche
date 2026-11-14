/**
 * 「打开项目」这一屏用到的纯函数。
 *
 * 为什么单独放一个文件：图号怎么算、时间怎么写、排序怎么比，
 * 都是**规则**而不是界面。规则跟界面分开，改规则不用碰组件，
 * 组件也不用知道图号是怎么来的。
 */
import type { ProjectSummary } from '../types';

/** 最近项目的三种排法 */
export type ProjectSort = 'recent' | 'name' | 'layers';

/** 两位补零：图号与时间戳都按两位写 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 时间戳：清单里存的是 ISO 字符串。
 *
 * 写成 `2026-11-08 14:32` 而不是「3 天前」——
 * 图签的产出是要拿去对账的，相对时间会飘，绝对时间不会。
 */
export function formatStamp(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 路径散列（FNV-1a）：同一个路径永远得到同一个序号 */
function pathHash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * 图号：图签框上那个编号（形如 `CH-2026-1108-01`）。
 *
 * - 年月日取项目最后修改时间 —— 图号要能对着交差日期读；
 * - 末两位取路径散列 —— 同一个项目永远同一个号，重新排序也不会变；
 * - 时间不可用时退化成 `CH-01`（宁可少信息，也不要编一个假日期）。
 */
export function sheetNumber(path: string, updatedAt: string): string {
  const seq = pad2(pathHash(path) % 100);
  const d = updatedAt ? new Date(updatedAt) : null;
  if (!d || Number.isNaN(d.getTime())) return `CH-${seq}`;
  return `CH-${d.getFullYear()}-${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${seq}`;
}

/** 按名称或路径过滤（大小写不敏感） */
export function filterProjects(
  list: readonly ProjectSummary[],
  query: string,
): ProjectSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter(
    (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
  );
}

/**
 * 排序。
 *
 * `recent` 保持数组原序 —— 最近项目本来就是按打开先后存的，
 * 再按时间重排一遍反而跟「我上次开的是哪个」对不上。
 */
export function sortProjects(
  list: readonly ProjectSummary[],
  sort: ProjectSort,
): ProjectSummary[] {
  const copy = [...list];
  if (sort === 'name') {
    copy.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  } else if (sort === 'layers') {
    copy.sort(
      (a, b) => b.layerCount - a.layerCount || a.name.localeCompare(b.name, 'zh-CN'),
    );
  }
  return copy;
}
