# MCP device authorization

`McpDeviceService` implements the four existing renderer channels. The GitHub
device grant is a host-owned background task, separate from MCP transport OAuth
and provider subscription sign-in. It does not open a browser, create an engine,
read account credentials, or write a second MCP credential ledger.

| Channel | Input | Result |
| --- | --- | --- |
| `mcp:device:client-id` | `{id, clientId?}` | `{ok: true, clientId}` |
| `mcp:device:start` | `{id}` | `{ok: true, userCode, verificationUri, expiresIn}` |
| `mcp:device:wait` | `{id}` | `{ok: true}` or `{ok: false, error}` |
| `mcp:device:cancel` | `{id}` | `{ok: true}` |

The existing UI branches `unsupported`, `unsupported_provider`, `no_client_id`,
`no_pending`, `cancelled`, `denied` and `expired` remain available. HTTP status
failures use `http_<status>`. The service never returns the device code, access
token, raw response body or token-bearing installer exception. A failed reload
after a durable install retains `saved: true, reloadRequired: true` and returns
`install_failed`.

## Composition

Create one service and call `registerMcpDeviceHandlers(registry, service)`:

```ts
const device = new McpDeviceService({
  configRoot,
  catalog: () => builtins.catalog(),
  install: (payload, signal) => builtins.install(payload, signal),
});
```

`resolveMcpDeviceClientId(configRoot, id, catalogRows, environment)` is synchronous
and accepts the batch already obtained by the built-in list. Its precedence is
`KLAUS_<ID>_CLIENT_ID`, then the existing SQLite row
`mcp-device-client-id:<id>`, then `deviceAuth.defaultClientId` from the catalog.
The client id is public metadata. Saving an empty value clears the user override
and restores environment/catalog resolution. Existing rows need no migration.

The installer receives only `{id, env: {[tokenEnvKey]: accessToken}}` and the
attempt's `AbortSignal`. It must use `McpBuiltinService.install` and the same
`McpConfigurationService` mutation queue as manual MCP changes. That path replaces
declared credential slots, rejects changed transport targets, preserves unrelated
settings and tool policy, enables the server, and awaits the normal reload.
An installer must check cancellation before its durable write; device authorization
cannot roll back a write that was already committed before cancellation.

Call `await device.close()` during host shutdown before closing the MCP owners.
This aborts HTTP requests and queued installations and drains outstanding work.
Do **not** attach cancellation to renderer destruction, dialog close or unmount.
Only explicit cancel, a replacement start for the same id, or host shutdown
terminates authorization. Waiters hold their original attempt; an old waiter
cannot consume or remove its replacement. Terminal results without a waiter are
retained for 15 minutes and contain no grant credentials.

## Protocol boundaries

The service uses `POST /login/device/code` and
`POST /login/oauth/access_token`, with JSON bodies and `Accept: application/json`.
`authorization_pending` retries; `slow_down` adds at least five seconds and
respects a longer server-supplied interval. Network failures and malformed poll
JSON cost one round. No request or credential install begins after local expiry,
and expiry also aborts an in-flight token response.

The default endpoint is `https://github.com`. The existing
`KLAUS_GITHUB_DEVICE_URL` override and injected `baseURL` support isolated tests
and explicitly configured HTTPS hosts. HTTP is accepted only on loopback.
Requests do not follow redirects. Verification links must use the endpoint's
origin. Responses are limited to 64 KiB, public ids and grant fields are bounded,
and token values are passed exclusively to the installer. `fetch`, `env`,
`baseURL` and `requestTimeoutMs` are dependency injection points, not renderer
options; production HTTP requests have a 30 second timeout.

Reference: [GitHub device flow documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
The current product fields are visible in
`apps/tauri/crates/klaus-shell/src/feedback.rs` (device section) and
`apps/tauri/frontend/bridge/klaus-api.ts` (four device calls). No removed client
implementation is used as a test baseline.

## Isolated gates

From the repository root:

```sh
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/desktop/dist/tests/mcp-device.test.js
```

Original output on macOS arm64:

```text
bundled 5 preload(s) -> dist/preload/ (main, artifact, quick-input, canvas, recorder)
mcp-device: 16 passed, 0 failed, 0 info
```

The suite uses actual loopback HTTP, real wall-clock polling, a fresh SQLite
profile, and an injected installer observer. It verifies registration, legacy
preferences, pending/slow-down timing, network retry, expiry, cancellation,
replacement, late waiters, response bounds, redirects, token suppression and
shutdown. The installer observer is not evidence of engine persistence.

Windows x64 was checked in the separate `electron-packaging-win-bbaa3560`
worktree using the same `npm run typecheck --prefix apps/desktop` and
`npm run build --prefix apps/desktop`, followed from Git Bash by:

```sh
ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/electron.exe apps/desktop/dist/tests/mcp-device.test.js
ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/electron.exe apps/desktop/dist/tests/mcp-builtins.test.js
```

Original Windows output was `mcp-device: 16 passed, 0 failed, 0 info` and
`mcp-builtins: 15 passed, 0 failed, 0 info`, with exit code 0 and no compiler
warnings. This is a Node HTTP/SQLite gate, not Windows foreground-interaction
acceptance. This slice has not tested real engine device persistence on Windows.

The separate live gate uses the actual built-in/configuration services and one
real engine. Supply an explicitly verified engine binary:

```sh
KLAUS_ENGINE_BINARY=/absolute/verified/klaus-agent-stdio ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/desktop/dist/tests/mcp-device-live.test.js
```

The measured macOS run supplied
`<engine-staging>/resources/bin/darwin-arm64/klaus-agent-stdio`.
`shasum -a 256` on that file returned
`8bf239be18253e95472a032774fb2cd7cf7603aede757acdc29f47311e4c2f79`.
Original output:

```text
mcp-device-live: 5 passed, 0 failed, 0 info
```

It verifies actual named config writes, device reauthorization and unrelated MCP
edits in the same queue, policy preservation, persistence across an engine
restart, cancellation while queued, and zero remaining engine processes. All
HTTP hosts and credentials are fixtures. It does not contact GitHub, open an
authorization browser, activate a model, or test a real account grant.

The live test depends on the built-in/configuration owner slice originally
committed as `7d71f21a`; it must not be run against an installer stub. The default
host runner should add `mcp-device`; add `mcp-device-live` only to an explicit gate
with a staged real engine. Both suites clean their own temporary profiles.
