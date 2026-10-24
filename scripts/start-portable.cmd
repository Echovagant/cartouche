@echo off
REM ============================================================================
REM 图签 Cartouche · 便携版启动器
REM
REM 给谁用：拿到这个包的人。双击它，画布就开了 —— 不用装 Node、不用装 GDAL、
REM 不用跑 npm install。运行时全在包里（runtime\ 目录）。
REM
REM 前提：没有。这个文件就是"前提"的终结者。
REM
REM 说明：这一步不碰用户的数据。图件、项目清单、留痕都在你自己登记的工作区里。
REM
REM 编码：本文件是 UTF-8（无 BOM）。第一行把控制台切到 UTF-8，
REM 否则中文提示在默认代码页（GBK）下是乱码 —— 而乱码的报错等于没有报错。
REM ============================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo.
echo   图签 Cartouche · 便携版
echo   --------------------------------------------
echo.

REM ── 1. 自检：运行时与产物必须齐全 ──────────────────────────────────────
REM 少任何一样都直接说清缺什么，而不是让用户去看 Node 的英文堆栈。
if not exist "runtime\node\node.exe" goto :no_node
if not exist "runtime\gdal\bin\gdalinfo.exe" goto :no_gdal
if not exist "server\dist\index.js" goto :no_build
if not exist "web\out\canvas.html" goto :no_build

set "NODE=%CD%\runtime\node\node.exe"
set "GDAL_BIN=%CD%\runtime\gdal\bin"
set "GDAL_DATA=%CD%\runtime\gdal\share\gdal"
set "PROJ_DATA=%CD%\runtime\gdal\share\proj"
REM PROJ_LIB 是老版本的 PROJ 认的变量名；新版本认 PROJ_DATA。两个都设，
REM 否则不同版本会各报各的（"找不到投影库" / "PROJ_LIB 已废弃"）。
set "PROJ_LIB=%CD%\runtime\gdal\share\proj"
set "PATH=%GDAL_BIN%;%PATH%"
set "ENGINE_PORT=8787"
set "ENGINE_HOST=127.0.0.1"

REM ── 2. 端口占用检查 ─────────────────────────────────────────────────────
REM 端口被占时静默失败是最糟的：用户看到的是"打不开"，不知道该怎么办。
call :port_busy 8787
if not errorlevel 1 goto :engine_busy
call :port_busy 8080
if not errorlevel 1 goto :web_busy

REM ── 3. 起引擎与画布 ───────────────────────────────────────────────────
REM 引擎走 scripts\run-engine.ps1：它负责把本机存的密钥（DPAPI 加密）读进内存，
REM 再用包里的 node 起服务 —— 包里没有 npm，也不需要。
REM --root 必须是**相对路径**：serve-static.mjs 把它拼在它自己算出来的包根目录下，
REM 传绝对路径会被拼成 "包根\D:\...\web\out"，静态站直接 404。
start "Cartouche 引擎" /D "%CD%" cmd /k "powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\run-engine.ps1" -Port 8787"
start "Cartouche 画布" /D "%CD%" cmd /k ""%NODE%" "%CD%\scripts\serve-static.mjs" --port 8080 --root web\out"

REM ── 4. 等引擎真正就绪，再开浏览器 ─────────────────────────────────────
REM 立刻开浏览器的话，第一次打开会看到"连不上引擎" —— 那是"还没起来"，
REM 不是"坏了"。所以先等健康检查通过。
"%NODE%" -e "const u='http://127.0.0.1:8787/api/health';const t=Date.now();(async()=>{for(;;){try{const r=await fetch(u);if(r.ok)return 0}catch(e){}if(Date.now()-t>30000)return 1;await new Promise(r=>setTimeout(r,300))}})().then(c=>process.exit(c))"
if errorlevel 1 goto :engine_timeout

echo.
echo   ------------------------------------------------------------
echo   画布   : http://127.0.0.1:8080/canvas.html
echo   引擎   : http://127.0.0.1:8787
echo.
echo   关掉：在弹出的两个命令行窗口里按 Ctrl+C，或直接关掉那两个窗口。
echo   ------------------------------------------------------------
echo.

start "" "http://127.0.0.1:8080/canvas.html"
pause
exit /b 0

REM ── 子过程：端口有没有人在听 ──────────────────────────────────────────
REM 用 netstat 而不是 PowerShell：启动要快，而且不依赖系统装了 PowerShell。
:port_busy
netstat -ano -p TCP | findstr /C:":%~1 " | findstr /C:"LISTENING" >nul 2>&1
exit /b %errorlevel%

:no_node
echo.
echo   [无法启动] 这个包里缺少 Node 运行时：runtime\node\node.exe
echo.
echo   多半是压缩包没有完整解压 —— 请把整个 zip 重新解压一次，
echo   不要只复制其中几个文件夹。
echo.
pause
exit /b 1

:no_gdal
echo.
echo   [无法启动] 这个包里缺少 GDAL：runtime\gdal\bin\gdalinfo.exe
echo.
echo   多半是压缩包没有完整解压 —— 请把整个 zip 重新解压一次，
echo   不要只复制其中几个文件夹。
echo.
pause
exit /b 1

:no_build
echo.
echo   [无法启动] 这个包里缺少构建产物（server\dist 或 web\out）。
echo.
echo   请把整个 zip 重新解压一次，不要只复制其中几个文件夹。
echo.
pause
exit /b 1

:engine_busy
echo.
echo   [无法启动] 端口 8787 已经被占用了。
echo.
echo   这通常是图签已经开着：找到标题是「Cartouche 引擎」的那个命令行窗口，
echo   按 Ctrl+C 关掉它（或者直接把窗口关掉），然后再双击一次本文件。
echo.
echo   如果确认不是图签占的，用这条命令看看是谁占的：
echo     netstat -ano | findstr :8787
echo.
pause
exit /b 1

:web_busy
echo.
echo   [无法启动] 端口 8080 已经被占用了。
echo.
echo   这通常是图签已经开着：找到标题是「Cartouche 画布」的那个命令行窗口，
echo   按 Ctrl+C 关掉它（或者直接把窗口关掉），然后再双击一次本文件。
echo.
echo   如果确认不是图签占的，用这条命令看看是谁占的：
echo     netstat -ano | findstr :8080
echo.
pause
exit /b 1

:engine_timeout
echo.
echo   [启动失败] 引擎 30 秒内没有就绪。
echo.
echo   请看标题是「Cartouche 引擎」的那个窗口里的报错。
echo   常见原因：
echo     - 压缩包没有完整解压
echo     - 杀毒软件拦了 runtime 目录里的 exe（把 runtime 目录加进白名单）
echo.
pause
exit /b 1
