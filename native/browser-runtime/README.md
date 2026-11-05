# Native browser runtime

The ordered series targets Electron 44.2.0, Chromium 152.0.7977.76 and Node 24.20.0. `manifest.json` records source revisions, repository roots, immutable hashes and authoritative patch order.

## Ownership

One browser process and main loop own both context types. Application renderers retain Electron contexts and isolated preloads. Browser pages and fixed management surfaces share a genuine Chrome Profile, with no Electron WebContents or Session wrapper. A virtual context discriminator guards native factories and dispatch. Policy, printing, metrics, WebUI, network and extension services have explicit owners. Native windows drain before Profile services.

Enable `native-browser-enabled` before readiness and keep `native-browser-data-dir` inside application user data to retain network sandbox grants. Existing legacy Electron browser storage is preserved separately; internal databases are not copied across embedders.

## Host services

The private `electron_browser_native_browser` binding provides `createProfile()`, `create({parent,bounds,url,visible})`, both service constructors and fixed management URLs. Its EventEmitter adapter lives in the trusted main process. Native pages have no Node integration, preload or host IPC bridge.

Pages provide native parent transfer, geometry, focus, bubble anchors, bounded activity leases, debugger access, FindTabHelper and lifecycle events. Password, address, extension and site-settings management use genuine WebUI. Task navigation cannot access privileged management surfaces.

Popup adoption preserves the original TabModel, WebContents, opener and navigation. A browser-side throttle waits for Fetch authorization. `getMainFrameId()` supplies browser-owned identity before renderer commands are available. The host installs interception, resumes the original request and only then enables renderer domains. Every redirect is authorized without URL or POST replay. Pending children cancel on shutdown; accepted children have independent lifetimes. Empty source windows close through weak deferred tasks outside detach notifications.

Profile networking uses bounded pull reads and cancellable headers and body reads. Redirects return before following another destination. Native DownloadManager observation exposes real target selection and pause/resume/cancel/remove capabilities; host paths retain normal reservation and policy checks. Removing history retains downloaded files.

`clearData` waits for the native browsing-data remover and keeps passwords, addresses, extensions and downloaded files. Persistent permissions share HostContentSettingsMap with real pages and native settings. Task grants cannot override persistent denial, and prompt restores the Profile default. Unsupported persistence fails explicitly. Physical input retires task control; debugger input does not.

`listImportableProfiles` and `importProfile` own the complete source pipeline in native code. A sequenced worker enumerates profile directories, uses the local index only for optional display metadata, validates canonical profile paths, snapshots the database/WAL/SHM together, derives a source-specific macOS key only when needed, and stages confirmed extensions. Source databases remain unchanged. Optional index failures retain operation-specific diagnostics; snapshot copy failures retain their original file error and errno without claiming which side denied access. Cookie and password values never enter JavaScript, IPC or logs. The host receives only progress receipts and confirmed history metadata.

Native writes use batches of at most 250 rows. History receipts distinguish processed rows, confirmed indices and visits skipped by native retention; host projection receives only confirmed visits. Repeated imports reuse existing visits through indexed confirmation. Source history keeps the newest bounded set and applies it chronologically. Password discovery and reading select the account database only when the primary database is absent; permission failures do not select another source. Unsupported non-web credential origins are skipped before decryption. Cookie partition attributes survive, password upserts are read back, and cancellation/disposal drain outstanding callbacks. Extensions use the genuine unpacked installer. Synthetic source overrides require mock-Keychain mode and an owned source under the native data root; mock mode without that source fails before default discovery.

## Build

Use an isolated physical Chromium checkout without unrelated node_modules in its ancestors. Prepare the pinned Electron tag and gclient dependencies and run the official prerequisite hooks before applying this series. Do not sync or run another source writer during application.

```sh
python3 native/browser-runtime/scripts/apply-patches.py <chromium-src> <electron-src> --check-only
native/browser-runtime/scripts/apply-patches.sh <chromium-src> <electron-src>
```

The applicator verifies hashes, preflights dependencies with private indexes and leaves real indexes unchanged. Failure reverses only this series. Source, compilation, runtime and packaging are separate gates.

The accepted macOS arm64 configuration is:

```gn
import("//electron/build/args/testing.gn")
target_cpu = "arm64"
symbol_level = 0
blink_symbol_level = 0
v8_symbol_level = 0
use_remoteexec = false
use_siso = false
```

Run `gn gen out/NativeBrowser`, then `ninja -C out/NativeBrowser electron -j <cpu-budget>`. Keep one native build active, reserve disk space and retain sandboxing. Other platforms require their own compiled artifacts and acceptance.

## Artifact delivery

Copy Electron.app outside its mutable build directory. The resolver records all bundle files, executable modes, symlinks, source metadata, manifest hash and patch-order hash, and creates the custom runtime ZIP for the packager.

```sh
node scripts/electron-runtime-resolver.mjs create --runtime-dir <artifact> --receipt <artifact>/runtime.json --manifest native/browser-runtime/manifest.json --app Electron.app --platform darwin --arch arm64
node scripts/electron-runtime-resolver.mjs verify --runtime-dir <artifact> --receipt <artifact>/runtime.json --manifest native/browser-runtime/manifest.json --platform darwin --arch arm64 --require-packager-zip
```

Set KLAUS_ELECTRON_RUNTIME_DIR, KLAUS_ELECTRON_RUNTIME_RECEIPT and KLAUS_ELECTRON_RUNTIME_MANIFEST for dev/package. Production defaults to native and rejects absent or mismatched artifacts. Explicit stock mode does not supply this native browser.

## Verification

STATUS.md distinguishes accepted evidence and remaining limits. The isolated mock-Keychain construction probe does not replace page, import, download, popup or composed UI acceptance. Use synthetic profiles, GUI preflight and the declared launcher. Keep original commands, output and genuinely painted captures in ignored evidence directories.

After building the host, run `node scripts/test-browser-native-import.mjs <native-electron-executable>` for isolated directory discovery, optional-index access failures, encrypted import without a readable index, acknowledged cancellation, malformed-source diagnostics, history retention and idempotence, primary/account password source selection, restart persistence and autofill. It uses only generated profiles and fixed synthetic credentials. Real source access and system Keychain authorization require their own explicit acceptance.
