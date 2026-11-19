/**
 * 流式编辑共用的输入形状（GeoPackage 原生 SQL 与 Shapefile DBF 两条路共用）。
 */
import type { ColumnKind } from '../feature/common.ts';
import type { ExprNode } from '../expression/index.ts';

/** 一条要写进去的 set 项（值或表达式） */
export type StreamSetValue =
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'expression'; readonly node: ExprNode; readonly source: string };

/** 一个要改的列：文件里真实的列名 + 要写进去的值 */
export interface StreamSetTarget {
  readonly name: string;
  readonly requested: string;
  readonly kind: ColumnKind;
  readonly value: StreamSetValue;
}
