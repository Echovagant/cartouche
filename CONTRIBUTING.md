# 参与图签 Cartouche

图签是一套跑在本机的地图出图工具：读图、改图、原子写回原文件，出图之前把兼容性体检做掉。
**图件与像元不出本机**，密钥用 DPAPI 加密存在仓库之外，不依赖商业 GIS 授权。

> 这里的「图签」指地图上的**图面要素框饰**（cartouche：图名、图例、比例尺那一圈），
> 不是设计单位的资质。

## 先跑起来

```bash
npm install
npm run doctor      # 环境自检：Node / GDAL / 驱动覆盖
npm run fixture     # 生成样本
npm run dev:server  # 终端 1：起引擎
npm run serve:web   # 终端 2：开画布
```

画布**必须用 http 打开**（`http://127.0.0.1:8080/canvas.html`）——
Chrome 禁止从 `file://` 构造 Web Worker，地图会起不来。

Windows 上装 GDAL：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-conda-gdal.ps1
```

## 环境要求

| | |
|---|---|
| Node.js | ≥ 22 |
| GDAL 命令行 | 3.13（Windows 推荐 conda-forge 发行版） |
| 密钥存储 | DPAPI（仅 Windows）；macOS / Linux 请用环境变量注入 |

## 提交之前

```bash
npm run typecheck
npm run test:ci
npm run check:schema     # 操作计划契约
npm run check:bench      # 基准集结构
npm run check:licenses   # 依赖许可门禁
npm run check:secrets    # 密钥扫描
npm run scan:encoding    # 编码污染扫描
npm run smoke:engine     # 引擎服务冒烟
```

**全绿才能提 PR。**

## 提交规范

- 提交信息用中文，格式 `type(scope): 摘要`（如 `fix(raster): 写回按类型落 ENVI`）
- **不加** `Co-Authored-By` 之类的生成器 trailer
- 一个提交只做一件事；不要把别人的在制品一起提交
- 注释写**为什么**，不写「改成了什么」

## 几条硬规矩

1. **不静默失败**：类型不支持、网格不对齐、磁盘不够、合成失败 —— 一律抛带原因的错误，
   不许默默降级、不许悄悄截断数据。
2. **原文件只在用户明确确认后才动**：写回走「临时文件 → 校验 → 原子替换 → 自动备份」，
   任何一步失败原文件保持原样。
3. **不包含、不分发任何 Esri 专有软件或数据**；ArcGIS 是 Esri 的注册商标。
4. **引用的第三方数据要有明确的开放许可**，付费数据集与来源不明的镜像一律不用。

## 想要什么功能

先开 issue 说清「在什么情况下我希望能做什么」，比直接改代码更容易被接受。
环境类问题请贴 `npm run doctor` 的完整输出。
