# Computer History runtime boundary

Computer History keeps a private, on-device timeline of the apps and windows
the person uses, so the agent surface can understand recent context. It shares
one design rule with Computer Use: the native helper observes, the host owns
lifecycle, policy and storage, and nothing is uploaded anywhere.

## Collection boundary

- macOS only. The native helper (`watchHistory` mode) records application
  activations and focused-window titles through accessibility APIs, plus an
  http(s) document URL when the app exposes one. It never takes screenshots,
  never records audio and does not need the screen-recording permission.
- Private-browsing windows are never recorded: the native side drops frames
  whose title or URL matches a private-browsing marker, and the host repeats
  the check before anything reaches the store (double insurance).
- Local file paths never enter the ledger; only http(s) URLs are kept.
- A missing accessibility permission degrades to a pinned
  `unavailable` frame (`macos-accessibility-permission-required`); the host
  rolls the durable enable switch back instead of pretending to run.

## Frame protocol (native → host)

The watch is one long-lived child, armed by a framed request
(`method: "watchHistory"`) and stopped by a framed `{"stop":true}` line on
stdin, with a kill fallback. It prints `klaus-history-watch-started` on stderr
when the observation loop is live, and JSON frames on stdout:

- `{"event":"appActivated","bundleId"?,"name","pid","at"}`
- `{"event":"windowTitle","bundleId"?,"title"?,"url"?,"at"}` (`at` is epoch ms)
- `{"event":"unavailable","reason"}` — the watch exits by itself afterwards
- `{"event":"stopped"}` — the graceful-stop acknowledgement

Consecutive identical observations are deduplicated natively. The pump is
bounded (24 h) and exits when the parent dies.

## Host service

`main/services/computer-history/service.ts` serializes every lifecycle
mutation and exposes the aligned method surface: `start` / `status` / `pause`
/ `resume` / `stop` / `getSettings` / `updateSettings` /
`updateObservationPolicy` / `clearHistory`. The desired state survives
restarts through the `computer_history.enabled` settings key (autostart);
pause is session-level and never rewrites it. An unexpected child exit while
the desired state is running restarts with bounded backoff (1 s doubling to
60 s, reset once the watch arms again).

## Observation policy

Persisted under `computer_history.observation_policy` as
`[{observe:"include"|"exclude", scope:"app"|"url", target}]` (at most 256
entries; app targets are bundle identifiers, url targets are domains).
Decision semantics: with no include entries everything except exclusions is
observed; once any include entry exists only included targets are observed,
minus exclusions. URL entries match the frame URL's host (subdomains
included); frames without URL data simply never match url entries.

## Storage and retention

`<configRoot>/computer-history/events.jsonl` — one JSON entry per line
(`kind:"app"|"window"`, `at`, identity fields). Retention is 48 hours with a
20 000-entry cap, pruned every 15 minutes while observing and at every start.
Pruning and clearing regenerate the per-day Markdown digest under
`<configRoot>/computer-history/memory/<local-date>.md`. `clearHistory`
accepts the intervals `all`, `last-day` and `last-hour`.

## Organization management

The same admin-provisioned `managed-computer-use.json` that governs Computer
Use carries `computerHistoryEnabled`. When it is false (or the file is
unreadable, which fails closed), enabling is refused with
`Computer History is blocked by your organization's policy.` and the settings
payload reports `managedDisabled`.

## Agent context integration

When Computer History is enabled on macOS (and not blocked by organization
policy), local owner conversations receive the read-only `read_computer_history`
host tool (`main/services/computer-history/tools.ts`) and its companion
`### Computer History` developer-instructions section (`session-init.ts`).
Friend task conversations and remote-workspace conversations never receive the
tool and are refused at execution time as well. Toggling the enable switch in
Settings marks idle session bindings stale so open conversations pick up the
updated tool set on their next message.

## IPC surface

Settings-window channels, group `computer-history-settings`:
`settings:computer-history:{get,set-enabled,pause,resume,update-observation,
remove-observation-entry,clear-history,entries}`. The renderer bridge exposes
them as `klaus.settings.computerHistory`. The settings tab is macOS-only.

Contract vectors: `contracts/vectors/computer-history-vectors.json` (frame
protocol, retention budget, policy decision table, private markers, wording,
channels) and the managed schema keys in
`contracts/vectors/computer-use-governance-vectors.json`.

Run the tests with the shipped Electron Node runtime:

```sh
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
node apps/desktop/scripts/run-tests.mjs computer-history
node --test apps/desktop/native/scripts/computer-history-watch.test.mjs
```
