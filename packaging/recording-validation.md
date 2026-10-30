# macOS recording resources

Recorded 2026-09-08 in the isolated `electron-packaging` worktree. This slice
adds the native recording executable to the existing package's explicit resource
and signing plans. It does not change the recording service, runtime composition,
permission settings, or the final release identity.

macOS requires both files at
`resources/recording/darwin-<arch>/klaus-recording-helper[.json]`. The package
option `--recording-dir` selects an explicit immutable staging directory; its
default is the shared resource location. `resolveDesktopPaths()` returns that
absolute resource path in development and in a relocated packaged app. There
is no checkout/artifact fallback in a package. Windows has no recording-helper
path, rejects `--recording-dir`, and rejects recording metadata or a recording
directory in its package verifier.

The source-only prerequisite `e42dcb53` copies the helper's `.m`, embedded
`helper-info.plist`, and `build.mjs` exactly from `9be7d688`; integration already
has those source files and must not cherry-pick that prerequisite again. The
source/build fingerprint and binary proof are independently checked before any
copy. The bundle verifier checks the target, executable mode, exact two-file
layout, inventory, and manifest identity again. The signing plan explicitly
includes this executable with hardened runtime and no extra entitlements.
No App Sandbox or capture-permission bypass is introduced.

Command:

```sh
node --input-type=module - <<'JS'
import { validateRecording, recordingSourceFingerprint } from './apps/desktop/packaging/resources.mjs';
const sourceRoot = 'apps/desktop/native/recording';
const directory = '<native-worktree>/apps/desktop/native/artifacts/recording-9be7d688/darwin-arm64';
const proof = validateRecording(directory, {platform:'darwin',arch:'arm64',sourceRoot});
console.log(JSON.stringify({sourceSha256:recordingSourceFingerprint(sourceRoot),sourceCommit:proof.sourceCommit,sourceTreeDirty:proof.sourceTreeDirty,sha256:proof.sha256}));
JS
```

Original output:

```json
{"sourceSha256":"1e8a88373da829f853fd3b2d84898ff1e86221ecb4a0aab9f8c71d6fc3891953","sourceCommit":"9be7d6889a1237446943609f412763eef8c0ac0e","sourceTreeDirty":false,"sha256":"ee2c41260a2f724c0368e9cbeb62c80c4f0207a5b8efc74899f075ce22f0a08b"}
```

The actual Mac build used the already verified immutable engine/speech resources
from the preceding local candidate, the production native addon, and the clean
recording helper above. A first attempt to use the integration worktree's mutable
engine staging correctly failed with `Engine commit does not match the explicitly
selected source`: its staged engine had advanced from 37e04050 to 3c2cf179. The
artifact was not relabeled. The repeat selected the retained 37e04050 bytes:

```sh
npm --prefix apps/desktop run package -- \
  --engine-dir <mac-packaging-worktree>/release/macos-speech-candidate/Klaus-darwin-arm64/Klaus.app/Contents/Resources/bin/darwin-arm64 \
  --engine-commit 37e04050d3a8f6c41484b88094966e13c8e9196c \
  --native-dir <native-worktree>/apps/desktop/native/artifacts/mcp-a9811446/production \
  --speech-dir <mac-packaging-worktree>/release/macos-speech-candidate/Klaus-darwin-arm64/Klaus.app/Contents/Resources/speech/darwin-arm64 \
  --recording-dir <native-worktree>/apps/desktop/native/artifacts/recording-9be7d688/darwin-arm64 \
  --electron-zip <electron-cache>/e71119b693128a03929bf5e755df56603f029607147c8d8c878eaab9ab75093c/electron-v44.2.0-darwin-arm64.zip \
  --out <mac-packaging-worktree>/release/macos-recording-candidate
```

The build printed `verified:true`, `recordingSourceCommit:9be7d688...`, and
`recordingSha256:ee2c4126...`, with client `e42dcb53` and
`clientTreeDirty:true`. It is a local unsigned candidate, not a final integrated
client build. The original engine hash remains `1c7532e3...`; the resource record
contains all full identities and hashes. Build-log warning scan returned `[]`.

Command:

```sh
node apps/desktop/scripts/smoke-package.mjs \
  release/macos-recording-candidate/Klaus-darwin-arm64/Klaus.app \
  --output release/macos-recording-candidate/smoke.json
```

Original output:

```text
ok packaged Node mode loads app.asar and the production addon in this process
ok packaged speech helper probes without requesting access and the app declares voice purposes
ok packaged recording helper reads capabilities without starting capture or prompting
ok packaged recording helper exits when the owning input pipe closes
ok packaged native messaging launcher replies and removes its endpoint
ok the untouched production entry opens the packaged frontend with an isolated preload
ok packaged artifact frontend renders owned media through the range-capable private protocol
ok packaged WebContentsView loads a real page and CDP edits that same sandboxed page
ok one packaged Rust engine belongs to the Electron process
ok normal application shutdown drains native resources and leaves no children
packaged-smoke: 10 passed, 0 failed
```

The native probe uses `--capabilities` only. The pipe-ownership probe sends no
start command and closes stdin, so no event tap is created and no user input is
captured. Its original result was:

```json
{"recordingProbe":{"version":1,"supported":true,"permissions":{"inputMonitoring":true,"accessibility":true}},"recordingClosedHost":{"exitCode":2,"error":"recording-helper: host-input-closed"}}
```

Those booleans report the current test host's existing permissions. They do not
establish permission for a future Developer ID-signed bundle. Active recording,
permission refusal/regrant for the final signed identity, and owner exit during
active capture remain separate release/integration gates.

On both platforms, `node --test apps/desktop/packaging/resources.test.mjs`
printed `tests 12`, `pass 12`, `fail 0`; `npm --prefix apps/desktop run typecheck`
and `build:main` exited 0 without compiler warnings. The real Electron Node
command `ELECTRON_RUN_AS_NODE=1 <candidate executable>
apps/desktop/dist/tests/desktop-paths.test.js` printed
`desktop-paths: 4 passed, 0 failed, 0 info`. The first Windows signing-plan test
used a hard-coded POSIX suffix; it was corrected to use `path.join` for its
fixture expectation. No production path behavior was changed to make that
assertion pass.

The Windows formal build used the same 37e04050 Windows artifacts and excluded
the new Mac resource. Command, run from its separate Windows worktree:

```sh
npm --prefix apps/desktop run package -- --platform win32 --arch x64 \
  --engine-dir <windows-packaging-worktree>/resources/bin/win32-x64 \
  --engine-commit 37e04050d3a8f6c41484b88094966e13c8e9196c \
  --native-dir <windows-packaging-worktree>/apps/desktop/native/artifacts/mcp-a9811446/production \
  --electron-zip <windows-packaging-worktree>/release/electron-runtime-cache/electron-v44.2.0-win32-x64.zip \
  --out <windows-packaging-worktree>/release/windows-recording-excluded
```

Reading `package-report.json`, its resource manifest, and the saved build log
printed:

```json
{"verified":true,"target":"win32-x64","recordingDirectory":false,"recordingManifestField":false,"buildWarnings":[]}
```

An actual package rejection probe temporarily created an empty `recording`
directory in that private candidate, called `verifyPackage()`, and removed it in
`finally`. The original output confirmed both rejection and restoration:

```json
{"foreignRecordingRejected":"The macOS recording helper leaked into a Windows package","restoredPackageVerified":true,"temporaryFolderRemaining":false}
```

No Windows GUI, registry, installed application, or user profile was changed in
this resource-only verification.
