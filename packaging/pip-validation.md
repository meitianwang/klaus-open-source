# PiP resource mapping validation

Date: 2026-09-08. This slice adds the macOS PiP producer to the existing Electron
resource contract. It does not rebuild the old application candidate, run capture,
sign a bundle, or claim completion of the final application package.

## Contract

- `resolveDesktopPaths().pipProducerPath` resolves
  `resourceRoot()/pip/<platform-arch>/klaus-pip-producer` on macOS; Windows returns
  `undefined`. The producer and its adjacent `.json` stay outside ASAR.
- `package.mjs --pip-dir <directory>` selects an explicit macOS artifact; the
  default is `resources/pip/<platform-arch>`. Windows rejects this option before
  reading build inputs. The package manifest records `pip` provenance and both
  resource hashes. The installed verifier requires one selected target and the
  exact executable/manifest pair; it rejects any Windows PiP directory or field.
- The producer fingerprint preserves the named, NUL-delimited input order used
  by `native/pip/build.mjs`. The addon fingerprint includes the three PiP files
  from `native/scripts/build.mjs`. Integrate native commit `a329dbf5` before using
  this package entry; old addon artifacts that lack this proof are rejected on
  both platforms. Windows still has no native producer.
- The macOS signing plan explicitly includes the producer among five copied
  executables/libraries, with hardened runtime and no extra media entitlement.
  Screen Recording access remains the native runtime's existing permission flow.

## Gates

Commands ran only in the agent's isolated worktrees:

```text
Mac: <mac-packaging-worktree>
Windows: <windows-packaging-worktree>
```

On both platforms:

```sh
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
node --test apps/desktop/packaging/resources.test.mjs apps/desktop/packaging/installers.test.mjs
```

Original build output included `tsc -p tsconfig.json --noEmit`,
`tsc -p tsconfig.build.json`, and
`bundled 5 preload(s) -> dist/preload/ (main, artifact, quick-input, canvas, recorder)`.
Both exited 0 with no compiler warnings. Original test totals:

```text
Mac:     # tests 20 / # pass 20 / # fail 0 / # skipped 0
Windows: ℹ tests 20 / ℹ pass 20 / ℹ fail 0 / ℹ skipped 0
```

The initial Mac run had 19 passes and one fixture cleanup failure:
`Path is a directory: rm returned EISDIR`. Adding `recursive: true` to the
fixture's empty-directory removal fixed that test harness error. Production
resource validation was unchanged by that correction.

Path checks used the existing Electron executable strictly in Node mode:

```sh
# Mac
ELECTRON_RUN_AS_NODE=1 release/macos-recording-candidate/Klaus-darwin-arm64/Klaus.app/Contents/MacOS/Klaus apps/desktop/dist/tests/desktop-paths.test.js
# Windows Git Bash
ELECTRON_RUN_AS_NODE=1 ./release/windows-recording-excluded/Klaus-win32-x64/Klaus.exe apps/desktop/dist/tests/desktop-paths.test.js
```

Original output on each platform:

```text
desktop-paths: 4 passed, 0 failed, 0 info
```

Windows additionally ran the real CLI rejection and read-only candidate check:

```js
// node --input-type=module, from the Windows checkout root
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { verifyPackage } from './apps/desktop/packaging/verify.mjs';
const result = spawnSync(process.execPath,
  ['apps/desktop/scripts/package.mjs', '--pip-dir', 'nonexistent'], { encoding: 'utf8' });
assert.equal(result.status, 1);
assert.match(result.stderr, /--pip-dir is only valid for a macOS package/);
console.log(JSON.stringify({ windowsPipOptionRejected: true,
  error: result.stderr.split('\n').find(line => line.startsWith('Error: ')) }));
const report = verifyPackage('release/windows-recording-excluded/Klaus-win32-x64');
assert.equal(report.target, 'win32-x64'); assert.equal(report.pipSha256, undefined);
console.log(JSON.stringify({ existingCandidateVerified: report.verified,
  target: report.target, pipExcluded: true, newApplicationBuild: false }));
```

Original output:

```json
{"windowsPipOptionRejected":true,"error":"Error: --pip-dir is only valid for a macOS package\r"}
{"existingCandidateVerified":true,"target":"win32-x64","pipExcluded":true,"newApplicationBuild":false}
```

## Immutable artifact proof

This command reads native-owned source and immutable artifacts; it does not alter
that worktree or run a native build:

```sh
node --input-type=module <<'JS'
import { validateNative, validatePip } from './apps/desktop/packaging/resources.mjs';
const nativeRoot = '<native-worktree>/apps/desktop/native';
const directory = `${nativeRoot}/artifacts/pip-a329dbf5/darwin-arm64`;
const native = validateNative(directory, nativeRoot, { platform: 'darwin', arch: 'arm64' });
const pip = validatePip(directory, { platform: 'darwin', arch: 'arm64', sourceRoot: `${nativeRoot}/pip` });
console.log(JSON.stringify({ nativeSourceCommit: native.manifest.sourceCommit, nativeSha256: native.manifest.sha256, nativeSourceSha256: native.manifest.nativeSourceSha256, pipSourceCommit: pip.sourceCommit, pipSha256: pip.sha256, pipSourceSha256: pip.sourceSha256, verified: true }));
JS
```

Original output:

```json
{"nativeSourceCommit":"a329dbf5152b7f4e96a3aae5a365ecd61d70d390","nativeSha256":"b58da548020e3a617b020263134b9453d0ef0b1eb1837fc65084821936a39de8","nativeSourceSha256":"52d68bb35c38a5d214cffc4c4fee1835df95f57d3f17d1f74f8711d34662ebb8","pipSourceCommit":"a329dbf5152b7f4e96a3aae5a365ecd61d70d390","pipSha256":"37d3e60063275c9da20c3cbca1628c73b46f33a250fa6ffe3e5f24ba18fec486","pipSourceSha256":"4a4c49fdff8a9db8c034c64f8bbb0c23302cda298d0e0bbdf346ef0d78d8c78a","verified":true}
```

The exact resources were also copied into an isolated bundle layout, checked
through the installed resource validator and path resolver, then removed:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { copyTree, inventory, validatePip } from './apps/desktop/packaging/resources.mjs';
import { verifyPipResource } from './apps/desktop/packaging/verify.mjs';
import { macSigningOptions } from './apps/desktop/packaging/macos-signing.mjs';
import paths from './apps/desktop/dist/main/app/paths.js';
const nativeRoot = '<native-worktree>/apps/desktop/native';
const source = join(nativeRoot, 'artifacts/pip-a329dbf5/darwin-arm64');
const pip = validatePip(source, { platform: 'darwin', arch: 'arm64', sourceRoot: join(nativeRoot, 'pip') });
const temporary = mkdtempSync(join(resolve('release'), '.pip-layout-'));
try {
 const app = join(temporary, 'Klaus Review.app'), resources = join(app, 'Contents/Resources');
 for (const file of ['klaus-pip-producer', 'klaus-pip-producer.json']) copyTree(join(source, file), join(resources, 'pip/darwin-arm64', file));
 assert.deepEqual(verifyPipResource(resources, { platform: 'darwin', arch: 'arm64', pip }), pip);
 const resolved = paths.resolveDesktopPaths({ appRoot: join(resources, 'app.asar'), resourcesPath: resources, packaged: true, platform: 'darwin', arch: 'arm64' });
 assert.equal(resolved.pipProducerPath, join(resources, 'pip/darwin-arm64/klaus-pip-producer'));
 const signing = macSigningOptions({ app, arch: 'arm64', identity: 'Developer ID Application: Fixture (ABCDEFGHIJ)', electronVersion: '44.2.0' });
 assert(signing.binaries.includes(resolved.pipProducerPath));
 console.log(JSON.stringify({ resourceLayoutVerified: true, files: inventory(resources).map(file => file.path), executeMode: (statSync(resolved.pipProducerPath).mode & 0o777).toString(8), pipSha256: pip.sha256, explicitSigningBinaries: signing.binaries.length, appLaunched: false, signed: false }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
console.log(JSON.stringify({ temporaryResourceTreeRemoved: !existsSync(temporary) }));
JS
```

Original output:

```json
{"resourceLayoutVerified":true,"files":["pip/darwin-arm64/klaus-pip-producer","pip/darwin-arm64/klaus-pip-producer.json"],"executeMode":"755","pipSha256":"37d3e60063275c9da20c3cbca1628c73b46f33a250fa6ffe3e5f24ba18fec486","explicitSigningBinaries":5,"appLaunched":false,"signed":false}
{"temporaryResourceTreeRemoved":true}
```

The final clean application build, matching Windows addon artifact, signed
producer, notarization, capture from the final package, and two-version update
replacement remain integration/release gates. The retained older candidates are
not evidence that those newer application behaviors or resources have shipped.
