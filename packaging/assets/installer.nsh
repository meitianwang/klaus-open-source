; The Chrome extension's native messaging host reuses the application
; executable image, and the extension reconnects a few seconds after its host
; process dies. An update that replaces application files while a browser is
; connected therefore loses a race it can never win: every killed host is
; respawned before the file replacement finishes, which surfaces as "cannot be
; closed" and "failed to uninstall old application files" dialogs.
;
; Park the host launcher (rename it aside) for the duration of this install or
; uninstall run. With the path the native messaging manifest points at gone,
; reconnect attempts fail instead of respawning a host, and the application
; restores the launcher on its next start (including after a cancelled run,
; which is what leaves a parked copy behind).
;
; Hook choice (learned the hard way across three 0.4.28 Windows builds): the
; stock customCheckAppRunning escape hatch cannot be used. electron-builder's
; CHECK_APP_RUNNING inserts the custom macro INSTEAD of its own body, and its
; preamble (Var /GLOBAL CmdPath and PowerShellPath, getProcessInfo.nsh, Var pid,
; IS_POWERSHELL_AVAILABLE) is conditionally skipped exactly when the custom
; macro exists. Reproducing that preamble by hand failed three different ways:
; duplicate CmdPath declaration, warning 6000 on IsPowerShellAvailable, and a
; System::Call plugin-directory conflict in the uninstaller compile. So park
; from customInit / customUnInit instead, which run inside .onInit / un.onInit
; and use no stock macros at all:
;   - installer: customInit runs before installSection.nsh calls
;     CHECK_APP_RUNNING, so parking precedes the kill loop;
;   - uninstaller: un.onInit calls un.checkAppRunning before customUnInit, so
;     parking lands after the kill loop but still before any file deletion
;     (deletion happens in the uninstall section, after un.onInit returns).
;     The extension respawn delay is seconds while this gap is sub-second, so
;     the residual window is not reachable in practice.
; Restore runs after file replacement in both contexts.
!ifndef KLAUS_CONFIG_DIRECTORY
  !define KLAUS_CONFIG_DIRECTORY ".klaus"
!endif
!ifndef KLAUS_DESKTOP_EDITION
  !define KLAUS_DESKTOP_EDITION "domestic"
!endif
!ifndef KLAUS_APPLICATION
  !define KLAUS_APPLICATION "ai.klaus.desktop"
!endif
!ifndef KLAUS_LEGACY_IDENTITY
  !define KLAUS_LEGACY_IDENTITY "1"
!endif

; An inherited override may belong to another installed edition. Only a matching
; ownership marker authorizes it for a non-legacy edition; the legacy identity
; keeps accepting unmarked profiles, as it did before editions existed.
!macro resolveChromeNativeHostProfile
  Push $R4
  Push $R5
  Push $R6
  StrCpy $R7 "$PROFILE\${KLAUS_CONFIG_DIRECTORY}"
  ReadEnvStr $R6 "KLAUS_CONFIG_DIR"
  ${if} $R6 != ""
    ${if} ${FileExists} "$R6\.desktop-edition.json"
      ClearErrors
      FileOpen $R5 "$R6\.desktop-edition.json" r
      ${ifNot} ${Errors}
        FileRead $R5 $R4
        FileClose $R5
        ${if} $R4 == '{"schemaVersion":1,"edition":"${KLAUS_DESKTOP_EDITION}","application":"${KLAUS_APPLICATION}"}$\n'
          StrCpy $R7 $R6
        ${endif}
        ${if} $R4 == '{"schemaVersion":1,"edition":"${KLAUS_DESKTOP_EDITION}","application":"${KLAUS_APPLICATION}"}$\r$\n'
          StrCpy $R7 $R6
        ${endif}
      ${endif}
    ${else}
      !if "${KLAUS_LEGACY_IDENTITY}" == "1"
        StrCpy $R7 $R6
      !endif
    ${endif}
  ${endif}
  Pop $R6
  Pop $R5
  Pop $R4
!macroend

!macro parkChromeNativeHostLauncher
  !insertmacro resolveChromeNativeHostProfile
  StrCpy $R8 "$R7\chrome-native-host\klaus-chrome-host.cmd"
  StrCpy $R9 "$R8.updating"
  ${if} ${FileExists} "$R8"
    Delete "$R9"
    Rename "$R8" "$R9"
  ${endif}
!macroend

!macro restoreChromeNativeHostLauncher
  !insertmacro resolveChromeNativeHostProfile
  Rename "$R7\chrome-native-host\klaus-chrome-host.cmd.updating" "$R7\chrome-native-host\klaus-chrome-host.cmd"
!macroend

!macro customInit
  !insertmacro parkChromeNativeHostLauncher
!macroend

!macro customUnInit
  !insertmacro parkChromeNativeHostLauncher
!macroend

!macro customInstall
  !insertmacro restoreChromeNativeHostLauncher
!macroend

!macro customUnInstall
  !insertmacro restoreChromeNativeHostLauncher
!macroend
