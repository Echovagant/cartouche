/**
 * 几何错误。
 *
 * 为什么单独成类：上层（空间连接、op 执行器）需要区分「几何坏了」和
 * 「算出来不相交」。前者必须中止并把原因带给用户，后者是正常结论。
 * 混在普通 Error 里就只能靠字符串匹配，脆。
 */
export class GeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeometryError';
  }
}
