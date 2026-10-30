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
void KlausEnsureUnlocked(id<KlausLockScreenPlatform> platform, BOOL enabled, void (^check)(void), void (^pause)(double), void (^posted)(void));
BOOL KlausUserIsInteracting(double idle, double sinceOwn);
NSString *KlausInteractionWaitMessage(NSString *app);
