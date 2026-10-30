# Electron update and installer contract

This P5 slice implements the existing three update channels and produces local
Electron-format installer candidates. It does not publish a feed, install into
a user's application directory, or certify a final migrated release. E1 is a
direct Electron installation; there is no Tauri transition release or automatic
cross-framework upgrade.

## Host integration

The composition root creates `createDesktopUpdater({ app, autoUpdater,
resourcesRoot: resourceRoot(), configRoot, emit, log })`, registers
`registerUpdaterHandlers(registry, service)`, calls `service.start()` after
startup, and awaits `service.dispose()` during normal shutdown. `emit` publishes
`updater:status` through the existing push transport. No renderer argument or
environment variable can replace the production public key or turn on updates
for an unsigned candidate.

The channels remain `updater:status`, `updater:check`, and `updater:install`.
Every status has exactly `supported`, `state`, `currentVersion`,
`availableVersion`, and `error`. The states remain `idle`, `checking`,
`downloading`, `downloaded`, and `error`. Check returns after the feed response;
download completion arrives through the status push. Installation returns
`{ok:true,started:true}` only after the platform handoff begins. That response is
not a claim that a replacement application successfully started.

The renderer must remove its ready banner for every state other than
`downloaded`, display installation failures, and leave the download as a user
choice. Background checks run after 30 seconds and every four hours. Repeated
checks share one operation, and an unchanged offer verifies the existing cache
instead of downloading the same installer again. Ordinary shutdown does not
invoke a native updater. A later process does not auto-execute a saved cache.

On macOS the composition root must handle `autoUpdater`'s
`before-quit-for-update` event before its close-to-hide handler. Electron closes
windows before the normal `app.before-quit` sequence for `quitAndInstall()`.
The app's existing shutdown owner still drains the engine and native resources;
do not create another owner or await the install request inside its own drain.
See the public [Electron autoUpdater API](https://www.electronjs.org/docs/latest/api/auto-updater).

## Signed identities and transport

`resources/electron-update.json` is a signed installed policy, not an editable
plain JSON switch. Its envelope has only `payload` and `signature`:

- `payload`: base64 of the exact UTF-8 JSON bytes.
- `signature`: base64 of the four-line Minisign signature text.

The installed payload contains `schemaVersion:1`,
`kind:"installed-update-policy"`, `application:"ai.klaus.desktop"`,
`framework:"electron"`, the exact installed `version`, `platform`, `arch`,
`installer` (`mac-zip` or `nsis`), `channel` (`stable` or `preview`), and an
HTTPS `feedUrl`. macOS also pins its ten-character Developer ID `teamId`.
Windows pins the full Authenticode certificate subject in `publisher`.
The existing Klaus public key is compiled into the production verifier.
Adjacent Windows JSON must be signed because Authenticode on the executable
does not cover that JSON file. The current installed binary must also pass its
OS signature check before `supported:true` is exposed.

The feed returns HTTP 204 when there is no newer compatible release, otherwise
the same two-field signed envelope. The feed endpoint in each installed policy
must know its client version/target, for example by encoding them in its signed
URL path. An equal or lower version in a release envelope is rejected; it is not
an alternate no-update response. Release payload fields are:

```text
schemaVersion: 1
kind: release
application: ai.klaus.desktop
framework: electron
platform: darwin | win32
arch: arm64 | x64
version: strict semver, newer than the installed version
channel: stable | preview
publishedAt: ISO timestamp
expiresAt: ISO timestamp
artifact:
  kind: mac-zip | nsis
  url: HTTPS URL ending in .zip or .exe, respectively
  size: exact byte count, at most 2 GiB
  sha256: lowercase hexadecimal
  sha512: canonical base64
  signature: base64 Minisign ED signature text
```

The signature covers every field above. The verifier rejects a wrong product,
framework, target, channel, installer kind, reused/lower version, expired
metadata, a validity period over 31 days, and stable-channel prereleases.
Old unsigned Tauri feeds and macOS `.app.tar.gz` offers are not accepted.
HTTPS, no credentials, no fragments, no redirects, no encoded transfer bodies,
bounded response sizes, and explicit timeouts apply before any installer sees
the download. HTTP loopback allowance exists only in direct test constructors;
the production factory does not read a bypass from environment or UI settings.

Downloads use a private directory under `configRoot/electron/updates`. Before
the ready state, streaming verification checks size, SHA-256, SHA-512, the
Minisign key ID, the artifact signature, and its trusted comment signature.
Before installation, the service fetches the current offer again and requires
the exact signed payload digest, then rechecks the file. Withdrawal, changed
metadata, tampering, cancellation, and timeouts delete owned partial artifacts
and cannot reach the installer.

Minisign ED needs BLAKE2b-512. Electron's Node uses BoringSSL and does not expose
that digest through `crypto.createHash`; the implementation uses the locked
CommonJS-compatible `@noble/hashes@1.8.0` streaming BLAKE2b implementation and
Node's Ed25519 verifier. The public
[noble-hashes 1.8.0 API](https://github.com/paulmillr/noble-hashes/blob/1.8.0/README.md)
documents its streaming hash interface. Tests include independent published
legacy Ed and prehashed ED vectors from `rust-minisign-verify` 0.2.5, as well as
ephemeral fixture keys. No test private key or trust override enters a package.

## Platform installation

macOS uses a verified ZIP and Electron's public Squirrel.Mac API. Only an
explicit install request starts a private loopback server with unguessable
exact feed/artifact paths; foreign origins, wrong host headers, extra paths,
and writes are rejected. The bridge serves only the already verified ZIP.
Squirrel's `update-downloaded` must arrive before `quitAndInstall()`. The bridge
closes on success, failure, cancellation, timeout, or application shutdown.
The native API has no cancellation method; a late native error remains handled
until app quit. Native staging has platform restart semantics after the user
has explicitly requested installation.

Windows uses a full per-user NSIS installer, not Squirrel.Windows, MSI, or the
old Tauri updater. Both the current executable and downloaded setup executable
must have valid Authenticode signatures with the pinned publisher. NSIS receives
the current executable's directory as the final `/D=...` argument, with
`--updated` and `--force-run`. Spawn is acknowledged before the app begins its
ordinary resource drain. There is no elevation helper or app-data deletion.

The stable Electron NSIS registry GUID is
`3e8bf0c1-fe6e-4fa0-8902-90e1048edb7b`. All subsequent Electron versions must
retain it. It is explicitly separate from identities derived from the former
shell's shared `ai.klaus.desktop` bundle identifier. Installation fixtures use
their own GUID, app ID, executable name, and no Klaus deep-link registration.
This does not claim a completed existing-install rollover test.

This is a controlled adapter allowed by the migration plan. No
`electron-updater` private fields or cancellation hooks are used. Its cache
ownership and native Mac server lifetime could not be injected through its
public API while preserving this host's explicit shutdown contract. The
platform installer is still the established native updater/NSIS mechanism.

## Local installer entry

`electron-builder@26.15.3` packages already verified app candidates through its
public `prepackaged` API. The input is copied with framework symlinks preserved;
the original is verified again after the build. Signing and publication are
disabled for this candidate-only command. The record always states
`buildKind:"local-unsigned-installer"` and `updateEligible:false`.

```sh
node apps/desktop/scripts/package-installer.mjs --candidate \
  --bundle <verified local .app or Windows bundle directory> \
  --out <new output directory>
```

Windows builds run on Windows and may use `--nsis-archive` for the official
offline toolset. Its pinned SHA-256 is
`56997fdefe25e7928a1a68b4583d08b240b66cf660234053b20131a74cc082f4` for
`nsis@1.2.1/nsis-bundle-3.12.tar.gz` from the official
`electron-userland/electron-builder-binaries` release. The checksum is verified
before extraction. Windows uses `%SystemRoot%/System32/tar.exe`; Git Bash tar
misinterprets a drive-letter archive as a remote host. Existing unverified NSIS
tool-directory environment overrides are rejected.

For later signing, the offline verifier can produce the final feed envelope
only after the existing public key verifies metadata and actual artifact bytes:

```sh
node apps/desktop/scripts/verify-electron-update.mjs \
  --metadata release.json --signature release.json.sig \
  --artifact <signed ZIP or NSIS> --platform darwin --arch arm64 \
  --from-version <installed version> --out <new envelope.json>
```

It neither signs nor publishes, and reports `platformInstallationVerified:false`
even when the cryptographic proof passes. It cannot turn an unsigned candidate
into a shipping release.

## Validation recorded on 2026-09-08

All commands ran in `electron-packaging` or its separate Windows worktree.
Both `npm --prefix apps/desktop run typecheck` and
`npm --prefix apps/desktop run build` exited 0 on both platforms, without
compiler warnings. The build's original final line was:

```text
bundled 5 preload(s) -> dist/preload/ (main, artifact, quick-input, canvas, recorder)
```

For each OS, the real unsigned candidate executable ran the compiled suites:

```sh
ELECTRON_RUN_AS_NODE=1 <candidate executable> apps/desktop/dist/tests/updater-policy.test.js
ELECTRON_RUN_AS_NODE=1 <candidate executable> apps/desktop/dist/tests/updater.test.js
ELECTRON_RUN_AS_NODE=1 <candidate executable> apps/desktop/dist/tests/updater-platform.test.js <candidate executable>
```

Original final output after the BoringSSL fix:

```text
updater-policy: 8 passed, 0 failed, 0 info
updater: 12 passed, 0 failed, 0 info
updater-platform: 4 passed, 0 failed, 0 info
```

`updater-policy` and `updater` can enter the normal host gate.
`updater-platform` is a separate platform gate requiring an actual unsigned
candidate argument; it performs real OS signature rejection without installing.
The HTTP/crypto tests do not count as signed two-version installation tests.

Command:

```sh
node --test apps/desktop/packaging/resources.test.mjs apps/desktop/packaging/installers.test.mjs
```

Original output: `tests 16`, `pass 16`, `fail 0`, `skipped 0`.

The only changed pre-existing locked package is `js-yaml` 4.1.1 to 4.3.2, closing
the advisory found while installing the builder. Its host-service regression
command was `ELECTRON_RUN_AS_NODE=1 <Mac candidate executable>
apps/desktop/dist/tests/services.test.js`; original output:
`services: 180 passed, 0 failed, 1 info`. The info is an existing informational
case, not a silently skipped updater check. The new dependencies are pinned;
the unused transitive `electron-winstaller@5.4.0` install script is explicitly
denied rather than granted an installation-script wildcard.

`npm audit --registry=https://registry.npmjs.org --prefix apps/desktop --json`
printed `"vulnerabilities": {}` and `"total": 0`. Fresh npm installation still
reports six upstream deprecation messages from the builder dependency tree
(including rimraf/glob/inflight/boolean). These are recorded, not claimed to be
zero-warning installation logs; TypeScript and actual installer builds are
warning-free.

Actual candidate build commands and hashes are recorded below. Their input app
bundles predate this updater implementation: these runs validate installer
formats and immutable resource layouts, not a final integrated updater UI.

```sh
node apps/desktop/scripts/package-installer.mjs --candidate \
  --bundle release/macos-speech-candidate/Klaus-darwin-arm64/Klaus.app \
  --out release/updater-mac-installer-final
```

The record printed `updateEligible:false`, ZIP size `177985696`, and SHA-256
`753909acf5e1e15735df57bb0a5ca027785b6d7afe3e90d1bb9662515966f880`.
Its source is client `57fb1142` with `clientTreeDirty:true`, clean engine
`37e04050`, production native `a9811446`, and speech helper `d0c9420`.

On the isolated Windows host:

```sh
node apps/desktop/scripts/package-installer.mjs --candidate \
  --bundle release/windows-candidate4/Klaus-win32-x64 \
  --nsis-archive release/nsis-bundle-3.12.tar.gz \
  --out release/updater-windows-installer-e1
```

The build and record projection printed:

```text
  • building        target=nsis file=release\updater-windows-installer-e1\Klaus-0.3.15-win32-x64-setup.exe archs=x64 oneClick=true perMachine=false
```

```json
{"buildKind":"local-unsigned-installer","updateEligible":false,"installer":{"kind":"nsis","registryGuid":"3e8bf0c1-fe6e-4fa0-8902-90e1048edb7b"},"files":[{"file":"Klaus-0.3.15-win32-x64-setup.exe","size":133834045,"sha256":"5ddeeecdfe2722664b06951c75ce68a7d80c894a8e61cf145f967b770e4bc4eb","sha512":"Hk7IYXr2/D8iPI25eYwOaF/Pzd/F0V496gES4zlY9oeIF7GjGrYLeIjNWbUF3u4L/Tvn7MjiJLEQWFhveNBfgw=="}],"buildWarnings":0}
```

The projection command reads the build's `installer-record.json`, selects
`buildKind`, `updateEligible`, `installer`, and `files`, and counts
`/warning|error/gi` matches in its saved build log. The corresponding Mac log
scan printed `{"installerBuildWarnings":0}`. Earlier failed downloads and
Git-Bash tar attempts were fixed by the pinned offline archive and native tar
selection, not by turning the checks off. Only the last successful installer
candidates and their records are retained; the official NSIS tarball is a
reusable build cache, not a runtime resource.

## Remaining P5 release gates

The following are not completed by this slice: composition-root/banner
integration, production HTTPS Electron feed service, signed installed-policy
creation, final clean integrated bundles, recording-helper resource inclusion,
Developer ID signing/notarization/stapling, Windows Authenticode signing,
isolated E1-to-E2 actual installation/restart/rollback, deliberate first-install
data handling with backups, and final package size/startup/idle-resource records.
No live production feed or user installation was changed. Keep later build
records tied to the actual client/engine/native
helper identities instead of relabeling these early candidates as final.
