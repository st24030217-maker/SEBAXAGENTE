' Inicia el agente en segundo plano, sin ventana negra.
' Se ejecuta solo al prender la PC (acceso directo en la carpeta Inicio de Windows).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
carpeta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c """ & carpeta & "\servicio.cmd""", 0, False
