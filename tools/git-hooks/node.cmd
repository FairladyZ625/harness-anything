@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem Resolve the executable directly so PATH cannot lead back to this wrapper.
set "real_node="
for %%N in (node.exe) do set "real_node=%%~$PATH:N"
if not defined real_node (
  echo node: not found 1>&2
  exit /b 127
)

set "run_tests="
:parse
rem Keep the original quoting on assignment. Expand only after cmd has parsed the IF lines.
set arg=%1
if not defined arg goto done
setlocal EnableDelayedExpansion
set "arg=!arg:"=!"
rem cmd splits an unquoted option at =. A quoted option arrives as one token.
if "!arg!"=="--test-concurrency" (endlocal & goto passthrough)
if "!arg:~0,19!"=="--test-concurrency=" (endlocal & goto passthrough)
if "!arg!"=="--test" (endlocal & set "run_tests=1") else endlocal
shift
goto parse

:done
if defined run_tests goto with_concurrency

:passthrough
"%real_node%" %*
exit /b %ERRORLEVEL%

:with_concurrency
"%real_node%" --test-concurrency=2 %*
exit /b %ERRORLEVEL%
