#import <AppKit/AppKit.h>
#import <CoreServices/CoreServices.h>
#import <CoreLocation/CoreLocation.h>
#import <Photos/Photos.h>
#import <UserNotifications/UserNotifications.h>
#include "KlausPermissions.h"

#ifndef KLAUS_PERMISSIONS_TESTING
typedef OSStatus (*KlausAutomationPermissionQuery)(const AEAddressDesc *, AEEventClass, AEEventID, Boolean);
#endif

static NSString *const kSystemEventsBundleId = @"com.apple.systemevents";

static int32_t SystemEventsProcess(void) {
    NSArray<NSRunningApplication *> *applications = [NSRunningApplication runningApplicationsWithBundleIdentifier:kSystemEventsBundleId];
    if (applications.count != 1 || applications.firstObject.terminated) return 0;
    return applications.firstObject.processIdentifier;
}

// Apple's Apple Events query resolves the target to a RUNNING process and only accepts a
// PID descriptor for it: measured on this machine, a bundle-id descriptor answers
// procNotFound (-600) even while System Events runs, while the PID descriptor of the same
// running process answers with the recorded TCC decision. So the probe addresses the
// running process by PID.
static OSStatus QueryRunningProcess(int32_t (*lookup)(void), KlausAutomationPermissionQuery query) {
    pid_t pid = lookup();
    if (pid <= 0) return procNotFound;
    // A PID descriptor cannot launch an application and cannot retarget a later bundle lookup.
    AEAddressDesc target = { typeNull, NULL };
    OSStatus created = AECreateDesc(typeKernelProcessID, &pid, sizeof(pid), &target);
    if (created != noErr) return created;
    OSStatus status = query(&target, typeWildCard, typeWildCard, false);
    AEDisposeDesc(&target);
    return status;
}

// With System Events absent the query can only answer procNotFound, so a purely passive
// probe can never observe a recorded grant. System Events is a faceless system agent (no
// window, no Dock icon); starting it is the only public way to make the decision
// observable, and it is done only after the passive probe proved the target absent.
static BOOL EnsureSystemEventsRunning(void) {
    if ([NSRunningApplication runningApplicationsWithBundleIdentifier:kSystemEventsBundleId].count > 0) return YES;
    NSURL *url = [[NSWorkspace sharedWorkspace] URLForApplicationWithBundleIdentifier:kSystemEventsBundleId];
    if (!url) return NO;
    NSWorkspaceOpenConfiguration *configuration = [[NSWorkspaceOpenConfiguration alloc] init];
    configuration.activates = NO;
    configuration.addsToRecentItems = NO;
    configuration.promptsUserIfNeeded = NO;
    __block BOOL opened = NO;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [[NSWorkspace sharedWorkspace] openApplicationAtURL:url configuration:configuration
                                      completionHandler:^(NSRunningApplication *application, NSError *error) {
        (void)error;
        opened = application != nil;
        dispatch_semaphore_signal(done);
    }];
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    for (int attempt = 0; attempt < 20; attempt++) {
        if ([NSRunningApplication runningApplicationsWithBundleIdentifier:kSystemEventsBundleId].count > 0) return YES;
        [NSThread sleepForTimeInterval:0.25];
    }
    return opened;
}

static OSStatus ProbeAutomation(KlausAutomationPermissionQuery query, BOOL allowLaunch) {
    OSStatus status = QueryRunningProcess(SystemEventsProcess, query);
    if (status == procNotFound && allowLaunch && EnsureSystemEventsRunning()) {
        status = QueryRunningProcess(SystemEventsProcess, query);
    }
    return status;
}

int32_t klaus_automation_permission_status(void) {
    @autoreleasepool {
        @try {
            return ProbeAutomation(AEDeterminePermissionToAutomateTarget, YES);
        } @catch (NSException *error) {
            (void)error;
            return paramErr;
        }
    }
}

// askUserIfNeeded=true is the only way Apple Events consent can be requested; it shows
// the system dialog once and records the answer in TCC. A plain C function, not a block:
// the probe takes a function pointer.
static OSStatus QueryWithConsent(const AEAddressDesc *target, AEEventClass eventClass,
                                 AEEventID eventId, Boolean askUserIfNeeded) {
    (void)askUserIfNeeded;
    return AEDeterminePermissionToAutomateTarget(target, eventClass, eventId, true);
}

int32_t klaus_automation_request_consent(void) {
    @autoreleasepool {
        @try {
            return ProbeAutomation(QueryWithConsent, YES);
        } @catch (NSException *error) {
            (void)error;
            return paramErr;
        }
    }
}

// PHAuthorizationStatus values: 0 notDetermined, 1 restricted, 2 denied, 3 limited, 4 authorized.
// Read-only queries never trigger the access dialog; only the explicit request does.
static int32_t PhotosStatus(void) {
    if (@available(macOS 11.0, *)) {
        return (int32_t)[PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite];
    }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    int32_t status = (int32_t)[PHPhotoLibrary authorizationStatus];
#pragma clang diagnostic pop
    return status;
}

int32_t klaus_photos_permission_status(void) {
    @autoreleasepool {
        @try {
            return PhotosStatus();
        } @catch (NSException *error) {
            (void)error;
            return -1;
        }
    }
}

int32_t klaus_photos_request_authorization(void) {
    @autoreleasepool {
        @try {
            __block int32_t result = -1;
            dispatch_semaphore_t done = dispatch_semaphore_create(0);
            if (@available(macOS 11.0, *)) {
                [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelReadWrite
                                                           handler:^(PHAuthorizationStatus status) {
                    result = (int32_t)status;
                    dispatch_semaphore_signal(done);
                }];
            } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
                [PHPhotoLibrary requestAuthorization:^(PHAuthorizationStatus status) {
                    result = (int32_t)status;
                    dispatch_semaphore_signal(done);
                }];
#pragma clang diagnostic pop
            }
            dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC));
            return result;
        } @catch (NSException *error) {
            (void)error;
            return -1;
        }
    }
}

// CLAuthorizationStatus values: 0 notDetermined, 1 restricted, 2 denied, 3 authorizedAlways.
// status is a passive read; requesting location consent is not exposed because the app
// has no location feature to justify the usage-description prompt yet.
int32_t klaus_location_permission_status(void) {
    @autoreleasepool {
        @try {
            if (![CLLocationManager locationServicesEnabled]) return 2; // services off reads as denied
            if (@available(macOS 11.0, *)) {
                CLLocationManager *manager = [[CLLocationManager alloc] init];
                return (int32_t)manager.authorizationStatus;
            }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
            int32_t status = (int32_t)[CLLocationManager authorizationStatus];
#pragma clang diagnostic pop
            return status;
        } @catch (NSException *error) {
            (void)error;
            return -1;
        }
    }
}

// UNAuthorizationStatus values: 0 notDetermined, 1 denied, 2 authorized, 3 provisional, 4 ephemeral.
// The center only exists inside an app bundle; outside one it throws from a dispatch_once
// block that @try cannot catch, so refuse early instead of crashing the process.
static BOOL HasAppBundle(void) {
    return [[[NSBundle mainBundle] bundleURL].pathExtension isEqualToString:@"app"];
}

int32_t klaus_notification_permission_status(void) {
    @autoreleasepool {
        @try {
            if (!HasAppBundle()) return -1;
            __block int32_t result = -1;
            dispatch_semaphore_t done = dispatch_semaphore_create(0);
            [[UNUserNotificationCenter currentNotificationCenter]
                getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
                    result = (int32_t)settings.authorizationStatus;
                    dispatch_semaphore_signal(done);
                }];
            dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
            return result;
        } @catch (NSException *error) {
            (void)error;
            return -1;
        }
    }
}

int32_t klaus_notification_request_authorization(void) {
    @autoreleasepool {
        @try {
            if (!HasAppBundle()) return -1;
            __block int32_t result = -1;
            dispatch_semaphore_t done = dispatch_semaphore_create(0);
            UNAuthorizationOptions options = UNAuthorizationOptionAlert | UNAuthorizationOptionBadge |
                                             UNAuthorizationOptionSound;
            [[UNUserNotificationCenter currentNotificationCenter]
                requestAuthorizationWithOptions:options
                              completionHandler:^(BOOL granted, NSError *error) {
                    (void)granted;
                    result = error ? -1 : klaus_notification_permission_status();
                    dispatch_semaphore_signal(done);
                }];
            dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC));
            return result;
        } @catch (NSException *error) {
            (void)error;
            return -1;
        }
    }
}

#ifdef KLAUS_PERMISSIONS_TESTING
// The test surface is strictly passive: it must never launch the target.
OSStatus klaus_automation_permission_probe(KlausAutomationTargetLookup lookup, KlausAutomationPermissionQuery query) {
    return QueryRunningProcess(lookup, query);
}
#endif
