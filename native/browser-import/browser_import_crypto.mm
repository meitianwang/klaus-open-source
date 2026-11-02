#include "browser_import_crypto.h"

#include <CommonCrypto/CommonCrypto.h>
#include <CommonCrypto/CommonKeyDerivation.h>

#include <array>
#include <cstdio>
#include <cstring>
#include <utility>

namespace klaus::browser_import {
namespace {

constexpr unsigned char kSalt[] = {
    's', 'a', 'l', 't', 'y', 's', 'a', 'l', 't'};
constexpr std::size_t kSaltLength = sizeof(kSalt);
constexpr std::uint32_t kIterations = 1003;
constexpr std::size_t kKeyLength = kCCKeySizeAES128;
constexpr char kV10Prefix[] = "v10";

const std::array<unsigned char, kCCBlockSizeAES128> kIv = {
    ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ',
    ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ',
};

DecryptResult Failure(const char* code, const char* message) {
  DecryptResult result;
  result.code = code;
  result.message = message;
  return result;
}

}  // namespace

bool DeriveKey(const std::string& password, unsigned char key[16]) {
  if (password.empty() || password.size() > 256) return false;
  return CCKeyDerivationPBKDF(
             kCCPBKDF2, password.data(), password.size(), kSalt, kSaltLength,
             kCCPRFHmacAlgSHA1, kIterations, key, kKeyLength) == kCCSuccess;
}

std::string Sha256(const std::string& value) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(value.data(), static_cast<CC_LONG>(value.size()), digest);
  std::string encoded(reinterpret_cast<const char*>(digest), sizeof(digest));
  Zeroize(digest, sizeof(digest));
  return encoded;
}

DecryptResult DecryptV10(const std::string& ciphertext, const unsigned char key[16]) {
  if (ciphertext.size() < std::strlen(kV10Prefix) ||
      ciphertext.compare(0, std::strlen(kV10Prefix), kV10Prefix) != 0) {
    return Failure("unsupported_encryption",
                   "Only Chromium v10 encryption is supported on macOS.");
  }
  const std::size_t encryptedLength = ciphertext.size() - std::strlen(kV10Prefix);
  if (encryptedLength == 0) {
    DecryptResult result;
    result.ok = true;
    return result;
  }
  if (encryptedLength % kCCBlockSizeAES128 != 0) {
    return Failure("invalid_ciphertext", "The encrypted value has an invalid length.");
  }

  std::string plaintext(encryptedLength + kCCBlockSizeAES128, '\0');
  std::size_t plaintextLength = 0;
  const CCCryptorStatus status = CCCrypt(
      kCCDecrypt, kCCAlgorithmAES128, kCCOptionPKCS7Padding, key, kKeyLength,
      kIv.data(), ciphertext.data() + std::strlen(kV10Prefix), encryptedLength,
      plaintext.data(), plaintext.size(), &plaintextLength);
  if (status != kCCSuccess) {
    Zeroize(plaintext.data(), plaintext.size());
    return Failure("decryption_failed", "The encrypted value could not be decrypted.");
  }
  plaintext.resize(plaintextLength);
  DecryptResult result;
  result.ok = true;
  result.plaintext = std::move(plaintext);
  return result;
}

void Zeroize(void* data, std::size_t size) {
  if (data == nullptr || size == 0) return;
  volatile unsigned char* bytes = static_cast<volatile unsigned char*>(data);
  while (size-- > 0) *bytes++ = 0;
}

}  // namespace klaus::browser_import
