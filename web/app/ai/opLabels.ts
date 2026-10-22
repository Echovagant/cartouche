/**
 * op 的中文名。
 *
 * 与引擎调度器（`src/engine/ops/executor.ts`）里的说法保持一致 ——
 * 界面上写"涂色"、引擎报告里写"涂色"，用户不用在两套词之间来回换算。
 */
const OP_LABELS: Readonly<Record<string, string>> = {
  'raster.paint': '涂色',
  'raster.erase': '擦除',
  'raster.replaceRegion': '区域替换',
  'raster.inpaint': '边界修补',
  'raster.adjustLevels': '亮度对比度调整',
  'raster.clip': '裁切',
  'raster.resample': '重采样',
  'raster.mosaic': '拼接',
  'dataset.open': '打开数据集',
  'dataset.healthCheck': '数据体检',
  'dataset.snapshot': '快照',
  'feature.setAttributes': '批量改属性',
  'feature.delete': '删除要素',
  'feature.editGeometry': '编辑几何',
  'feature.create': '新建要素',
  'feature.summarize': '汇总统计',
  'vector.repairGeometry': '修复几何',
  'vector.renameFields': '重命名字段',
  'vector.recode': '重编码',
  'vector.reproject': '重投影',
  'vector.overlay': '叠加分析',
  'export.image': '导出图片',
  'export.report': '导出报告',
};

/** op 名 → 中文名；认不出来就原样返回 op 名 */
export function opLabel(op: string): string {
  return OP_LABELS[op] ?? op;
}
