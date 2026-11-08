#import "../computer-use/lockscreen.h"
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <assert.h>
#include <math.h>
#include <stdio.h>

static NSUInteger Assertions = 0;
static void Expect(BOOL value) { Assertions++; assert(value); }
static void Cancel(void) { @throw [NSException exceptionWithName:@"ComputerUse" reason:@"cancelled" userInfo:nil]; }

// These executable-local symbols replace every system keychain call. This fixture never uses a real account.
static NSMutableDictionary *Stored;
static NSDictionary *Identity;
static BOOL InteractionDisabled;
OSStatus SecKeychainSetUserInteractionAllowed(Boolean enabled) { Expect(!enabled); InteractionDisabled = YES; return errSecSuccess; }
static void ValidateQuery(CFDictionaryRef raw) {
    Expect(InteractionDisabled); InteractionDisabled = NO;
    NSDictionary *query = (__bridge NSDictionary *)raw;
    Expect([query[(__bridge id)kSecClass] isEqual:(__bridge id)kSecClassGenericPassword]);
    Expect([query[(__bridge id)kSecAttrService] isEqual:Identity[@"service"]]);
    Expect([query[(__bridge id)kSecAttrAccount] isEqual:Identity[@"account"]]);
    Expect([query[(__bridge id)kSecUseAuthenticationContext] isKindOfClass:LAContext.class]);
    Expect([query[(__bridge id)kSecUseAuthenticationContext] interactionNotAllowed]);
}
OSStatus SecItemCopyMatching(CFDictionaryRef raw, CFTypeRef *value) {
    ValidateQuery(raw); NSDictionary *query = (__bridge NSDictionary *)raw;
    Expect([query[(__bridge id)kSecReturnAttributes] boolValue]);
    Expect(!query[(__bridge id)kSecReturnData]);
    if (!Stored) return errSecItemNotFound;
    if (value) *value = CFBridgingRetain(@{ @"present": @YES });
    return errSecSuccess;
}
OSStatus SecItemAdd(CFDictionaryRef raw, CFTypeRef *value) {
    (void)value; ValidateQuery(raw); if (Stored) return errSecDuplicateItem;
    Stored = [(__bridge NSDictionary *)raw mutableCopy]; return errSecSuccess;
}
OSStatus SecItemDelete(CFDictionaryRef raw) {
    ValidateQuery(raw); NSDictionary *query = (__bridge NSDictionary *)raw;
    if (!Stored || (query[(__bridge id)kSecAttrGeneric] && ![query[(__bridge id)kSecAttrGeneric] isEqual:Stored[(__bridge id)kSecAttrGeneric]])) return errSecItemNotFound;
    Stored = nil; return errSecSuccess;
}

@interface Fixture : NSObject <KlausLockScreenPlatform>
@property BOOL present;
@property BOOL cancelled;
@property BOOL cancelInPrompt;
@property BOOL cancelInStore;
@property BOOL duplicateInStore;
@property BOOL cancelBeforeInput;
@property NSUInteger prompts;
@property NSUInteger stores;
@property NSUInteger removals;
@property NSUInteger attempts;
@property NSUInteger lockIndex;
@property NSArray *locks;
@property double idle;
@property NSMutableData *secret;
@end
@implementation Fixture
- (BOOL)hasPassword { return self.present; }
- (NSMutableData *)collectPassword:(void (^)(void))check {
    check(); self.prompts++; self.secret = [[@"disposable-native-fixture" dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
    if (self.cancelInPrompt) self.cancelled = YES;
    return self.secret;
}
- (BOOL)storeNewPassword:(NSData *)password owner:(NSString *)owner {
    Expect(password.length > 0); Expect([owner isEqual:@"fixture-owner"]); self.stores++;
    self.present = YES; if (self.cancelInStore) self.cancelled = YES;
    return !self.duplicateInStore;
}
- (void)removePasswordOwnedBy:(NSString *)owner { Expect([owner isEqual:@"fixture-owner"]); self.removals++; self.present = NO; }
- (NSNumber *)locked { id value = self.locks[MIN(self.lockIndex++, self.locks.count - 1)]; return value == NSNull.null ? nil : value; }
- (double)secondsSinceInput { return self.idle; }
- (void)attemptStoredPassword:(void (^)(void))check posted:(void (^)(void))posted {
    if (self.cancelBeforeInput) self.cancelled = YES;
    check(); self.attempts++; posted();
}
@end

int main(int argc, char **argv) {
    @autoreleasepool {
        Expect(argc == 2);
        NSDictionary *vector = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[1]]] options:0 error:nil];
        NSMutableDictionary *identity = [vector[@"credential"] mutableCopy];
        identity[@"service"] = KlausLockScreenKeychainService(NSProcessInfo.processInfo.environment);
        Identity = identity;
        Expect([KlausLockScreenKeychainService(@{}) isEqualToString:@"agent-engine"]);
        Expect([KlausLockScreenKeychainService(@{@"KLAUS_COMPUTER_USE_KEYCHAIN_SERVICE": @"agent-engine-international"}) isEqualToString:@"agent-engine-international"]);
        Expect([KlausLockScreenKeychainService(@{@"KLAUS_COMPUTER_USE_KEYCHAIN_SERVICE": @"agent-engine-sample"}) isEqualToString:@"agent-engine-sample"]);
        for (NSString *rejected in vector[@"rejectedEditionServices"]) {
            BOOL invalidService = NO;
            @try { KlausLockScreenKeychainService(@{@"KLAUS_COMPUTER_USE_KEYCHAIN_SERVICE": rejected}); }
            @catch (NSException *error) { invalidService = [error.reason isEqualToString:@"Invalid product credential namespace"]; }
            Expect(invalidService);
        }
        id<KlausLockScreenPlatform> system = KlausSystemLockScreenPlatform();
        Expect(![system hasPassword]);
        NSData *password = [@"disposable-native-fixture" dataUsingEncoding:NSUTF8StringEncoding];
        Expect([system storeNewPassword:password owner:@"first"]); Expect([system hasPassword]);
        Expect(![system storeNewPassword:password owner:@"second"]);
        [system removePasswordOwnedBy:@"second"]; Expect([system hasPassword]);
        [system removePasswordOwnedBy:@"first"]; Expect(![system hasPassword]);
        Expect([system storeNewPassword:password owner:@"existing"]); [system removePasswordOwnedBy:nil]; Expect(![system hasPassword]);

        for (NSUInteger mode = 0; mode < 5; mode++) {
            Fixture *f = [Fixture new]; f.present = mode == 1; f.cancelInPrompt = mode == 2;
            f.cancelInStore = mode == 3 || mode == 4; f.duplicateInStore = mode == 4;
            BOOL threw = NO; NSDictionary *result = nil;
            @try { result = KlausPromptLoginPassword(f, @"fixture-owner", ^{ if (f.cancelled) Cancel(); }); }
            @catch (NSException *error) { Expect([error.reason isEqual:@"cancelled"]); threw = YES; }
            Expect(threw == (mode >= 2));
            if (mode == 0) Expect([result[@"stored"] boolValue] && f.stores == 1 && f.present);
            if (mode == 1) Expect(![result[@"stored"] boolValue] && f.prompts == 0 && f.stores == 0 && f.removals == 0 && f.present);
            if (mode == 2) Expect(f.stores == 0 && f.removals == 0 && !f.present);
            if (mode == 3) Expect(f.stores == 1 && f.removals == 1 && !f.present);
            if (mode == 4) Expect(f.stores == 1 && f.removals == 0 && f.present);
            for (NSUInteger index = 0; index < f.secret.length; index++) Expect(((const unsigned char *)f.secret.bytes)[index] == 0);
        }
        for (NSDictionary *scenario in vector[@"lockCases"]) {
            Fixture *f = [Fixture new]; f.locks = scenario[@"locked"]; f.idle = [scenario[@"idle"] doubleValue];
            f.present = [scenario[@"password"] boolValue]; f.cancelBeforeInput = [scenario[@"cancelBeforeInput"] boolValue];
            __block NSUInteger pauses = 0, posts = 0; NSString *outcome = @"unlocked"; BOOL returned = NO;
            @try {
                returned = KlausEnsureUnlocked(f, [scenario[@"enabled"] boolValue],
                    ^{ return (BOOL)(scenario[@"trusted"] == nil ? YES : [scenario[@"trusted"] boolValue]); },
                    ^{ if (f.cancelled) Cancel(); },
                    ^(double duration) { Expect(duration * 1000 == [vector[@"verificationDelayMs"] doubleValue]); pauses++; }, ^{ posts++; });
            } @catch (NSException *error) {
                outcome = [error.reason isEqual:@"cancelled"] ? @"cancelled"
                    : [error.reason containsString:@"physical input"] ? @"paused"
                    : [error.reason isEqual:KlausLockScreenTrustMessage()] ? @"untrusted" : @"manual";
            }
            Expect([outcome isEqual:scenario[@"outcome"]]); Expect(f.attempts == [scenario[@"attempts"] unsignedIntegerValue]);
            Expect(posts == f.attempts); Expect(pauses == f.attempts);
            Expect(returned == [scenario[@"returned"] boolValue]);
        }
        for (NSDictionary *scenario in vector[@"ancestryCases"]) {
            Expect(KlausAncestryTrusted([scenario[@"selfSigned"] boolValue], [scenario[@"ancestorMatched"] boolValue]) == [scenario[@"trusted"] boolValue]);
        }
        for (NSDictionary *scenario in vector[@"inputCases"]) {
            double own = scenario[@"sinceOwn"] == NSNull.null ? INFINITY : [scenario[@"sinceOwn"] doubleValue];
            Expect(KlausUserIsInteracting([scenario[@"idle"] doubleValue], own) == [scenario[@"interacting"] boolValue]);
        }
        Expect([KlausInteractionWaitMessage(@"Notes") isEqual:@"The user is still interacting with Notes. Wait 2 seconds and retry."]);
        Expect([KlausInteractionWaitMessage(@"  ") isEqual:@"The user is still interacting with this app. Wait 2 seconds and retry."]);
        printf("{\"assertions\":%lu,\"realKeychainCalls\":0,\"realInputPosts\":0,\"realPrompts\":0}\n", (unsigned long)Assertions);
    }
}
