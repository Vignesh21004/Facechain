@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (echo npm install failed.&pause&exit /b 1)
)
if not exist .env (
  copy .env.example .env >nul
  echo.
  echo .env was created. Open .env and add your SERPAPI_KEY, then run run.bat again.
  echo Keep your API key private.
  pause
  exit /b 0
)
echo Starting FaceChain...
call npm start
pause
