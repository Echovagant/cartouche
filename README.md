# 图签 Cartouche · 本机运行的地图出图工具

[![CI](https://github.com/Echovagant/cartouche/actions/workflows/ci.yml/badge.svg)](https://github.com/Echovagant/cartouche/actions/workflows/ci.yml)

> 改一处标注，不必先学一整套 ArcGIS。

![图签 Cartouche](assets/landing.jpg)

**图签**是一套跑在**本机**的地图出图工具。读图、改图、**原子写回**原文件，
并在交差之前把**兼容性体检**做掉——ArcGIS 照常打开原图件。

> 这里的「图签」指地图上的**图面要素框饰**（cartouche：图名、图例、比例尺那一圈），
> 不是设计单位的资质，也不是图档签章。

## 亮点

| | |
|---|---|
| **改完不影响原文件** | 临时文件 → 校验 → 原子替换 → 自动备份。任何一步失败，原文件保持原样 |
| **写回可回退** | 每次写回都留一份带时间戳的备份，回滚是"复制回去" |
| **占用检测** | ArcGIS 打开数据时会持有句柄；占用时直接拒绝写入，不硬来 |
| **坐标系与伴随文件** | 写回的是原图件，坐标系原样保留；坐标系是内嵌还是来自伴随文件，自检报告会写明 |
| **图件与像元不出本机** | 服务只监听回环地址，图件读写都在你自己的文件夹里；模型密钥用 DPAPI 加密存在仓库之外，从不明文落盘。接上模型服务时只发图层清单（名称、字段、要素数、坐标系），发送前可预览 |
| **AI 只提议，绝不执行** | 模型的唯一产物是一份操作计划；执行永远由确定性引擎完成，且要过四道闸门。接 10 家模型服务（MiniMax 国内/国际、智谱 GLM、百炼、火山方舟、DeepSeek、Kimi、硅基流动、本机 Ollama、自定义端点） |
| **数据体检查得动脏数据** | 面自己跟自己交叠、两个图层坐标系不一致、坐标跑出该投影的范围——都查得出。**查不了的那几项会写明「没查」**，不会说成「未发现问题」 |
| **像元数值全程保真** | Int16 / Int32 / UInt32 / Float32 / Float64 读进来是什么数位，写回去就是什么数位。GDAL 老毛病里「`-ot Byte` 把 3000 米高程饱和成 255」被专门挡着 |
| **GeoPackage 也能写回** | 写回只动你指定的那一层，同一文件里其它图层要素数与列名一字不差，图层顺序也不变 |
| **空间连接跑得动大数据** | 两级网格索引（要素级 + 线段级）。4,133 个真实海岸线要素从 327 秒降到 1.4 秒；25 万点对 25 万点 33 秒出结果。与暴力扫描逐行比对，差异 0 行 |
| **不依赖商业 GIS 授权** | 引擎是纯 TypeScript + GDAL 命令行，浏览器打开即用 |

## 能改哪些格式

按「能不能写回」分开列，不含糊。写回的都是**原图件**，格式与坐标系原样保留。

| 格式 | 写回 | 说明 |
|---|---|---|
| `.tff` `.tif` | ✅ | GeoTIFF；栅格类型 Byte / UInt16 / Int16 / UInt32 / Int32 / Float32 / Float64 全保真 |
| `.shp` | ✅ | Shapefile，整套文件（.shp/.shx/.dbf/.prj/.cpg）一起写回 |
| `.geojson` | ✅ | |
| `.gpkg` | ✅ | GeoPackage；**只动指定的那一层**，其它图层与图层顺序不变 |
| `.img` `.vrt` `.asc` `.bil` `.png` | 只读 | 能打开、出图、查属性、导出；写回统一产出 GeoTIFF，所以工具会明确拒绝而不是把文件改坏 |
| `.gdb` `.kml` `.gml` | 只读 | 同上；矢量编辑请先另存成 `.shp` / `.geojson` / `.gpkg` |

矢量编辑已实现的操作：重投影、改字段名、**字符编码转换**（GBK/UTF-8）、加字段、
按位置连接、改属性、删要素、按条件汇总。

> 「值重编码」（把 A/B/C 这类**取值**改成 1/2/3）还没做。
> `vector.recode` 是**字符编码**转换，两回事，别混。

## 界面

**出图工作台** —— 栅格与矢量叠在图框中；图名、操作人、图例、比例尺、出图时间都在图面上。

![出图工作台](assets/canvas.jpg)

**改之前先自检** —— 文件格式、坐标系、几何有效性、伴随文件是否齐全、编码、拓扑、变化检测。
**缺什么、会出什么问题、怎么改**，逐条写清。

![兼容性自检报告](assets/report.jpg)

**项目化：源数据原地** —— 把你放图件的文件夹登记进来，工具在**旁边**建一个 `.cartouche/`
放清单、产出物与留痕，**你的图件一个字节都不会被搬动或改写**。

![项目列表](assets/projects.jpg)

## 快速开始

### 不想装环境？用绿色便携包

包里带齐了 Node 与 GDAL，**解压双击就能用**，什么都不用装：

```bash
npm run pack:release        # 产出 release/cartouche-portable-0.1.0.zip（约 99 MB）
# 解压 → 双击 START.cmd
# 浏览器自动打开画布；首次启动会播一份示例数据（40 个文件，
# Natural Earth 公共领域数据，中文文件夹名）
```

- 工作区固定在 `%LOCALAPPDATA%\cartouche\workspace`，**删掉便携包不丢图件**
- 启动器会打印工作区位置、示例数据位置与备份方法
- 便携包里也有 `scripts\set-key.ps1`：DPAPI 密文存密钥，与源码跑法同一套

### 从源码跑

**前置**：Node.js ≥ 22、GDAL 命令行（Windows 上推荐 conda-forge 发行版）。

```bash
# 装 GDAL（仅 conda-forge 通道，走国内镜像）
powershell -ExecutionPolicy Bypass -File scripts/setup-conda-gdal.ps1

# 环境自检：Node / GDAL / 驱动覆盖 / 就绪度
npm run doctor
```

拉公开样本、起引擎、出图：

```bash
npm run samples        # 拉公开样本（21 个，含多格式/多坐标系/大体量）
npm run samples:seed   # 播种进工作区
npm run dev:server     # 起引擎（另开一个终端）

npm run build:web
npm run serve:web      # http://127.0.0.1:8080/canvas.html
```

画布是**静态导出**的纯前端页面，**必须用 http 打开**——Chrome 禁止从 `file://` 构造 Web Worker，
MapLibre 起不来，地图会一片空白。

### 密钥怎么放

**先说一句：用不用 AI，都不影响其它功能。** 改图、出图排版、交差用的 PDF 与报告、
矢量编辑与属性查询，全是本机确定性功能，**不需要任何密钥**。密钥只有「用一句话改图」这条
AI 路径要。

**API Key 不进 GitHub，也不以明文保存。** 磁盘上只允许出现 DPAPI 密文。两种拿法：

**① 只想试试（推荐给普通用户）**——打开 AI 接入页，把密钥粘进去。
它只驻留引擎内存，引擎一关就没了，不写任何文件、不用命令行。

**② 想跨重启保留（开发者 / 天天用）**——写一份本机 DPAPI 密文：

```powershell
# 交互输入 → DPAPI 加密 → 存到 %LOCALAPPDATA%\cartouche\llm-key.txt（仓库之外）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-key.ps1
```

密文绑定当前 Windows 用户，别的账号、别的机器都解不开。
**注意**：引擎是从环境变量读密钥的，所以要用配套的启动脚本把它注入进去：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-engine.ps1
```

直接 `npm run dev:server` 的话引擎读不到密钥（AI 页会显示"还没配置密钥"）。

状态接口只返回"配没配 / 从哪来"，**永不返回 Key 本身**；所有错误路径都会先抹掉密钥再回话。

### 你的数据会不会被发出去

**图件本体一个字节都不上传**：引擎只监听回环地址，只读你自己电脑上的文件夹。

用 AI 那条路径时，发给模型的是一份**白名单切片**——项目名、图层名与字段名、要素数量、
坐标系标识、你视窗内最多 200 个要素的简化坐标与关键属性值、以及你写的那句话。
绝对路径、用户名、机器信息都不发。发出去的原文在 AI 接入页上可以**逐字预览**
（"看看会发送什么"）。白名单的口径见 `server/src/llm-plan.ts` 顶部注释。

## 技术栈

| 层 | 选型 |
|---|---|
| 引擎 | TypeScript（Node 原生类型剥离）+ GDAL 3.13 命令行，零运行时二进制依赖 |
| 服务 | Node HTTP，只监听回环地址 |
| 前端 | Next.js 静态导出 + React + MapLibre GL JS + Tailwind CSS |
| 出图 | 栅格底图 PNG + Canvas 合成图面要素 → PDF |
| 测试 | `node:test`，955 个用例；CI 跑在 ubuntu-latest（十二道门禁） |

## 开发

```bash
npm run test:ci          # 单元测试（串行）
npm run check:schema     # 操作计划契约自检
npm run check:bench      # 基准集自检（AI 用例）
npm run check:licenses   # 依赖许可门禁
npm run check:secrets    # 密钥扫描门禁
npm run scan:encoding    # 编码污染扫描
npm run smoke:engine     # 引擎服务冒烟测试
```

### 真实数据评测

`scripts/eval-samples.mjs` 把 22 个 op 在**公开真实数据**与**合成刁难数据**上真跑一遍，
结论分三档：`PASS`（成功且可验证）、`REJECT`（引擎明确拒绝 —— **正确行为**）、
`CRASH`（崩了 / 静默失败 / 改坏源数据 —— 这才是要修的）。

```bash
npm run samples            # 21 个公开样本（多格式 / 多坐标系 / 多体量）
npm run samples:eval       # 跑评测，产出 samples/report.json 与 samples/op-eval.json
node scripts/eval-samples.mjs --only <样本 id>   # 只跑一个
```

「刁难」数据集（中文与空格路径、缺 .prj、脏拓扑、空图层、混合坐标系、
25 万要素、退化几何、极端坐标值、多部件、大栅格、怪坐标系栅格）由
`make-hard-cases.mjs` 生成，**每次跑完核对源文件校验和**——
写坏源数据是最严重的一种失败，评测必须能发现。

> 测试与评测的临时目录：设 `CARTOUCHE_TEST_TMP` / `CARTOUCHE_EXT_SAMPLES` /
> `CARTOUCHE_HARDCASES` 可以把它们挪到别的盘（默认在系统临时目录）。
> **指向的目录要先存在** —— 目录不存在时，测试会以 `ENOENT: mkdtemp` 收场，
> 看起来像代码坏了，其实是目录没建。

## 许可

[Apache-2.0](LICENSE)。本项目不包含、不分发任何 Esri 专有软件或数据；ArcGIS 是 Esri 的注册商标。
第三方组件许可见 [NOTICE](NOTICE)。
