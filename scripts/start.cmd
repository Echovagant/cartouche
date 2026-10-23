@echo off
REM ============================================================================
REM 一键启动图签 Cartouche（Windows）
REM
REM 给谁用：拿到发布包里的人。双击这个文件，它会检查环境、装依赖、起引擎、
REM 起画布、并打开浏览器 —— 不用记住四个命令的顺序。
REM
REM 前提：装了 Node.js（>= 22）和 GDAL 命令行。
REM   - Node：https://nodejs.org/
REM   - GDAL：Windows 上跑 scripts\setup-conda-gdal.ps1（conda-forge 预编译版）
REM
REM 说明：这一步不碰用户的数据。图件、项目清单、留痕都在你自己登记的工作区里。
REM ============================================================================
setlocal
cd /d "%~dp0.."

echo.
echo   图签 Cartouche · 本机运行的地图出图工具
echo   --------------------------------------------
echo.

REM ── 1. Node ────────────────────────────────────────────────────────────
where node >nul 2>nul
if errorlevel 1 goto :no_node
for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo   [1/5] Node: %NODE_VER%

REM ── 2. 依赖 ────────────────────────────────────────────────────────────
if exist node_modules (
  echo   [2/5] 依赖: 已安装，跳过
) else (
  echo   [2/5] 依赖: 首次运行，正在安装（几分钟）...
  call npm install
  if errorlevel 1 goto :npm_failed
)

REM ── 3. 引擎构建产物 ────────────────────────────────────────────────────
if exist "src\engine\dist\index.js" (
  echo   [3/5] 引擎: 已有构建产物，跳过
) else (
  echo   [3/5] 引擎: 正在构建...
  call npm run build:server
  if errorlevel 1 goto :build_failed
)

REM ── 4. GDAL ────────────────────────────────────────────────────────────
where gdalinfo >nul 2>nul
if not errorlevel 1 goto :gdal_ok
if exist "%USERPROFILE%\miniconda3\envs\gdal\Library\bin\gdalinfo.exe" goto :gdal_ok
if exist "%USERPROFILE%\miniconda3\envs\gdal\bin\gdalinfo" goto :gdal_ok
echo   [4/5] GDAL: 没找到
echo.
echo   先装 GDAL（Windows）：在 PowerShell 里跑这一句，然后重新双击本文件：
echo     powershell -ExecutionPolicy Bypass -File scripts\setup-conda-gdal.ps1
echo.
pause
exit /b 1
:gdal_ok
echo   [4/5] GDAL: 已就绪

REM ── 5. 起服务 ──────────────────────────────────────────────────────────
echo   [5/5] 启动引擎与画布...
start "Cartouche Engine" cmd /k "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-engine.ps1"
start "Cartouche Web" cmd /k "node scripts\serve-static.mjs --port 8080"

REM 等引擎与静态站把端口占上再开浏览器，否则第一次打开会看到"连不上"
timeout /t 4 /nobreak >nul
start "" http://127.0.0.1:8080/

echo.
echo   ------------------------------------------------------------
echo   画布   : http://127.0.0.1:8080/canvas.html
echo   引擎   : http://127.0.0.1:8787
echo.
echo   关掉服务：在弹出的两个窗口里按 Ctrl+C，或直接关掉那两个窗口。
echo   ------------------------------------------------------------
echo.
pause
exit /b 0

:no_node
echo   没有找到 Node.js。
echo.
echo   先装 Node.js（>= 22）：https://nodejs.org/
echo   装完重新双击本文件。
echo.
pause
exit /b 1

:npm_failed
echo.
echo   依赖安装失败。常见原因：网络不通。
echo   可以先设置镜像源再试一次：
echo     npm config set registry https://registry.npmmirror.com
echo.
pause
exit /b 1

:build_failed
echo.
echo   引擎构建失败。上面窗口里的报错是原因。
echo.
pause
exit /b 1
