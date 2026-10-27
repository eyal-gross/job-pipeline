' Runs the given .cmd with no console window (same pattern as the WhatsApp bot's scheduled task).
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & WScript.Arguments(0) & Chr(34), 0, False
