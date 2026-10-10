@echo off
setlocal
title KankanBan

pushd "%~dp0KankanBan"
if errorlevel 1 (
  echo Could not open the KankanBan project folder.
  pause
  exit /b 1
)

call npm run app
set "app_exit_code=%errorlevel%"
popd

if not "%app_exit_code%"=="0" (
  echo.
  echo Startup failed. See the error above.
  pause
)
exit /b %app_exit_code%
