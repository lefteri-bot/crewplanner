' Run a command hidden (no console window)
On Error Resume Next
Dim shell, cmd
Set shell = CreateObject("WScript.Shell")
If WScript.Arguments.Count = 0 Then WScript.Quit 1
cmd = WScript.Arguments(0)
shell.Run Chr(34) & cmd & Chr(34), 0, False
