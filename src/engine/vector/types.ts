/**
 * 矢量读写用到的公共类型。
 *
 * 为什么自己定义一套"要素"形状，而不直接用 GeoJSON 的原始对象：
 * 属性查询的结果要进操作计划的返回值（会被序列化、给界面看），
 * GeoJSON 原始对象里混着 bbox、crs 这些与查询无关的字段，
 * 直接透传会让返回结构随 GDAL 版本漂移。
 */
export interface FeatureGeometry {
  readonly type: string;
  readonly coordinates: unknown;
}

export interface FeatureRecord {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly geometry: FeatureGeometry | null;
}

/** 图层的一列。 */
export interface LayerField {
  readonly name: string;
  /** GDAL 的字段类型名：String / Integer / Real … */
  readonly type: string;
}

/** 读一个图层时探到的信息。 */
export interface LayerInfo {
  /** 实际要用的图层名（多图层容器里取第一个） */
  readonly layerName: string;
  /**
   * 这个文件里的全部图层名（按出现顺序）。
   *
   * 为什么单列一个字段：多图层容器（GeoPackage 是最常见的一个）里
   * `ogrinfo -al` 会把所有图层都列出来。不记下来，就没法告诉用户
   * 「你打开的这个文件其实有 3 个图层，我读的是第一个」。
   */
  readonly layerNames: readonly string[];
  /** 图层里的要素总数（未筛选） */
  readonly featureCount: number;
  readonly fields: readonly LayerField[];
  /** 图层的坐标系 WKT；没有坐标系时是 null */
  readonly srsWkt: string | null;
  /** 能认出的 EPSG 码；认不出是 null */
  readonly epsg: number | null;
}

export interface ReadFeaturesOptions {
  /** 矢量文件绝对路径 */
  readonly path: string;
  /**
   * 读的时候按哪个编码解码属性表（Shapefile 的 DBF）。
   *
   * 不给就按 .cpg / GDAL 自己的判断来。
   * .cpg 说的与实际不符时（属性表本来就是按另一种编码写的），
   * 显式给这个才能把字读对。
   */
  readonly encoding?: string;
  /**
   * 条件表达式（SQL）。由表达式引擎产出。
   *
   * 注意：这个条件**由引擎自己算**，不交给 GDAL 的 SQL。
   * 原因见 read.ts 的注释：GDAL 的通用 SQL 方言没有 UPPER/LOWER 这些函数，
   * 而且它会把文字悄悄当数字比 —— 与本项目"类型对不上必须报错"的口径相反。
   */
  readonly where?: string;
  /** 只读这几列；不给就全读 */
  readonly fields?: readonly string[];
  /** 最多返回多少条 */
  readonly limit?: number;
}

export interface ReadFeaturesResult {
  readonly features: readonly FeatureRecord[];
  /** 返回的条数 */
  readonly featureCount: number;
  /** 满足条件的总条数（不受 limit 影响） */
  readonly totalCount: number;
  /** 是否因为 limit 被截断 */
  readonly truncated: boolean;
  /** 图层的列名（按图层里的顺序） */
  readonly fields: readonly string[];
  /** 这次读的是哪个图层 */
  readonly layerName: string;
  /**
   * 这个文件里还有哪些图层（这次没读）。
   *
   * 空数组 = 只有一层。**非空就必须让用户看见** ——
   * 静默只读第一层、让人以为整个文件都处理过了，是最坏的一种做法。
   */
  readonly otherLayerNames: readonly string[];
}

/**
 * 写回支持的三种格式。
 *
 * - shapefile：一套文件（.shp/.shx/.dbf/.prj/.cpg）
 * - geojson：单个文件
 * - gpkg：GeoPackage —— **一个文件里的多个图层**（底层是 SQLite）
 */
export type VectorWriteFormat = 'shapefile' | 'geojson' | 'gpkg';

export interface WriteFeaturesOptions {
  /** 目标文件（工作区相对路径）；绝对路径与 .. 会被路径闸门挡掉 */
  readonly target: string;
  readonly features: readonly FeatureRecord[];
  /** 不给就按扩展名判断（.shp / .geojson / .gpkg） */
  readonly format?: VectorWriteFormat;
  /**
   * 写回 GeoPackage 的**哪一层**。
   *
   * 不给就写文件里的第一个图层 —— 与读路径（read.ts 的 `readFeatures`）默认读的是同一层，
   * 这样"读出来改一改再写回去"才落回原处。
   *
   * 只对 GeoPackage 有意义：Shapefile/GeoJSON 只有一个图层。
   */
  readonly layerName?: string;
  /** 备份目录名里的标签，默认取时间戳 */
  readonly label?: string;
  /**
   * 写回时贴的坐标系 WKT。
   *
   * 不给就沿用目标文件原来的坐标系（"原样保留"，见 write.ts 开头）——
   * 坐标没变、只把标签保住。
   *
   * 给了就表示"这次要把坐标系换成它"：写回时用它当标签，
   * 写完也按它核对（而不是按原坐标系核对）。
   * 重投影走的就是这条：坐标已经是新坐标系的值，标签也得跟着换。
   */
  readonly srsWkt?: string;
  /**
   * 写回属性表用的编码（Shapefile 的 DBF）。
   *
   * 不给就用 UTF-8（这是现在的行为，也是转码交差的默认目标）。
   */
  readonly encoding?: string;
}

export interface WriteFeaturesResult {
  /** 备份目录（工作区相对路径）；没备份时是 null */
  readonly backupPath: string | null;
  /** 实际写入的文件（工作区相对路径） */
  readonly files: readonly string[];
  /** 写完清掉的旧文件（工作区相对路径） */
  readonly removed: readonly string[];
  /** 写完后文件里实际存在的列名 */
  readonly fieldNames: readonly string[];
  /** 写进去的要素数 */
  readonly featureCount: number;
  /**
   * 写的是哪个图层。
   *
   * Shapefile/GeoJSON 只有一个图层，这里给的是它的名字（一般是文件名去扩展名）；
   * GeoPackage 一个文件里有多个图层，这里给的是**实际被替换的那一层**。
   */
  readonly layerName: string;
}

/** 矢量读写过程中出的错。带上原始输出，便于定位是 GDAL 哪一步失败。 */
export class VectorError extends Error {
  readonly stderr: string;
  /** 出错时裹着的原始异常 */
  readonly originalError?: unknown;

  constructor(message: string, stderr = '', originalError?: unknown) {
    super(message);
    this.name = 'VectorError';
    this.stderr = stderr;
    if (originalError !== undefined) this.originalError = originalError;
  }
}
