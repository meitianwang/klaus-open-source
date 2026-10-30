# Klaus pairing envelope verification

Upstream: wacore 0.5.0, commit aac3db0ac574fb21da4944f2d89e871af81e8499, path wacore.
Original crates.io archive SHA-256: `5292fb723da7505e90cfd7a828dd397802b98e0f819a2bc058a6b3a9f2345306`. The MIT license is retained.

The pairing change in src/pair.rs checks the existing HMAC-SHA256 accumulator with `Mac::verify_slice` before parsing and accepting the signed identity. The QR's ADV secret is already the device-state key. Hosted envelopes retain their existing prefix. No credentials, database schema, account identity, or transport setting changes. Cargo's unused standalone test/benchmark targets and the benchmark-only dependency are omitted; other upstream library source is unchanged except for the cache retention change described below.

The normal-Electron encrypted loopback regression first observed an invalid HMAC reach connected. With the patch a valid QR completes pairing and reconnect, while the same signed identity with a wrong MAC yields pairError and remains unpaired. Unit vectors cover missing, malformed, modified and hosted MACs.

The rejection maps to a fixed error message. The production HMAC dependency does not enable its optional standard-error implementation; the check must compile with production defaults as well as fixture features.

Protocol reference (not copied source): https://github.com/tulir/whatsmeow/blob/main/pair.go uses the QR ADV secret to authenticate the envelope before accepting account identity.

The additional src/store/signal_cache.rs change retains only dirty/deleted entries when reconnect cleanup clears the cache. Failed disk writes must not silently revert cryptographic state. See ../whatsapp-rust/KLAUS-PATCH.md and the real SQLite fault regression.
