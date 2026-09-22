@echo off
rem AI Comic Studio launcher  (keep this file ASCII-only: cmd reads .bat as GBK)
cd /d %~dp0
set ELECTRON_RUN_AS_NODE=
start "FeiYu AI Comic" "node_modules\electron\dist\electron.exe" .
