# 代码导览

给「第一次系统性读这个仓库的人」写的地图：每个目录负责什么、数据怎么流动、
要改某件事该去哪个文件。

想先看界面怎么用 → 看 [README](../README.md)；想直接上手 → 看 README 的「快速开始」。

---

## 一、它跑起来是什么形状

```
浏览器（画布）
   │  ① 静态页面（Next 静态导出，8080 端口）
   │  ② 所有数据请求 → 引擎 HTTP 服务（8787 端口，只监听 127.0.0.1）
   ▼
引擎（Node + TypeScript）
   │  ③ GDAL 命令行（子进程）
   ▼
用户自己的文件夹（图件原地，工具只在旁边建 .cartouche/）
```

三句话记住边界：

1. **浏览器里没有业务逻辑**——它只画界面、发请求。真正的计算都在引擎里。
2. **引擎只监听回环地址**，且只读**已登记的工作区根**（用户显式授权的目录）。
3. **图件一个字节都不出本机**，AI 那条路也只发白名单切片（见 `server/src/llm-plan.ts` 顶部注释）。

---

## 二、目录地图

| 目录 | 负责什么 | 什么时候动它 |
|---|---|---|
| `src/engine/` | **引擎核心**（跨形态复用的唯一资产）。向量/栅格读写、空间运算、体检、出图导出 | 加一种数据能力、加一个 op |
| `src/engine/ops/` | 操作（op）的契约与执行器。`ops.schema.json` 是**唯一事实源**，前端与 AI 都读它 | 加/改一个 op |
| `src/engine/vector/`、`raster/` | 各自的读写实现（写回一律原子替换 + 备份） | 改某种格式的读写细节 |
| `src/engine/health/` | 兼容性体检：元信息规则 + 逐要素规则 + `coverage`（**哪些查了、哪些没查**） | 加一条体检规则 |
| `src/engine/export/` | 出图（raster.png）、矢量转 GeoJSON、**视口金字塔**、PDF 封装 | 改导出格式 |
| `src/engine/workspace/` | 工作区抽象：文件句柄 / HTTP / 内存三种 store，项目清单读写 | 换工作区形态 |
| `src/engine/gdal/` | GDAL 定位、命令执行、错误分类、探测 | 换 GDAL 探测逻辑 |
| `server/src/` | HTTP 服务层：`app.ts` 是路由总表（**所有接口都在这一文件**），`roots.ts` 管已登记根，`settings.ts` 管机器级设置，`llm*.ts` 管模型那条路 | 加一个接口、改 CORS/权限 |
| `web/app/canvas/` | **画布工作台**（用户真正待的地方）。`CanvasWorkbench.tsx` 是状态总控 | 改工作台交互 |
| `web/app/canvas/workbench/` | 工作台外壳：活动栏、侧栏、底部面板、快速打开、设置 | 改工作台框架 |
| `web/app/page.tsx` | **官网落地页**（对外门面） | 改官网文案 |
| `web/app/motion/` | 官网的滚动编排与动效（GSAP） | 改官网动效 |
| `scripts/` | 打包、门禁、播种、引擎启动。**`pack-*.mjs` 产出发布物** | 改打包内容 |
| `test/` | `node:test` 用例。**夹具在运行时现场造**，仓库里不放二进制数据 | 加/改测试 |

---

## 三、一条数据的完整旅程

用户点「选一个文件夹」→ 选到「图件/我的项目」文件夹 → 里面有一张 `底图.tff`。

| 步 | 发生在哪 | 关键文件 |
|---|---|---|
| 弹系统选目录框 | 引擎起一个 PowerShell 子进程，用 WinForms 的文件夹对话框 | `server/src/folder-picker.ts` |
| 路径**不落到前端** | 引擎把它换成代号 `folder-3`，只把代号给浏览器 | `server/src/roots.ts`、`src/engine/workspace/file-handle-store.ts` |
| 浏览器拿到清单 | `GET /api/project/manifest` | `server/src/app.ts` |
| 读图层数据 | `GET /api/data/geojson?path=…&bbox=…` | `src/engine/export/vector-geojson.ts` |
| 出栅格底图 | `GET /api/render/raster.png?bbox=…`（**按视口取景，墨卡托**） | `src/engine/export/raster-image.ts` |
| 叠到地图上 | MapLibre 的 `image` source + 经纬度四角 | `web/app/canvas/MapCanvas.tsx` |
| 画笔画一笔 | 屏幕坐标 → 原生像元 → 一条 op | `web/app/canvas/useEditTools.ts` |
| **预演**（算影响面，不写盘） | `POST /api/op/preview` | `src/engine/ops/executor.ts` |
| 确认卡 | 把预演结果摆出来：像元数/目标文件/备份名/操作类型 | `web/app/canvas/ConfirmCard.tsx` |
| 执行 | `POST /api/op/execute` → 原子写回 + 备份 + 留痕 | `src/engine/ops/executor.ts`、`src/engine/gdal/writeback.ts` |
| 出 PDF | `POST /api/export/pdf` | `src/engine/export/pdf.ts` |

---

## 四、「我要改 X，去哪个文件」

| 想改 | 去哪 |
|---|---|
| 画布的界面、状态编排 | `web/app/canvas/CanvasWorkbench.tsx` |
| 地图上的图层、栅格底图贴图、图面要素绘制 | `web/app/canvas/MapCanvas.tsx` + `web/app/canvas/sheet.ts` |
| 出图版式（图框/图例/比例尺/标题栏） | `web/app/canvas/layout/`（版式定义）+ `sheet.ts`（画法） |
| 一个 op 的契约 | `src/engine/ops.schema.json`（**改这里，别改别处**） |
| op 的执行 | `src/engine/ops/executor.ts` |
| 加一条体检规则 | `src/engine/health/checks.ts` + `types.ts` |
| 工作区能读写哪些路径 | `src/engine/workspace/` + `server/src/roots.ts` |
| 模型那条路（计划/预演/密钥） | `server/src/llm.ts`、`server/src/llm-plan.ts` |
| 官网文案 | `web/app/page.tsx` |
| 依赖许可 / 密钥扫描 / 漏洞扫描 | `scripts/check-licenses.mjs`、`check-secrets.mjs`、`check-vulns.mjs` |
| 发布物内容 | `scripts/pack-release.mjs`、`pack-portable.mjs` |

---

## 五、几条容易踩的约定

1. **路径不落到浏览器**。引擎把用户目录换成代号（`folder-N`），代号表落盘；
   绝对路径、用户名都不进前端，也不进日志。
2. **写回一律原子**：临时文件 → 校验 → 原子替换 → 自动备份。任何一步失败，
   原文件保持原样。
3. **预演先行**：影响面算不出来，就不给执行按钮（不是"给个警告"）。
4. **`coverage` 与 `findings` 同等重要**：体检报告里"哪些查了、哪些没查"
   和"查出了什么"一样要写清——少了它，"没查"会被读成"查过、没问题"。
5. **改引擎要重建**：引擎 dev 模式跑的是 `src/engine/dist/`（构建产物），
   改完 `npm run build:engine` 才生效。
6. **测试夹具运行时现场造**：`test/` 里没有二进制数据文件，
   `fixtures/` 下的少量二进制被 gitignore（本地才有）。
7. **CI 跑在 ubuntu**：涉及 Windows 专有行为的用例要么跳过、要么显式 mock。

---

## 六、门禁与测试

```bash
npm run test:ci          # 全量单测（串行；多文件并行在本机会撞车）
npm run typecheck        # 引擎 + 服务端 + 前端三处类型检查
npm run check:licenses   # 依赖与资产的许可（只允许可闭源商用）
npm run check:secrets    # 密钥扫描（含"盘符 + 非 ASCII"这类个人路径规则）
npm run check:vulns      # 依赖漏洞（critical 及以上阻断）
npm run check:schema     # op 契约自检
npm run smoke:engine     # 起真引擎跑一遍路由级冒烟
```

GitHub Actions 在 `main` 上跑这些门禁，并另行把静态站发到 Pages
（`deploy-site.yml`；**发版与门禁是两条独立流程**，门禁红不挡发站）。
