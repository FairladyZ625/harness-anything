@echo off
setlocal EnableExtensions

set "git_exe="
for %%G in (git.exe) do if not defined git_exe set "git_exe=%%~$PATH:G"
if not defined git_exe (
  echo git: not found 1>&2
  exit /b 127
)

for %%G in ("%git_exe%") do set "git_root=%%~dpG.."
set "shell=%git_root%\bin\sh.exe"
if not exist "%shell%" set "shell=%git_root%\usr\bin\sh.exe"
if not exist "%shell%" (
  echo git: POSIX shell not found next to %git_exe% 1>&2
  exit /b 127
)

"%shell%" "%~dp0git" %*
exit /b %ERRORLEVEL%
