/**
 * 像素带的类型抽象：一幅影像的样点可以是 8/16/32 位整型，也可以是 32/64 位浮点。
 *
 * 为什么需要这一层：
 * 引擎原先把像素写死成 8 位，读取时靠 `gdal_translate -ot Byte` 把影像转成 8 位。
 * 但 `-ot Byte` 对 16 位以上的源是**静默饱和**：65535 被压成 255，退出码仍是 0、stderr 也是空的
 * （实测 GDAL 3.13.3）。也就是说数据被改坏了，却没有任何报错提示。
 * 大影像大量使用 UInt16（高程、DN、反射率），SRTM 这类高程数据更是 Int32，
 * Web Mercator 下的高程还常是 Float32 —— 这种损失是实打实的。
 * 所以像素带必须自己记住"我是哪种类型"，读写两端才能对上口径，而不是靠下游猜。
 *
 * 为什么 8 位不统一升成 16 位：
 * 8 位影像占绝大多数，统一升位会让内存占用直接翻倍，却换不来任何精度收益；
 * 而且升位会改变现有链路的数值范围，掩膜/混合/修补/色阶的结果都会跟着变。
 * 保持"按源类型走"：8 位链路零变化，其他链路才走新口径。
 *
 * 为什么**读进来是什么类型，写回去就是什么类型**：
 * 用户手上的高程数据是有价值的原始资料，被工具悄悄降成 8 位之后，
 * 他既看不出来，也没法追回 —— 那比"明确拒绝"坏得多。
 * 所以整条链路（读 → 算 → 写）都按源类型走，任何一步发现类型对不上就当场报错。
 */

/** 本引擎支持的像素类型。 */
export type PixelType =
  | 'Byte'
  | 'UInt16'
  | 'Int16'
  | 'UInt32'
  | 'Int32'
  | 'Float32'
  | 'Float64';

/** 一条像素带：数组本身即类型标签，不同位深/符号的带不会混。 */
export type PixelBand =
  | Uint8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

/** 每个样点占几个字节。决定裸二进制怎么切、怎么写回去。 */
export const BYTES_PER_SAMPLE: Readonly<Record<PixelType, number>> = Object.freeze({
  Byte: 1,
  UInt16: 2,
  Int16: 2,
  UInt32: 4,
  Int32: 4,
  Float32: 4,
  Float64: 8,
});

/**
 * 每个样点的取值上限 —— **该类型能表示的最大值**。
 *
 * 整型：Byte 255、UInt16 65535、Int16 32767、UInt32 4294967295、Int32 2147483647。
 * 浮点：没有"值域上限"这种说法（3.4e38 只是类型本身的上限，不是数据的值域），
 * 这里给的是 Float32 / Float64 能表示的最大有限值。
 * 拿它当"满量程"去拉伸 32 位影像会把 3000 米的高程变成 6.4e9 ——
 * 所以 32 位与浮点的运算一律按**数据的实际值域**来（见 levels.ts）。
 */
export const MAX_SAMPLE: Readonly<Record<PixelType, number>> = Object.freeze({
  Byte: 255,
  UInt16: 65535,
  Int16: 32767,
  UInt32: 4294967295,
  Int32: 2147483647,
  Float32: 3.4028234663852886e38,
  Float64: 1.7976931348623157e308,
});

/**
 * 每个样点的取值下限 —— 该类型能表示的最小值。
 *
 * 有符号类型必须留负数：负高程（海平面以下）是合法数据，
 * 裁到 0 就是把数据改坏了（这正是本引擎要消灭的那类静默损坏）。
 */
export const MIN_SAMPLE: Readonly<Record<PixelType, number>> = Object.freeze({
  Byte: 0,
  UInt16: 0,
  Int16: -32768,
  UInt32: 0,
  Int32: -2147483648,
  Float32: -3.4028234663852886e38,
  Float64: -1.7976931348623157e308,
});

/**
 * 这个类型是不是浮点。
 *
 * 差别不只是"有小数"：浮点**不能取整**（高程的小数位是数据），
 * 而且**没有固定值域**（不能拿类型的上限当满量程用）。
 */
export function isFloatingPoint(type: PixelType): boolean {
  return type === 'Float32' || type === 'Float64';
}

/** 按类型开一条空带。 */
export function newBand(type: PixelType, length: number): PixelBand {
  switch (type) {
    case 'UInt16':
      return new Uint16Array(length);
    case 'Int16':
      return new Int16Array(length);
    case 'UInt32':
      return new Uint32Array(length);
    case 'Int32':
      return new Int32Array(length);
    case 'Float32':
      return new Float32Array(length);
    case 'Float64':
      return new Float64Array(length);
    default:
      return new Uint8Array(length);
  }
}

/**
 * 读一个样点。
 *
 * 各种数组下标取值都得到 number，所以不必分支；
 * 越界读返回 0 而不是 undefined —— 让上层算法不必到处判空。
 */
export function readSample(band: PixelBand, i: number): number {
  return band[i] ?? 0;
}

/**
 * 写一个样点：先按类型钳位，再落盘。
 *
 * ⚠️ 带自身的类型必须与声明的类型一致：
 * 把 3000 塞进 8 位带会**回绕**成 232（数据被改坏了还不吭声），
 * 把 -500（负高程）塞进无符号带会变成 4 万多。
 * 所以这里直接报错，而不是按带的宽度悄悄夹一下。
 */
export function writeSample(band: PixelBand, i: number, v: number, type: PixelType): void {
  const value = clampSample(v, type);
  switch (type) {
    case 'Byte':
      if (!(band instanceof Uint8Array)) throw bandTypeMismatch(type, band);
      band[i] = value;
      return;
    case 'UInt16':
      if (!(band instanceof Uint16Array)) throw bandTypeMismatch(type, band);
      band[i] = value;
      return;
    case 'Int16':
      if (!(band instanceof Int16Array)) throw bandTypeMismatch(type, band);
      band[i] = value;
      return;
    case 'UInt32':
      if (!(band instanceof Uint32Array)) throw bandTypeMismatch(type, band);
      band[i] = value;
      return;
    case 'Int32':
      if (!(band instanceof Int32Array)) throw bandTypeMismatch(type, band);
      band[i] = value;
      return;
    case 'Float32':
      if (!(band instanceof Float32Array)) throw bandTypeMismatch(type, band);
      band[i] = value;
      return;
    default:
      if (!(band instanceof Float64Array)) throw bandTypeMismatch(type, band);
      band[i] = value;
  }
}

/** 带类型与声明类型对不上时的报错。 */
function bandTypeMismatch(declared: PixelType, band: PixelBand): Error {
  const actual = pixelTypeOf(band);
  return new Error(
    `像素带类型与声明的类型不一致：声明 ${declared}，实际拿到的是 ${actual}。` +
      '按另一种类型写会把数值悄悄截断或回绕 —— 那正是要消灭的数据损坏，所以这里直接报错。',
  );
}

/**
 * 把一个数钳成该类型能表示的样点值。
 *
 * 整型：非有限数归零，其余四舍五入后夹进 [下限, 上限]。
 *  - 四舍五入而非截断：着色、混合这类运算会产生小数，而整型像元值只能是整数；
 *    四舍五入比截断少半分误差。
 *  - 有符号类型夹到负数区间：负高程是合法数据，裁到 0 就是改坏数据。
 * 浮点：**不取整**（高程的小数位是数据），只把非有限数归零、越界的夹回类型能表示的范围。
 */
export function clampSample(v: number, type: PixelType): number {
  if (!Number.isFinite(v)) return 0;
  if (isFloatingPoint(type)) {
    const max = MAX_SAMPLE[type];
    const min = MIN_SAMPLE[type];
    if (v > max) return max;
    if (v < min) return min;
    return v;
  }
  return Math.max(MIN_SAMPLE[type], Math.min(MAX_SAMPLE[type], Math.round(v)));
}

/**
 * 把 GDAL 报告的波段类型翻译成本引擎的像素类型。
 *
 * 认不出来的类型必须报错：Complex / CInt16 这类带如果被默默当成 8 位或 16 位处理，
 * 结果就是数据被改错了却看不出来。错误信息里带上原始类型名，方便直接定位。
 */
export function pixelTypeFromGdal(gdalType: string | undefined): PixelType {
  switch (gdalType) {
    case 'Byte':
      return 'Byte';
    case 'UInt16':
      return 'UInt16';
    case 'Int16':
      return 'Int16';
    case 'UInt32':
      return 'UInt32';
    case 'Int32':
      return 'Int32';
    case 'Float32':
      return 'Float32';
    case 'Float64':
      return 'Float64';
    default:
      throw new Error(
        `不支持的像素类型「${String(gdalType)}」：` +
          '本引擎只支持 Byte / UInt16 / Int16 / UInt32 / Int32 / Float32 / Float64 影像',
      );
  }
}

/** 从带自身认出像素类型。 */
export function pixelTypeOf(band: PixelBand): PixelType {
  if (band instanceof Uint8Array) return 'Byte';
  if (band instanceof Uint16Array) return 'UInt16';
  if (band instanceof Int16Array) return 'Int16';
  if (band instanceof Uint32Array) return 'UInt32';
  if (band instanceof Int32Array) return 'Int32';
  if (band instanceof Float32Array) return 'Float32';
  if (band instanceof Float64Array) return 'Float64';
  throw new Error('无法识别的像素带类型：既不是已知的整型带也不是浮点带');
}

/**
 * 同类型逐元素拷贝。
 *
 * `Uint8Array.from(b)` 对 16 位带是**逐元素截断**（65535 会被写成 255），
 * 对 32 位带更糟（负数直接变成天文数字）。所以必须按带自己的类型拷。
 */
export function copyBand(band: PixelBand, type: PixelType): PixelBand {
  const out = newBand(type, band.length);
  switch (type) {
    case 'UInt16':
      (out as Uint16Array).set(band as Uint16Array);
      return out;
    case 'Int16':
      (out as Int16Array).set(band as Int16Array);
      return out;
    case 'UInt32':
      (out as Uint32Array).set(band as Uint32Array);
      return out;
    case 'Int32':
      (out as Int32Array).set(band as Int32Array);
      return out;
    case 'Float32':
      (out as Float32Array).set(band as Float32Array);
      return out;
    case 'Float64':
      (out as Float64Array).set(band as Float64Array);
      return out;
    default:
      (out as Uint8Array).set(band as Uint8Array);
      return out;
  }
}

/**
 * 从裸字节流里解出一个样点。
 *
 * byteOrder 与 GDAL 的 GByteOrder 对齐：0 = 低字节在前（LSB，小端），1 = 高字节在前（MSB，大端）。
 * 字节序搞反不会报错，只会得出一个完全不同的数值，所以这里必须严格按序拼装。
 *
 * view 由调用方复用：逐像元新建 DataView 会在几千万像元的影像上把读取拖垮。
 */
export function decodeSample(
  view: DataView,
  offset: number,
  type: PixelType,
  byteOrder: number,
): number {
  // 越界读返回 0 而不是抛异常：与旧实现一致，让上层不必到处判空。
  if (offset < 0 || offset + BYTES_PER_SAMPLE[type] > view.byteLength) return 0;
  const littleEndian = byteOrder !== 1;
  switch (type) {
    case 'Byte':
      return view.getUint8(offset);
    case 'UInt16':
      return view.getUint16(offset, littleEndian);
    case 'Int16':
      return view.getInt16(offset, littleEndian);
    case 'UInt32':
      return view.getUint32(offset, littleEndian);
    case 'Int32':
      return view.getInt32(offset, littleEndian);
    case 'Float32':
      return view.getFloat32(offset, littleEndian);
    default:
      return view.getFloat64(offset, littleEndian);
  }
}
