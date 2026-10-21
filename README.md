# 图签 Cartouche

> 用一句话描述要改什么，AI 给出**可核对的修改方案**，你确认后写回原图件——ArcGIS 照常打开，全程留痕可交差。

面向国土、规划、不动产、管网、市政等岗位的**非 GIS 专业**在职人员。他们手上有图件、有明确要改的地方，但往往没有 ArcGIS 授权，也不愿意面对专业 GIS 软件的学习成本。

> **命名**：开源项目 **`Cartouche` / 图签**，商业版 **`Cartouche Studio` / 图签工作台**。
> 代码标识统一为 `@cartouche/*`。中文名「图签」= 工程制图的图签（标注图名/图号/比例尺的框位），
> 与英文 cartouche（西方地图上的题签框）是同一个东西的两种叫法。商标与域名核查排在 S5 之后。

## 它解决什么

| 现状 | 图签的做法 |
|---|---|
| 为了改一处标注，得学一整套 ArcGIS | 一句话描述意图，AI 给出方案 |
| 改完不确定改了哪些、影响多大 | 每次执行强制输出**量化影响报告**（影响像元数、涉及要素数、净面积变化、拓扑检查结果） |
| 怕改坏原数据 | 原子写入 + 自动备份 + 占用检测，失败不损坏原文件 |
| 改完说不清谁改的 | 本地审计日志，可导出交差报告 |
| 工具装在 GIS 软件里、还要授权 | 浏览器打开即用；核心能力不依赖任何商业 GIS 授权 |

## 核心设计原则

1. **AI 只提议，绝不执行。**
   LLM 的唯一合法产物是一份符合 `src/engine/ops.schema.json` 的**操作计划**。执行永远由确定性引擎完成，且必须经过四道闸门：Schema 校验 → 引擎前置校验 → 量化影响报告 → 人工确认。

2. **最小必要披露。**
   发往模型的不是整份图件，而是图层清单、字段名、当前视窗内要素的简化几何与关键属性，且**发送前可预览**。

3. **写回必须可回退。**
   临时文件 → 校验 → 原子替换 → 自动备份。任何一步失败，原文件保持不变。

4. **引擎与交互壳解耦。**
   引擎是纯 TypeScript + WebAssembly 的一组确定性操作；桌面端、Web 端、MCP Server 都是它的调用方。

## 快速开始

前置条件：

- Node.js ≥ 22
- GDAL 命令行（`gdalinfo` / `ogr2ogr`）。Windows 上推荐用 conda-forge 发行版：

```bash
# 安装 Miniconda + GDAL（仅 conda-forge 通道，走国内镜像）
powershell -ExecutionPolicy Bypass -File scripts/setup-conda-gdal.ps1
```

检查环境：

```bash
npm run doctor
```

生成一个真实的 `.tff` 样本并做往返校验（识别 → 世界文件 → 坐标系 → 写回无损 → Shapefile/FileGDB）：

```bash
npm run fixture
```

产物在 `fixtures/`，其中 `worldref.tff` + `worldref.tfw` + `worldref.prj` 就是 Esri 常见的「影像 + 世界文件 + 坐标系」组合，可直接在 ArcGIS 中打开验证。

## 打开地图画布

画布是**静态导出**的纯前端页面，能力由独立的引擎进程提供。**必须用 http 打开**——
Chrome 禁止从 `file://`（origin 为 null）的页面构造 Web Worker，MapLibre 的 worker 起不来，
地图会一片空白。

```bash
# 1) 拉取公开样本并播种进工作区
npm run samples
npm run samples:seed

# 2) 起引擎（另开一个终端）
npm run dev:server        # 或：node server/dist/index.js

# 3) 起静态服务器并打开画布
npm run build:web
npm run serve:web         # http://127.0.0.1:8080/canvas.html
```

引擎默认放行**回环来源**（`http://127.0.0.1:<端口>` / `http://localhost:<端口>`），
外网来源一律被浏览器拦下；设 `ENGINE_ALLOWED_ORIGINS=a,b` 则只放行列出的 Origin。

## 开发命令

| 命令 | 作用 |
|---|---|
| `npm run doctor` | 环境自检：Node / GDAL / 驱动覆盖 / C++ 工具链 / M0' 验证就绪度 |
| `npm run fixture` | 生成样本 + 写回往返校验（像素校验和比对） |
| `npm test` | 单元测试（并行，本地快） |
| `npm run test:ci` | 单元测试（串行，CI 用） |
| `npm run check:schema` | 操作计划契约自检（23 个 op） |
| `npm run check:bench` | 基准集自检（30 条基层用例 + 20 条 Pro 进阶用例，12 条已覆盖 / 8 条能力缺口） |
| `npm run check:licenses` | 依赖许可门禁（强/弱 copyleft 分级） |
| `npm run check:secrets` | **密钥扫描门禁**：防 API Key 误提交进仓库 |
| `npm run scan:encoding` | 扫描「UTF-8 被按 GBK 解码后再存回」的编码污染 |
| `npm run smoke:engine` | 引擎服务冒烟测试 |
| `npm run build:web` | 构建静态前端产物（`web/out/`） |
| `npm run serve:web` | 零依赖静态服务器，把 `web/out` 跑在 http 上（画布要用它打开） |
| `npm run dev:web` | 前端开发服务器 |
| `npm run samples` | 拉取**公开真实数据**样本（免登录、免费、可商用） |
| `npm run samples:eval` | 用真实数据量出「实现程度」，产出能力矩阵 |
| `npm run samples:seed` | 把样本播种进工作区，画布可直接打开 |
| `npm run serve:web` | 零依赖静态服务器，把 `web/out` 跑在 http 上（画布要用它打开） |
| `node scripts/fetch-fonts.mjs` | 一次性下载自托管字体（Geist / Satoshi）到 `web/fonts/` |
| `powershell -File scripts/check-name-availability.ps1` | 名称占用实测（GitHub org/user + npm 顶层/scope） |
| `powershell -File scripts/mutation-check*.ps1` | 变异测试：故意改坏实现，确认测试会红 |

> **工程现状**：160 / 160 测试通过；**23 次变异测试**（捕获率 23/23）——变异测试已抓出 4 处"名不副实的测试"，
> 并在 2026-10-21 定位并修复了一个会导致**无备份覆盖原文件**的数据安全缺陷。
> 同日第一次在真浏览器里过画布首屏，又抓出 8 个单测/类型检查/冒烟都发现不了的问题
> （最严重的是 MapLibre 的 worker 起不来导致地图全白），详见 `docs/05` §S5.1。

## 模型接入

v1 只落地 **MiniMax 国内版**一个 provider。

> ⚠️ **模型名以官网为准**（2026-10-21 核对 MiniMax 官网）：
> 当前可用的是 **`MiniMax-M3.1-Flash`** 与 **`MiniMax-M3`**（1M 上下文）。
> **M2 / M2.1 / M2.5 / M2.7 / M2-her 全系已下线**（M2.7 正式下线 2026-11-18），
> 旧文档里的 `MiniMax-M2.7` 一律作废。
> base_url：`https://api.minimax.cn/v1`（OpenAI 兼容）/ `https://api.minimax.cn/anthropic`（官方推荐）。

架构保留 `KeyProvider` 接口，将来加别的 provider 不改引擎：

```ts
// 换一家模型只改这个实现，引擎与网关不动
const provider = new MiniMaxProvider({
  readApiKey: () => process.env.MINIMAX_API_KEY ?? null,
  model: 'MiniMax-M3.1-Flash',
});
```

`KeyProviderId` 预留了 MiniMax / DeepSeek / Qwen / GLM / OpenAI / Claude / Gemini
以及任意 OpenAI 兼容接入点（含本地 Ollama / vLLM），当前只落地第一个。

### 密钥怎么放（重要）

**API Key 不进 GitHub，也不以明文保存。** 磁盘上只允许出现 DPAPI 密文。

```powershell
# 1) 一次性配置：交互输入 → DPAPI 加密 → 存到 %LOCALAPPDATA%\cartouche\llm-key.txt
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-key.ps1

# 2) 启动引擎：自动解密并注入当前进程（不回显 Key）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-engine.ps1

# 随时查看状态（只显示长度与前 4 位）/ 清除
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-key.ps1 -Show
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-key.ps1 -Clear
```

- 密文**绑定当前 Windows 用户**，别的账号、别的机器都解不开；文件在**仓库之外**。
- 也可以临时用环境变量（会话级，不落盘）：`$env:MINIMAX_API_KEY = Read-Host 'MiniMax API Key'`
- 或在 Web 界面里粘贴 —— 只驻留内存，服务重启即失效。
- `GET /api/llm/status` **只返回** `configured` / `source`（env / session），**永不返回 Key 本身**。
- `npm run check:secrets` 是 CI 里的最后一道防线：扫到疑似 Key 直接让构建失败。

## 目录结构

```
src/engine/         引擎：操作计划 Schema、密钥提供方接口
server/             引擎服务（HTTP 接口 + 密钥状态管理）
web/                前端静态壳（Next.js 静态导出；canvas/ 是地图画布，motion/ 是动效）
web/fonts/          自托管字体（Geist / Satoshi），构建不依赖网络
scripts/            开发脚本：环境自检、样本生成、样本拉取、依赖安装、门禁
bench/              AI 基准集（30 条基层用例 + 20 条 Pro 进阶对照用例）
samples/            公开真实数据样本（体积大、按需拉取，不入库）
fixtures/           生成的合成样本（不入库）
docs/               方案与计划文档
```

## 安全说明

- 服务端不持久化模型密钥，不做遥测，不含任何自动更新。
- 浏览器只与本机/内网服务通信；是否连接外部模型由使用者自行配置。
- 所有写回操作留痕，审计日志可导出。

## 许可

[Apache-2.0](LICENSE)。本项目不包含、不分发任何 Esri 专有软件或数据；ArcGIS 是 Esri 的注册商标。第三方组件许可见 [NOTICE](NOTICE)。
