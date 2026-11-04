# Browser import helper packaging

Browser profile import uses a macOS helper that decrypts browser secrets in a
standalone process. The helper is never built in test mode for a package:
`mode: "test"` artifacts are rejected by the verifier and cannot be written into
`resources/browser-import`.

The development entrypoint reuses a valid production resource or builds one with
`scripts/browser-import-helper.mjs`. It injects the absolute executable path as
`KLAUS_BROWSER_IMPORT_HELPER`. On other platforms it reports the capability as
unavailable and does not create a helper.

The packaged resource layout is:

```text
resources/browser-import/<platform-arch>/
  klaus-browser-import-helper
  klaus-browser-import-helper.json
```

`scripts/package.mjs` validates the default directory
`resources/browser-import/<target>`, or an explicit `--browser-import-dir` on
macOS. It checks schema 1, `mode: production`, target, executable architecture,
size, binary SHA-256, source fingerprint, source commit, compiler and signing
metadata before copying both files into the staged resources. The package
manifest records the relative `browserImport.helperPath` and
`browserImport.manifestPath` plus provenance fields.

Packaging on Windows receives an explicit
`{ "supported": false, "platform": "win32", ... }` record. `verifyPackage`
rejects a leaked macOS helper directory in a Windows package rather than
inventing a helper or silently omitting a recorded capability.

Prepare a production resource explicitly with:

```sh
node scripts/browser-import-helper.mjs prepare \
  --platform darwin \
  --arch arm64 \
  --mode production
```

Add `--identity <Developer ID Application identity>` for a signed release
artifact. Local unsigned packaging verifies the bytes and records
`releaseEligible: false`; a release gate can request
`verifyBrowserImportHelper({ requireRelease: true })`.
