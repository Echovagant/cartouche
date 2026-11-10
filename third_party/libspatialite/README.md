# libspatialite（打了 CVE 补丁的构建）

便携包里的 GDAL 会用到 **libspatialite** 的空间函数（`ST_IsValid` / `ST_IsValidReason` /
`ST_Intersection` —— 项目的几何拓扑体检靠它们）。

## 为什么这里放着一份改过的源码

libspatialite 5.1.0 有两个 2026-10-18 公布的漏洞，**上游至今没有发布修复版本**
（官方页面仍写 "current version is 5.1.0, released on 2023-08-04"）：

| 漏洞 | 影响 | 严重度 |
|---|---|---|
| CVE-2026-112048 | `ParseWkbPolygon` 未校验多边形环数 → 非受控内存分配 | CVSS 6.9(v4) / 6.1(v3) |
| CVE-2026-112052 | WKB 点/顶点数尺寸守卫**整数溢出** → 越界读 | CVSS 6.9(v4) / 6.1(v3) |

`patched/` 里是**上游 5.1.0 加上上游修复提交 `5a5528e8d2`** 的那两个源文件
（`src/gaiageo/gg_wkb.c` 与 `src/gaiageo/gg_geometries.c`）。
改动都打了 `[CART-2026-PATCH]` 标记，核心是：

- 把「点数 × 每点字节数会不会超出剩余缓冲区」这种**乘法**判断，改成**除法**判断
  （`count <= (size - offset) / stride`）—— 乘法在 32 位下会回绕，
  `0x10000000` 个点会让 `16 * points` 变成 0，守卫形同虚设；
  除法写法是原判断的**代数重排**，对没有溢出的输入，接受与拒绝的结果完全一致；
- 给多边形的**环数**补上校验（每个环至少占 4 字节的顶点数）；
- 给几个分配函数补上返回值判空。

## 为什么不能干脆「不打包 spatialite」

试过，三条路都走不通（都有实测记录）：

1. **直接删掉 `spatialite.dll`** —— `gdal.dll` 在 PE 导入表里**硬引用**它的 5 个符号
   （`spatialite_init_ex` 等），删掉后 `gdalinfo.exe` 直接崩，错误码 `0xC0000135`（DLL 找不到）。
2. **用一个只导出那 5 个符号的 stub 顶替** —— GDAL 能加载，但 `ST_IsValid` /
   `ST_IsValidReason` / `ST_Intersection` **全部不可用** → 几何拓扑体检直接废掉。
3. **等上游发版** —— 上游没有 5.1.1。

所以只能自己编一个。

## 怎么构建

前置：MinGW-w64 交叉编译工具链，以及 GDAL 的那些依赖（GEOS / PROJ / SQLite3 / freexl / libxml2 /
iconv）—— conda 的 GDAL 环境里全都有。

```bash
# 1. 拿源码
curl -L -o libspatialite-5.1.0.tar.gz \
  https://www.gaia-gis.it/fossil/libspatialite/tarball/libspatialite-5.1.0.tar.gz
tar xzf libspatialite-5.1.0.tar.gz

# 2. 覆盖这两个文件（就是 patched/ 里那两份）
cp patched/gg_wkb.c        libspatialite-5.1.0/src/gaiageo/gg_wkb.c
cp patched/gg_geometries.c  libspatialite-5.1.0/src/gaiageo/gg_geometries.c

# 3. 编译（build.sh 是 conda-forge 那套配方，改成手工调用）
cd libspatialite-5.1.0
./configure --prefix=<你的输出目录> \
            --host=x86_64-w64-mingw32 --build=x86_64-pc-linux-gnu \
            --enable-static=no --enable-minizip=no \
            --enable-rttopo=no --enable-gcp=no
make
make install

# 4. 把产物放到本目录的 build/ 下
#    打包器会去找 third_party/libspatialite/build/spatialite.dll
mkdir -p build
cp <你的输出目录>/bin/spatialite.dll build/
```

也可以用环境变量指到别处：

```bash
CARTOUCHE_SPATIALITE_DLL=/path/to/spatialite.dll npm run pack:portable
```

## 打包器找不到它会怎样

**直接报错，不出包。** 不会静默退回 conda 那份有漏洞的库 ——
那正是这个目录存在的理由。

## 许可

libspatialite 是 **LGPL-2.1**。分发的这个 DLL 是**动态链接**的
（`gdal.dll` 运行时加载它，可以替换），因此按 LGPL 的要求提供：

- 修改后的源码就在本目录 `patched/` 里；
- 完整的构建步骤见上，用户可以自行重建出一个替换用的 DLL。

未修改部分的版权与许可属于上游（Copyright (c) 2006-2020 Fausto Beccaria 等），
详见 `LICENSE` 文件（随上游源码分发）。
