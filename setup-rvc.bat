@echo off
rem One-time setup for a custom Peter voice in "Peter explains" (RVC voice conversion).
rem Builds .rvc-env\ (git-ignored): a Python 3.12 environment plus Applio's RVC
rem inference code, CUDA PyTorch, and Applio's pitch/content models + ffmpeg.
rem About 5 GB. Needs Anaconda/Miniconda and git. Safe to re-run.
setlocal
cd /d "%~dp0"
set "RVC=%~dp0.rvc-env"
set "APPLIO_COMMIT=55fe0b9"

set "CONDA="
for %%C in ("%USERPROFILE%\anaconda3\Scripts\conda.exe" "%USERPROFILE%\miniconda3\Scripts\conda.exe" "%ProgramData%\anaconda3\Scripts\conda.exe" "%ProgramData%\miniconda3\Scripts\conda.exe") do (
  if not defined CONDA if exist %%C set "CONDA=%%~C"
)
if not defined CONDA for /f "delims=" %%C in ('where conda 2^>nul') do if not defined CONDA set "CONDA=%%C"
if not defined CONDA (
  echo Anaconda or Miniconda is required: https://docs.anaconda.com/miniconda/
  goto :fail
)

if not exist "%RVC%\env\python.exe" (
  echo Creating Python 3.12 environment...
  "%CONDA%" create -p "%RVC%\env" python=3.12 -y || goto :fail
)

if not exist "%RVC%\Applio\core.py" (
  echo Downloading Applio %APPLIO_COMMIT%...
  git init -q "%RVC%\Applio" || goto :fail
  git -C "%RVC%\Applio" fetch -q --depth 1 https://github.com/IAHispano/Applio.git %APPLIO_COMMIT% || goto :fail
  git -C "%RVC%\Applio" checkout -q FETCH_HEAD || goto :fail
)

echo Installing packages (CUDA PyTorch; this is the big download)...
"%RVC%\env\python.exe" -m pip install -q uv || goto :fail
"%RVC%\env\python.exe" -m uv pip install --python "%RVC%\env\python.exe" -r "%RVC%\Applio\requirements.txt" --extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match || goto :fail

echo Downloading RVC pitch/content models and ffmpeg...
pushd "%RVC%\Applio"
"%RVC%\env\python.exe" -c "from rvc.lib.tools.prerequisites_download import prequisites_download_pipeline as p; p(False, True, True)" || (popd & goto :fail)
popd

"%RVC%\env\python.exe" -c "import torch; print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none (CPU - slower)')"
echo.
echo Done. Now set RPM_PETER_RVC_MODEL (and optionally RPM_PETER_RVC_INDEX) in .env
echo to your voice model files, then restart the app.
pause
exit /b 0

:fail
echo.
echo Setup failed - see the messages above.
pause
exit /b 1
