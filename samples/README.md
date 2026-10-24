# 公开真实数据样本

本目录放**公开、免费、免登录**的真实地理数据，用来压测引擎能力、量出"实现程度"。

> **数据不进仓库**（`.gitignore` 已排除 `samples/*`，只保留 `manifest.json` 与本文件）。
> 需要时跑 `npm run samples` 拉取，`npm run samples:eval` 实测。

## 选源三条原则

1. **免登录可直连**——不能要求注册、实名、审批
2. **许可允许商用**——不能用非商业许可的数据做基准
3. **能压到已知薄弱点**——非 Byte 类型、缺 CRS、nodata、超大、超多字段、中文字段

## 数据放在哪（`baseDir`）

manifest 里每个样本都带一个 `baseDir`，只有两个取值：

| `baseDir` | 落位 | 说明 |
|---|---|---|
| `samples` | 仓库内的 `samples/` | 已被 `.gitignore` 排除，克隆后不会入库 |
| `ext` | **扩展样本目录** | 仓库外；位置由环境变量 `CARTOUCHE_EXT_SAMPLES` 决定，每个样本一个同名子目录（manifest 里的路径以 `<id>/` 开头） |

判据是**解压后的实际占用**：30 MB 以内放 `samples/`，超过就放扩展样本目录。
只看压缩包大小会低估——一个 3 MB 的 zip 解开有 50 MB，系统盘照样被撑爆。

扩展样本目录默认落在**用户主目录**下的 `cartouche-samples`（换盘只要改环境变量，不设也行）：

```powershell
$env:CARTOUCHE_EXT_SAMPLES = '<另一块盘上的目录>/map-samples'
```

manifest 里只写逻辑名，**不写任何本机绝对路径**——换机器、换用户只改这个环境变量。

派生样本（`derive`）跟源样本同处一个目录：VRT 里存的是**相对路径**，
源文件挪了位置，索引就指向空气。

## 样本清单（21 个）

`派生` = 数据本身来自公共源，派生只换容器或换坐标系（换格式/转投影/抽稀），步骤写在 manifest 的 `derive` 里。

| ID | 类型 | 来源 | 落位 | 主要考察点 |
|---|---|---|---|---|
| `naturalearth-admin0` | 矢量 | Natural Earth 110m 国界 | samples | **168 个字段**、复杂多边形、UTF-8 + .cpg、.prj 正常 |
| `naturalearth-rivers` | 矢量 | Natural Earth 10m 河流湖泊 | samples | 线+面混合、极细长多段线、38 字段 |
| `naturalearth-lakes` | 矢量 | Natural Earth 10m 湖泊 | samples | **Polygon 与 MultiPolygon 混层**、**231 个内环 / 80 个带洞要素**、ESRI 旧式 .prj |
| `naturalearth-coastline` | 矢量 | Natural Earth 10m 海岸线 | samples | 4000+ 条碎线、只有 3 个字段（重几何轻属性） |
| `datav-china-provinces` | 矢量 | 阿里云 DataV.GeoAtlas | samples | **中文字段名**、GeoJSON 无显式 CRS |
| `gadm-china-l1` | 矢量 | GADM 4.1 中国一级行政区 | samples | 与 DataV 版本**交叉验证**边界、**GCJ-02 陷阱** |
| `gadm-china-kmz` | 矢量 | GADM 4.1（KMZ） | samples | **KMZ = zip 包的 KML**、gdalinfo 打不开而 ogrinfo 能开、37 个要素拆出 2143 个面 |
| `gadm-china-gpkg` | 矢量·派生 | GADM 4.1 → GeoPackage | samples | **GPKG 就是 SQLite**、几何列存 WKB |
| `gadm-china-gauss-kruger` | 矢量·派生 | GADM 4.1 → CGCS2000 高斯-吕格 | ext | **EPSG:4547**、国产软件写的旧式 .prj、DBF 中文掉码 |
| `flatgeobuf-lakes` | 矢量·派生 | Natural Earth 湖泊 → FlatGeobuf | samples | **一层只能一种几何类型**、几何列是 WKB |
| `srtm-points-csv` | 矢量·派生 | SRTM 高程 → CSV | samples | **几何写在 WKT 列里**、**带 Z 值**、CSV 无坐标系、16 万行 |
| `naturalearth-ne1-raster` | 栅格 | Natural Earth 10m shaded relief | samples | 真实世界 21600×10800×3（约 700 MB）、CRS 内嵌、.tfw 世界文件 |
| `srtm-ascii` | 栅格 | SRTM 90m 高程（AAIGrid） | ext | **纯文本网格**、6000×6000、Int32、NODATA=-9999、考古级 ESRI .prj |
| `srtm-img-hfa` | 栅格·派生 | SRTM 90m 高程 → Erdas Imagine .img | ext | **.img 是另一套二进制布局**，投影写在自己的数据字典里 |
| `srtm-webmercator-float32` | 栅格·派生 | SRTM 90m → Web Mercator | ext | **EPSG:3857**、**Float32**、纬向拉伸成 5033×6832、nodata 仍是 -9999 |
| `webmercator-png-worldfile` | 栅格·派生 | 上面那张 → PNG + 世界文件 | samples | **地理信息全在 .wld 六行数字里**，世界文件不带坐标系、32 位浮点降成 8 位 |
| `webmercator-vrt` | 栅格·派生 | 上面那张 → VRT 索引 | ext | **VRT 是 XML 壳**，数据在它指向的文件里、存的是相对路径 |
| `sentinel2-l3-b04` | 栅格(远程) | Copernicus Sentinel-2 L3 季度无云镶嵌 | 远程 | **int16**、缩放因子 0.0001 未写入、nodata=-32768、10008²、COG 范围读 |
| `ftw-field-2024` | 栅格(远程) | Fields of the World 2e | 远程 | 双波段概率、2.5 m、40032²（约 3 GB） |
| `gbk-shapefile` | 矢量(合成) | `npm run fixture` 生成 | fixtures | **DBF 是 GBK** → 触发 **V-ENC-002** |
| `chinese-filename-shp` | 矢量(合成) | `npm run fixture` 生成 | fixtures | **文件名本身是中文** → 路径、.prj 关联、备份名都不能因此出错 |

### 覆盖到哪些"甲方真实数据"的坑

- **格式**：SHP / GeoJSON / KML / KMZ / GeoPackage / FlatGeobuf / CSV（几何在 WKT 列里）/ GeoTIFF / AAIGrid / Erdas Imagine .img / PNG+世界文件 / VRT
- **坐标系**：WGS84（EPSG:4326）、Web Mercator（3857）、UTM 分带（31N，见 Sentinel-2）、CGCS2000 3 度带高斯-吕格（4547）、**完全没有坐标系**、**ESRI 旧式 .prj**
- **体量**：10 万级点要素（16 万）、6000×6000 大栅格、21600×10800 三波段、多波段、Int32、Float32、带 nodata（-9999 与 -32768 两种约定）
- **几何**：点、线、面、多几何混层、带洞多环、带 Z 值、多部件

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
npm run samples -- --dry-run   # 只打印将要下载什么，不落盘
npm run samples -- --only srtm-ascii
npm run samples:eval       # 跑体检 + 像素 + 往返，产出 samples/report.json
npm run samples:eval -- --only sentinel2-l3-b04
```

`report.json` 保留了每个样本的完整探查结果（driver / CRS / 字段数 / 阻断项 / 校验和），
可直接作为"实现程度"的基线快照。
