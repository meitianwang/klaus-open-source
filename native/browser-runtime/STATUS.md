# Native browser runtime acceptance

The manifest contains 161 immutable patches. Ordered preflight matches the actual source with both real indexes unchanged (906-final-native-source.log). The complete Electron target compiles, links and assembles its bundle with exit zero (906-final-native-build.log). The final electron_lib header dependency check passes (907-final-native-headers.log). Product BrowserManager, settings, imports and lifecycle handling are connected.

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

- Application and Profile service keepalives have distinct ownership. Closing and reopening the final native window five times preserves the host renderer and live Profile services, then exits cleanly (905). Host compositor capture with a native child also passes (903). Native management windows close normally; no retired hidden pages are retained.

## Limits and remaining delivery

Accepted native execution is macOS arm64. Windows and x64 native builds are not established. The native CSV picker reached its real dialog but selection was refused by the UI focus guard; no picker success is claimed. Production import APIs have independent synthetic success evidence. Legacy Electron profile files are retained without unverified internal database copying.

The final runtime receipt, complete bundle tree and packager ZIP pass verification (908). Development preparation passed (878), and the final native runtime is consumed by a verified local application package (910). Independent composed settings UI acceptance covers all four management pages, native back navigation, 1280/760 layouts, 125% zoom, resize, six opens and real closure with zero remaining management views; the host PID and JavaScript remain live (settings-compose-worktree/dist/native-settings-compose-logs/20-final-33b9fa1.log). The complete production command-map audit passes with 727 required and registered handlers, zero missing or extra handlers, and 79 matching push producers (918). Its real annotation flow captures rendered pixels, selects a region and retains a draft attachment without sending. Public review, push and primary-checkout reconciliation are tracked separately. Failed attempts remain negative evidence in ignored logs.
