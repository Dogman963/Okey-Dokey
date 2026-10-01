@echo off
rem okey -- Windows wrapper so `okey ...` works directly from PATH.
rem
rem Note: this file is deliberately ASCII-only. cmd.exe reads .cmd files using the
rem console code page (ANSI/GBK on zh-CN systems), not UTF-8, so non-ASCII bytes in
rem comments get mangled and can even be executed as stray commands.
rem
rem The Node exit code is forwarded unchanged: callers rely on it to distinguish
rem "not found" (2), "ambiguous" (3) and "vault problem" (4) from a generic failure.
node "%~dp0..\src\cli\okey.js" %*
exit /b %ERRORLEVEL%
