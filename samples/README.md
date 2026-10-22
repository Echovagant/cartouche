# 公开真实数据样本

本目录放**公开、免费、免登录**的真实地理数据，用来压测引擎能力、量出"实现程度"。

> **数据不进仓库**（`.gitignore` 已排除 `samples/*`，只保留 `manifest.json`）。
> 需要时跑 `npm run samples` 拉取，`npm run samples:eval` 实测。

## 选源三条原则

1. **免登录可直连**——不能要求注册、实名、审批
2. **许可允许商用**——不能用非商业许可的数据做基准
3. **能压到已知薄弱点**——非 Byte 类型、缺 CRS、nodata、超大、超多字段、中文字段

## 样本清单（9 个：7 个公开真实 + 2 个合成怪癖）

| ID | 类型 | 来源 | 许可 | 主要考察点 |
|---|---|---|---|---|
| `naturalearth-admin0` | 矢量 | Natural Earth 110m 国界 | 公共领域 | **168 个字段**、复杂多边形、UTF-8 + .cpg、.prj 正常 |
| `naturalearth-rivers` | 矢量 | Natural Earth 10m 河流湖泊 | 公共领域 | 线+面混合、极细长多段线、38 字段 |
| `datav-china-provinces` | 矢量 | 阿里云 DataV.GeoAtlas | 公开接口 | **中文字段名**、GeoJSON 无显式 CRS |
| `gadm-china-l1` | 矢量 | GADM 4.1 中国一级行政区 | 自由使用（非商业） | 与 DataV 版本**交叉验证**边界、**GCJ-02 陷阱** |
| `naturalearth-ne1-raster` | 栅格 | Natural Earth 10m shaded relief | 公共领域 | 真实世界 21600×10800×3（约 700 MB）、CRS 内嵌、.tfw 世界文件 |
| `sentinel2-l3-b04` | 栅格(远程) | Copernicus Sentinel-2 L3 季度无云镶嵌 | Copernicus 条款（可商用） | **int16**、缩放因子 0.0001 未写入、nodata=-32768、10008²、COG 范围读 |
| `ftw-field-2024` | 栅格(远程) | Fields of the World 2e | CC-BY-4.0 | 双波段概率、2.5 m、40032²（约 3 GB） |
| `gbk-shapefile` | 矢量(合成) | `npm run fixture` 生成 | 项目自造 | **DBF 是 GBK** → 触发 **V-ENC-002** |
| `chinese-filename-shp` | 矢量(合成) | `npm run fixture` 生成 | 项目自造 | **文件名本身是中文** → 路径、.prj 关联、备份名都不能因此出错 |

## 远程 COG 怎么用的

Sentinel-2 与 FTW 都是 **Cloud Optimized GeoTIFF**，不整文件下载，而是用 GDAL 的 `/vsicurl/`
走 HTTP 范围读：

```
/vsicurl/https://data.source.coop/tge-labs/sentinel-2-quarterly-cloudless-mosaics/2024/Q2/31UFU_0_0/B04.tif
```

官方 README 就给了这个用法（`gdal_translate -srcwin ... /vsicurl/...`），直接沿用。

## 怎么用

```bash
npm run samples            # 拉取缺失的样本（已存在则跳过）
npm run samples -- --all   # 强制重下
npm run samples:eval       # 跑体检 + 像素 + 往返，产出 samples/report.json
npm run samples:eval -- --only sentinel2-l3-b04
```

`report.json` 保留了每个样本的完整探查结果（driver / CRS / 字段数 / 阻断项 / 校验和），
可直接作为"实现程度"的基线快照。
