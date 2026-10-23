/**
 * 矢量 op 共用的参数读取。
 *
 * 为什么单独一个文件：重投影、重命名字段、重编码这三个 op 都要读字符串、
 * 读对照表、还要处理"同一个意思的两种写法"。
 * 各写一遍就会出现"这几个 op 对同一个参数的理解不一样"——
 * 而参数理解不一致是最难查的一类缺陷（契约说必填，引擎说可以不填，
 * 或者一个 op 按字符串比、另一个 op 按数值比）。
 */

/** 读一个非空字符串参数；不给或给空串都算没给。 */
export function readStringParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * 读一个数值参数；不给或不是有限数字都算没给。
 *
 * ⚠️ 这个函数分不出"没给"与"给了但类型不对"（两者都是 undefined）。
 * 要区分的调用方先看 params[key] 是不是 undefined，再调这个 ——
 * "没给"走默认值，"给错了"必须报错（否则 0 会被当成一个合法的阈值，
 * 把"转换残差上限"悄悄变成 0）。
 */
export function readNumberParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * 读一个对象参数（对照表）。
 *
 * 形状不对要当场报错：把数组或字符串当对照表传进来，
 * 静默当成空表处理等于"什么也没改还报成功"。
 */
export function readObjectParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`参数 ${key} 必须是一个对象（形如 {"旧名": "新名"}）`);
  }
  return v as Record<string, unknown>;
}

/**
 * 读"同一个意思的两种写法"里给了的那个。
 *
 * 为什么允许别名：同一个 op 的参数名在契约、模板与基准集里可能不一样
 * （字段重命名的对照表既叫 renames 也叫 mapping）。
 * 引擎认两种写法，就不用为了统一名字去改别人的文件；
 * 但**只给一个**才合法 —— 两个都给时说不清用户到底要哪个，必须报错。
 */
export function readAliasObjectParam(
  params: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): { readonly key: string; readonly value: Record<string, unknown> } | undefined {
  const given = keys.filter((k) => params[k] !== undefined && params[k] !== null);
  if (given.length > 1) {
    throw new Error(
      `参数 ${keys.join(' 与 ')} 只能给一个（它们是同一个意思的两种写法）：实为 ${given.join('、')}`,
    );
  }
  const key = given[0];
  if (key === undefined) return undefined;
  return { key, value: readObjectParam(params, key)! };
}
