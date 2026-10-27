@echo off
rem One run of the scheduled reviewer (Windows task JobApplyReviewer, every 6 hours, hidden via run-hidden.vbs).
rem Headless Claude Code reads the standing prompt from stdin, works for up to ~40 minutes, commits what it proved, writes the digest.
rem Permissions are skipped because nobody is there to answer prompts; the prompt file carries the hard rules.
cd /d "%~dp0.."
rem timestamp via PowerShell: %DATE% is locale dependent ("Thu 10/22/2026" here) and broke the log path on the first two runs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd-HHmm"') do set TS=%%i
if "%TS%"=="" set TS=run
if not exist "worker\logs" mkdir "worker\logs"
rem one reviewer at a time: the task itself ignores a second start, but a by-hand start can overlap a running one (22 Oct, two instances 3 min apart).
rem the lock is stale after 70 minutes (the task limit is 1 h), so a crashed run never blocks the next one.
for /f %%i in ('powershell -NoProfile -Command "$f='worker/logs/reviewer.lock'; if ((Test-Path $f) -and ((Get-Date) - (Get-Item $f).LastWriteTime).TotalMinutes -lt 70) { 'busy' } else { Set-Content $f (Get-Date -Format o); 'free' }"') do set LOCK=%%i
if "%LOCK%"=="busy" (
  echo skipped %TS%: another reviewer is running ^(reviewer.lock^) >> "worker\logs\reviewer.out"
  exit /b 0
)
echo ===== reviewer run %TS% ===== >> "worker\logs\reviewer.out"
rem step 0 (supply widening item 3, Eyal 26 Oct 2026): board discovery and the daily supply score run BEFORE the agent and without it, so
rem supply grows every run even when the agent's 40 minutes go elsewhere. About 4 minutes; output goes to the run log; a failure never stops the agent.
node "worker\reviewer\discover.mjs" --budget 8m >> "worker\logs\reviewer-%TS%.log" 2>&1
node "worker\reviewer\supply.mjs" --score --record >> "worker\logs\reviewer-%TS%.log" 2>&1
type "worker\reviewer\REVIEWER-PROMPT.md" | claude -p --dangerously-skip-permissions --output-format text >> "worker\logs\reviewer-%TS%.log" 2>&1
echo exit %ERRORLEVEL% at %TIME% >> "worker\logs\reviewer.out"
del "worker\logs\reviewer.lock" 2>nul
