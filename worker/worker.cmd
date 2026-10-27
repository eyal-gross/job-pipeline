@echo off
rem One tick of the PC worker (started hidden by the JobApplyWorker scheduled task through run-hidden.vbs).
cd /d "%~dp0"
if not exist logs mkdir logs
node worker.mjs >> logs\worker.out 2>&1
