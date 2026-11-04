# Native browser runtime handoff

Use manifest.json as the single source of patch order, repository roots,
versions and SHA-256 values. Do not reconstruct order from patch numbers. A
missing number does not imply a missing prerequisite.

Finish pinned dependency sync and official Electron prerequisite hooks before
applying this series. Check actual child repository HEADs after interrupted
sync. Do not apply custom patches while another operation can reset or patch
the same source tree. Patch 0 restores typed Profile selection after the
official factory adaptation; the following immutable discriminator patches
then reject non-Profile contexts before downcasts. Do not omit this first step
when preparing an official patched source tree.

Preflight the complete ordered series without modifying source:

```sh
python3 native/browser-runtime/scripts/apply-patches.py \
  <chromium-src> <electron-src> --check-only
```

Apply it only after preflight passes:

```sh
native/browser-runtime/scripts/apply-patches.sh <chromium-src> <electron-src>
```

The applicator verifies immutable hashes, uses private temporary Git indexes
for sequential preflight and leaves each source repository's real index alone.
The manifest also records required GN targets; a successful preflight does not
prove their compilation or link closure.

After compiling, use the probe runner with a new empty owned working directory:

```sh
native/browser-runtime/scripts/run-probe.sh <built-electron> <probe-directory>
```

The runner uses spawnElectronGuiSync, enforces GUI preflight and mock Keychain
use, and checks all required probe results. It isolates application Local State
with --user-data-dir in addition to the native Profile directory.
Report original build output and the complete probe JSON. A failed build,
initialization CHECK, missing service or failed isolation check remains a failed
gate. See STATUS.md for remaining integration gates.

Maintain a single browser-process owner and a single real system network
manager implementation. Do not return an Electron lookalike through a Chrome
service type or swap global content clients while contexts are active.
