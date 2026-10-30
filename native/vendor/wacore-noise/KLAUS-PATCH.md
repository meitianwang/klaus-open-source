# Pinned Noise certificate verification patch

Source: wacore-noise 0.5.0 from crates.io, upstream commit aac3db0ac574fb21da4944f2d89e871af81e8499.
Crates.io archive SHA-256: `3e1c5a0ef2ddaf0f7c5a227649c09de5f354571d95feea4dbac55f2b31c2da53`. All other protocol code remains upstream code.

The upstream 0.5.0 verifier checked certificate fields but never authenticated either signature. This patch verifies the intermediate payload against WA_CERT_PUB_KEY and the leaf payload against the authenticated intermediate key, using the existing Signal public-key signature primitive. TLS continues to use the OS trust store.

The `klaus-fixture-root` feature substitutes a public root derived from a fixed synthetic private key ONLY in the separately built WhatsApp fixture addon. It has no runtime/environment switch and must never be packaged. The production addon contains the original WhatsApp root and rejects synthetic chains. Tests exercise missing, forged and mismatched signatures as well as a signed fixed vector.
