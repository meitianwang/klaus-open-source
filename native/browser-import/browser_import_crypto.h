#ifndef KLAUS_BROWSER_IMPORT_CRYPTO_H_
#define KLAUS_BROWSER_IMPORT_CRYPTO_H_

#include <cstddef>
#include <string>

namespace klaus::browser_import {

struct DecryptResult {
  bool ok = false;
  std::string code;
  std::string message;
  std::string plaintext;
};

/** Derive the 16-byte AES key used by Chromium's macOS v10 format. */
bool DeriveKey(const std::string& password, unsigned char key[16]);

/** Raw 32-byte SHA-256, matching Chromium's SHA256HashString. */
std::string Sha256(const std::string& value);

/** Decrypt a v10 blob. The returned plaintext is not yet host-hash checked. */
DecryptResult DecryptV10(const std::string& ciphertext, const unsigned char key[16]);

/** Best-effort wipe for key material held in helper memory. */
void Zeroize(void* data, std::size_t size);

}  // namespace klaus::browser_import

#endif  // KLAUS_BROWSER_IMPORT_CRYPTO_H_
