@echo off
rem PDF Select & Translate - open the built-in (bundled) PDF reader.
rem You can also drag a PDF file onto this file.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-reader.ps1" %*
endlocal
