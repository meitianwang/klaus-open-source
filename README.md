# Klaus Desktop

[简体中文](README.zh-CN.md) · [Website](https://klaus-ai.cn) · [Engine](https://github.com/meitianwang/klaus-engine)

Klaus is an AI agent desktop application. It combines conversations with tools that work on your projects, drive a browser, and carry out multi-step tasks with explicit permissions. This repository holds the Electron desktop client; the Rust agent engine lives in [klaus-engine](https://github.com/meitianwang/klaus-engine) and is mounted here as a submodule.

## What is in this repository

- `main/`, `preload/`, `shared/` — the Electron host: sessions, IPC, permissions, extensions, the single engine process it owns.
- `frontend/` — the desktop UI.
- `native/` — the native addon and platform helpers (speech, recording, picture-in-picture, Computer Use).
- `engine/klaus-agent-rust` — the engine submodule; `engine/scripts/` stages it for development and packaging.
- `resources/` — resources the application ships: built-in plugins, canvas recipes, workspace runtime, the user manual.
- `contracts/` — committed contract vectors that pin host and engine wire behaviour.
- `packaging/`, `scripts/` — packaging, verification and test runners.

## Requirements

- Git, Node.js 22.12 or newer, and npm; Bun for the frontend test suite.
- Rust and Cargo (the toolchain is pinned in `rust-toolchain.toml`).
- Native build tools: Xcode Command Line Tools on macOS, Visual Studio Build Tools on Windows.

## Build and run

```sh
git clone --recurse-submodules https://github.com/meitianwang/klaus-open-source.git klaus-desktop
cd klaus-desktop
npm ci
./dev.sh --profile="$HOME/.klaus-desktop-dev"     # Windows: dev.bat --profile="%USERPROFILE%\.klaus-desktop-dev"
```

The launcher prepares the frontend, host, engine and native helpers, then opens a development window. The first native and engine builds take a while. The explicit profile keeps this checkout away from any installed copy.

## Configuration

- **Editions.** Build identities (application id, product name, service address, data directory) are data in `contracts/desktop-editions.json`. Additional editions can be supplied at development or packaging time with `KLAUS_DESKTOP_EDITIONS_FILE` / `--editions-file`; a packaged app carries only its own definition.
- **Service address.** The default editions point at the hosted Klaus service. Set `KLAUS_SERVER_URL` to use your own server.
- **Official plugins.** Some first-party plugins are distributed separately. A development launch can load them from a marketplace directory named by `KLAUS_OFFICIAL_PLUGINS_DIR`; packaging bundles them only when given `--official-plugins-dir` and `--bundle-official-plugin`.

## Tests

```sh
npm run typecheck && npm run typecheck:frontend
npm run test:frontend                 # bun
npm run test:host                     # host suites under Electron's Node runtime
node scripts/test-packaging.mjs       # packaging
npm test                              # the aggregate gate (builds the engine and native addon)
```

GUI fixtures check native permissions before launching Electron (`node scripts/electron-test-preflight.cjs`).

## License

MIT for this project's own code (see [LICENSE](LICENSE)). Bundled third-party material keeps its own license; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Product names and logos of integrated services are trademarks of their owners.
