# Local Electron packages

This entry produces a reviewable local application. It does not sign, notarize,
publish, generate update feeds, or install over the user's current app.
`apps/desktop/package.json` supplies the desktop version and pins Electron exactly.
macOS candidates use a numeric `major.minor.patch` bundle version. Choose the
`preview` channel when signing an unpublished candidate; do not put arbitrary
prerelease suffixes in the system bundle version fields. See Apple's
[bundle version format](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion)
and [display version format](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring).
The single frontend is built from `apps/desktop/frontend`; the resulting
application contains no Tauri host, Tauri runtime tree, standalone Chromium, or CFT.

## Regional editions

`contracts/desktop-editions.json` is the sole identity table for `domestic` and
`international`. Packaging defaults to `domestic`; pass `--edition international`
to produce the other edition. Package metadata keeps `name: klaus-desktop` and
`klausDesktopLayoutVersion: 1`, and adds `klausDesktopEdition`. The identity table
is included inside the application archive. Old packages without the edition
field remain domestic.

Installer and signing entries inherit an explicit verified candidate edition
when the option is omitted; an explicit conflicting selection is rejected.
Artifact names, executables, helpers, app IDs, protocols, NSIS GUIDs and DMG
volume names come from the same table. Both editions can share one update
signing key without accepting each other's signed policies, offers or receipts.
The default HTTPS origin is the selected edition's `serverUrl`. `--origin`
remains an explicit HTTPS-origin override, not an edition selector.

Release indexes declare one edition and application. Missing declarations are
accepted only as legacy domestic indexes. A merge across editions is rejected;
`stable` and `preview` remain independent update channels, not regional editions.
Each site's release directory must remain separate. Fresh-output checks,
immutable artifact checks and atomic index publication are unchanged.
The serving process selects its edition from its configured public site URL;
the international site must configure `web.public_base_url` or
`KLAUS_PUBLIC_BASE_URL` as `https://klaus-ai.site`. Pages and release endpoints
use that same selection, never the request Host or incoming release metadata.
For the first international rollout, stage edition-bound artifacts in a separate
release directory before switching the site's configuration and release directory.
Historical overseas downloads carrying the domestic identity are not eligible
after this cutover; publishing the client and switching the site require one
coordinated acceptance, not an intermediate domestic fallback.

Both desktop editions bind engine plugin and session paths to their selected
profile, overriding inherited `KLAUS_PLUGIN_HOME` and `KLAUS_SESSION_DIR`.
Choose a separate `KLAUS_CONFIG_DIR` when a custom profile is needed.
Ownership markers protect upgraded applications and installers. Earlier domestic
applications do not understand these markers: never point an older domestic app
at an international profile, even after closing the international app.

`publish-electron-release.mjs` defaults to domestic. International publication
and remote verification require `--edition international` and an explicit
`--ssh-host` or `KLAUS_SSH_HOST` before any remote access. A local manifest for the
wrong selected edition is rejected before reading the remote manifest. The
repository's `desktop:upload` wrapper already forwards all arguments; it must
keep doing so and must not inject a domestic SSH host for an international run.
Select the intended `KLAUS_REMOTE_RELEASE_DIR`, `KLAUS_REMOTE_ENV_FILE` and
`KLAUS_REMOTE_SERVICE` when the target host serves multiple sites.

The Windows installer hook receives the canonical default profile directory in
a generated NSIS include. An inherited `KLAUS_CONFIG_DIR` override is used only
when its ownership marker matches this edition. Unmarked legacy domestic
profiles retain their existing override behavior. International installer
configuration requires the generated include. Launcher parking/restoration
never selects a marked profile belonging to the other edition. Chrome uses one
shared extension, bound to one application at a time; its launcher lives under
the selected application's profile directory.

Offline verification and metadata renewal also accept `--edition`; they default
to domestic and never infer the expected application from signed update data.
The installed host must pass its package-derived application into both
`parseInstalledUpdateConfiguration` and `productionPolicy`. macOS runtime
signature verification must additionally bind the primary executable identifier
to that same installed application.

## Build

Run in `apps/desktop` in an isolated checkout:

```sh
npm ci
npm run package -- \
  --engine-dir /absolute/staging/resources/bin/darwin-arm64 \
  --native-dir /absolute/production-native-artifacts \
  --speech-dir /absolute/production-speech/darwin-arm64 \
  --recording-dir /absolute/production-recording/darwin-arm64 \
  --pip-dir /absolute/production-pip/darwin-arm64 \
  --computer-use-dir /absolute/production-computer-use/darwin-arm64 \
  --out /absolute/review-output
```

The script runs TypeScript checks, the main/preload build, and the frontend build.
It installs only locked production Node dependencies into an isolated staging
directory, archives only compiled application files, copies an explicit resource
allowlist, and validates the finished bundle. Temporary staging is removed.
An existing target directory is rejected; choose a new `--out` for a new build.
Dependencies must first be installed with `npm ci` in the checkout.
`--electron-zip /absolute/electron-v44.2.0-win32-x64.zip` supports a previously
downloaded archive. Both network and offline inputs use the checksum shipped in
the exactly pinned Electron npm package; another filename or modified byte fails
before building. No runtime archive or checksum check is fabricated or skipped.

The engine commit defaults to the checkout's committed submodule pointer.
`--engine-commit <full SHA>` permits an explicitly selected clean engine for local
migration review. Both that selection and the original pointer are retained in
the manifest. A dirty engine, credential-fixture addon, incorrect SHA, mismatched
native source/lock fingerprint, or wrong Mach-O/PE architecture stops the build.
The native source commit may differ from the client commit when its full native
source fingerprint matches. Client dirty state is recorded, never concealed.
macOS also requires the standalone speech helper and adjacent JSON manifest.
`--speech-dir` defaults to `resources/speech/<platform-arch>`. The builder checks
its clean source identity, source/build-script fingerprint, compiler metadata,
Mach-O architecture, execute permission and binary SHA. Windows packages exclude
this helper and reject a supplied `--speech-dir`.
The same checks apply independently to the macOS action-recording helper at
`resources/recording/<platform-arch>`, or an explicit `--recording-dir`.
Both its executable and adjacent manifest are mandatory for macOS packages;
Windows excludes them and rejects the macOS-only option. The app receives an
absolute packaged path, with no development-artifact fallback.
The independent PiP producer follows `resources/pip/<platform-arch>`, or
`--pip-dir`. macOS requires its executable and adjacent JSON manifest, including
the six-file source fingerprint from `native/pip/build.mjs`. The native addon's
fingerprint also includes `pip/KlausPIP.h`, `pip/KlausPIPHost.m` and
`pip/KlausPIPTransport.m`; older artifacts are rejected when these sources differ.
Windows excludes the producer, rejects `--pip-dir`, and rejects any `pip`
resource directory or manifest field during package verification.
The Computer Use helper follows `resources/computer-use/<platform-arch>`, or
`--computer-use-dir`. Its executable and adjacent manifest are mandatory on both
platforms. macOS uses `klaus-computer-use-helper` and concatenates
`klaus-computer-use-helper.m`, `helper-info.plist` and `build.mjs` for its source
fingerprint. Windows uses `klaus-computer-use-helper.exe` and concatenates
`windows-helper.cpp`, `windows-helper.manifest` and `build-windows.mjs` instead.
Each fingerprint preserves that exact order and file bytes, matching its native
build recipe. Validation rejects foreign targets, stale sources, dirty source
proof, missing compiler identity, modified bytes, symbolic links and extra payload
files. It checks Mach-O or PE architecture and requires macOS execute permission.
The Windows helper is built with `asInvoker` and `uiAccess=false`; a resource
identity check does not replace the final application signing gate.

The macOS browser-import helper follows
`resources/browser-import/<platform-arch>`, or `--browser-import-dir`. Its
executable and adjacent JSON manifest are required on macOS. The verifier
requires schema 1, production mode, the exact target, source fingerprint,
binary SHA-256 and signing metadata. Test-mode artifacts are rejected. Windows
packages record the capability as unsupported and reject a leaked macOS helper.
The package manifest exposes relative helper paths for the host runtime locator.

The independent resource check can copy and validate a clean helper in its final
resource layout without rebuilding an old application baseline:

```sh
node apps/desktop/scripts/verify-computer-use-artifact.mjs \
  --artifact-dir <immutable-target-artifacts> \
  --source-root apps/desktop/native/computer-use --platform win32 --arch x64 --probe
```

`--probe` executes the copied helper on its own platform, sends only `capabilities`
and removes the temporary resource directory afterward. It reports
`resourceRoundTrip: true` and `fullAppBuilt: false`. An SSH Session 0 response of
`Computer Use requires an interactive user session` proves resource loading only;
it does not validate user input or capture. Those require the separate Session 1
Computer Use fixture. Omit `--probe` for a cross-platform resource audit.

The currently supported build keys are `darwin-arm64` and `win32-x64`.
Run Windows packaging on Windows with `npm run package -- --platform win32
--arch x64 ...` and provide Windows-produced engine/native artifacts. Intel macOS
and Linux desktop packages are intentionally rejected. This script never invokes
Cargo or cross-compiles Rust.
`--frontend-dir` accepts an explicitly prepared frontend directory; without it,
the current frontend is rebuilt automatically.

## Installed layout

On macOS the resource root is `Klaus.app/Contents/Resources`; on Windows it is
`Klaus-win32-x64/resources`:

```text
Resources/
  app.asar
    package.json
    contracts/channel-table.json
    contracts/engine/klaus-app-server.schema.json
    dist/main/**.js
    dist/preload/{main,artifact,canvas,quick-input,recorder}.js
    node_modules/                 # production dependencies only
  desktop-resources.json         # provenance, file sizes and SHA-256 inventory
  frontend/                      # all six production HTML entry points
  bin/<platform-arch>/
    klaus-agent-stdio[.exe]
    klaus_browser_pipe.node        # Windows schema 2 release only
    manifest.json
  native/
    klaus-native-<platform-arch>.node
    klaus-native-<platform-arch>.node.json
  speech/<platform-arch>/         # macOS only
    klaus-speech-helper
    klaus-speech-helper.json
  recording/<platform-arch>/      # macOS only
    klaus-recording-helper
    klaus-recording-helper.json
  pip/<platform-arch>/            # macOS only
    klaus-pip-producer
    klaus-pip-producer.json
  computer-use/<platform-arch>/
    klaus-computer-use-helper[.exe]
    klaus-computer-use-helper[.exe].json
  browser-import/<platform-arch>/       # macOS only
    klaus-browser-import-helper
    klaus-browser-import-helper.json
  plugins-builtin/                # browser only (loadable Chrome extension); digram ships via the official plugin market
  plugins-seed/
  canvas/
  tray-icon.png
  app-icon.icns                   # macOS only
```

`main/app/paths.ts` exposes pure `resolveDesktopPaths(context)`; `main/paths.ts`
keeps `appRoot()`, `frontendDist()`, `engineBinDir()` and `resourceRoot()` stable.
The main process uses Electron's `app.isPackaged` and `process.resourcesPath`.
The Node-mode Chrome helper has no `app` object, so the packaged package.json's
`klausDesktopLayoutVersion` marker selects the same layout. Installed paths never
depend on cwd or search the checkout. Native libraries and spawned executables
remain real files outside ASAR. The helper script runs from ASAR using the
packaged Klaus executable and `ELECTRON_RUN_AS_NODE=1`; its existing installation
action writes only on an explicit settings request.
`resolveDesktopPaths().pipProducerPath` is the absolute PiP producer path on
macOS and `undefined` on Windows. The producer uses the existing Screen Recording
permission flow; packaging does not request access or grant capture capability.
`resolveDesktopPaths().computerUseHelperPath` uses the same absolute-resource
rule for the macOS helper and Windows executable. The host must inject this path;
packaged mode does not search for a development helper.

Do not disable the RunAsNode fuse in a later signing pipeline without replacing
that native-host execution mechanism and rerunning the external Chrome suite.
The application does not enable an inspector by default. The test runner passes
an ephemeral loopback inspector flag to its own child for observation and normal
shutdown; no fixture module or test endpoint is included in app.asar.

## Verify and measure

```sh
npm run package:test
npm run build:main
node dist/tests/desktop-paths.test.js
npm run package:verify -- /absolute/Klaus.app
npm run package:smoke -- /absolute/Klaus.app --output /absolute/smoke.json
npm run package:measure -- /absolute/Klaus.app \
  --rounds 3 --idle-seconds 10 --output /absolute/measure.json \
  --archive /absolute/Klaus-local-size-sample.zip
```

Verification hashes the actual ASAR and unpacked resources against their full
inventory, checks required entries and prevents duplicate app/engine payloads.
Without `--receipt`, smoke and measurement retain this strict unsigned check.
For a formally signed copy, supply its separately signed receipt explicitly:

```sh
npm run package:smoke -- '/absolute/Review copy/Klaus.app' \
  --receipt /absolute/release/Klaus.receipt.json --output /absolute/signed-smoke.json
npm run package:measure -- '/absolute/Review copy/Klaus.app' \
  --receipt /absolute/release/Klaus.receipt.json \
  --rounds 3 --idle-seconds 10 --output /absolute/signed-measure.json
```

The adjacent `Klaus.receipt.json.sig` must exist. The runner verifies the shipping
Ed25519 signature, the entire signed file inventory and the original unsigned
content constraints. It also reruns the target OS signature checks; macOS
requires accepted, stapled notarization and Gatekeeper assessment. The inventory
and receipt bytes are checked again after the OS checks, before the package can
start. Wrong bundles, foreign targets, changed content, invalid signatures or
receipt replacement fail without falling back to unsigned verification. There
is no CLI public-key override or signature bypass.

All execution paths are derived from the canonical path of the supplied copy.
The receipt's historical `unsigned.source.bundle`, `resources` and `executable`
paths are provenance only. Reports distinguish `package.verification.mode`
(`signed` or `unsigned`). Signed reports record the receipt and detached-signature
paths, sizes and SHA-256 values, live platform verification, actual bundle path,
and the unmodified `originalUnsignedSource`. Original binary hashes remain in
that provenance; they are never relabelled as the post-signing bytes. Neither the
receipt nor the original resource manifests are rewritten. Performance reports
also hash the shared verifier and its release-validation dependencies as runner
sources, preserving the existing workload and budgets.

The smoke runs the untouched production entry with an isolated guest profile and
local HTTP fixture. It checks packaged Node/ASAR loading, an in-process native
search, native messaging ping/cleanup, the isolated frontend bridge, owned media
Range responses and real artifact image rendering, the same sandboxed WCV page
edited by debugger/CDP, exactly one packaged engine, and normal shutdown with no
live children. On macOS it also runs the actual packaged speech helper's
non-prompting `--probe` and checks the app's microphone/speech usage descriptions.
A dummy local model definition enables `session:new`; no model
request, user credential or OAuth grant is used. The macOS native-host installation
is confined to a disposable Chrome profile. Windows registry registration is
explicitly not performed or claimed by this probe.

For a Windows SSH session, use the logged-in desktop runner from the repo root:

```sh
node apps/desktop/scripts/smoke-windows-interactive.mjs /absolute/Klaus-win32-x64 \
  --output /absolute/package-smoke.json
node apps/desktop/scripts/download-test-chrome.mjs \
  --version 152.0.7977.82 --out /absolute/test-cache
node apps/desktop/scripts/smoke-windows-interactive.mjs /absolute/Klaus-win32-x64 \
  --chrome /absolute/test-cache/chrome-win64/chrome.exe \
  --output /absolute/chrome-package-smoke.json
```

For a signed Windows package, add `--receipt /absolute/Klaus.receipt.json` to
either interactive command. It is forwarded as a separate argument to the
actual desktop-session fixture, which performs the same receipt, complete
inventory and live Authenticode checks before running the application or Chrome
native host. Direct `smoke-windows-chrome-package.mjs` also accepts this option.

The runner creates one unique, trigger-free, least-privilege InteractiveToken
task, verifies a nonzero Windows session, and removes its task and launcher in
`finally`. No password or elevation is requested. The Chrome suite snapshots all
four supported HKCU native-host keys in both registry views and refuses any
preexisting registration. It installs the actual packaged host into an isolated
Unicode/space-containing config path, loads the bundled extension in official
CFT, validates authenticated relay access, task/tab ownership, input, screenshot,
download and normal shutdown, then restores the original absent registry state.
This is a CFT native-host verification; installed Chrome/Edge profile compatibility
and physical keyboard/global-shortcut input are separate cases.

Chrome's Windows AppContainer needs read/execute access to downloaded binaries.
The downloader grants that access only to its public browser cache, as described
by [Puppeteer's Windows sandbox guidance](https://github.com/puppeteer/puppeteer/blob/main/docs/troubleshooting.md#chrome-reports-sandbox-errors-on-windows).
It never grants access to a user profile or disables Chromium's sandbox. Pin
`--version` to reuse the receipt and ZIP hash without fetching stable metadata.
The CFT cache is a test dependency and is excluded from the package.

The measurement runner records package logical/allocated bytes, optional macOS
ZIP size, startup, input, streaming tools, three browser tabs, background work,
3,000-file search, 8 MiB PTY output, cleanup and exit. Each of three rounds takes
at least ten one-second samples per stage. The committed `measure-budgets.json`
is hashed into every report before measurement; failed budgets cannot be relaxed
after a run. Round one uses a fresh profile and later rounds reuse it. OS caches
are not cleared. Input timing ends at the second renderer animation frame, not
the physical display. RSS/WorkingSet sums may count shared pages more than once.
CPU uses cumulative counter differences for observed owned processes, including
the engine and helpers. Energy and unsupported wakeup counters remain explicitly
unavailable. Stage records are persisted before asynchronous work; incomplete
workloads or missing required measurements cannot exit successfully. A local ZIP
size sample does not replace a signed installer receipt.

Packaged smoke and performance runs retain the production single-instance
identity even with a private test profile. Quit any other Klaus installation
first; the runners must not remove its socket or bypass its lock.

Reports and application output belong under ignored `release/`. Retain only the
review artifact and relevant reports; remove earlier candidate apps, one-off
profiles, and diagnostic dumps. No release path reads the user's Chrome profile.

## Signed release gates

`packaging/macos-signing.mjs` supplies public `@electron/osx-sign` options for the
release pipeline. Inspect a plan without signing anything:

```sh
node apps/desktop/scripts/print-mac-signing-plan.mjs /absolute/Klaus.app \
  --identity 'Developer ID Application: Your Name (TEAMID)'
```

The plan includes the copied engine, native addon, speech helper, recording
helper, PiP producer and Computer Use helper explicitly,
keeps hardened runtime enabled, and grants `com.apple.security.device.audio-input`
to the main application and speech helper. The app also retains JIT and browser
camera entitlements. The Rust engine embeds V8 and separately receives JIT
permission. The native addon, recording helper, PiP producer and Computer Use
helper receive no additional entitlements.
Electron's framework/renderer/GPU options use the official signer's defaults.
`Info.plist` declares `NSMicrophoneUsageDescription` and
`NSSpeechRecognitionUsageDescription`. The plan requires an explicit identity and
does not disable the signer's identity validation.

From the repository root, `npm run desktop:package -- --bundle <candidate>
--out <fresh-output> --origin <https-origin>` signs a copy of a verified clean
candidate. The candidate's client commit, engine gitlink, version and target
must match the release checkout. macOS verifies every signed Mach-O, notarizes
and staples the application and DMG, and produces a signed ZIP for updates.
Windows signs the application and NSIS installer with Authenticode. Both retain
the original resource proofs and create a separately signed receipt and update
metadata with the shipping Ed25519 key. The command does not install or publish.
Do not replace original resource hashes with post-sign hashes or pass a signed
bundle through the unsigned verifier.

Actual signature, first-install/manual-replacement, E1-to-E2 update and performance
results are recorded separately from the implementation. An existing Tauri
installation is replaced manually. macOS and Windows automatic updates require
the default data profile: ShipIt and the NSIS desktop Shell relaunch do not
inherit a custom profile's process environment. Custom profiles use a manual
replacement followed by startup with the same profile configuration. Full
updater tests use a separate OS account or VM. Signing code,
unit tests and Rosetta execution do not prove a real update or physical Intel
hardware acceptance. Platform reports under `apps/desktop/dist/*-logs/` keep
the commands, original output and remaining external prerequisites.

Official APIs used: [Electron distribution](https://www.electronjs.org/docs/latest/tutorial/application-distribution),
[ASAR behavior](https://www.electronjs.org/docs/latest/tutorial/asar-archives),
[Packager options](https://packages.electronjs.org/packager/v20.0.4/interfaces/Options.html),
[Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses).
Signing APIs: [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing),
[@electron/osx-sign](https://github.com/electron/osx-sign).
