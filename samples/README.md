# 公开真实数据样本

本目录放**公开、免费、免登录**的真实地理数据，用来压测引擎能力、量出"实现程度"。

> **数据不进仓库**（`.gitignore` 已排除 `samples/*`，只保留 `manifest.json`）。
> 需要时跑 `npm run samples` 拉取，`npm run samples:eval` 实测。

## 选源三条原则

1. **免登录可直连**——不能要求注册、实名、审批（政务内网用户同理）
2. **许可允许商用**——我们要做商业版，不能用非商业许可的数据做基准
3. **能触发已知薄弱点**——非 Byte 类型、缺 CRS、nodata、超大、超多字段、中文字段

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

Sentinel-2 与 FTW 都是 **Cloud Optimized GeoTIFF**，我们**不整文件下载**，而是用 GDAL 的 `/vsicurl/` 走 HTTP 范围读：

```
/vsicurl/https://data.source.coop/tge-labs/sentinel-2-quarterly-cloudless-mosaics/2024/Q2/31UFU_0_0/B04.tif
```

官方 README 就给了这个用法（`gdal_translate -srcwin ... /vsicurl/...`），我们直接沿用。

## 实测结论（2026-10-21）

`npm run samples:eval` 的结果（**7 个公开样本全部 `open=PASS` + `health=PASS`**，2 个合成样本一并覆盖）：

| 样本 | open | health | 关键发现 |
|---|---|---|---|
| naturalearth-admin0 | ✅ | ✅ | 177 要素 / **168 字段**，体检无阻断 |
| datav-china-provinces | ✅ | ✅ | 35 要素 / 10 字段，中文字段名正常 |
| gadm-china-l1 | ✅ | ✅ | 37 要素 / 11 字段 |
| naturalearth-rivers | ✅ | ✅ | 1473 要素 / 38 字段，线面混合 |
| naturalearth-ne1-raster | ✅ | ✅ | 700 MB / 3 波段；**CRS 是内嵌的**，同名 .prj 只是冗余副本 |
| sentinel2-l3-b04 | ✅ | ✅ | ⚠️ **类型降级：Int16 → Byte，物理量纲不可恢复** |
| ftw-field-2024 | ✅ | ✅ | 双波段 UInt8，类型无损失；3 GB 体量 |
| gbk-shapefile | ✅ | ✅ | 编码识别为 GBK → **触发 V-ENC-002**（转 UTF-8 交差会丢生僻字） |
| chinese-filename-shp | ✅ | ✅ | 中文文件名下 .prj 仍被正确读取 |

### 三个有价值的发现

**① 真实数据的"能打开 + 能体检"已经过关。** 7 个样本全部 open=PASS、health=PASS，
包括 168 字段的复杂矢量、700 MB 的三波段栅格、3 GB 的双波段 COG、远程范围读。

**② 找到一个真实的数据保真缺陷：Int16 被静默降级成 Byte。**
`readRasterPixels` 内部固定用 `gdal_translate -ot Byte`，
于是 Sentinel-2 的 int16 反射率（0~10000，缩放因子 0.0001 **未写入文件**）被压成 8 位，
**物理量纲不可恢复**。对"改图交差"这类场景这是**不可见的错误**——
用户看不出区别，但反射率已经废了。
→ 已记为 P5（gap 用例）+ 需要在引擎里支持非 Byte 类型与缩放因子。

**③ "以 GDAL 实际解析结果为准"这条设计原则被真实数据验证了。**
Natural Earth 的 NE1 栅格旁边有 `.prj`，一开始我们以为会触发 R-CRS-001 阻断；
实测发现它的 CRS **内嵌在 GeoTIFF 里**（`gdalinfo` 的 `Files:` 段只列了 .tif），
旁边的 `.prj` 只是 Esri 习惯留下的冗余副本 → **不触发阻断是正确的**。
反过来，合成样本里的 `.tff + .tfw + .prj` 组合才真的触发（GTiff 不读同名 .prj）。
这正是 M0' 那条结论的实战复核。

## 已知盲区

- **GCJ-02 / WGS84 / CGCS2000 混用**（用例 P13）：两个文件都写 EPSG:4326，
  但其中一个其实是 GCJ-02，元数据不会告诉你，**面积会系统性偏大 0.1%~0.5%**。
  我们的体检规则**识别不了**，目前只能靠用户常识判断。
- **超大栅格的像素级操作**：超过 400 万像元的样本，本次只验了"能打开、能体检"，
  **没有做像素级往返**（内存预算限制）。窗口化编辑（T26）尚未实现。
- **非 Byte 类型**：见发现 ②。

## 怎么用

```bash
npm run samples            # 拉取缺失的样本（已存在则跳过）
npm run samples -- --all   # 强制重下
npm run samples:eval       # 跑体检 + 像素 + 往返，产出 samples/report.json
npm run samples:eval -- --only sentinel2-l3-b04
```

`report.json` 保留了每个样本的完整探查结果（driver / CRS / 字段数 / 阻断项 / 校验和），
可直接作为"实现程度"的基线快照。
