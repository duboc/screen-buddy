' Runs restart.ps1 with no console window.
'
' The desktop shortcut points here rather than straight at powershell.exe so
' that double-clicking it does not flash a blue console window on screen —
' which rather defeats the point of a HUD you are looking at.

Dim shell, fso, scriptsDir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptsDir = fso.GetParentFolderName(WScript.ScriptFullName)

shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & _
          scriptsDir & "\restart.ps1""", 0, False
