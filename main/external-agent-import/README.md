# External agent import

`ExternalAgentImportService` implements the existing detect/import/status UI contract for eight ecosystem layouts. It is a format importer, not another engine. Register it with `registerExternalAgentImportHandlers(registry, service)`.

Construction takes `home`, `workspaces`, the named facade `request`, existing `skills`, `hooks`, `mcp`, and `plugins` owners, and an `onChanged` callback. On Windows pass the host's `APPDATA` as `appData` when it differs from `home/AppData/Roaming`. `platform` and `now` are optional fixture inputs. Shutdown calls `close()`; drain shared acquisition owners alongside this service so a pending shared plugin download can be cancelled by its owner.

The three channels are `external-agent-import:detect`, `external-agent-import:import`, and `external-agent-import:status`. Import keeps `{ok, imported, errors, projectRoots, changed, mcpChanged}`; status keeps `{importedSessionCount, latestImportedAtMs}`. Partial committed changes remain counted and refresh is attempted even when a later item fails.

Files are resolved from the known provider layout, not renderer-supplied destination paths. Project destinations must have been detected or registered. Existing extension children and instruction files are preserved. Copying rejects escaped symlinks, special files, unsupported Windows names, oversized content and cycles. The committed Tauri detection and disk-import vectors are consumed unchanged. The vector fixture uses its declared macOS app-data layout on both test hosts; separate coverage checks native Windows app-data and drive paths.

Global settings import only missing `allow`, `deny`, `ask`, `model`, and `outputStyle` keys through versioned `config/batchWrite`. Hooks use the existing hook mutation queue and `hooks/read`/`hooks/write`. MCP uses `McpConfigurationService.importJson`, including its actual live reload. Plugins use the installed plugin owner, with an explicit existing-install enable path; no second installed-plugin ledger or flattened components are written.

Claude/Qoder JSONL, Codex `archived_sessions` JSONL and Kiro `.chat` become bounded user/assistant messages for `engine/importExternalSession`. Tool records remain marked text; they are never native tool executions. Missing original message timestamps are omitted. Source reads are stable regular-file descriptors and normalized messages observe the engine's 10,000-message, 1 MiB/message, 8 MiB total-text and 16 MiB request limits. The engine additionally validates its complete header size.

The source realpath and SHA-256 determine the UUID. Only `{threadId, persisted:true, alreadyImported, messageCount}` confirms an import. A dropped reply produces no host receipt; exact retry relies on engine idempotency. Changed source bytes get a new UUID. Legacy host ledger entries are upgraded through the named method rather than treated as engine history. The engine alone writes rollouts. Projectless imports create no project binding or sidebar root, and imports never activate a project. Read-only inspection uses `engine/readThread`, not a model session.

## Isolated verification

From the repository root:

```sh
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
node apps/desktop/scripts/run-import-feedback-test.mjs --node-only
```

Mac arm64 and Windows x64 original output:

```text
external-agent-import: 20 passed, 0 failed, 0 info
feedback: 12 passed, 0 failed, 0 info
```

The initial fixture used the wrong contract directory, missing-project inputs, and tree mask; those were corrected to the committed fixture's actual materialization. An added MCP-key sort was removed after the unchanged vector showed that source order is significant. No vector was rewritten to accept a porting difference.

The explicit live gate requires a clean engine containing the new facade:

```sh
KLAUS_ENGINE_BINARY=/absolute/path/to/klaus-agent-stdio ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/desktop/dist/tests/external-agent-import-live.test.js
```

Mac arm64 engine `468700e8540f3877e801bfa525f6f5a8d044b89b`, binary SHA-256 `8bf239be18253e95472a032774fb2cd7cf7603aede757acdc29f47311e4c2f79`, original output:

```text
external-agent-import-live: 5 passed, 0 failed, 0 info
```

This covers TS parsing through a real engine process, a deliberately dropped persisted reply, endpoint restart/idempotent retry, conflict rejection, changed-source identity and shutdown. It performs no inference and reads no real provider data or credentials. The fixture initially omitted its process cwd and assumed `userMessage.text`; it now creates its own cwd and verifies actual `userMessage.content[]`. Windows source/SMTP gates are real; a Windows build of this new engine has not been exercised by this host slice.
