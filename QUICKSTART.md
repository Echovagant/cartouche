# 快速开始

图签 Cartouche 跑在**你自己的电脑**上。图件不传云端，密钥不落明文。

这份包里已经带了预构建好的引擎与前端产物，所以不用先编译。

---

## 一、前置条件

| 需要 | 版本 | 怎么确认 |
|---|---|---|
| Node.js | ≥ 22 | `node -v` |
| GDAL 命令行 | 3.x 即可 | `gdalinfo --version` |

Windows 上装 GDAL（走国内镜像的 conda-forge 通道）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-conda-gdal.ps1
```

macOS / Linux 用系统包管理器装 `gdal-bin` 即可。

## 二、装依赖

```bash
npm install
```

## 三、自检

```bash
npm run doctor
```

它会检查 Node 版本、GDAL 是否在位、驱动覆盖、引擎能不能就绪。**有缺什么会直接说**，不用自己猜。

## 四、跑起来

开两个终端。

```bash
# 终端 1：引擎服务（只监听回环地址 127.0.0.1:8787）
npm run dev:server
```

```bash
# 终端 2：静态站
npm run serve:web
```

然后打开 **<http://127.0.0.1:8080/canvas.html>**。

> ⚠️ **必须用 http 打开，不能直接双击 html 文件。**
> Chrome 禁止从 `file://` 构造 Web Worker，MapLibre 起不来，地图会一片空白。

## 五、改一笔

1. 在画布上点「新建项目」，填**图件所在文件夹的绝对路径**（比如 `D:\任务\2026改图`），登记。
   工具会在这个文件夹**旁边**建一个 `.cartouche/` 放清单、产出物与留痕，**你的图件一个字节都不会被搬动或改写**。
2. 在「工作区文件」里点「加载」，把栅格加进项目。
3. 选「画笔」或「框选」，在图上拖一下。
4. **确认卡**会先写清：这次会影响多少像元、改的是哪个文件、备份叫什么、是什么操作。
5. 确认之后：原图件就地改好，自动留一份带时间戳的备份，地图刷新，PDF 落进 `.cartouche/outputs/`，留痕追加到 `.cartouche/history.jsonl`。

## 六、目录长什么样

```
D:\任务\2026改图\          ← 你自己的图件，原样保留
├─ 底图.tff
├─ 底图.tfw
└─ .cartouche\             ← 工具只在这个目录里放自己的东西
   ├─ project.json         ← 清单（纯 JSON，人可读）
   ├─ history.jsonl        ← 留痕，一行一次操作
   └─ outputs\             ← 产出的 PDF / 报告
```

整个项目文件夹可以直接压缩发给别人，对方打开还是原样。

## 七、要接模型（可选）

```powershell
# 交互输入 → DPAPI 加密 → 存到 %LOCALAPPDATA%\cartouche\llm-key.txt
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/set-key.ps1

# 启动引擎：自动解密并注入当前进程（不回显 Key）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-engine.ps1
```

也可以在 <http://127.0.0.1:8080/ai.html> 里粘贴——只驻留内存，服务重启即失效。

**磁盘上只允许出现 DPAPI 密文。** 密文绑定当前 Windows 用户，别的账号、别的机器都解不开。

## 八、能改哪些格式

- **能改 · 原样写回**：`.tff`、`.tif`（GeoTIFF）。格式、坐标系、伴随文件都跟着走，ArcGIS 照常打开。
- **能看能导出 · 不改**：`.img` `.vrt` `.asc` `.bil` `.png`（栅格），`.shp` `.gdb` `.gpkg` `.geojson` `.kml` `.gml`（矢量）。
  写回统一产出 GeoTIFF，改了会换格式，所以工具会**明确拒绝**而不是把文件改坏。

## 九、出问题看哪儿

| 现象 | 多半是 |
|---|---|
| 地图一片空白 | 用 file:// 打开了。用 http://127.0.0.1:8080/canvas.html |
| 提示"无法连接引擎服务" | 终端 1 的引擎没起，或端口不是 8787 |
| 提示缺 GDAL 驱动 | `npm run doctor` 看看具体缺哪个 |
| 写回被拒绝 | 目标不是 GeoTIFF，先转成 .tif 再改 |
| 写回报"文件被占用" | ArcGIS 打开着这个数据，工具不会硬来 |

## 十、许可

[Apache-2.0](../LICENSE)。本项目不包含、不分发任何 Esri 专有软件或数据；ArcGIS 是 Esri 的注册商标。
第三方组件许可见 [NOTICE](../NOTICE)。
