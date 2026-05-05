@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [setup] Creating virtual environment...
  python -m venv .venv
  if errorlevel 1 (
    echo [error] Failed to create venv. Make sure Python is installed and available in PATH.
    pause
    exit /b 1
  )
)

echo [setup] Installing requirements...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo [error] Dependency installation failed.
  pause
  exit /b 1
)

echo [start] Launching gpt-image-studio...
".venv\Scripts\python.exe" -m image_studio.server
pause
