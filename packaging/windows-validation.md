# Bounded Windows package validation

Recorded 2026-09-08 on the Windows x64 `asus` host. All builds and fixtures ran in
the isolated `electron-packaging-win-bbaa3560` worktree. This is a local unsigned
migration candidate, not a production release or a complete Windows acceptance.

The package records client commit `bbaa3560b75bf1373349953a4c9ea2eed4eca136` with
`clientTreeDirty: true`, because this slice and prerequisite build fixes were
copied into that isolated checkout for verification. Its original committed
gitlink remains separately recorded as `50f25c6...`; the explicitly selected and
actually packaged clean engine is `37e04050d3a8f6c41484b88094966e13c8e9196c`.
The final integrated client must be rebuilt from a clean commit.

## Build inputs

Command, from the Windows worktree:

```sh
CARGO_BUILD_JOBS=4 node engine/scripts/prepare-rust-release.mjs --platform win32 --arch x64
node engine/scripts/prepare-rust-release.mjs --platform win32 --arch x64 --verify-only
```

Original output excerpts:

```text
Finished `release` profile [optimized] target(s) in 4m 29s
Finished `release` profile [optimized] target(s) in 1.75s
[rust-release] staged engine binary matches the indexed gitlink 37e0405; reusing without rebuild.
```

The emitted manifest identifies `x86_64-pc-windows-msvc`, clean engine source,
raw release-flags SHA `2dc8accd0d136e3e5e1c21208f552ee328fee9c07d47fa487b15a366cce4f8a3`
and portable recipe SHA `1d9ad9185c48c97932269f466c9e3a3c365ecdf97695a34705900d8feb3a3759`.
The final package verifier printed the following original artifact fields:

```json
{
  "engineCommit": "37e04050d3a8f6c41484b88094966e13c8e9196c",
  "engineArtifacts": [
    { "role": "engine", "file": "klaus-agent-stdio.exe", "sha256": "f662265255ca4990d3942e4900a2bc68644f0e7c272f321e321164720c56e441" },
    { "role": "browserPipeAddon", "file": "klaus_browser_pipe.node", "sha256": "db5dd0b7c9cdcdb591a03b86875693881c1943850ee1428b555a2714bf2202f9" }
  ],
  "nativeSourceCommit": "a9811446002670aaf5809abc66f4c943d795d715",
  "nativeSha256": "cd46a796d47da40851cd2da96783a67b26ebaed4c7ffeb8fc315bd807df67363"
}
```

Command (`<worktree>` expands to this worktree's absolute Windows path):

```sh
npm --prefix apps/desktop run package -- \
  --engine-dir <worktree>/resources/bin/win32-x64 \
  --engine-commit 37e04050d3a8f6c41484b88094966e13c8e9196c \
  --native-dir <worktree>/apps/desktop/native/artifacts/mcp-a9811446/production \
  --electron-zip <worktree>/release/electron-runtime-cache/electron-v44.2.0-win32-x64.zip \
  --out <worktree>/release/windows-candidate3
```

Original output excerpts:

```text
bundled 5 preload(s) -> dist/preload/ (main, artifact, quick-input, canvas, recorder)
Packaging app for platform win32 x64 using electron v44.2.0
```

The verifier's original numeric fields were `appFiles:218`, `resourceFiles:1486`,
`appAsarBytes:2453390`, `engineBytes:90771456`, `nativeBytes:8758272`,
`resourceBytes:117334470`, `verified:true`. The supplied Electron ZIP SHA was
`4021363e3090d67a144ebedb90765cf193b0e61f300c519c83f0174502a481da`, checked
against the exactly locked Electron npm package's official release checksums.

Command for the saved build log:

```js
const lines = fs.readFileSync('release/windows-package3.log', 'utf8').split(/\r?\n/);
const warnings = lines.filter(line => /\bwarn(?:ing)?\b/i.test(line));
console.log(JSON.stringify({ packageBuildWarnings: warnings.length, warnings }));
```

Original output:

```text
{"packageBuildWarnings":0,"warnings":[]}
```

## Actual desktop and Chrome

Command:

```sh
node apps/desktop/scripts/smoke-windows-interactive.mjs \
  release/windows-candidate3/Klaus-win32-x64 \
  --output release/windows-candidate3/interactive-smoke.json
```

Original output:

```text
interactiveSessionId=1
ok packaged Node mode loads app.asar and the production addon in this process
ok packaged native messaging launcher replies and removes its endpoint
ok the untouched production entry opens the packaged frontend with an isolated preload
ok packaged artifact frontend renders owned media through the range-capable private protocol
ok packaged WebContentsView loads a real page and CDP edits that same sandboxed page
ok one packaged Rust engine belongs to the Electron process
ok normal application shutdown drains native resources and leaves no children
packaged-smoke: 7 passed, 0 failed
interactive_exit_code=0
interactive_task_cleanup=removed
interactive_launcher_cleanup=removed
Session report: 1
```

Command:

```sh
node apps/desktop/scripts/smoke-windows-interactive.mjs \
  release/windows-candidate3/Klaus-win32-x64 \
  --chrome release/chrome-test-cache/chrome-win64/chrome.exe \
  --output release/windows-candidate3/chrome-interactive-final.json
```

Original output:

```text
interactiveSessionId=1
ok all four registry keys are absent in both registry views
ok production setup registers the packaged launcher in HKCU
ok official Chrome launches the actual packaged native host with Unicode paths
ok the Windows loopback relay refuses an unauthenticated client
ok task ownership, real page input, isolated globals and screenshot work through the packaged extension
ok task-owned download returns the actual Windows file
ok task shutdown and normal Chrome close remove the native process and discovery file
ok temporary registry keys are removed and the original absent state is restored
windows-chrome-package: 8 passed, 0 failed
{"registryRestored":true}
interactive_exit_code=0
interactive_task_cleanup=removed
interactive_launcher_cleanup=removed
Session report: 1
```

CFT version `152.0.7977.82` came from the official storage.googleapis.com release
URL. Its download receipt and the transferred ZIP agreed on SHA
`460016c1ddba882bf253445175ab240dd947fa349bd720daeb0e311c17e74540`.
No user Chrome profile was read or changed. All four native-host registry keys
were initially absent; the fixture never overwrites an existing registration.

## Defects found during this slice

- Windows ASAR lookup requires host-normalized paths. With the real package,
  `statFile(archive, 'contracts/engine/klaus-app-server.schema.json')` originally
  returned `Error: "contracts/engine/klaus-app-server.schema.json" was not found
  in this archive`; the same call with backslashes returned `size:148339` and
  `extractFile(...).length` returned `148339`. The verifier now converts the
  portable inventory path only at the ASAR API boundary.
- A UTF-8 native-host CMD launcher was parsed in the Windows OEM code page.
  The failed Chrome fixture timed out and created `Klaus 閰嶇疆 with spaces`
  instead of the intended `Klaus 配置 with spaces` relay directory. The launcher
  now selects UTF-8 before CMD reads any path-containing line, with code-page
  command output excluded from native messaging stdout. The real Chrome suite
  above exercises that exact installed launcher.
- PowerShell's default output encoding corrupted the fixture's registry readback.
  The fixture now requests UTF-8 output explicitly. Its independent cleanup
  confirmed `{"registryRestored":true}` before retrying.
- An extracted CFT cache initially lacked AppContainer read/execute access:
  the Chrome log contained `Sandbox cannot access executable` and `0x5`.
  Only the public CFT runtime cache received the documented read/execute ACL;
  sandbox flags and user-data permissions were not relaxed.

Commands `npm --prefix apps/desktop run package:test` on both hosts printed
`tests 9`, `pass 9`, `fail 0`. The compiled `chrome-setup.test.js` run through
the packaged Electron executable printed `chrome-setup: 6 passed, 0 failed, 0 info`
on macOS and Windows. TypeScript and five-preload builds completed without
compiler warnings. The full raw build and smoke logs remain beside the retained
candidate, under the worktree's ignored `release/` directory.

The final successful CFT run also preserves its raw browser stderr separately.
Command `rg -n 'ERROR|WARNING|klaus|native'
release/windows-validation/chrome-interactive-final.json.chrome.log` printed:

```text
3:[22676:25908:0908/210641.510:WARNING:chrome\browser\media\router\discovery\discovery_network_list_win.cc:230] Failed to open WLAN handle: 服务尚未启动。 (0x426)
```

The machine's WLAN discovery service is unavailable. This Chrome diagnostic was
retained; no Windows service or sandbox setting was changed to hide it. The
zero-warning claim above applies to compilation/packaging, not all runtime logs.

Remaining cases include final clean integrated builds, installers/signatures/
updates, macOS x64 execution, installed Chrome/Edge profiles, real keyboard and
global shortcuts, media/voice devices, and the full performance workload matrix.
Session 1 establishes the real desktop environment; programmatic CDP input does
not establish physical-keyboard or global-shortcut acceptance.
