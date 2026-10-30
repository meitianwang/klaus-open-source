# Klaus application control tools

`KlausControlService` implements the `klaus_query` and `klaus_action` dynamic tools.
It maps a fixed product surface/action catalog to named host handlers. The model
never supplies an IPC channel, renderer ID, engine operation, or transport method.
`registerKlausControlTools(dynamicTools, service)` registers the two definitions;
`productContextNote(platform)` is the application-specific session context note.

## Composition

Create the service with the following trusted dependencies:

- `context(engineSessionId, signal)` resolves the active engine caller into a host
  task identity. The returned `ControlCallContext` carries `sessionId`,
  `unattended`, `signal`, `assertCurrent()`, `dispatch(channel, payload)`, and
  `currentBrowserSessionId()`. Reject absent, private, closed or stale-generation
  callers. Named handler dispatch must retain the captured engine generation and
  signal. The model must not choose the IPC sender or broaden its role.
- `manual()` reads `resolveDesktopPaths().manualPath`. Development uses the single
  `public/klaus-manual.md`; packaged apps use `Resources/manual/klaus-manual.md`.
  The package inventory requires and hashes the resource. There is no checkout
  fallback for an installed app.
- `storedRows()` reads the settings owner's current rows for enumeration. All
  responses pass credential redaction; direct credential-key reads are refused
  before dispatch. This does not add another settings store or credential owner.
- `threadTool(name, payload, context)` calls `ThreadToolsService.execute`. The
  session list/history aliases use its bounded paging and private-thread policy;
  they do not load full UI history or activate another task.
- `navigate({view, tab?}, context)` delivers `app:navigate` to the current main
  renderer after checking its captured owner. Resolve only after actual delivery;
  throw if the renderer or subscription is unavailable. Unknown views and tabs are
  rejected before delivery.
- `preferencesChanged(key, context)` refreshes dependent UI state after storage.
  Reuse the existing settings notification owner instead of creating a second
  config writer.
- `quickInput` supplies actual shortcut registration states, card state, and
  show/hide operations. Shortcut writes use the normal settings handler and then
  verify its actual OS registration receipt. A failed registration is not reported
  as successful merely because SQLite contains the requested string.

Call `close()` while host services can still finish their pending work. It aborts
new work and waits for actual handler promises. It does not mistake an earlier
cancelled response for resource drain. The composition root retains its normal
shutdown deadline and must report a missed deadline rather than claim cleanup.

Application-update handoff needs special composition: the install handler's
`prepareToQuit` callback drains dynamic tools, so it must not wait on its own
calling control operation. A trusted dispatcher can hand off a validated update
to the update owner's tracked background operation and return an explicit
accepted/in-progress receipt. It must not report installation success, discard
later updater errors, or skip draining unrelated control work.

## Behavior and boundaries

The catalog has 57 surfaces and 329 named operations. It accounts for all 452
committed renderer invokes through a model action or a deliberate exclusion;
there are 137 excluded channels. These counts move with every channel added, so
treat them as indicative: `tests/klaus-control.test.ts` is the authority, and it
fails whenever a committed invoke has neither an operation nor an exclusion. The
contract test requires each new channel to receive an explicit decision. Catalog
entries are not implementations: execution must reach the real registered handler
or return its actual error.

The existing destructive/external-action confirmation decisions remain explicit.
A caller must pass `confirm: true` only after the user's agreement. An unattended
run cannot execute a confirm-gated action even with that flag. Global permission
mode cannot be changed here. Raw settings writes cannot bypass named preference,
model, thinking-level or shortcut validation. Disabling the command sandbox and
adding writable roots keep their explicit agreement gate. The audit also closes
indirect protection bypasses: pre-authorization rule edits, allowed-app additions,
automatic hook writes, disabling strict isolation/read confinement, and widening
readable roots now require agreement and are refused unattended. This is an
intentional tightening of the earlier catalog, not a change to engine defaults. Windows roots reuse the
settings owner's drive/UNC validation rather than assuming POSIX paths.

Browser UI channels operate the displayed task. A caller belonging to a different
task is refused and directed to its separate browser MCP tools. The read-only
`browser.tabs` action only permits `list`; it cannot pass a mutation through the
UI channel's multi-action payload. Session-scoped operations receive the trusted
host identity when their optional task field is absent.

Results redact credential fields, environment/header containers, known token
prefixes, serialized objects, URL credentials and auth query parameters, argument
pairs, and inline authentication carriers. Numeric usage counts remain readable.
Other conversations, saved notes, package metadata and server responses are
explicitly treated as untrusted context. Error/`ok:false`/`success:false` responses
remain failed tool results. The public manual and normal result text are bounded
at UTF-8 boundaries.

The parameter hints reflect the current agent-history (`agentId`), teammate
history (`taskId`) and sandbox diagnostic (`operationId`, `networkEnabled`)
contracts. The agent snapshot exclusion is a renderer reconciliation boundary,
not a claim that the handler is an empty implementation.

## Isolated verification

Build and type-check with the ordinary desktop scripts. The unit/contract suite
uses Electron's shipped Node runtime and SQLite:

```
npm run build --prefix apps/desktop
npm run typecheck --prefix apps/desktop
ELECTRON_RUN_AS_NODE=1 <electron> apps/desktop/dist/tests/klaus-control.test.js
ELECTRON_RUN_AS_NODE=1 <electron> apps/desktop/dist/tests/desktop-paths.test.js
node --test apps/desktop/packaging/resources.test.mjs
```

The final Mac and Windows runs each reported
`klaus-control: 21 passed, 0 failed, 0 info`. Both ordinary builds emitted all five
preloads without warnings. `desktop-paths` reported 4 passed on each platform;
the Mac packaging resource suite reported 20 passed, 0 failed. The test entry
defaults to a failing process exit code until its final summary is produced, so
an unresolved promise cannot be reported as an exit-0 run. The SQLite fixture, dispatcher, navigation delivery receipt, pending
handler, and settings notifications are isolated local data; no real account
credentials, installation directory or external service is accessed.

These tests validate catalog decisions, local storage, routing safeguards and
lifecycle boundaries. They do not claim to execute all 298 product operations or
verify the real main-window `app:navigate` subscriber. The composition root's
actual application gate must verify model tool call, handler side effect,
`app:navigate` delivery and renderer navigation using the final application.
