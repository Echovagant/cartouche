/**
 * 像素带的类型抽象：像素可以是 8 位无符号（Byte），也可以是 16 位无符号（UInt16）。
 *
 * 为什么需要这一层：
 * 引擎原先把像素写死成 8 位，读取时靠 `gdal_translate -ot Byte` 把影像转成 8 位。
 * 但 `-ot Byte` 对 16 位源是**静默饱和**：65535 被压成 255，退出码仍是 0、stderr 也是空的
 * （实测 GDAL 3.13.3）。也就是说数据被改坏了，却没有任何报错提示。
 * 大影像大量使用 UInt16（高程、DN、反射率），这种损失是实打实的。
 * 所以像素带必须自己记住"我是哪种类型"，读写两端才能对上口径，而不是靠下游猜。
 *
 * 为什么 8 位不统一升成 16 位：
 * 8 位影像占绝大多数，统一升位会让内存占用直接翻倍，却换不来任何精度收益；
 * 而且升位会改变现有链路的数值范围，掩膜/混合/修补/色阶的结果都会跟着变。
 * 保持"按源类型走"：8 位链路零变化，16 位链路才走新口径。
 */

/** 本引擎支持的像素类型。刻意只收无符号：负数像元在地理影像里没有语义。 */
export type PixelType = 'Byte' | 'UInt16';

/** 一条像素带：数组本身即类型标签，8 位与 16 位不会混。 */
export type PixelBand = Uint8Array | Uint16Array;

/** 每个样点占几个字节。决定裸二进制怎么切、怎么写回去。 */
export const BYTES_PER_SAMPLE: Readonly<Record<PixelType, number>> = Object.freeze({
  Byte: 1,
  UInt16: 2,
});

/** 每个样点的取值上限。写样点时超出上限就是数据错了，必须钳住而不是回绕。 */
export const MAX_SAMPLE: Readonly<Record<PixelType, number>> = Object.freeze({
  Byte: 255,
  UInt16: 65535,
});

/** 按类型开一条空带。 */
export function newBand(type: PixelType, length: number): PixelBand {
  return type === 'UInt16' ? new Uint16Array(length) : new Uint8Array(length);
}

/**
 * 读一个样点。
 *
 * 两种数组下标取值都得到 number，所以不必分支；
 * 越界读返回 0 而不是 undefined —— 让上层算法不必到处判空。
 */
export function readSample(band: PixelBand, i: number): number {
  return band[i] ?? 0;
}

/**
 * 写一个样点：先按类型钳位并取整，再落盘。
 *
 * 落盘时还要受**带自身**的宽度约束：把 65535 塞进 8 位带会回绕成 255，
 * 那是把数值改坏了还不吭声，宁可钳到 255 也要保持"值在带里始终成立"。
 */
export function writeSample(band: PixelBand, i: number, v: number, type: PixelType): void {
  const value = clampSample(v, type);
  if (band instanceof Uint16Array) {
    band[i] = Math.min(value, MAX_SAMPLE.UInt16);
  } else {
    band[i] = Math.min(value, MAX_SAMPLE.Byte);
  }
}

/**
 * 把一个数钳成该类型能表示的样点值：非有限数归零，其余取整后夹进 [0, 上限]。
 *
 * 取整而非截断：着色、混合这类运算会产生小数，而像元值只能是整数；
 * 四舍五入比截断少半分误差。
 */
export function clampSample(v: number, type: PixelType): number {
  if (!Number.isFinite(v)) return 0;
  const max = MAX_SAMPLE[type];
  return Math.max(0, Math.min(max, Math.round(v)));
}

/**
 * 把 GDAL 报告的波段类型翻译成本引擎的像素类型。
 *
 * 认不出来的类型必须报错：Int16 / Float32 这类带如果被默默当成 8 位或 16 位处理，
 * 结果就是数据被改错了却看不出来。错误信息里带上原始类型名，方便直接定位。
 */
export function pixelTypeFromGdal(gdalType: string | undefined): PixelType {
  if (gdalType === 'Byte') return 'Byte';
  if (gdalType === 'UInt16') return 'UInt16';
  throw new Error(
    `不支持的像素类型「${String(gdalType)}」：本引擎只支持 8 位无符号（Byte）与 16 位无符号（UInt16）影像`,
  );
}

/** 从带自身认出像素类型。 */
export function pixelTypeOf(band: PixelBand): PixelType {
  return band instanceof Uint16Array ? 'UInt16' : 'Byte';
}

/**
 * 从裸字节流里解出一个样点。
 *
 * byteOrder 与 GDAL 的 GByteOrder 对齐：0 = 低字节在前（LSB，小端），1 = 高字节在前（MSB，大端）。
 * 字节序搞反不会报错，只会得出一个完全不同的数值，所以这里必须严格按序拼装。
 */
export function decodeSample(
  bytes: Uint8Array,
  offset: number,
  bytesPerSample: number,
  byteOrder: number,
): number {
  if (bytesPerSample === 1) return bytes[offset] ?? 0;
  if (bytesPerSample !== 2) {
    throw new Error(
      `不支持的样点字节数 ${bytesPerSample}：本引擎只支持 8 位无符号（Byte）与 16 位无符号（UInt16）影像`,
    );
  }
  const first = bytes[offset] ?? 0;
  const second = bytes[offset + 1] ?? 0;
  // 高字节在前：第一个字节就是高位；低字节在前：高位在第二个字节。
  return byteOrder === 1 ? (first << 8) | second : (second << 8) | first;
}
