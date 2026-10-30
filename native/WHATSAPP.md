# WhatsApp native resource and host composition

The Electron main process remains the only account supervisor and engine owner. `NativeWhatsApp` is an in-process protocol, network and SQLite resource. It never starts an engine or receives model/history configuration. The standalone protocol server exists only as a test executable.

## Host API

`registerWhatsAppPairingHandlers(registry, deps)` registers exactly:

- `channels:whatsapp:start`
- `channels:whatsapp:poll`

It returns `WhatsAppPairingService`. Supply its `factory` as the WhatsApp factory in the existing `ChannelService`. `deps.enable(signal)` must save enabled configuration and connect through that same channel owner. It must not create a second native resource. A normal `whatsappAdapter(options)` is also exported for callers that do not need pairing presentation.

Pass the packaged absolute `.node` path as `addonPath`. The default profile is `<configRoot>/whatsapp/store.db`; `authDir` and `auth_dir` retain their existing precedence. The existing `whatsapp-rust-sqlite-storage` 0.5.0 schema and device/Signal credentials are used directly. Legacy `creds.json` without `store.db` is refused without overwriting credentials.

Before waiting on a disconnect/account mutation gate, call `pairing.cancel()`. Then await the channel owner's disconnect, which awaits `WhatsAppTransport.close()`. On full shutdown also await `pairing.close()`; that service only owns QR presentation and pending presentation work. QR responses are generated from the current, unexpired event and are never put into status logs. Pairing failure invalidates the QR.

`NativeWhatsAppTransport` exposes `open`, `sendText`, `report`, `close`, and `finished`. The binding has explicit operation IDs, deadlines and cancellation. `sendText` returns the actual generated protocol message ID after successful Signal persistence and socket send; it is not a recipient-delivery or read receipt. A send cancelled after protocol processing starts returns `WHATSAPP_SEND_OUTCOME_UNKNOWN` and is not replayed.

`close` seals admission, cancels network activity, stops and drains the scoped protocol runtime (including actual blocking closures), checks Signal/device flushes, drops the Tokio runtime and SQLite owner, and only then releases the profile lease. `complete: false` is not successful closure. A storage flush error remains observable even when resource release completes. The transport surfaces that error rather than claiming a successful persistence result. Logout and replacement events require manual reconnection.

Bounds include four resources, eight pending native operations, a single event reader, 128 events/8 MiB, a four-frame transport queue with 16 MiB per frame, and 2,048 registered protocol tasks. The TS adapter separately limits accepted inbound turns, per-conversation work, bytes and outbound sends. None of these queues owns an engine lifecycle.

## Pinned protocol fixes

The dependency versions remain 0.5.0. Three small production patches are carried as source with their original MIT license and archive SHA-256:

- `vendor/wacore-noise/KLAUS-PATCH.md`: authenticate intermediate and leaf signatures against the fixed production root before accepting the Noise static key.
- `vendor/wacore/KLAUS-PATCH.md`: verify the QR ADV HMAC in constant time, retain hosted-prefix/account-signature checks, and retain dirty Signal cache records across reconnect cleanup.
- `vendor/whatsapp-rust/KLAUS-PATCH.md`: commit an advanced Signal ratchet before transmitting ciphertext and propagate disk errors; expose final Signal flush to the resource owner.

The normal TLS implementation uses the platform trust verifier. There is no production TLS bypass, fixture endpoint setting or mutable Noise trust root. The fixture addon has a separate compile-time synthetic root and explicit loopback-only factory. Packaging rejects its `whatsappFixtures: true` manifest.

## Reproducible checks

From the repository root:

```
CARGO_BUILD_JOBS=4 cargo clippy --locked --manifest-path apps/desktop/native/Cargo.toml --workspace --all-targets -- -D warnings
CARGO_BUILD_JOBS=4 cargo clippy --locked --manifest-path apps/desktop/native/Cargo.toml --workspace --all-targets --all-features -- -D warnings
CARGO_BUILD_JOBS=4 cargo test --locked --manifest-path apps/desktop/native/Cargo.toml --workspace --all-features -- --test-threads=1
CARGO_BUILD_JOBS=4 cargo test --locked --manifest-path apps/desktop/native/Cargo.toml -p wacore-noise klaus_certificate_tests
CARGO_BUILD_JOBS=4 cargo build --locked --manifest-path apps/desktop/native/Cargo.toml -p klaus-native-core --features whatsapp-fixtures --bin klaus-whatsapp-fixture
node apps/desktop/native/scripts/build.mjs --debug --whatsapp-fixtures
node apps/desktop/native/scripts/test-whatsapp.mjs
```

The private server implements actual HTTP version discovery, encrypted Noise nodes, QR/account pairing, reconnection and a Signal peer. Tests exercise authenticated send/receive, same-profile reopen, invalid signatures/HMAC, actual SQLite write rejection, held HTTP/Noise/key requests, cancellation, exclusive profile ownership and real TS pairing/message routing. These isolated tests do not log into or send messages through a user WhatsApp account. They do not claim compatibility against the live WhatsApp service.

The verified macOS development checkpoint produced:

```
test result: ok. 39 passed; 0 failed
test result: ok. 13 passed; 0 failed
test result: ok. 5 passed; 0 failed
whatsapp-electron: 10 passed, 0 failed
services: 282 passed, 0 failed, 1 info
# tests 18
# pass 18
# fail 0
```

The service result uses `npm run typecheck && npm run build:main` followed by Electron running `dist/tests/services.test.js` with `ELECTRON_RUN_AS_NODE=1`. The packaging result uses `node --test packaging/resources.test.mjs`, both from `apps/desktop`.

After committing a clean source snapshot, build the production addon with `node apps/desktop/native/scripts/build.mjs` and check it in normal Electron with `node apps/desktop/native/scripts/test-whatsapp.mjs --production`. Copy the `.node` and adjacent JSON manifest together into an immutable staging directory; do not rename a fixture binary or edit its manifest to resemble production. The manifest binds the source commit, clean status, compiled-source fingerprint, lockfile and binary SHA-256. Windows builds and normal-Electron checks must run on Windows and are separate evidence.
