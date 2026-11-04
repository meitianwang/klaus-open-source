# Native browser runtime acceptance

The manifest contains 156 immutable patches. Ordered preflight matches the actual source with both real indexes unchanged (874-native-source-state.log). The complete Electron target compiles, links and assembles its bundle with exit zero (867). The final electron_lib header dependency check passes (876). Product BrowserManager, settings, imports and lifecycle handling are connected.

## Accepted behavior

Original commands, outputs and images are in the ignored browser-settings-alignment-logs/native-fork-build-logs directory unless noted otherwise.

- Genuine Profile HTTP pages coexist with sandboxed Electron pages without Node or host bridges. Native parent transfer, geometry, anchors, visibility, bounded activity and clean closure pass (488, 595, 598, 599, 674, 679).
- A real native save-password prompt is accepted and a second process autofills the credential without typing (501).
- Profile networking and cookie isolation, bounded streaming, redirect authorization and cancellation pass (658, 696, 702, 716). Data removal changes native cache, cookies and site storage without clearing unrelated Electron data (675).
- Production manager, FindTabHelper, original POST/307, task permissions, multi-window lifetime and strict management-view ownership pass (755, 781).
- Synthetic production import preserves CHIPS and cookie attributes, confirms password upserts, imports genuine history, installs an extension and reports cancellation prefixes. Cookies, credentials, autofill and extensions survive restart (797). The genuinely painted site-settings capture was inspected; earlier blank captures are not visual evidence.
- Real multipart uploads hold the original request before HTTP, preserve its body through 307, authorize every hop, refuse a denied redirect before bytes arrive and cancel pending uploads on agent disable (805).
- Eight real native DownloadManager cases pass: target wait, original POST/307, per-hop authorization, denied destination, history-only removal, pause/resume, interrupted resume and cancelled pending target. Evidence is in page-transport-decouple-worktree/dist/native-download-bridge-logs/native-download-full-817-report.md.
- Native persistent permission edits, WebUI edits, real page queries, task-denial precedence, default reset and restart persistence use one Profile rule store (822).
- Native popup adoption preserves POST/307 and task ownership, handles target-blank and window.open, blocks denied redirects, cancels pending children on disable, retains accepted children after opener closure and exits cleanly (848). Startup-order regression checks pass (847, 851).

## Limits and remaining delivery

Accepted native execution is macOS arm64. Windows and x64 native builds are not established. The native CSV picker reached its real dialog but selection was refused by the UI focus guard; no picker success is claimed. Production import APIs have independent synthetic success evidence. Legacy Electron profile files are retained without unverified internal database copying.

Composed settings UI, the affected command-map audit, runtime artifact verification and dev/package consumption remain product delivery gates, followed by public review, push and primary-checkout reconciliation. Compilation and raw Profile probes do not establish these gates. Failed attempts remain negative evidence in ignored logs.
