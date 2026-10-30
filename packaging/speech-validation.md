# macOS speech packaging validation

Recorded 2026-09-08 in the isolated `electron-packaging` worktree. The local
unsigned candidate uses clean engine `37e04050`, production native `a9811446`,
and the immutable speech helper from clean `d0c9420`. The source/build-script
fingerprint was reconstructed from the three committed speech source files:

```sh
node --input-type=module - <<'NODE'
import { speechSourceFingerprint } from './apps/desktop/packaging/resources.mjs';
console.log('speechSourceSha256:', speechSourceFingerprint('apps/desktop/native/speech'));
NODE
```

```text
speechSourceSha256: ddf4c1c0d3500c9b01e6292110c91c6853bccf6943cdf1c40d8b2903d3ee1621
```

The source-only prerequisite commit `57fb1142` copies files already present in
the integration branch. It does not need a second integration cherry-pick.
The package records that commit and `clientTreeDirty:true`; it is not described
as a final clean client release.

Build command, from the packaging worktree:

```sh
npm --prefix apps/desktop run package \
  --engine-dir <mac-candidate-worktree>/resources/bin/darwin-arm64 \
  --engine-commit 37e04050d3a8f6c41484b88094966e13c8e9196c \
  --native-dir <native-worktree>/apps/desktop/native/artifacts/mcp-a9811446/production \
  --speech-dir <mac-candidate-worktree>/resources/speech/darwin-arm64 \
  --electron-zip <electron-cache>/e71119b693128a03929bf5e755df56603f029607147c8d8c878eaab9ab75093c/electron-v44.2.0-darwin-arm64.zip \
  --out <mac-packaging-worktree>/release/macos-speech-candidate
```

Original output excerpts:

```text
bundled 5 preload(s) -> dist/preload/ (main, artifact, quick-input, canvas, recorder)
Packaging app for platform darwin arm64 using electron v44.2.0
```

The actual bundle verifier printed `appFiles:218`, `resourceFiles:1488`,
`appAsarBytes:2453692`, `resourceBytes:123663904`, `verified:true`. Its speech
identity was `speechSourceCommit:d0c9420cd1bb0df65dccece51e3b37dbb3723fab` and
`speechSha256:92e7d154be6ad2a32766303c8f8a11de4fc3c4fddb6019bad9e9b099b6776c96`.
The engine SHA remained
`1c7532e37a9777090d3582435caaf49fc885845ebe9e5a78f6ed4e3b90ec9e31`.

Command:

```sh
node apps/desktop/scripts/smoke-package.mjs \
  release/macos-speech-candidate/Klaus-darwin-arm64/Klaus.app \
  --output release/macos-speech-candidate/smoke.json
```

Original output:

```text
ok packaged Node mode loads app.asar and the production addon in this process
ok packaged speech helper probes without requesting access and the app declares voice purposes
ok packaged native messaging launcher replies and removes its endpoint
ok the untouched production entry opens the packaged frontend with an isolated preload
ok packaged artifact frontend renders owned media through the range-capable private protocol
ok packaged WebContentsView loads a real page and CDP edits that same sandboxed page
ok one packaged Rust engine belongs to the Electron process
ok normal application shutdown drains native resources and leaves no children
packaged-smoke: 8 passed, 0 failed
```

The real helper's `--probe` response, retained in the smoke report:

```json
{"channels":1,"sampleRate":16000,"format":"s16le","type":"capabilities","authorization":0,"onDevice":true,"seq":1,"available":true}
```

This response establishes executable loading and the protocol. It does not mean
speech permission was granted or that live microphone transcription was tested.
The same smoke reads the actual app's `Info.plist` via `plutil` and requires
nonempty microphone and speech-recognition usage descriptions.

On both macOS and Windows, `npm --prefix apps/desktop run package:test` printed
`tests 11`, `pass 11`, `fail 0`; the compiled `desktop-paths.test.js` printed
`desktop-paths: 4 passed, 0 failed, 0 info`. Windows rebuilt successfully through
the formal package entry. Reading the finished Windows candidate's resources
and manifest printed:

```text
{"speechDirectory":false,"speechManifestField":false,"windowsExecutableStat":{"size":246218240,"blocks":480896,"blksize":4096}}
```

Scanning each saved package build log with
`lines.filter(line => /\bwarn(?:ing)?\b/i.test(line))` returned no warnings.
The Mac output was `{"packageBuildWarnings":0}` and the Windows output was
`{"packageBuildWarnings":0,"warnings":[]}`.

Command, using an explicit review-only placeholder identity:

```sh
node apps/desktop/scripts/print-mac-signing-plan.mjs \
  release/macos-speech-candidate/Klaus-darwin-arm64/Klaus.app \
  --identity 'Developer ID Application: Review Only (ABCDEFGHIJ)'
```

Original fields were
`operation:review-only-signing-plan`, `performedSigning:false`,
`performedNotarization:false`, `identityValidation:true`, with
`com.apple.security.device.audio-input` in both the main app and speech helper
options. The pure configuration uses the public `@electron/osx-sign` API.
Developer ID signing, notarization, post-sign file inventory, live microphone
transcription and the final integrated performance matrix remain unverified.
