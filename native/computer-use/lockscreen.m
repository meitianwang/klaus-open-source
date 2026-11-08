#import "lockscreen.h"
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <math.h>
#include <string.h>
#include <sys/sysctl.h>
#include <unistd.h>

static NSString *const Account = @"computer_use.login_password";
static NSString *const LockedFallback = @"The Mac is locked and automatic unlock could not unlock it. Ask the user to unlock the Mac manually before continuing.";
static NSString *const PhysicalInput = @"The Mac is locked and automatic unlock is paused because physical input was detected. Ask the user to unlock the Mac manually before continuing.";
static NSString *const TrustDenied = @"Automatic unlock is unavailable because this helper was not launched by a trusted Klaus process. Ask the user to unlock the Mac manually.";
static void Fail(NSString *message) { @throw [NSException exceptionWithName:@"ComputerUse" reason:message userInfo:nil]; }
// Product credential namespaces: `agent-engine`, optionally followed by
// lowercase alphanumeric `-segments`, at most 64 bytes. Each desktop edition
// owns one namespace; anything outside this family is refused.
static BOOL KlausProductKeychainService(NSString *service) {
    if (service.length == 0 || service.length > 64 || ![service hasPrefix:@"agent-engine"]) return NO;
    NSString *rest = [service substringFromIndex:@"agent-engine".length];
    if (rest.length == 0) return YES;
    if (![rest hasPrefix:@"-"]) return NO;
    for (NSString *segment in [[rest substringFromIndex:1] componentsSeparatedByString:@"-"]) {
        if (segment.length == 0) return NO;
        for (NSUInteger index = 0; index < segment.length; index++) {
            unichar character = [segment characterAtIndex:index];
            if (!((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9'))) return NO;
        }
    }
    return YES;
}

NSString *KlausLockScreenKeychainService(NSDictionary<NSString *, NSString *> *environment) {
    NSString *service = environment[@"KLAUS_COMPUTER_USE_KEYCHAIN_SERVICE"] ?: @"agent-engine";
    if (!KlausProductKeychainService(service)) {
        Fail(@"Invalid product credential namespace");
    }
    return service;
}

static void ClearPassword(NSMutableData *password) {
    volatile unsigned char *bytes = password.mutableBytes;
    for (NSUInteger index = 0; index < password.length; index++) bytes[index] = 0;
}

BOOL KlausUserIsInteracting(double idle, double sinceOwn) { return isfinite(idle) && idle >= 0 && idle < 1.5 && idle + 0.2 < sinceOwn; }
NSString *KlausInteractionWaitMessage(NSString *app) {
    NSString *name = [app stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return [NSString stringWithFormat:@"The user is still interacting with %@. Wait 2 seconds and retry.", name.length ? name : @"this app"];
}

NSDictionary *KlausPromptLoginPassword(id<KlausLockScreenPlatform> platform, NSString *owner, void (^check)(void)) {
    check();
    if ([platform hasPassword]) { check(); return @{@"hasLoginPassword": @YES, @"stored": @NO, @"cancelled": @NO}; }
    NSMutableData *password = nil; BOOL created = NO;
    @try {
        password = [platform collectPassword:check]; check();
        if (!password.length) return @{@"hasLoginPassword": @NO, @"stored": @NO, @"cancelled": @YES};
        if (password.length > 16384) Fail(@"The login password exceeds the native storage limit");
        check(); created = [platform storeNewPassword:password owner:owner]; check();
        return @{@"hasLoginPassword": @YES, @"stored": @(created), @"cancelled": @NO};
    } @catch (NSException *error) {
        // Never remove a credential that existed before this operation or was written by another owner.
        if (created) {
            @try { [platform removePasswordOwnedBy:owner]; }
            @catch (NSException *cleanup) { (void)cleanup; Fail(@"The password save entered the system before cancellation; removal of this operation's new credential could not be confirmed"); }
        }
        @throw error;
    } @finally { ClearPassword(password); }
}

BOOL KlausEnsureUnlocked(id<KlausLockScreenPlatform> platform, BOOL enabled, BOOL (^trusted)(void), void (^check)(void), void (^pause)(double), void (^posted)(void)) {
    check(); NSNumber *locked = [platform locked]; check();
    if (locked && !locked.boolValue) return NO;
    if (!locked) Fail(LockedFallback);
    double idle = [platform secondsSinceInput]; check();
    if (!isfinite(idle) || idle < 0 || idle < 5) Fail(PhysicalInput);
    if (!enabled || ![platform hasPassword]) Fail(LockedFallback);
    // Only a launcher whose process ancestry proves it may spend the stored
    // credential; everything else keeps the Mac locked.
    if (trusted && !trusted()) Fail(TrustDenied);
    check();
    @try { [platform attemptStoredPassword:check posted:posted]; }
    @catch (NSException *error) { (void)error; check(); }
    check(); pause(0.6); check(); locked = [platform locked]; check();
    if (!locked || locked.boolValue) Fail(LockedFallback);
    return YES;
}

NSString *KlausLockScreenTrustMessage(void) { return TrustDenied; }

BOOL KlausAncestryTrusted(BOOL selfSigned, BOOL ancestorMatched) { return selfSigned ? ancestorMatched : YES; }

/// How many parent processes the ancestry walk inspects before giving up.
static const int KlausAncestorWalkDepth = 10;

static NSString *OwnTeamIdentifier(BOOL *signedOut) {
    BOOL valid = NO; NSString *team = nil;
    SecCodeRef code = NULL;
    if (SecCodeCopySelf(kSecCSDefaultFlags, &code) == errSecSuccess && code) {
        valid = SecCodeCheckValidity(code, kSecCSDefaultFlags, NULL) == errSecSuccess;
        if (valid) {
            CFDictionaryRef info = NULL;
            if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) == errSecSuccess && info) {
                id value = ((__bridge NSDictionary *)info)[(__bridge NSString *)kSecCodeInfoTeamIdentifier];
                if ([value isKindOfClass:NSString.class] && [value length]) team = value;
                CFRelease(info);
            }
        }
        CFRelease(code);
    }
    if (signedOut) *signedOut = valid && team != nil;
    return team;
}

static BOOL AncestorMatchesTeam(NSString *team) {
    pid_t pid = getppid();
    for (int depth = 0; depth < KlausAncestorWalkDepth && pid > 1; depth++) {
        SecCodeRef code = NULL;
        NSDictionary *attributes = @{(__bridge id)kSecGuestAttributePid: @(pid)};
        if (SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attributes, kSecCSDefaultFlags, &code) == errSecSuccess && code) {
            BOOL matches = NO;
            if (SecCodeCheckValidity(code, kSecCSDefaultFlags, NULL) == errSecSuccess) {
                CFDictionaryRef info = NULL;
                if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) == errSecSuccess && info) {
                    id value = ((__bridge NSDictionary *)info)[(__bridge NSString *)kSecCodeInfoTeamIdentifier];
                    matches = [value isKindOfClass:NSString.class] && [value isEqual:team];
                    CFRelease(info);
                }
            }
            CFRelease(code);
            if (matches) return YES;
        }
        int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
        struct kinfo_proc info; size_t size = sizeof(info);
        if (sysctl(mib, 4, &info, &size, NULL, 0) != 0 || size < sizeof(info)) break;
        pid = info.kp_eproc.e_ppid;
    }
    return NO;
}

BOOL KlausSystemAncestryTrusted(void) {
    BOOL selfSigned = NO;
    NSString *team = OwnTeamIdentifier(&selfSigned);
    return KlausAncestryTrusted(selfSigned, selfSigned ? AncestorMatchesTeam(team) : NO);
}

static NSMutableDictionary *CredentialQuery(void) {
    NSString *service = KlausLockScreenKeychainService(NSProcessInfo.processInfo.environment);
    // This fixed account predates the data-protection keychain. Its legacy access UI ignores LAContext.
    // The setting is local to this one-operation helper, never the Electron process.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    OSStatus legacy = SecKeychainSetUserInteractionAllowed(false);
#pragma clang diagnostic pop
    if (legacy != errSecSuccess) Fail(@"Non-interactive keychain access is unavailable");
    LAContext *context = [LAContext new]; context.interactionNotAllowed = YES;
    return [@{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: service, (__bridge id)kSecAttrAccount: Account,
        (__bridge id)kSecUseAuthenticationContext: context} mutableCopy];
}
static void KeychainStatus(OSStatus status) {
    if (status != errSecSuccess) Fail(@"Computer Use login password could not be accessed in the system keychain");
}
static id CopyAttribute(AXUIElementRef element, CFStringRef attribute) {
    AXUIElementSetMessagingTimeout(element, 0.25); CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(element, attribute, &value);
    if (error != kAXErrorSuccess || !value) return nil;
    return CFBridgingRelease(value);
}
static BOOL IsElement(id value) { return value && CFGetTypeID((__bridge CFTypeRef)value) == AXUIElementGetTypeID(); }

@interface SystemLockScreen : NSObject <KlausLockScreenPlatform>
@end
@implementation SystemLockScreen
- (BOOL)hasPassword {
    NSMutableDictionary *query = CredentialQuery();
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    query[(__bridge id)kSecReturnAttributes] = @YES;
    CFTypeRef value = NULL; OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &value);
    if (value) CFRelease(value);
    if (status == errSecItemNotFound) return NO;
    KeychainStatus(status); return YES;
}
- (NSMutableData *)collectPassword:(void (^)(void))check {
    check();
    NSAlert *alert = [NSAlert new]; alert.messageText = @"Klaus";
    alert.informativeText = @"Enter this Mac's login password to allow an unlock attempt when nobody is at the keyboard. It is stored only in the system keychain. macOS may still require you to unlock manually.";
    [alert addButtonWithTitle:@"Save"]; [alert addButtonWithTitle:@"Cancel"];
    NSSecureTextField *field = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(0, 0, 320, 24)];
    alert.accessoryView = field; [alert.window setInitialFirstResponder:field];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    if (@available(macOS 14.0, *)) [NSApp activate]; else [NSApp activateIgnoringOtherApps:YES];
    __block NSException *cancelled = nil;
    NSTimer *timer = [NSTimer timerWithTimeInterval:0.02 repeats:YES block:^(NSTimer *unused) {
        (void)unused;
        @try { check(); } @catch (NSException *error) { cancelled = error; [NSApp abortModal]; [alert.window orderOut:nil]; }
    }];
    [NSRunLoop.currentRunLoop addTimer:timer forMode:NSModalPanelRunLoopMode];
    @try {
        NSModalResponse response = [alert runModal]; check(); if (cancelled) @throw cancelled;
        if (response != NSAlertFirstButtonReturn || !field.stringValue.length) return nil;
        return [[field.stringValue dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
    } @finally { [timer invalidate]; field.stringValue = @""; [alert.window orderOut:nil]; }
}
- (BOOL)storeNewPassword:(NSData *)password owner:(NSString *)owner {
    NSMutableDictionary *query = CredentialQuery();
    query[(__bridge id)kSecValueData] = password;
    query[(__bridge id)kSecAttrGeneric] = [owner dataUsingEncoding:NSUTF8StringEncoding];
    OSStatus status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);
    if (status == errSecDuplicateItem) return NO;
    KeychainStatus(status); return YES;
}
- (void)removePasswordOwnedBy:(NSString *)owner {
    NSMutableDictionary *query = CredentialQuery();
    if (owner) query[(__bridge id)kSecAttrGeneric] = [owner dataUsingEncoding:NSUTF8StringEncoding];
    OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query);
    if (status != errSecItemNotFound) KeychainStatus(status);
}
- (NSNumber *)locked {
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    if (![session isKindOfClass:NSDictionary.class] || ![session[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue]
        || ![session[(__bridge NSString *)kCGSessionLoginDoneKey] boolValue]) return nil;
    return @([session[@"CGSSessionScreenIsLocked"] boolValue]);
}
- (double)secondsSinceInput { return CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGAnyInputEventType); }
- (void)attemptStoredPassword:(void (^)(void))check posted:(void (^)(void))posted {
    check();
    NSMutableDictionary *query = CredentialQuery(); query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne; query[(__bridge id)kSecReturnData] = @YES;
    CFTypeRef value = NULL; OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &value);
    NSData *stored = CFBridgingRelease(value); KeychainStatus(status);
    if (![stored isKindOfClass:NSData.class] || !stored.length || stored.length > 16384) Fail(LockedFallback);
    NSMutableData *bytes = [stored mutableCopy]; stored = nil;
    @try {
        check(); NSArray<NSRunningApplication *> *apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.loginwindow"];
        if (apps.count != 1 || apps.firstObject.terminated || !AXIsProcessTrusted()) Fail(LockedFallback);
        NSRunningApplication *app = apps.firstObject;
        AXUIElementRef process = AXUIElementCreateApplication(app.processIdentifier);
        @try {
            id field = CopyAttribute(process, kAXFocusedUIElementAttribute);
            if (!IsElement(field) || ![CopyAttribute((__bridge AXUIElementRef)field, kAXSubroleAttribute) isEqual:@"AXSecureTextField"]) Fail(LockedFallback);
            pid_t pid = 0;
            if (AXUIElementGetPid((__bridge AXUIElementRef)field, &pid) != kAXErrorSuccess || pid != app.processIdentifier) Fail(LockedFallback);
            NSString *password = [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding];
            if (!password.length) Fail(LockedFallback);
            check(); NSNumber *locked = [self locked]; double idle = [self secondsSinceInput];
            if (!locked.boolValue || !isfinite(idle) || idle < 5 || app.terminated) Fail(LockedFallback);
            check(); AXError result = AXUIElementSetAttributeValue((__bridge AXUIElementRef)field, kAXValueAttribute, (__bridge CFStringRef)password); password = nil;
            if (result != kAXErrorSuccess) Fail(LockedFallback);
            check();
            // The unlock keystrokes carry the same own-input mark as every other
            // event this helper family posts, so watch modes never mistake the
            // unlock itself for a person at the keyboard.
            CGEventSourceRef unlockSource = CGEventSourceCreate(kCGEventSourceStatePrivate);
            CGEventRef down = CGEventCreateKeyboardEvent(unlockSource, 36, true), up = CGEventCreateKeyboardEvent(unlockSource, 36, false);
            if (unlockSource) CFRelease(unlockSource);
            if (!down || !up) { if (down) CFRelease(down); if (up) CFRelease(up); Fail(LockedFallback); }
            CGEventSetIntegerValueField(down, kCGEventSourceUserData, 0x4b4c4155);
            CGEventSetIntegerValueField(up, kCGEventSourceUserData, 0x4b4c4155);
            BOOL pressed = NO;
            @try { check(); CGEventPost(kCGHIDEventTap, down); pressed = YES; posted(); }
            @finally { if (pressed) { CGEventPost(kCGHIDEventTap, up); posted(); } CFRelease(down); CFRelease(up); }
        } @finally { CFRelease(process); }
    } @finally { ClearPassword(bytes); }
}
@end
id<KlausLockScreenPlatform> KlausSystemLockScreenPlatform(void) { return [SystemLockScreen new]; }
