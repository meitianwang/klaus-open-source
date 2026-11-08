#import <Foundation/Foundation.h>

// This protocol stays inside the native helper. No method returns a password to the host.
@protocol KlausLockScreenPlatform <NSObject>
- (BOOL)hasPassword;
- (NSMutableData *)collectPassword:(void (^)(void))check;
- (BOOL)storeNewPassword:(NSData *)password owner:(NSString *)owner;
- (void)removePasswordOwnedBy:(NSString *)owner;
- (NSNumber *)locked;
- (double)secondsSinceInput;
- (void)attemptStoredPassword:(void (^)(void))check posted:(void (^)(void))posted;
@end

NSString *KlausLockScreenKeychainService(NSDictionary<NSString *, NSString *> *environment);
id<KlausLockScreenPlatform> KlausSystemLockScreenPlatform(void);
NSDictionary *KlausPromptLoginPassword(id<KlausLockScreenPlatform> platform, NSString *owner, void (^check)(void));
/**
 * Unlock the screen for an authorized run when needed. Returns YES only when this
 * call took the screen from locked to unlocked. `trusted` gates the unlock attempt
 * itself (a NULL block counts as trusted); an untrusted launcher gets the trust
 * wording instead of an unlock.
 */
BOOL KlausEnsureUnlocked(id<KlausLockScreenPlatform> platform, BOOL enabled, BOOL (^trusted)(void), void (^check)(void), void (^pause)(double), void (^posted)(void));
BOOL KlausUserIsInteracting(double idle, double sinceOwn);
NSString *KlausInteractionWaitMessage(NSString *app);
/** Wording used when the launching process ancestry failed the trust check. */
NSString *KlausLockScreenTrustMessage(void);
/** Pure trust verdict: an unsigned (development) helper skips the ancestry gate. */
BOOL KlausAncestryTrusted(BOOL selfSigned, BOOL ancestorMatched);
/** System trust check: the helper's own signing team must appear in its parent chain. */
BOOL KlausSystemAncestryTrusted(void);
