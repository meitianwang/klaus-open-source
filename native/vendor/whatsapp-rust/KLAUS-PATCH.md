# Klaus Signal persistence boundary

Upstream whatsapp-rust 0.5.0, commit aac3db0ac574fb21da4944f2d89e871af81e8499.
Original crates.io archive SHA-256: `b5b79e16847fe6e7ea8d103b4b575b1a1b77bd57cb4c292f7c50616b72a74374`. MIT license retained.

Production changes are limited to src/send.rs and src/client.rs. Send commits the advanced Signal cache before transmitting the ciphertext and propagates commit errors. `flush_signal_cache` is public so the native resource can check final persistence after its scoped runtime has stopped protocol tasks. No protocol or SQLite format changes. Unused binary/example Cargo targets are omitted.

The private, encrypted loopback test first reproduced a successful send and peer receipt while a SQLite trigger rejected the ratchet write. It now requires an error and no wire message. Normal sends, replies and reopen use real Signal keys and the existing SqliteStore. The companion wacore patch retains dirty cache records across disconnect until a successful flush; clean entries are still discarded.
