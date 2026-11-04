# Electron runtime resolver

`scripts/electron-runtime-resolver.mjs` selects the Electron runtime used by the
development entrypoint, the packaging entrypoint and the common test launchers.
It never downloads Electron and never treats an injected custom runtime as a
best-effort hint.

## Selection

| Mode | Selection |
| --- | --- |
| `native` | Requires the three native inputs below. Any missing, malformed or changed input is a hard failure. The stock package is never used as a fallback. |
| `stock` | Resolves the pinned `node_modules/electron` package. This is a deliberate opt-in for ordinary Node-only tests and tools that do not need the native Browser binding. |

`scripts/dev.mjs` and `scripts/package.mjs` default to `native`. A production
run without the three native inputs therefore fails with a missing-artifact
message instead of silently using stock. Set `KLAUS_ELECTRON_RUNTIME_MODE=stock`
or pass `--runtime-mode stock` to `scripts/package.mjs` when stock is intentional.

The general resolver used by other tools keeps mode inference: if the mode is
omitted, any injected native input selects `native`; otherwise `stock` is
selected and the source is printed. The common Node-only test launcher passes
`stock` explicitly.

## Native inputs

All paths must be absolute:

```text
KLAUS_ELECTRON_RUNTIME_DIR=/path/to/runtime-bundle
KLAUS_ELECTRON_RUNTIME_RECEIPT=/path/to/runtime-bundle/runtime.json
KLAUS_ELECTRON_RUNTIME_MANIFEST=/path/to/manifest.json
```

`KLAUS_ELECTRON_RUNTIME_DIR` contains the application bundle and the packager
ZIP. The receipt must live inside that directory. The manifest is read only and
may live elsewhere.

Example development selection (native is the default):

```sh
KLAUS_ELECTRON_RUNTIME_MODE=native \
KLAUS_ELECTRON_RUNTIME_DIR=/path/to/runtime-bundle \
KLAUS_ELECTRON_RUNTIME_RECEIPT=/path/to/runtime-bundle/runtime.json \
KLAUS_ELECTRON_RUNTIME_MANIFEST=/path/to/manifest.json \
node scripts/dev.mjs
```

Example packaging selection:

```sh
KLAUS_ELECTRON_RUNTIME_MODE=native \
KLAUS_ELECTRON_RUNTIME_DIR=/path/to/runtime-bundle \
KLAUS_ELECTRON_RUNTIME_RECEIPT=/path/to/runtime-bundle/runtime.json \
KLAUS_ELECTRON_RUNTIME_MANIFEST=/path/to/manifest.json \
node scripts/package.mjs --runtime-mode native
```

For ordinary Node-only test workers, the common launcher selects stock
explicitly unless `KLAUS_ELECTRON_RUNTIME_MODE=native` is set. Stock is not a
fallback for a production dev or package run.

## Receipt

The receipt is generated from the runtime bundle and manifest. It records:

- `target`: the selected platform and architecture.
- `electron`: Electron, Chromium and Node versions copied from the manifest.
- `source`: repository roots, the SHA-256 of the manifest file and the SHA-256
  of the ordered `repo\0file\0sha256` patch sequence.
- `bundle`: the application directory, executable path, a deterministic tree
  digest, every directory, file and symlink, and the SHA-256 of every file.
- `packager`: the relative ZIP filename and its SHA-256.

The patch manifest is hashed at receipt creation time. The resolver does not
carry a manifest snapshot in source code, so a new manifest is accepted by
regenerating the receipt; a missing receipt or a changed manifest fails closed.

Generate or verify a receipt with the same resolver:

```sh
node scripts/electron-runtime-resolver.mjs create \
  --runtime-dir /path/to/runtime-bundle \
  --receipt /path/to/runtime-bundle/runtime.json \
  --manifest /path/to/manifest.json

node scripts/electron-runtime-resolver.mjs verify \
  --runtime-dir /path/to/runtime-bundle \
  --receipt /path/to/runtime-bundle/runtime.json \
  --manifest /path/to/manifest.json \
  --require-packager-zip
```

`create` produces `packager/electron-v<version>-<platform>-<arch>.zip` from the
validated application bundle. The installed packager does not expose an
`electronDist` option, so packaging passes this archive through `electronZipDir`.
The ZIP is checked again by SHA-256 before packaging.
