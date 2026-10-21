@echo off
REM 安装 Visual Studio Build Tools 2022 + C++ 桌面开发工作负载 (MSVC v143 + Windows 11 SDK 26100)
REM 用于：Tauri 桌面版编译 / 需要原生依赖时；GDAL 本身用预编译二进制，不需要编译
echo [%date% %time%] 开始安装 VS Build Tools 2022 ...
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-package-agreements --accept-source-agreements --override "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.26100 --includeRecommended"
echo [%date% %time%] winget exit code = %ERRORLEVEL%
echo DONE_MARKER
