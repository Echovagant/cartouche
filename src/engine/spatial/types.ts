/**
 * 空间连接的类型契约。
 *
 * 纯函数：不碰文件、不碰 GDAL。输入两组要素，输出每个目标要素的匹配与汇总结果。
 */

/**
 * 空间连接只需要要素的两样东西：属性与几何。
 *
 * 为什么要用 `unknown` 收几何：要素来自文件，几何可能是 null、可能是坏数据。
 * 这里先不假设它合法，判定时统一走几何层的校验，把「第几个要素的几何坏了」
 * 这种能定位的错误抛出去，而不是当成「不相交」。
 */
export interface FeatureLike {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly geometry: unknown;
}

/**
 * 空间关系。
 *
 * - `within`：目标要素**完全落在**某个源要素内部（目标 ⊆ 源）。
 * - `intersects`：目标与源有交集即可，相交、压边都算。
 * - `contains`：源要素**完全落在**目标要素内部（源 ⊆ 目标，与 within 方向相反）。
 */
export type SpatialRelation = 'within' | 'intersects' | 'contains';

/**
 * 汇总方式。
 *
 * - `first`：取第一个匹配源要素的字段值（原样保值，字符串也是字符串）。
 * - `count`：匹配到的源要素**条数**（只产出一个计数字段）。
 * - `sum` / `mean`：对源的**数值字段**求和 / 求均值。
 */
export type JoinAggregate = 'first' | 'count' | 'sum' | 'mean';

export interface SpatialJoinOptions {
  readonly relation: SpatialRelation;
  readonly aggregate: JoinAggregate;
  /**
   * 汇总时取源的哪些字段。
   *
   * 不给时的默认口径（三种汇总各不相同，这里必须写死，不能含糊）：
   *   - `first`：取源的全部字段（原样复制）。
   *   - `sum` / `mean`：取源的全部**数值字段**，非数值字段跳过并在
   *     `skippedFields` 里列出来。
   *   - `count`：忽略本参数（只产出一个计数字段）。
   */
  readonly fields?: readonly string[];
  /**
   * 汇总值字段名前缀；不给就用源字段名。
   *
   * 写回目标图层时建议给（如 `sj_`）：不带前缀时 `sum` 出来的字段名与源字段
   * 同名，若目标图层本来就有同名字段，写回时会撞名。
   */
  readonly fieldPrefix?: string;
}

export interface SpatialJoinResult {
  /** 每个目标要素的匹配结果（按目标要素原顺序） */
  readonly rows: ReadonlyArray<{
    readonly targetIndex: number;
    readonly sourceIndexes: readonly number[];
    readonly aggregates: Readonly<Record<string, number | string | null>>;
  }>;
  /** 没有任何匹配的目标要素下标 */
  readonly unmatched: readonly number[];
  /**
   * 被跳过的源字段。
   *
   * 为什么要有这一项：`sum` / `mean` 遇到非数值字段只能跳过（把字符串
   * "12" 当成 12 会得到用户完全没预期的数字），但「跳过了哪些」必须
   * 可见——否则用户看到汇总值少了几列，却不知道为什么。
   * 列出的字段包括：参与汇总但非数值的字段，以及指定的字段里源数据中
   * 根本不存在的字段。
   */
  readonly skippedFields: readonly string[];
}

/** 空间连接的错误（几何非法、关系不支持等）。 */
export class SpatialJoinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpatialJoinError';
  }
}
