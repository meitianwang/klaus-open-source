# Skill and plugin marketplace acquisition

This slice supplies seven existing renderer channels. Runtime composition remains
in the application owner; neither registrar creates a second engine or writes the
engine's installed-plugin ledger.

| Channel | Payload | Result and retained behavior |
| --- | --- | --- |
| `skills:market` | Optional `query`, `limit`, `cursor` | Remote rows plus local-only rows; `isRemote`, pagination, dependency status, installed version and known update comparison. A failed remote request returns the local catalog and its actual error. |
| `skills:install` | `name`, optional `version`, `installMissing`, `skipDependencyInstall` | Remote installation first, then the existing local mirror when acquisition fails. Local dependency refusal includes `needsDependencyInstall`, `canAutoInstall: false` and an empty `installCommands`. No dependency command is executed. |
| `skills:install-from-source` | `spec`, optional `name`, `force` | A direct HTTP(S) ZIP URL, including URLs with query strings. Existing skills require explicit `force`; Git, npm and other source types remain explicit errors. This request never obtains a market bearer token. |
| `skills:update` | `slug`, optional `version` | A remote version installation; an unavailable endpoint is an error, with no bundled-version replacement. |
| `skills:upload` | Filename `name`, `buffer` | UTF-8 text, byte arrays and the frontend's strict `__klausBinary` envelope. A `.md` becomes `SKILL.md`; a `.zip` is safely extracted and must contain `SKILL.md`. Other file types are rejected. |
| `plugins:marketplace:add` | `source` | An absolute local directory, Git URL, or GitHub `owner/repo`; returns the declared marketplace name and actual install location. |
| `plugins:refresh` | None | Refreshes the official mirror with Git fallback, then rereads all catalogs. `official.ok` records the upstream outcome separately from the readable catalog result. It does not pull every custom Git marketplace. |

The relevant prior behavior is in `apps/tauri/crates/klaus-shell/src/market.rs`,
`extensions.rs` and `plugins.rs`. The route names and frontend binary envelope are
in `apps/desktop/contracts/channel-table.json` and
`apps/tauri/frontend/bridge/klaus-api.ts`. These implementations do not restore or
compare against the deleted Electron client. Existing plugin facade vectors remain
unchanged: acquiring a marketplace is not installing its plugins.

## Runtime composition

Create `SkillMarketService` with the already registered `SkillService` instance,
an endpoint getter and the same awaited global skill invalidation
callback used by skill toggle/uninstall. Register it with
`registerSkillMarketHandlers(registry, market)`.

The endpoint getter returns `SkillMarketEndpoint | undefined`, synchronously or
asynchronously. `resolveSkillMarketEndpoint({ serverUrl, token, environment })`
selects direct `KLAUS_MARKET_UPSTREAM_URL` / `KLAUS_MARKET_UPSTREAM_BASE_URL` plus
`KLAUS_MARKET_UPSTREAM_TOKEN`, or the account server with the stored token when
one exists. The market is public read-and-install, so a guest without any stored
credential still resolves the account server, only without a bearer token.
Account ownership and stored credential lookup stay in the existing account
service/composition layer. The market service performs no credential file reads.

A local mirror resolves only from an explicit absolute `marketDirectory` or
`KLAUS_SKILLS_MARKET_DIR` (test fixtures and ops): the shipped client bundles no
free catalog anymore, the server hosts it. There is no working
directory or application resource fallback.

Create `PluginMarketplaceService` with `workspaces`, the existing `PluginService`,
the existing named facade `request`, `seedDir`, and an awaited marketplace config
invalidation callback. Register it with
`registerPluginMarketplaceHandlers(registry, marketplaces)`. Do not pass the plugin
mutation callback: this service saves one `marketplaces."<name>"` entry through
`config/batchWrite`, and never sends an install/toggle/uninstall mutation.

Both services expose `close()`. Close acquisition services before closing their
shared skill/plugin services and before shutting down the engine. Closing aborts
HTTP work, reaps Git children, rejects queued mutations and waits for accepted
work. The new `SkillService.withMutation` and `PluginService.withMutation` methods
reserve the same queues used by existing writes, so acquisition cannot race an
uninstall or a plugin-source copy.

## Durable state and failures

Skill installs preserve the existing `skills/.install-records.json` shape and
unrelated fields in `skill:<name>` preferences. A source ZIP or upload retains the
existing enablement behavior. Upload now decodes the envelope the frontend
actually emits; it does not treat the envelope object as a successful empty file.

Downloads are bounded and cancellable. Cross-origin redirects permanently remove
bearer authorization, and HTTPS downloads cannot redirect to HTTP. ZIP extraction
checks expanded bytes, entry count, CRC-32, path traversal, duplicate filenames,
links, special files and Windows reserved filenames. A new private tree replaces
the old tree only after acquisition and manifest validation succeed. Known
metadata failure restores both the prior directory and its metadata.

Marketplace config writes carry the engine snapshot's `expectedVersion`. A lost
or malformed reply is successful only if a fresh engine snapshot proves the exact
entry. An unresolved write returns `ok: false`, `commitUnknown: true` and
`reloadRequired: true`, retaining the candidate and any previous directory backup.
Its error includes the backup path. A committed write whose live invalidation
fails returns the durable-state flag (`installed` for skills, `saved` for
marketplaces) with `reloadRequired: true`, and cannot trigger a local fallback.

Remote marketplaces stay under the profile's `plugins/marketplaces` directory.
Name/source/cache collisions, linked destinations, and seed-managed official
content are refused before replacement. Git runs without a shell or interactive
terminal prompts. The official mirror retains its `latest` commit plus
`marketplaces/claude-plugins-official/` archive prefix and `.gcs-sha` sentinel.
Matching sentinels still require a valid matching marketplace manifest.

## Reproducible gates

The isolated test suites are `skills-market.test.ts` and
`plugin-marketplaces.test.ts`; add `skills-market` and `plugin-marketplaces` to the
application's default suite runner. `extension-market-live.test.ts` is a separate
explicit engine gate and requires an absolute `KLAUS_ENGINE_BINARY`.

Run from the repository root after the desktop dependencies are installed:

```sh
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
ELECTRON_RUN_AS_NODE=1 <electron-executable> apps/desktop/dist/tests/skills-market.test.js
ELECTRON_RUN_AS_NODE=1 <electron-executable> apps/desktop/dist/tests/plugin-marketplaces.test.js
KLAUS_ENGINE_BINARY=<absolute-engine-binary> ELECTRON_RUN_AS_NODE=1 <electron-executable> apps/desktop/dist/tests/extension-market-live.test.js
```

On 2026-09-08 these commands ran on macOS arm64 and Windows x64 in the dedicated
packaging worktrees, with the original summary output on each platform:

```text
bundled 5 preload(s) -> dist/preload/ (main, artifact, quick-input, canvas, recorder)
skills-market: 20 passed, 0 failed, 0 info
plugin-marketplaces: 17 passed, 0 failed, 0 info
extension-market-live: 4 passed, 0 failed, 0 info
```

The executable placeholders above were, respectively:

```text
macOS:
release/macos-recording-candidate/Klaus-darwin-arm64/Klaus.app/Contents/MacOS/Klaus
<own-worktree>/release/macos-recording-candidate/Klaus-darwin-arm64/Klaus.app/Contents/Resources/bin/darwin-arm64/klaus-agent-stdio

Windows:
release/windows-recording-excluded/Klaus-win32-x64/Klaus.exe
<windows-packaging-worktree>/release/windows-recording-excluded/Klaus-win32-x64/resources/bin/win32-x64/klaus-agent-stdio.exe
```

Those retained executables supplied Electron's Node runtime and the clean
`37e04050d3a8f6c41484b88094966e13c8e9196c` engine. This is not a rebuild or validation
of the current whole application. The live gate uses a new HOME/config root, local
Git repositories and a loopback mirror, verifies the real config write and restart
persistence, and creates no model session. All bearer tokens in HTTP tests are
fixture values. No actual account, upstream service, user installation directory,
or existing Chrome profile participates. Windows runs use SSH Session 0 and make
no desktop-interaction claim.

Existing skill and plugin service regressions were also run on macOS by importing
only their two isolated registrars, avoiding the unrelated real-profile
informational test in the broader services suite:

```sh
ELECTRON_RUN_AS_NODE=1 <electron-executable> <<'NODE'
const {mkdtempSync,mkdirSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {Harness}=require('./apps/desktop/dist/tests/harness');
const {registerSkillsHooksStyleTests}=require('./apps/desktop/dist/tests/skills-hooks-styles');
const {registerPluginServiceTests}=require('./apps/desktop/dist/tests/plugin-services');
const h=new Harness(), roots=[];
process.env.KLAUS_TEST='1';
const freshRoot=()=>{const root=mkdtempSync(join(tmpdir(),'klaus-market-regression-'));roots.push(root);return root;};
registerSkillsHooksStyleTests(h,freshRoot);
registerPluginServiceTests(h,freshRoot);
mkdirSync('release/extension-market-validation',{recursive:true});
h.finish('release/extension-market-validation/existing-services.result.json','extension-market-existing-services').then(code=>{process.exitCode=code;}).finally(()=>{for(const root of roots)rmSync(root,{recursive:true,force:true});});
NODE
```

Original output:

```text
extension-market-existing-services: 21 passed, 0 failed, 0 info
```

The required preceding slices are the local-model download/archive dependencies
and services (`f00f045b`, `d2b3bf1c`). This slice adds no package or lock changes.
Runtime wiring and production UI acceptance remain with the integration owner.
Final packaging, signing, and two-version updater verification remain a later P5
gate after the complete application source is stable.
