@echo off
rem Starts the dedicated apply-runner Chrome profile with remote debugging on port 9222.
rem Log into Google once in this window. Keep it open while run.mjs works.
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\apply-runner-profile" --no-first-run --no-default-browser-check --disable-blink-features=AutomationControlled --window-size=1280,900 about:blank
