; IPFLIX Windows NSIS Setup Installer Script
; Compiled natively on Linux/Windows via Unicode makensis v3.08+

Unicode True
!include "MUI2.nsh"
!include "FileFunc.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "1.0.0"
!endif
!ifndef SOURCE_DIR
  !define SOURCE_DIR "..\release\win-unpacked"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "..\release\IPFlix-Windows-Setup.exe"
!endif
!ifndef ICON_FILE
  !define ICON_FILE "..\electron\assets\icon.ico"
!endif

!define APP_NAME "IPFLIX"
!define APP_PUBLISHER "IPFLIX"
!define APP_EXE "IPFLIX.exe"
!define UNINSTALL_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"
RequestExecutionLevel user
ManifestSupportedOS all
SetCompressor zlib
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=1055 "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=1055 "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey /LANG=1055 "LegalCopyright" "Copyright (c) 2026 IPFLIX"
VIAddVersionKey /LANG=1055 "FileDescription" "IPFLIX IPTV Kurulum Sihirbazi"
VIAddVersionKey /LANG=1055 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1055 "ProductVersion" "${APP_VERSION}"

!define MUI_ABORTWARNING
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "IPFLIX uygulamasini simdi baslat"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Turkish"
!insertmacro MUI_LANGUAGE "English"

Section "IPFLIX" SecMain
  SectionIn RO

  ; Gracefully close any running instance before replacing binaries during auto-update
  nsExec::ExecToStack 'taskkill /IM "${APP_EXE}" /T /F'
  Pop $0
  Pop $1
  Sleep 500

  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}\*.*"

  ; Persist install path and Add/Remove Programs metadata (HKCU, zero UAC elevation required)
  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "UninstallString" '"$INSTDIR\Uninstall IPFLIX.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_REG_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_REG_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTALL_REG_KEY}" "EstimatedSize" $0

  ; Start Menu & Desktop shortcuts
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\IPFLIX Kaldir.lnk" "$INSTDIR\Uninstall IPFLIX.exe" "" "$INSTDIR\Uninstall IPFLIX.exe" 0
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0

  ; Write uninstaller — strictly preserves %APPDATA%\IPFLIX (SQLite + DPAPI encrypted vault)
  WriteUninstaller "$INSTDIR\Uninstall IPFLIX.exe"
SectionEnd

Section "Uninstall"
  nsExec::ExecToStack 'taskkill /IM "${APP_EXE}" /T /F'
  Pop $0
  Pop $1
  Sleep 400

  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\IPFLIX Kaldir.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  ; Remove only application installation directory; NEVER delete $APPDATA\IPFLIX user data
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_REG_KEY}"
  DeleteRegKey HKCU "Software\${APP_NAME}"
SectionEnd
