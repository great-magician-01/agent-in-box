!include LogicLib.nsh

!macro customInstall
  ; Storage location, Host Reserve and auto-start policy are chosen in the
  ; first-run wizard, so the installer only needs to explain the sequence.
  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONINFORMATION "Agent-in-Box 将以当前用户权限安装，不需要管理员权限。首次启动会检查 CPU 虚拟化与磁盘空间，并让您选择数据目录、Host Reserve（为宿主机保留的内存）、VM 自动启动和敏感操作审批。VM 镜像和磁盘不会存储在安装目录，卸载时默认保留。"
  ${EndIf}
!macroend

!macro customUnInstall
  ; Silent uninstall never deletes user data. The interactive uninstaller asks
  ; explicitly, with "keep data" as the default choice.
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "是否同时删除 Agent-in-Box 的本地数据？$\r$\n$\r$\n选择“否”（推荐，默认）：保留 VM 磁盘、镜像、快照、任务数据库、项目备份和机器人配置，重新安装后可继续使用。$\r$\n$\r$\n选择“是”：调用应用清理工具删除当前配置的数据根目录。只删除带有 Agent-in-Box 数据目录标记的目录，不会删除其他文件。" IDNO agent_in_box_keep_data
    StrCpy $0 ""
    ExecWait '"$INSTDIR\Agent-in-Box.exe" --uninstall-clean-data --yes' $0
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "数据清理未完全成功（退出码 $0）。请查看应用日志目录，或手动删除自定义数据目录。"
    ${EndIf}
  ${EndIf}
  agent_in_box_keep_data:
!macroend
