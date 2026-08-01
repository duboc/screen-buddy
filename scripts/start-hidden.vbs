' Launches screen-buddy with no console window.
'
' Registry Run entries execute a command line directly, so pointing one at
' npm.cmd flashes a console window at every login. wscript with an intWindowStyle
' of 0 starts it hidden instead.

Dim shell, fso, projectRoot
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Parent of the scripts/ directory this file lives in.
projectRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

shell.CurrentDirectory = projectRoot
shell.Run "cmd /c npm start", 0, False
