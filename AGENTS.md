# AGENTS.md

Guidance for people and coding agents working in the Klaus desktop repository.

## Repository

- This is the Electron desktop client. `main/`, `preload/` and `shared/` are the TypeScript host; `frontend/` is the UI (with `bridge/`, which publishes `window.klaus`); `native/` holds the native addon and platform helpers.
- The Rust engine is the submodule `engine/klaus-agent-rust` (https://github.com/meitianwang/klaus-engine). `engine/scripts/` stages it for development and packaging. Changes that belong in the engine are made and pushed there first, then this repository advances the submodule pointer.
- `resources/` holds what the application ships; build outputs under it (`resources/bin`, `speech`, `recording`, `pip`, `computer-use`) are ignored.
- Every path in code, scripts and tests is relative to this repository's root. Do not reference anything outside it.

## Public repository rules

- This repository is public. Never commit credentials, private hostnames or IP addresses, personal email addresses, real names, or machine-specific paths. Test values must be obviously synthetic (`example.invalid`, `user:secret@example.com`).
- Deployment-specific identities are data, not code. Build editions come from `contracts/desktop-editions.json` plus an optional external file (`KLAUS_DESKTOP_EDITIONS_FILE` / `--editions-file`); code decides behaviour from edition fields such as `legacyIdentity`, never from an edition id or an organisation name.
- First-party plugins that are distributed separately are injected at build time (`--official-plugins-dir`, `--bundle-official-plugin`) or, in development, through `KLAUS_OFFICIAL_PLUGINS_DIR`. Tests that need them fail with an explicit message when the variable is missing.
- Comments, docs, commit messages, test names and user-visible copy describe what this code does on its own terms. They never say a design was taken from another product. Names of the model sources, login providers and import sources Klaus integrates with are product surface and stay as they are.

## Engine contract

- Every client reaches the engine through one surface: the app-server JSON-RPC facade (`session/*`, `engine/*` named methods). Adding a capability means adding a named facade method first; there is no generic op passthrough. Details: `engine/klaus-agent-rust/docs/host-integration-seams.md`.
- Plugins belong to the engine: it owns `~/.klaus/plugins/installed_plugins.json` and loads enabled plugins itself. The desktop prepares marketplace content and hands a package directory to `session/installPlugin`; it never flattens plugin components into the session init.
- Wire behaviour is pinned by committed vectors in `contracts/vectors/`. A behaviour change updates the vector deliberately, in the same commit, with the reason stated.

## Testing

- `npm run typecheck`, `npm run typecheck:frontend`, `npm run test:frontend` (bun), `npm run test:host` (host suites under Electron's Node runtime), `node scripts/test-packaging.mjs`, and the aggregate `npm test`. Run the narrowest set that covers a change.
- Before launching an Electron GUI test, run `node scripts/electron-test-preflight.cjs`. Committed GUI launchers use `spawnElectronGui` / `spawnElectronGuiSync` from that file; never bypass the preflight.
- Changes to IPC channels, routing registration, renderer bridge contracts or role permissions require a passing `npm run audit:command-map`, which prepares the engine and starts Electron.
- Do not write tests that check this client by comparing it against another implementation; pin behaviour with committed vectors instead.
- Raw command output belongs in durable logs under `dist/*-logs/`, not in prose.
