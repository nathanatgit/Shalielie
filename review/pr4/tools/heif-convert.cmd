@echo off
rem heif-convert stand-in for Windows -- see heif_convert_shim.py.
rem Put this directory on PATH so photographic_style_port.py can find it:
rem   set "PATH=%CD%\tools;%PATH%"
setlocal
set "PY=%~dp0..\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0heif_convert_shim.py" %*
