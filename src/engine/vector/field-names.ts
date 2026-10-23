/**
 * 字段名的闸门，以及"写回之后这一列到底叫什么"的查找。
 *
 * 为什么单独一个文件：字段重命名与计算字段两个 op 都要回答同一个问题 ——
 * "我要求的这一列，写进文件之后实际叫什么"。答案取决于 GDAL 的改名规则
 * （超长会被截断、大小写可能被改），两处各猜一次就会出现两个答案。
 */
import { VectorError } from './types.ts';

/**
 * 字段名的合法性闸门。
 *
 * 只拦三件事（都是会**毁掉数据**或**毁掉路径**的）：
 *  - 空串：空列名在 DBF 里没法表示；
 *  - 路径分隔符：列名会被写进 .dbf 的头与用户给的路径上下文，
 *    带分隔符的列名容易在别的工具里被当成路径的一部分；
 *  - 控制字符（含换行、回车、制表符）：DBF 的字段名是定长文本，
 *    换行会把属性表结构本身弄坏。
 *
 * 为什么不拦"太长"：Shapefile 的 10 字节限制是 GDAL 的行为，
 * 拦下来等于替用户做决定；这里让它截断，然后**如实报出实际叫什么**。
 */
export function assertValidFieldName(name: string): void {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new VectorError(`列名不能为空`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new VectorError(`列名里不能有控制字符（换行、制表符等）：${JSON.stringify(name)}`);
  }
  if (/[\\/]/.test(name)) {
    throw new VectorError(`列名里不能有路径分隔符（/ 或 \\）：${JSON.stringify(name)}`);
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new VectorError(`列名不能是 ${trimmed}`);
  }
}

/**
 * 在写好的文件里找到这一列。
 *
 * Shapefile 的列名会被截断（超过 10 个字节的部分没了），也可能被改了大小写。
 * 找不到就当写坏了 —— 这一列不存在，用户后面按它查就是查不到。
 *
 * ⚠️ **截断是按字节切的**，所以中文列名会被切在半个字上：
 * "更新编号"（12 字节）写成 "更新编" + 半个 "编"，
 * 那个半个字解出来是一个替换字符（U+FFFD）。
 * 所以前缀比对要**先把替换字符去掉**再比 —— 否则 "更新编" 与 "更新编号"
 * 在字符层面一个前缀关系都不是，而它们确实是同一列。
 */
export function findWrittenField(
  written: readonly string[],
  requested: string,
): string | null {
  const exact = written.find((n) => n === requested);
  if (exact) return exact;
  const lower = written.find((n) => n.toLowerCase() === requested.toLowerCase());
  if (lower) return lower;
  // 截断：写进去的是请求名的前缀（去掉被切坏的半个字符再比）
  const prefix = written.find((n) => {
    const cleaned = n.replace(/\uFFFD/g, '');
    return cleaned !== '' && requested.toLowerCase().startsWith(cleaned.toLowerCase());
  });
  if (prefix) return prefix;
  return null;
}

/**
 * 把解码出来的替换字符显示成 '?'。
 *
 * 为什么这么显示：GDAL 自己的告警也是这么写的
 * （"Normalized/laundered field name: '更新编号' to '更新编?'"），
 * 用户在别处看到的是一样的写法，才认得出这是同一个名字。
 */
export function displayFieldName(name: string): string {
  return name.replace(/\uFFFD/g, '?');
}

/**
 * 两个属性值算不算一样。
 *
 * 为什么数字要留一点余量：Shapefile 的整数列会把小数四舍五入，
 * 读回来是 100 而原值是 100.4 —— 这是格式本身的限制，不是数据被改了，
 * 算成"不一样"会误报。
 */
export function valuesMatch(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined || b === '';
  if (b === null || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return true;
    return Math.abs(a - b) < 1e-9 || Math.round(a) === b || Math.round(b) === a;
  }
  return String(a) === String(b);
}
