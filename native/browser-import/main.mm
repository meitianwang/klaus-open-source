#import <Foundation/Foundation.h>

#include "browser_import_crypto.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unistd.h>

#ifdef KLAUS_BROWSER_IMPORT_PRODUCTION
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#endif

namespace {

constexpr std::size_t kMaxLineBytes = 1024 * 1024;
constexpr std::size_t kMaxCiphertextBytes = 256 * 1024;
constexpr std::size_t kMaxPlaintextBytes = 64 * 1024;
constexpr long long kProtocolVersion = 1;

enum class ReadResult { kLine, kEof, kTooLarge };

struct KeyState {
  bool ready = false;
  bool failed = false;
  std::string failureCode;
  std::string failureMessage;
  unsigned char key[16] = {};
};

#ifdef KLAUS_BROWSER_IMPORT_TEST
bool gIgnoreShutdown = false;
#endif

bool SourceCredentials(const std::string& family, std::string* service,
                       std::string* account) {
  if (family == "chrome") {
    *service = "Chrome Safe Storage";
    *account = "Chrome";
    return true;
  }
  if (family == "chromium") {
    *service = "Chromium Safe Storage";
    *account = "Chromium";
    return true;
  }
  if (family == "edge") {
    *service = "Microsoft Edge Safe Storage";
    *account = "Microsoft Edge";
    return true;
  }
  return false;
}

ReadResult ReadLine(std::string* line) {
  line->clear();
  int character = 0;
  while ((character = std::getchar()) != EOF) {
    if (character == '\n') return ReadResult::kLine;
    if (line->size() >= kMaxLineBytes) return ReadResult::kTooLarge;
    line->push_back(static_cast<char>(character));
  }
  return line->empty() ? ReadResult::kEof : ReadResult::kLine;
}

std::string StdString(NSString* value) {
  if (![value isKindOfClass:[NSString class]]) return {};
  const char* utf8 = [value UTF8String];
  return utf8 == nullptr ? std::string() : std::string(utf8);
}

bool WriteResponse(NSDictionary* response) {
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:response
                                                 options:0
                                                   error:&error];
  if (data == nil) return false;
  if (fwrite(data.bytes, 1, data.length, stdout) != data.length) return false;
  fputc('\n', stdout);
  fflush(stdout);
  return true;
}

void WriteError(NSNumber* requestId, NSString* code, NSString* message) {
  NSMutableDictionary* response = [@{
    @"ok" : @NO,
    @"code" : code,
    @"message" : message,
  } mutableCopy];
  if (requestId != nil) response[@"id"] = requestId;
  WriteResponse(response);
}

bool LoadPassword(const std::string& family, std::string* password,
                  std::string* code, std::string* message) {
#ifdef KLAUS_BROWSER_IMPORT_TEST
  (void)family;
  const char* fixture = std::getenv("KLAUS_BROWSER_IMPORT_TEST_KEY");
  if (fixture == nullptr || fixture[0] == '\0') {
    *code = "test_key_missing";
    *message = "The synthetic test key was not provided.";
    return false;
  }
  *password = fixture;
  return true;
#else
  std::string service;
  std::string account;
  if (!SourceCredentials(family, &service, &account)) {
    *code = "unsupported_source";
    *message = "The selected browser source is not supported.";
    return false;
  }

  LAContext* authentication = [[LAContext alloc] init];
  authentication.localizedReason =
      @"Klaus needs the browser Safe Storage key to import the selected profile.";
  NSDictionary* query = @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : [NSString stringWithUTF8String:service.c_str()],
    (__bridge id)kSecAttrAccount : [NSString stringWithUTF8String:account.c_str()],
    (__bridge id)kSecReturnData : @YES,
    (__bridge id)kSecMatchLimit : (__bridge id)kSecMatchLimitOne,
    (__bridge id)kSecUseAuthenticationContext : authentication,
  };
  CFTypeRef result = nullptr;
  const OSStatus status =
      SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status == errSecItemNotFound) {
    *code = "keychain_item_not_found";
    *message = "The browser Safe Storage key was not found.";
    return false;
  }
  if (status == errSecUserCanceled) {
    *code = "keychain_auth_cancelled";
    *message = "The Keychain authorization was cancelled.";
    return false;
  }
  if (status == errSecAuthFailed) {
    *code = "keychain_auth_failed";
    *message = "The Keychain authorization failed.";
    return false;
  }
  if (status == errSecInteractionNotAllowed) {
    *code = "keychain_interaction_not_allowed";
    *message = "The Keychain requires user interaction that is not available.";
    return false;
  }
  if (status != errSecSuccess || result == nullptr) {
    *code = "keychain_error";
    *message = "The browser Safe Storage key could not be read.";
    if (result != nullptr) CFRelease(result);
    return false;
  }

  if (CFGetTypeID(result) != CFDataGetTypeID()) {
    CFRelease(result);
    *code = "keychain_item_invalid";
    *message = "The browser Safe Storage item has an unsupported shape.";
    return false;
  }
  NSData* data = (__bridge_transfer NSData*)result;
  if (![data isKindOfClass:[NSData class]] || data.length == 0 ||
      data.length > 256) {
    *code = "keychain_item_invalid";
    *message = "The browser Safe Storage item has an unsupported shape.";
    return false;
  }
  password->assign(static_cast<const char*>(data.bytes), data.length);
  return true;
#endif
}

void ResetKey(KeyState* state) {
  klaus::browser_import::Zeroize(state->key, sizeof(state->key));
  state->ready = false;
  state->failed = false;
  state->failureCode.clear();
  state->failureMessage.clear();
}

bool DeriveAndCacheKey(const std::string& family, KeyState* state,
                       std::string* code, std::string* message) {
  if (state->ready) return true;
  if (state->failed) {
    *code = state->failureCode;
    *message = state->failureMessage;
    return false;
  }
  std::string password;
  if (!LoadPassword(family, &password, code, message)) {
    state->failed = true;
    state->failureCode = *code;
    state->failureMessage = *message;
    return false;
  }
  const bool derived = klaus::browser_import::DeriveKey(password, state->key);
  klaus::browser_import::Zeroize(password.data(), password.size());
  if (!derived) {
    ResetKey(state);
    *code = "key_derivation_failed";
    *message = "The browser Safe Storage key could not be derived.";
    state->failed = true;
    state->failureCode = *code;
    state->failureMessage = *message;
    return false;
  }
  state->ready = true;
  return true;
}

bool DecodeBase64(NSString* value, std::string* decoded) {
  if (![value isKindOfClass:[NSString class]]) return false;
  NSData* data = [[NSData alloc] initWithBase64EncodedString:value options:0];
  if (data == nil) return false;
  if (data.length > kMaxCiphertextBytes) return false;
  decoded->assign(static_cast<const char*>(data.bytes), data.length);
  return true;
}

bool HandleInit(NSDictionary* request, std::string* family, KeyState* key) {
  NSString* requestedFamily = request[@"family"];
  if (![requestedFamily isKindOfClass:[NSString class]]) {
    WriteError(nil, @"invalid_request", @"The init request has no source family.");
    return false;
  }
  std::string service;
  std::string account;
  *family = StdString(requestedFamily);
  if (!SourceCredentials(*family, &service, &account)) {
    WriteError(nil, @"unsupported_source",
               @"The selected browser source is not supported.");
    return false;
  }
  ResetKey(key);
#ifdef KLAUS_BROWSER_IMPORT_TEST
  NSNumber* ignoreShutdown = request[@"ignoreShutdown"];
  gIgnoreShutdown = [ignoreShutdown isKindOfClass:[NSNumber class]]
      ? ignoreShutdown.boolValue
      : false;
#endif
  WriteResponse(@{
    @"ok" : @YES,
    @"op" : @"init",
    @"protocol" : @(kProtocolVersion),
  });
  return true;
}

void HandleDecrypt(NSDictionary* request, const std::string& family,
                   KeyState* key) {
  NSNumber* requestId = request[@"id"];
  if (![requestId isKindOfClass:[NSNumber class]]) {
    WriteError(nil, @"invalid_request", @"The decrypt request has no id.");
    return;
  }

  NSString* kind = request[@"kind"];
  NSString* data = request[@"data"];
  NSString* hostValue = request[@"host"];
  NSString* kindValue = [kind isKindOfClass:[NSString class]] ? kind : @"";
  const std::string kindString = StdString(kindValue);
  const std::string host = StdString(hostValue);

  if (kindString != "cookie" && kindString != "password") {
    WriteError(requestId, @"invalid_request", @"The decrypt request has an unknown kind.");
    return;
  }

  std::string ciphertext;
  if (!DecodeBase64(data, &ciphertext)) {
    WriteError(requestId, @"request_too_large",
               @"The encrypted value is missing, invalid, or too large.");
    return;
  }

#ifdef KLAUS_BROWSER_IMPORT_TEST
  NSString* responseMode = request[@"responseMode"];
  if ([responseMode isEqualToString:@"invalid-base64"]) {
    WriteResponse(@{@"id" : requestId, @"ok" : @YES, @"value" : @"!!!!"});
    return;
  }
  if ([responseMode isEqualToString:@"invalid-utf8"]) {
    WriteResponse(@{@"id" : requestId, @"ok" : @YES, @"value" : @"/w=="});
    return;
  }
  NSNumber* delay = request[@"delayMs"];
  if ([delay isKindOfClass:[NSNumber class]]) {
    const long long milliseconds = delay.longLongValue;
    if (milliseconds > 0 && milliseconds <= 60000) {
      usleep(static_cast<useconds_t>(milliseconds) * 1000);
    }
  }
#endif

  std::string code;
  std::string message;
  if (!DeriveAndCacheKey(family, key, &code, &message)) {
    WriteError(requestId, [NSString stringWithUTF8String:code.c_str()],
               [NSString stringWithUTF8String:message.c_str()]);
    return;
  }

  klaus::browser_import::DecryptResult decrypted =
      klaus::browser_import::DecryptV10(ciphertext, key->key);
  if (!decrypted.ok) {
    WriteError(requestId, [NSString stringWithUTF8String:decrypted.code.c_str()],
               [NSString stringWithUTF8String:decrypted.message.c_str()]);
    return;
  }

  NSNumber* databaseVersion = request[@"databaseVersion"];
  const long long version = [databaseVersion isKindOfClass:[NSNumber class]]
      ? databaseVersion.longLongValue
      : 0;
  if (kindString == "cookie" && version >= 24) {
    if (host.empty()) {
      klaus::browser_import::Zeroize(decrypted.plaintext.data(),
                                     decrypted.plaintext.size());
      WriteError(requestId, @"host_required",
                 @"A partitioned cookie check requires the host key.");
      return;
    }
    const std::string expected = klaus::browser_import::Sha256(host);
    if (decrypted.plaintext.size() < expected.size() ||
        decrypted.plaintext.compare(0, expected.size(), expected) != 0) {
      klaus::browser_import::Zeroize(decrypted.plaintext.data(),
                                     decrypted.plaintext.size());
      WriteError(requestId, @"host_hash_mismatch",
                 @"The encrypted cookie host hash does not match.");
      return;
    }
    decrypted.plaintext.erase(0, expected.size());
  }

  if (decrypted.plaintext.size() > kMaxPlaintextBytes) {
    klaus::browser_import::Zeroize(decrypted.plaintext.data(),
                                   decrypted.plaintext.size());
    WriteError(requestId, @"plaintext_too_large",
               @"The decrypted value exceeds the supported size.");
    return;
  }

  NSData* plaintext = [NSData dataWithBytes:decrypted.plaintext.data()
                                     length:decrypted.plaintext.size()];
  NSString* encoded = [plaintext base64EncodedStringWithOptions:0];
  klaus::browser_import::Zeroize(decrypted.plaintext.data(),
                                 decrypted.plaintext.size());
  WriteResponse(@{
    @"id" : requestId,
    @"ok" : @YES,
    @"value" : encoded,
  });
}

}  // namespace

int main(int argc, char** argv) {
  (void)argc;
  (void)argv;
  std::string family;
  KeyState key;

  for (;;) {
    std::string line;
    const ReadResult read = ReadLine(&line);
    if (read == ReadResult::kEof) break;
    if (read == ReadResult::kTooLarge) {
      WriteError(nil, @"request_too_large",
                 @"The helper request exceeds the supported line size.");
      ResetKey(&key);
      return 1;
    }
    if (!line.empty() && line.back() == '\r') line.pop_back();
    @autoreleasepool {
      NSData* input = [NSData dataWithBytes:line.data() length:line.size()];
      NSError* parseError = nil;
      id parsed = [NSJSONSerialization JSONObjectWithData:input
                                                   options:0
                                                     error:&parseError];
      if (![parsed isKindOfClass:[NSDictionary class]]) {
        WriteError(nil, @"invalid_request", @"The helper request is not valid JSON.");
        continue;
      }
      NSDictionary* request = (NSDictionary*)parsed;
      NSString* operation = request[@"op"];
      if (![operation isKindOfClass:[NSString class]]) {
        WriteError(nil, @"invalid_request", @"The helper request has no operation.");
        continue;
      }
      if ([operation isEqualToString:@"init"]) {
        HandleInit(request, &family, &key);
      } else if ([operation isEqualToString:@"decrypt"]) {
        if (family.empty()) {
          WriteError(request[@"id"], @"not_initialized",
                     @"The helper was not initialized.");
        } else {
          HandleDecrypt(request, family, &key);
        }
      } else if ([operation isEqualToString:@"shutdown"]) {
#ifdef KLAUS_BROWSER_IMPORT_TEST
        if (gIgnoreShutdown) {
          usleep(60 * 1000 * 1000);
        }
#endif
        ResetKey(&key);
        WriteResponse(@{@"ok" : @YES, @"op" : @"shutdown"});
        return 0;
      } else {
        WriteError(request[@"id"], @"unsupported_operation",
                   @"The helper operation is not supported.");
      }
    }
  }

  ResetKey(&key);
  return 0;
}
