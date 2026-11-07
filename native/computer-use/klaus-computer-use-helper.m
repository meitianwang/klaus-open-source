#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreImage/CoreImage.h>
#import <CoreAudio/CoreAudio.h>
#import "lockscreen.h"
#include <signal.h>
#include <stdlib.h>
#include <unistd.h>
#include <time.h>
#include <dlfcn.h>
#import <IOKit/hidsystem/IOLLEvent.h>

// One request, one OS operation. The host owns approval, sessions and tree history.
static volatile sig_atomic_t Cancelled = 0;
static pid_t Parent = 0;
static double PostedAt = 0;
static double StartedAt = 0;
static double OperationDeadline = 118;
static double CooldownUntil = 0;
static BOOL ActionStarted = NO;
static CGEventSourceRef InputSource = NULL;
static void Stop(int value) { (void)value; Cancelled = 1; }
static void Fail(NSString *message) { @throw [NSException exceptionWithName:@"ComputerUse" reason:message userInfo:nil]; }
static void Check(void) {
    if (Cancelled || getppid() != Parent) Fail(@"Computer Use operation was cancelled");
    if (CFAbsoluteTimeGetCurrent() - StartedAt > OperationDeadline) Fail(@"Computer Use native operation exceeded its deadline");
}
static NSString *Text(id value) { return [value isKindOfClass:NSString.class] ? value : @""; }
static NSDictionary *Dict(id value) { return [value isKindOfClass:NSDictionary.class] ? value : @{}; }
static double NowMs(void) { return NSDate.date.timeIntervalSince1970 * 1000; }
static double Numeric(id value, double minimum, double maximum) {
    if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) Fail(@"Invalid native numeric argument");
    double number = [value doubleValue]; if (!isfinite(number) || number < minimum || number > maximum) Fail(@"Native numeric argument is outside its range"); return number;
}
static void WaitUntil(BOOL (^ready)(void), double seconds) {
    double limit = CFAbsoluteTimeGetCurrent() + seconds;
    while (!ready()) { Check(); if (CFAbsoluteTimeGetCurrent() >= limit) Fail(@"Computer Use OS response timed out");
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]]; }
}
static void Pause(double seconds) { double end = CFAbsoluteTimeGetCurrent() + seconds; WaitUntil(^BOOL { return CFAbsoluteTimeGetCurrent() >= end; }, seconds + 0.1); }
static NSString *Clean(id value) {
    NSString *text = [value isKindOfClass:NSString.class] ? value : [value isKindOfClass:NSNumber.class] ? [value stringValue] : @"";
    text = [[text componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet] componentsJoinedByString:@" "];
    return text.length > 4096 ? [text substringToIndex:4096] : text;
}
static id CopyAttribute(AXUIElementRef element, CFStringRef attribute) {
    Check(); AXUIElementSetMessagingTimeout(element, 0.25); CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(element, attribute, &value);
    if (error != kAXErrorSuccess && error != kAXErrorAttributeUnsupported && error != kAXErrorNoValue
        && CFEqual(attribute, kAXChildrenAttribute) && [NSProcessInfo.processInfo.environment[@"KLAUS_COMPUTER_USE_DIAGNOSTICS"] isEqualToString:@"1"]) fprintf(stderr, "accessibility children read: %d\n", (int)error);
    if (error != kAXErrorSuccess || !value) return nil;
    return CFBridgingRelease(value);
}
static NSString *Attribute(AXUIElementRef element, CFStringRef name) { return Clean(CopyAttribute(element, name)); }
static NSArray *Children(AXUIElementRef element, CFStringRef name) { id value = CopyAttribute(element, name); return [value isKindOfClass:NSArray.class] ? value : @[]; }
static BOOL IsElement(id value) { return value && CFGetTypeID((__bridge CFTypeRef)value) == AXUIElementGetTypeID(); }
static CGRect ElementBounds(AXUIElementRef element) {
    id p = CopyAttribute(element, kAXPositionAttribute), s = CopyAttribute(element, kAXSizeAttribute); CGPoint point = CGPointZero; CGSize size = CGSizeZero;
    if (p && CFGetTypeID((__bridge CFTypeRef)p) == AXValueGetTypeID()) AXValueGetValue((__bridge AXValueRef)p, kAXValueCGPointType, &point);
    if (s && CFGetTypeID((__bridge CFTypeRef)s) == AXValueGetTypeID()) AXValueGetValue((__bridge AXValueRef)s, kAXValueCGSizeType, &size);
    return (CGRect){ point, size };
}
static NSDictionary *Rectangle(CGRect frame) { return @{@"x": @(frame.origin.x), @"y": @(frame.origin.y), @"width": @(frame.size.width), @"height": @(frame.size.height)}; }
static CGRect ReadRectangle(NSDictionary *value) {
    return CGRectMake(Numeric(value[@"x"], -1000000, 1000000), Numeric(value[@"y"], -1000000, 1000000), Numeric(value[@"width"], 1, 100000), Numeric(value[@"height"], 1, 100000));
}
static BOOL SameRectangle(CGRect a, CGRect b) {
    return fabs(a.origin.x - b.origin.x) < 2 && fabs(a.origin.y - b.origin.y) < 2 && fabs(a.size.width - b.size.width) < 2 && fabs(a.size.height - b.size.height) < 2;
}
static NSDictionary *CaptureDiagnosticWindow(NSDictionary *window) {
    if (!window) return @{@"exists": @NO};
    CGRect bounds = CGRectZero;
    BOOL hasBounds = CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(__bridge NSString *)kCGWindowBounds], &bounds);
    return @{@"exists": @YES, @"pid": window[(__bridge NSString *)kCGWindowOwnerPID] ?: @0,
        @"windowId": window[(__bridge NSString *)kCGWindowNumber] ?: @0, @"layer": window[(__bridge NSString *)kCGWindowLayer] ?: @0,
        @"onScreen": @([window[(__bridge NSString *)kCGWindowIsOnscreen] boolValue]), @"bounds": hasBounds ? Rectangle(bounds) : (id)NSNull.null};
}
static void AppshotWindowDiagnostic(NSString *phase, pid_t pid, CGWindowID identifier, CGRect expected, NSArray *onScreen) {
    if (![NSProcessInfo.processInfo.environment[@"KLAUS_COMPUTER_USE_DIAGNOSTICS"] isEqualToString:@"1"]) return;
    NSDictionary *visible = nil;
    for (NSDictionary *window in onScreen) if ([window[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == identifier) { visible = window; break; }
    NSArray *known = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, identifier));
    NSDictionary *same = nil;
    for (NSDictionary *window in known) if ([window[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == identifier) { same = window; break; }
    NSDictionary *event = @{@"event": @"appshot-window-diagnostic", @"phase": phase, @"at": @(NowMs()),
        @"helperPid": @(getpid()), @"parentPid": @(Parent), @"foregroundPid": @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),
        @"expectedPid": @(pid), @"expectedWindowId": @(identifier), @"expectedBounds": Rectangle(expected),
        @"sameWindow": CaptureDiagnosticWindow(same), @"onScreenSameWindow": CaptureDiagnosticWindow(visible)};
    NSData *encoded = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    if (encoded && encoded.length < 8192) fprintf(stderr, "%s\n", [[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding].UTF8String);
}
static NSString *CanonicalPath(NSString *path) {
    if (!path.length) return @"";
    char *resolved = realpath(path.fileSystemRepresentation, NULL);
    if (!resolved) return path.stringByStandardizingPath;
    NSString *value = [NSString stringWithUTF8String:resolved]; free(resolved); return value ?: @"";
}
static NSDictionary *Identity(NSRunningApplication *app, NSString *input) {
    NSMutableDictionary *result = [@{@"input": input, @"name": app.localizedName ?: @"Application", @"path": CanonicalPath(app.bundleURL.path ?: app.executableURL.path ?: @""),
        @"pid": @(app.processIdentifier)} mutableCopy];
    if (app.bundleIdentifier.length) result[@"bundleId"] = app.bundleIdentifier; return result;
}
static NSDictionary *SelectApplication(NSArray<NSDictionary *> *candidates, NSString *input, pid_t foreground) {
    BOOL path = input.isAbsolutePath; NSString *canonical = path ? CanonicalPath(input) : @"", *token = input.lowercaseString;
    NSMutableArray<NSDictionary *> *matches = [NSMutableArray array];
    for (NSDictionary *candidate in candidates) {
        BOOL match = path ? [Text(candidate[@"path"]) isEqualToString:canonical]
            : ([Text(candidate[@"bundleId"]).lowercaseString isEqualToString:token] || [Text(candidate[@"name"]).lowercaseString isEqualToString:token]);
        if (match) [matches addObject:candidate];
    }
    if (matches.count == 1) return matches.firstObject;
    if (matches.count > 1) {
        // Several running instances can share one installation. Its foreground
        // instance is unambiguous; an identically named different installation is not.
        NSSet *paths = [NSSet setWithArray:[matches valueForKey:@"path"]];
        if (paths.count == 1) for (NSDictionary *candidate in matches) if ([candidate[@"pid"] intValue] == foreground) return candidate;
        if (paths.count == 1) {
            NSPredicate *visible = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *candidate, NSDictionary *bindings) { (void)bindings; return [candidate[@"windowCount"] unsignedIntegerValue] > 0; }];
            NSArray *windowed = [matches filteredArrayUsingPredicate:visible]; if (windowed.count == 1) return windowed.firstObject;
            NSPredicate *regular = [NSPredicate predicateWithBlock:^BOOL(NSDictionary *candidate, NSDictionary *bindings) { (void)bindings; return [candidate[@"regular"] boolValue]; }];
            NSArray *ui = [matches filteredArrayUsingPredicate:regular]; if (ui.count == 1 && !windowed.count) return ui.firstObject;
        }
        NSMutableArray *details = [NSMutableArray array];
        for (NSDictionary *candidate in matches) [details addObject:[NSString stringWithFormat:@"%@ (pid %@)", candidate[@"path"], candidate[@"pid"]]];
        Fail([NSString stringWithFormat:@"Application identity is ambiguous: %@. Use its exact application path and bring the intended instance to the foreground.", [details componentsJoinedByString:@", "]]);
    }
    return nil;
}
static NSDictionary *Resolve(NSString *input) {
    if (!input.length || input.length > 4096) Fail(@"An application name or path is required");
    NSMutableArray *candidates = [NSMutableArray array];
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
        NSMutableDictionary *candidate = [Identity(app, input) mutableCopy]; NSUInteger count = 0;
        for (NSDictionary *window in windows) if ([window[(__bridge NSString *)kCGWindowOwnerPID] intValue] == app.processIdentifier) count++;
        candidate[@"windowCount"] = @(count); candidate[@"regular"] = @(app.activationPolicy == NSApplicationActivationPolicyRegular);
        [candidates addObject:candidate];
    }
    NSDictionary *selected = SelectApplication(candidates, input, NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
    if (selected) return selected;
    NSURL *url = nil;
    if (input.isAbsolutePath) url = [NSURL fileURLWithPath:CanonicalPath(input)];
    else if ([input containsString:@"."]) url = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:input];
    if (!url) {
        for (NSString *directory in @[@"/Applications", @"/System/Applications", @"/System/Applications/Utilities", [NSHomeDirectory() stringByAppendingPathComponent:@"Applications"]]) {
            NSString *name = [input.pathExtension.lowercaseString isEqualToString:@"app"] ? input : [input stringByAppendingString:@".app"];
            NSString *candidate = [directory stringByAppendingPathComponent:name];
            if ([NSFileManager.defaultManager fileExistsAtPath:candidate]) { if (url) Fail(@"Application name is ambiguous; use its full path"); url = [NSURL fileURLWithPath:candidate]; }
        }
    }
    NSBundle *bundle = url ? [NSBundle bundleWithURL:url] : nil;
    if (!bundle || ![bundle.bundleURL.pathExtension.lowercaseString isEqualToString:@"app"] || !bundle.executableURL) Fail(@"Application was not found");
    NSMutableDictionary *result = [@{@"input": input, @"name": Clean(bundle.infoDictionary[@"CFBundleDisplayName"] ?: bundle.infoDictionary[@"CFBundleName"] ?: url.lastPathComponent),
        @"path": CanonicalPath(url.path)} mutableCopy];
    if (bundle.bundleIdentifier.length) result[@"bundleId"] = bundle.bundleIdentifier; return result;
}
static NSRunningApplication *VerifiedApplication(NSDictionary *identity) {
    pid_t pid = (pid_t)Numeric(identity[@"pid"], 1, INT32_MAX); NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (!app || app.terminated || ![CanonicalPath(app.bundleURL.path ?: app.executableURL.path ?: @"") isEqualToString:CanonicalPath(Text(identity[@"path"]))]
        || (Text(identity[@"bundleId"]).length && ![app.bundleIdentifier isEqualToString:identity[@"bundleId"]])) {
        if ([NSProcessInfo.processInfo.environment[@"KLAUS_COMPUTER_USE_DIAGNOSTICS"] isEqualToString:@"1"]) {
            NSDictionary *event = @{@"event": @"application-verification", @"pid": @(pid), @"present": @(app != nil), @"terminated": @(app.terminated), @"expectedPath": Text(identity[@"path"]), @"actualPath": app.bundleURL.path ?: app.executableURL.path ?: @"", @"expectedBundleId": Text(identity[@"bundleId"]), @"actualBundleId": app.bundleIdentifier ?: @""};
            NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
            if (data) fprintf(stderr, "%s\n", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
        }
        Fail(@"Approved application identity changed; read fresh app state");
    }
    return app;
}
static void Permissions(BOOL screenshot) {
    if (!AXIsProcessTrusted()) Fail(@"Accessibility permission is required. Enable Klaus in System Settings > Privacy & Security > Accessibility");
    if (screenshot && !CGPreflightScreenCaptureAccess()) Fail(@"Screen Recording permission is required. Enable Klaus in System Settings > Privacy & Security > Screen Recording");
}
static void GuardInteraction(NSDictionary *args) {
    KlausEnsureUnlocked(KlausSystemLockScreenPlatform(), [args[@"autoUnlock"] boolValue], ^{ Check(); }, ^(double seconds) { Pause(seconds); }, ^{ PostedAt = NowMs(); });
    NSDictionary *app = Dict(args[@"app"]); NSString *name = Text(app[@"name"]).length ? Text(app[@"name"]) : Text(app[@"input"]);
    if (NowMs() < [args[@"cooldownUntil"] doubleValue]) Fail(KlausInteractionWaitMessage(name));
    double idle = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGAnyInputEventType);
    if (!isfinite(idle) || idle < 0) Fail(@"User input presence could not be determined");
    double own = [args[@"lastOwnInputAt"] doubleValue], sinceOwn = own > 0 ? (NowMs() - own) / 1000 : INFINITY;
    if (PostedAt > own) sinceOwn = (NowMs() - PostedAt) / 1000;
    if (KlausUserIsInteracting(idle, sinceOwn)) { CooldownUntil = NowMs() + 2000; Fail(KlausInteractionWaitMessage(name)); }
    if (!CGPreflightPostEventAccess()) Fail(@"Input injection permission is unavailable");
}
static void Foreground(NSRunningApplication *app) {
    Check(); if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != app.processIdentifier) Fail(@"Approved application lost keyboard focus; read fresh app state");
}
static NSDictionary *Activate(NSDictionary *args) {
    Permissions(NO); if ([args[@"inputAction"] boolValue]) GuardInteraction(args);
    NSDictionary *identity = Dict(args[@"app"]); NSRunningApplication *app = nil;
    if (identity[@"pid"]) app = VerifiedApplication(identity);
    else {
        NSDictionary *fresh = Resolve(Text(identity[@"path"]));
        if (![Text(fresh[@"path"]) isEqualToString:Text(identity[@"path"])] || ![Text(fresh[@"bundleId"]) isEqualToString:Text(identity[@"bundleId"])]) Fail(@"Application changed after approval");
        __block BOOL finished = NO; __block NSError *failure = nil; __block NSRunningApplication *opened = nil;
        NSWorkspaceOpenConfiguration *configuration = NSWorkspaceOpenConfiguration.configuration; configuration.activates = NO;
        [NSWorkspace.sharedWorkspace openApplicationAtURL:[NSURL fileURLWithPath:identity[@"path"]] configuration:configuration completionHandler:^(NSRunningApplication *value, NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{ opened = value; failure = error; finished = YES; });
        }];
        WaitUntil(^BOOL { return finished; }, 5); if (failure || !opened) Fail(@"Approved application could not be opened"); app = opened;
        NSMutableDictionary *running = [identity mutableCopy]; running[@"pid"] = @(app.processIdentifier); app = VerifiedApplication(running);
    }
    Check();
    if (@available(macOS 14.0, *)) { [NSApp yieldActivationToApplication:app]; [app activateWithOptions:0]; }
    else [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    WaitUntil(^BOOL { return NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == app.processIdentifier; }, 2);
    return Identity(app, Text(identity[@"input"]));
}
static NSDictionary *SelectWindow(NSArray<NSDictionary *> *infos, pid_t pid, CGWindowID identifier, CGRect bounds) {
    NSMutableArray *matches = [NSMutableArray array];
    for (NSDictionary *info in infos) {
        if ([info[(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid) continue;
        CGRect frame;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)info[(__bridge NSString *)kCGWindowBounds], &frame)
            || frame.size.width <= 0 || frame.size.height <= 0) continue;
        if (identifier != kCGNullWindowID) {
            if ([info[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == identifier && SameRectangle(frame, bounds)) return info;
        } else if (bounds.size.width > 0 && bounds.size.height > 0 && SameRectangle(frame, bounds)) [matches addObject:info];
    }
    if (matches.count > 1) Fail(@"Approved window identity is ambiguous; request fresh app state");
    return matches.firstObject;
}
static CGWindowID WindowIdentifier(AXUIElementRef window) {
    // Prefer the OS window identity over bounds: dialogs and overlapping windows
    // can share a frame. Older systems retain the unique-frame fallback.
    typedef AXError (*WindowIdFunction)(AXUIElementRef, CGWindowID *);
    WindowIdFunction function = (WindowIdFunction)dlsym(RTLD_DEFAULT, "_AXUIElementGetWindow");
    CGWindowID identifier = kCGNullWindowID;
    if (function && function(window, &identifier) == kAXErrorSuccess) return identifier;
    id number = CopyAttribute(window, CFSTR("AXWindowNumber"));
    return [number isKindOfClass:NSNumber.class] ? [number unsignedIntValue] : kCGNullWindowID;
}
static NSDictionary *Window(AXUIElementRef app, pid_t pid, id *rootOut, BOOL allowAppearance) {
    double limit = CFAbsoluteTimeGetCurrent() + (allowAppearance ? 1 : 0), lastTrace = 0;
    for (;;) {
        Check(); id focused = CopyAttribute(app, kAXFocusedWindowAttribute); NSArray *windows = Children(app, kAXWindowsAttribute);
        if (!IsElement(focused)) focused = windows.firstObject;
        if (IsElement(focused)) {
            NSUInteger index = [windows indexOfObject:focused];
            if (index == NSNotFound) {
                id parentWindow = CopyAttribute((__bridge AXUIElementRef)focused, kAXWindowAttribute);
                if (IsElement(parentWindow)) { index = [windows indexOfObject:parentWindow]; if (index != NSNotFound) focused = parentWindow; }
            }
            CGRect bounds = ElementBounds((__bridge AXUIElementRef)focused);
            NSArray *infos = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
            CGWindowID identifier = WindowIdentifier((__bridge AXUIElementRef)focused);
            NSDictionary *selected = SelectWindow(infos, pid, identifier, bounds);
            if ([NSProcessInfo.processInfo.environment[@"KLAUS_COMPUTER_USE_DIAGNOSTICS"] isEqualToString:@"1"] && (!selected || index == NSNotFound) && CFAbsoluteTimeGetCurrent() - lastTrace > 0.25) {
                NSMutableArray *candidates = [NSMutableArray array];
                for (NSDictionary *info in infos) if ([info[(__bridge NSString *)kCGWindowOwnerPID] intValue] == pid) [candidates addObject:@{@"id": info[(__bridge NSString *)kCGWindowNumber] ?: @0, @"layer": info[(__bridge NSString *)kCGWindowLayer] ?: @0, @"bounds": info[(__bridge NSString *)kCGWindowBounds] ?: @{}}];
                NSMutableArray *allCandidates = [NSMutableArray array];
                NSArray *all = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
                for (NSDictionary *info in all) if ([info[(__bridge NSString *)kCGWindowOwnerPID] intValue] == pid) [allCandidates addObject:@{@"id": info[(__bridge NSString *)kCGWindowNumber] ?: @0, @"onscreen": info[(__bridge NSString *)kCGWindowIsOnscreen] ?: @NO, @"bounds": info[(__bridge NSString *)kCGWindowBounds] ?: @{}}];
                NSDictionary *event = @{@"event": @"window-resolution", @"pid": @(pid), @"axWindowId": @(identifier), @"axBounds": Rectangle(bounds), @"axWindowCount": @(windows.count), @"listed": @(index != NSNotFound), @"candidates": candidates, @"allCandidates": allCandidates};
                NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
                if (data) fprintf(stderr, "%s\n", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
                lastTrace = CFAbsoluteTimeGetCurrent();
            }
            if (selected && index != NSNotFound) {
                *rootOut = focused;
                return @{@"windowId": selected[(__bridge NSString *)kCGWindowNumber], @"bounds": Rectangle(bounds), @"path": [NSString stringWithFormat:@"w%@", selected[(__bridge NSString *)kCGWindowNumber]]};
            }
        }
        if (CFAbsoluteTimeGetCurrent() >= limit) Fail(@"Approved window could not be identified uniquely; no desktop fallback was captured");
        // Only observations wait through window creation and focus transitions.
        // Input and post-capture validation still reject a changed target.
        Pause(0.03);
    }
}
static NSMutableDictionary *Describe(AXUIElementRef element, NSString *path, NSUInteger depth) {
    NSMutableDictionary *node = [@{@"path": path, @"depth": @(depth)} mutableCopy];
    NSArray *names = @[@"role", @"subrole", @"title", @"label", @"identifier", @"value", @"description", @"help"];
    NSArray *attributes = @[(__bridge NSString *)kAXRoleAttribute, (__bridge NSString *)kAXSubroleAttribute, (__bridge NSString *)kAXTitleAttribute,
        @"AXLabel", (__bridge NSString *)kAXIdentifierAttribute, (__bridge NSString *)kAXValueAttribute, (__bridge NSString *)kAXDescriptionAttribute, (__bridge NSString *)kAXHelpAttribute];
    for (NSUInteger i = 0; i < names.count; i++) {
        if ([names[i] isEqualToString:@"value"] && [node[@"subrole"] isEqualToString:@"AXSecureTextField"]) continue;
        NSString *value = Attribute(element, (__bridge CFStringRef)attributes[i]); if (value.length) node[names[i]] = value;
    }
    // Secure text fields must never expose their AXValue or selection contents.
    if ([node[@"subrole"] isEqualToString:@"AXSecureTextField"]) [node removeObjectForKey:@"value"];
    NSString *description = NSAccessibilityRoleDescription(node[@"role"] ?: @"", node[@"subrole"] ?: @"");
    if (description.length) node[@"roleDescription"] = description;
    node[@"name"] = node[@"title"] ?: node[@"label"] ?: node[@"identifier"] ?: @"";
    Boolean settable = false; AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable); node[@"settable"] = settable ? @YES : @NO;
    for (NSString *name in @[@"enabled", @"focused"]) {
        id value = CopyAttribute(element, [name isEqualToString:@"enabled"] ? kAXEnabledAttribute : kAXFocusedAttribute);
        if ([value isKindOfClass:NSNumber.class]) node[name] = @([value boolValue]);
    }
    id busy = CopyAttribute(element, CFSTR("AXElementBusy"));
    if ([busy isKindOfClass:NSNumber.class]) node[@"busy"] = @([busy boolValue]);
    CFArrayRef raw = NULL; NSMutableArray *actions = [NSMutableArray array];
    if (AXUIElementCopyActionNames(element, &raw) == kAXErrorSuccess && raw) {
        NSArray *values = CFBridgingRelease(raw);
        for (NSString *name in values) { if (actions.count >= 64) break; CFStringRef label = NULL;
            AXUIElementCopyActionDescription(element, (__bridge CFStringRef)name, &label);
            [actions addObject:@{@"raw": name, @"description": label ? CFBridgingRelease(label) : @""}]; }
    }
    node[@"actions"] = actions; CGRect rect = ElementBounds(element); if (rect.size.width > 0 && rect.size.height > 0) node[@"bounds"] = Rectangle(rect);
    return node;
}
static void Walk(AXUIElementRef element, NSString *path, NSUInteger depth, NSMutableArray *nodes, NSUInteger *textBudget, BOOL *truncated) {
    if (nodes.count >= 500 || depth > 8 || *textBudget > 50000 || [path componentsSeparatedByString:@"."].count > 32) { *truncated = YES; return; }
    NSMutableDictionary *node = Describe(element, path, depth); NSArray *children = Children(element, kAXChildrenAttribute);
    // Chromium nests a web document in several unlabeled one-child AXGroups.
    // They retain their native path, but do not consume semantic tree depth.
    BOOL wrapper = [node[@"role"] isEqualToString:@"AXGroup"] && children.count == 1 && IsElement(children.firstObject)
        && !Text(node[@"title"]).length && !Text(node[@"label"]).length && !Text(node[@"identifier"]).length
        && !Text(node[@"description"]).length && !Text(node[@"value"]).length
        && ![node[@"actions"] count];
    if (wrapper) { Walk((__bridge AXUIElementRef)children.firstObject, [path stringByAppendingString:@".0"], depth, nodes, textBudget, truncated); return; }
    node[@"index"] = [NSString stringWithFormat:@"%lu", (unsigned long)nodes.count];
    for (id value in node.allValues) if ([value isKindOfClass:NSString.class]) *textBudget += [value length];
    [nodes addObject:node]; if ([node[@"role"] isEqualToString:@"AXButton"]) return;
    for (NSUInteger i = 0; i < children.count; i++) if (IsElement(children[i])) {
        if (nodes.count >= 500) { *truncated = YES; break; }
        Walk((__bridge AXUIElementRef)children[i], [path stringByAppendingFormat:@".%lu", (unsigned long)i], depth + 1, nodes, textBudget, truncated);
    }
}

// Lossy quality for observation frames: keeps repeated per-turn payloads small
// while UI text stays legible. Attachment captures stay lossless.
static const double ObservationJpegQuality = 0.8;

@interface Screenshot : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic) SCStream *stream;
@property(nonatomic) NSData *image;
@property(nonatomic) BOOL jpeg;
@property(nonatomic) NSError *error;
@property(nonatomic) BOOL done;
@property(nonatomic) BOOL stopped;
@property(nonatomic) NSUInteger width;
@property(nonatomic) NSUInteger height;
@end
@implementation Screenshot
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error { (void)stream; self.error = error; self.done = YES; }
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)buffer ofType:(SCStreamOutputType)type {
    (void)stream; if (type != SCStreamOutputTypeScreen || self.done || !CMSampleBufferIsValid(buffer)) return;
    CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(buffer); if (!pixels) return;
    NSArray *attachments = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(buffer, false);
    if (attachments.count && [attachments[0][SCStreamFrameInfoStatus] integerValue] != SCFrameStatusComplete) return;
    CIImage *image = [CIImage imageWithCVPixelBuffer:pixels]; CGImageRef cg = [[CIContext contextWithOptions:nil] createCGImage:image fromRect:image.extent];
    if (!cg) return;
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:cg]; CGImageRelease(cg);
    self.image = self.jpeg
        ? [bitmap representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor: @(ObservationJpegQuality)}]
        : [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    self.done = YES;
}
@end
static NSDictionary *Capture(pid_t pid, CGWindowID windowId, CGRect bounds, BOOL jpeg) {
    Permissions(YES); __block BOOL found = NO; __block SCShareableContent *content = nil; __block NSError *failure = nil;
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *value, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{ content = value; failure = error; found = YES; });
    }];
    WaitUntil(^BOOL { return found; }, 4); if (failure || !content) Fail(@"ScreenCaptureKit could not enumerate the approved window");
    SCWindow *target = nil; for (SCWindow *window in content.windows) if (window.windowID == windowId && window.owningApplication.processID == pid) target = window;
    if (!target || !SameRectangle(target.frame, bounds)) Fail(@"Approved capture window changed");
    SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
    double scale = fmin(2, 2560 / fmax(bounds.size.width, bounds.size.height));
    SCStreamConfiguration *configuration = [SCStreamConfiguration new];
    configuration.width = (NSUInteger)fmax(1, floor(bounds.size.width * scale)); configuration.height = (NSUInteger)fmax(1, floor(bounds.size.height * scale));
    configuration.pixelFormat = kCVPixelFormatType_32BGRA; configuration.showsCursor = NO; configuration.queueDepth = 3;
    configuration.minimumFrameInterval = CMTimeMake(1, 30); configuration.capturesAudio = NO;
    if (@available(macOS 14.0, *)) { configuration.ignoreShadowsSingleWindow = YES; configuration.shouldBeOpaque = YES; }
    if (@available(macOS 14.2, *)) configuration.includeChildWindows = NO;
    Screenshot *capture = [Screenshot new]; capture.jpeg = jpeg; capture.width = configuration.width; capture.height = configuration.height;
    capture.stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:capture];
    NSError *outputError = nil;
    if (![capture.stream addStreamOutput:capture type:SCStreamOutputTypeScreen sampleHandlerQueue:dispatch_get_main_queue() error:&outputError]) Fail(@"ScreenCaptureKit output could not be attached");
    [capture.stream startCaptureWithCompletionHandler:^(NSError *error) {
        if (error) dispatch_async(dispatch_get_main_queue(), ^{ capture.error = error; capture.done = YES; });
    }];
    @try { WaitUntil(^BOOL { return capture.done; }, 5); }
    @finally {
        [capture.stream stopCaptureWithCompletionHandler:^(NSError *error) { (void)error; dispatch_async(dispatch_get_main_queue(), ^{ capture.stopped = YES; }); }];
        // Cancellation still drains the entered stream before process exit.
        double limit = CFAbsoluteTimeGetCurrent() + 0.35;
        while (!capture.stopped && CFAbsoluteTimeGetCurrent() < limit) [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (capture.error || !capture.image.length || capture.image.length > 15 * 1024 * 1024) Fail(@"Approved window capture failed");
    return @{@"data": [capture.image base64EncodedStringWithOptions:0], @"mimeType": jpeg ? @"image/jpeg" : @"image/png", @"width": @(capture.width), @"height": @(capture.height)};
}
static NSDictionary *State(NSDictionary *args) {
    Permissions(YES); NSRunningApplication *running = VerifiedApplication(Dict(args[@"app"]));
    AXUIElementRef app = AXUIElementCreateApplication(running.processIdentifier);
    @try {
        // Web renderers expose their document only after accessibility is enabled.
        // Unsupported attributes are harmless on native applications.
        id manual = CopyAttribute(app, CFSTR("AXManualAccessibility"));
        if (![manual isKindOfClass:NSNumber.class] || ![manual boolValue]) {
            AXError status = AXUIElementSetAttributeValue(app, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
            if ([NSProcessInfo.processInfo.environment[@"KLAUS_COMPUTER_USE_DIAGNOSTICS"] isEqualToString:@"1"]) fprintf(stderr, "accessibility activation AXManualAccessibility: %d\n", (int)status);
            if (status == kAXErrorSuccess) {
                // Activation is debounced in some renderers. Set once, then
                // observe readiness; another write would restart their timer.
                double readyUntil = CFAbsoluteTimeGetCurrent() + 5;
                for (;;) {
                    id ready = CopyAttribute(app, CFSTR("AXManualAccessibility"));
                    if ([ready isKindOfClass:NSNumber.class] && [ready boolValue]) break;
                    if (CFAbsoluteTimeGetCurrent() >= readyUntil) break;
                    Pause(0.1);
                }
            } else {
                AXUIElementSetAttributeValue(app, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
            }
        }
        double own = fmax(PostedAt, [args[@"lastOwnInputAt"] doubleValue]);
        double settle = own > 0 ? 1 - (NowMs() - own) / 1000 : 0;
        if (settle > 0) Pause(fmin(1, settle));
        // Read the focused branch before enumerating the full window tree.
        id initialFocus = CopyAttribute(app, kAXFocusedUIElementAttribute);
        if ([NSProcessInfo.processInfo.environment[@"KLAUS_COMPUTER_USE_DIAGNOSTICS"] isEqualToString:@"1"] && IsElement(initialFocus)) fprintf(stderr, "accessibility focused role: %s\n", Attribute((__bridge AXUIElementRef)initialFocus, kAXRoleAttribute).UTF8String);
        double retryUntil = CFAbsoluteTimeGetCurrent() + 5;
        for (;;) {
            Check(); VerifiedApplication(Dict(args[@"app"]));
            @try {
                id root; NSDictionary *window = Window(app, running.processIdentifier, &root, YES);
                NSMutableArray *nodes = [NSMutableArray array]; NSUInteger budget = 0; BOOL truncated = NO;
                Walk((__bridge AXUIElementRef)root, window[@"path"], 0, nodes, &budget, &truncated);
                id menubar = CopyAttribute(app, kAXMenuBarAttribute);
                if (IsElement(menubar)) Walk((__bridge AXUIElementRef)menubar, @"menubar", 0, nodes, &budget, &truncated);
                BOOL busy = NO; for (NSDictionary *node in nodes) if ([node[@"busy"] boolValue]) { busy = YES; break; }
                if (busy && CFAbsoluteTimeGetCurrent() < retryUntil) { Pause(0.1); continue; }
                NSDictionary *image = Capture(running.processIdentifier, [window[@"windowId"] unsignedIntValue], ReadRectangle(window[@"bounds"]), YES);
                VerifiedApplication(Dict(args[@"app"])); id after; NSDictionary *fresh = Window(app, running.processIdentifier, &after, NO);
                if (![fresh[@"windowId"] isEqual:window[@"windowId"]] || !SameRectangle(ReadRectangle(fresh[@"bounds"]), ReadRectangle(window[@"bounds"]))) Fail(@"Approved window moved during capture; request fresh state");
                NSMutableArray *confirmed = [NSMutableArray array]; NSUInteger confirmedBudget = 0; BOOL confirmedTruncated = NO;
                Walk((__bridge AXUIElementRef)after, fresh[@"path"], 0, confirmed, &confirmedBudget, &confirmedTruncated);
                id confirmedMenu = CopyAttribute(app, kAXMenuBarAttribute);
                if (IsElement(confirmedMenu)) Walk((__bridge AXUIElementRef)confirmedMenu, @"menubar", 0, confirmed, &confirmedBudget, &confirmedTruncated);
                BOOL changed = ![nodes isEqualToArray:confirmed] || truncated != confirmedTruncated;
                if (changed && CFAbsoluteTimeGetCurrent() < retryUntil) { Pause(0.1); continue; }
                return @{@"app": Identity(running, Text(args[@"app"][@"input"])), @"windowId": window[@"windowId"], @"bounds": window[@"bounds"], @"screenshot": image,
                    @"treeTruncated": @(truncated || confirmedTruncated), @"loading": @(busy), @"observationChanged": @(changed), @"elements": confirmed};
            } @catch (NSException *error) {
                NSArray *transient = @[@"Approved window moved during capture; request fresh state", @"Approved capture window changed",
                    @"Approved app state changed during capture; request fresh state",
                    @"Focused accessibility window changed", @"Approved window could not be identified uniquely; no desktop fallback was captured"];
                if (![error.name isEqualToString:@"ComputerUse"] || ![transient containsObject:error.reason] || CFAbsoluteTimeGetCurrent() >= retryUntil) @throw;
                // A read can safely retry; the preceding input is never repeated.
                Pause(0.1);
            }
        }
    } @finally { CFRelease(app); }
}
static id ResolveElement(AXUIElementRef app, id windowRoot, NSDictionary *expected, NSString *windowPath) {
    NSString *path = Text(expected[@"path"]); NSArray *parts = [path componentsSeparatedByString:@"."];
    BOOL menu = [parts.firstObject isEqualToString:@"menubar"];
    if (!menu && ![parts.firstObject isEqualToString:windowPath]) Fail(@"Element belongs to a different window; request fresh state");
    id element = menu ? CopyAttribute(app, kAXMenuBarAttribute) : windowRoot;
    if (!IsElement(element)) Fail(@"Element root is no longer available");
    for (NSUInteger i = 1; i < parts.count; i++) {
        NSInteger index = [parts[i] integerValue]; NSArray *children = Children((__bridge AXUIElementRef)element, kAXChildrenAttribute);
        if (index < 0 || (NSUInteger)index >= children.count || !IsElement(children[(NSUInteger)index])) Fail(@"Element path is no longer available; request fresh state"); element = children[(NSUInteger)index];
    }
    NSDictionary *fresh = Describe((__bridge AXUIElementRef)element, path, 0);
    for (NSString *key in @[@"role", @"subrole", @"identifier", @"title", @"label", @"description"]) if (![Text(fresh[key]) isEqualToString:Text(expected[key])]) Fail(@"Element identity changed; request fresh state");
    if (![Text(fresh[@"value"]) isEqualToString:Text(expected[@"value"])]) Fail(@"Element value changed; request fresh state");
    if (expected[@"bounds"] && (!fresh[@"bounds"] || !SameRectangle(ReadRectangle(Dict(expected[@"bounds"])), ReadRectangle(Dict(fresh[@"bounds"]))))) Fail(@"Element position changed; request fresh state");
    if ([fresh[@"enabled"] isEqual:@NO]) Fail(@"The requested element is disabled"); return element;
}
static void Set(AXUIElementRef element, CFStringRef name, CFTypeRef value) {
    Check(); ActionStarted = YES; AXError error = AXUIElementSetAttributeValue(element, name, value); PostedAt = NowMs();
    if (error != kAXErrorSuccess) Fail([NSString stringWithFormat:@"Accessibility attribute write failed (%d)", (int)error]);
}
static void PostEvent(CGEventRef event, NSRunningApplication *app, BOOL pointerChord) {
    if (!event) Fail(@"Native input event creation failed");
    @try {
        Foreground(app); CGEventSetIntegerValueField(event, kCGEventSourceUserData, 0x4b4c4155); ActionStarted = YES;
        CGEventType type = CGEventGetType(event);
        // AppKit/Chromium route pointer events through WindowServer hit testing.
        // Ordinary keys use direct-to-PID delivery. Pointer chords share the
        // pointer event stream so their releases clear the same modifier state.
        if (!pointerChord && (type == kCGEventKeyDown || type == kCGEventKeyUp || type == kCGEventFlagsChanged)) CGEventPostToPid(app.processIdentifier, event);
        else CGEventPost(kCGHIDEventTap, event);
        PostedAt = NowMs();
    }
    @finally { CFRelease(event); }
}
static void Post(CGEventRef event, NSRunningApplication *app) { PostEvent(event, app, NO); }
static CGEventSourceRef EventSource(void) {
    if (!InputSource) InputSource = CGEventSourceCreate(kCGEventSourceStatePrivate);
    if (!InputSource) Fail(@"Native input event source creation failed");
    return InputSource;
}
static CGPoint InputPoint(NSDictionary *value, CGRect window) {
    CGPoint point = CGPointMake(Numeric(value[@"x"], -1000000, 1000000), Numeric(value[@"y"], -1000000, 1000000));
    if (!CGRectContainsPoint(window, point)) Fail(@"Input point is outside the approved window"); return point;
}
static void Mouse(NSRunningApplication *app, CGPoint point, NSString *button, NSUInteger count, CGEventFlags flags, double duration) {
    CGMouseButton btn = [button isEqualToString:@"right"] ? kCGMouseButtonRight : [button isEqualToString:@"middle"] ? kCGMouseButtonCenter : kCGMouseButtonLeft;
    CGEventType down = btn == kCGMouseButtonRight ? kCGEventRightMouseDown : btn == kCGMouseButtonCenter ? kCGEventOtherMouseDown : kCGEventLeftMouseDown;
    CGEventType up = btn == kCGMouseButtonRight ? kCGEventRightMouseUp : btn == kCGMouseButtonCenter ? kCGEventOtherMouseUp : kCGEventLeftMouseUp;
    Post(CGEventCreateMouseEvent(EventSource(), kCGEventMouseMoved, point, btn), app);
    for (NSUInteger i = 0; i < count; i++) {
        CGEventRef press = CGEventCreateMouseEvent(EventSource(), down, point, btn); CGEventSetFlags(press, flags); CGEventSetIntegerValueField(press, kCGMouseEventClickState, (int64_t)i + 1); Post(press, app);
        @try { Pause(duration); }
        @finally { CGEventRef release = CGEventCreateMouseEvent(EventSource(), up, point, btn); if (release) { CGEventSetFlags(release, flags); CGEventSetIntegerValueField(release, kCGMouseEventClickState, (int64_t)i + 1); CGEventPost(kCGHIDEventTap, release); CFRelease(release); PostedAt = NowMs(); } }
    }
}
static NSDictionary *Keys(void) {
    return @{@"a": @0, @"s": @1, @"d": @2, @"f": @3, @"h": @4, @"g": @5, @"z": @6, @"x": @7, @"c": @8, @"v": @9, @"b": @11,
        @"q": @12, @"w": @13, @"e": @14, @"r": @15, @"y": @16, @"t": @17, @"1": @18, @"2": @19, @"3": @20, @"4": @21, @"6": @22,
        @"5": @23, @"=": @24, @"9": @25, @"7": @26, @"-": @27, @"8": @28, @"0": @29, @"]": @30, @"o": @31, @"u": @32, @"[": @33,
        @"i": @34, @"p": @35, @"return": @36, @"enter": @36, @"l": @37, @"j": @38, @"'": @39, @"k": @40, @";": @41, @"\\": @42, @",": @43,
        @"/": @44, @"n": @45, @"m": @46, @".": @47, @"tab": @48, @"space": @49, @"`": @50, @"backspace": @51, @"escape": @53, @"esc": @53,
        @"delete": @117, @"forwarddelete": @117, @"home": @115, @"end": @119, @"pageup": @116, @"pagedown": @121, @"left": @123, @"right": @124,
        @"down": @125, @"up": @126, @"f1": @122, @"f2": @120, @"f3": @99, @"f4": @118, @"f5": @96, @"f6": @97, @"f7": @98,
        @"f8": @100, @"f9": @101, @"f10": @109, @"f11": @103, @"f12": @111, @"f13": @105, @"f14": @107, @"f15": @113, @"f16": @106,
        @"f17": @64, @"f18": @79, @"f19": @80, @"f20": @90, @"kp_0": @82, @"kp_1": @83, @"kp_2": @84, @"kp_3": @85, @"kp_4": @86,
        @"kp_5": @87, @"kp_6": @88, @"kp_7": @89, @"kp_8": @91, @"kp_9": @92, @"kp_enter": @76, @"kp_equal": @81,
        @"kp_multiply": @67, @"kp_add": @69, @"kp_subtract": @78, @"kp_decimal": @65, @"kp_divide": @75, @"clear": @71, @"help": @114, @"caps_lock": @57};
}
static CGEventFlags Modifier(NSString *name) {
    name = [name stringByReplacingOccurrencesOfString:@"_l" withString:@""]; name = [name stringByReplacingOccurrencesOfString:@"_r" withString:@""];
    if ([@[@"super", @"meta", @"cmd", @"command", @"controlormeta"] containsObject:name]) return kCGEventFlagMaskCommand;
    if ([@[@"ctrl", @"control"] containsObject:name]) return kCGEventFlagMaskControl;
    if ([@[@"alt", @"option"] containsObject:name]) return kCGEventFlagMaskAlternate;
    if ([name isEqualToString:@"shift"]) return kCGEventFlagMaskShift;
    return 0;
}
static CGKeyCode ModifierCode(NSString *name) {
    CGEventFlags modifier = Modifier(name); BOOL right = [name hasSuffix:@"_r"];
    return modifier == kCGEventFlagMaskCommand ? (right ? 54 : 55) : modifier == kCGEventFlagMaskControl ? (right ? 62 : 59)
        : modifier == kCGEventFlagMaskAlternate ? (right ? 61 : 58) : (right ? 60 : 56);
}
static CGKeyCode CharacterKey(NSString *character, CGEventFlags *flags) {
    TISInputSourceRef source = TISCopyCurrentKeyboardLayoutInputSource();
    if (!source) Fail(@"The current keyboard layout is unavailable");
    @try {
        CFDataRef data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
        if (!data || CFDataGetLength(data) == 0) Fail(@"The current keyboard layout does not expose character mappings");
        const UCKeyboardLayout *layout = (const UCKeyboardLayout *)CFDataGetBytePtr(data);
        const UInt32 variants[] = { 0, shiftKey, optionKey, shiftKey | optionKey };
        for (NSUInteger variant = 0; variant < 4; variant++) for (UInt16 code = 0; code < 128; code++) {
            UInt32 dead = 0; UniChar output[8]; UniCharCount length = 0;
            OSStatus status = UCKeyTranslate(layout, code, kUCKeyActionDown, variants[variant] >> 8, LMGetKbdType(), kUCKeyTranslateNoDeadKeysBit, &dead, 8, &length, output);
            if (status == noErr && length == character.length && [[NSString stringWithCharacters:output length:length] isEqualToString:character]) {
                if (variants[variant] & shiftKey) *flags |= kCGEventFlagMaskShift;
                if (variants[variant] & optionKey) *flags |= kCGEventFlagMaskAlternate;
                return code;
            }
        }
        Fail([NSString stringWithFormat:@"The current keyboard layout cannot produce key %@", character]);
    } @finally { CFRelease(source); }
    return 0;
}
static CGEventFlags HeldFlags(NSArray<NSNumber *> *held) {
    CGEventFlags flags = 0;
    for (NSNumber *item in held) switch (item.unsignedShortValue) {
        case 54: flags |= kCGEventFlagMaskCommand | NX_DEVICERCMDKEYMASK; break;
        case 55: flags |= kCGEventFlagMaskCommand | NX_DEVICELCMDKEYMASK; break;
        case 56: flags |= kCGEventFlagMaskShift | NX_DEVICELSHIFTKEYMASK; break;
        case 60: flags |= kCGEventFlagMaskShift | NX_DEVICERSHIFTKEYMASK; break;
        case 59: flags |= kCGEventFlagMaskControl | NX_DEVICELCTLKEYMASK; break;
        case 62: flags |= kCGEventFlagMaskControl | NX_DEVICERCTLKEYMASK; break;
        case 58: flags |= kCGEventFlagMaskAlternate | NX_DEVICELALTKEYMASK; break;
        case 61: flags |= kCGEventFlagMaskAlternate | NX_DEVICERALTKEYMASK; break;
    }
    return flags;
}
static void HoldChord(NSRunningApplication *app, NSString *spec, BOOL pointerChord, void (^run)(CGEventFlags)) {
    NSArray *parts = [spec componentsSeparatedByString:@"+"]; NSString *key = parts.lastObject;
    CGEventFlags flags = 0; NSMutableArray<NSNumber *> *codes = [NSMutableArray array];
    for (NSUInteger i = 0; i + 1 < parts.count; i++) {
        CGEventFlags modifier = Modifier(parts[i]); if (!modifier) Fail(@"Unsupported keyboard modifier"); flags |= modifier;
        NSNumber *code = @(ModifierCode(parts[i])); if (![codes containsObject:code]) [codes addObject:code];
    }
    CGEventFlags modifier = Modifier(key); CGKeyCode code;
    if (modifier) {
        code = ModifierCode(key);
        flags |= modifier;
    } else if ([key isEqualToString:@"plus"] || (key.length == 1 && [key characterAtIndex:0] >= 33)) {
        code = CharacterKey([key isEqualToString:@"plus"] ? @"+" : key, &flags);
    } else {
        NSNumber *number = Keys()[key]; if (!number) Fail(@"Unsupported keyboard key on this platform"); code = number.unsignedShortValue;
    }
    // Layout-generated Shift/Option must be physically held for pointer chords.
    for (NSString *name in @[@"shift", @"alt"]) if (flags & Modifier(name)) {
        CGKeyCode left = ModifierCode(name), right = ModifierCode([name stringByAppendingString:@"_r"]);
        if (![codes containsObject:@(left)] && ![codes containsObject:@(right)] && code != left && code != right) [codes addObject:@(left)];
    }
    if (![codes containsObject:@(code)]) [codes addObject:@(code)];
    BOOL diagnostics = [NSProcessInfo.processInfo.environment[@"KLAUS_COMPUTER_USE_DIAGNOSTICS"] isEqualToString:@"1"];
    for (NSNumber *item in codes) {
        BOOL physical = CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, item.unsignedShortValue);
        if (diagnostics) fprintf(stderr, "key state before %s code=%u hid=%d combined=%d\n", spec.UTF8String, item.unsignedShortValue, physical, CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, item.unsignedShortValue));
        if (physical) Fail(@"A requested key is already held; leave physical input untouched");
    }
    NSMutableArray<NSNumber *> *held = [NSMutableArray array];
    @try {
        for (NSNumber *item in codes) {
            CGEventRef down = CGEventCreateKeyboardEvent(EventSource(), item.unsignedShortValue, true);
            CGEventSetFlags(down, HeldFlags([held arrayByAddingObject:item])); PostEvent(down, app, pointerChord); [held addObject:item];
        }
        run(HeldFlags(held));
    }
    @finally {
        for (NSNumber *item in held.reverseObjectEnumerator) {
            CGKeyCode releaseCode = item.unsignedShortValue;
            NSArray *remaining = [held subarrayWithRange:NSMakeRange(0, [held indexOfObject:item])];
            CGEventRef up = CGEventCreateKeyboardEvent(EventSource(), releaseCode, false);
            if (up) {
                CGEventSetFlags(up, HeldFlags(remaining));
                if (pointerChord) CGEventPost(kCGHIDEventTap, up); else CGEventPostToPid(app.processIdentifier, up);
                CFRelease(up); PostedAt = NowMs();
            }
        }
        if (diagnostics) for (NSNumber *item in @[@56, @60]) fprintf(stderr, "key state after %s code=%u hid=%d combined=%d\n", spec.UTF8String, item.unsignedShortValue, CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, item.unsignedShortValue), CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, item.unsignedShortValue));
    }
}
static void Keyboard(NSRunningApplication *app, NSString *spec, double duration) { HoldChord(app, spec, NO, ^(CGEventFlags flags) { (void)flags; Pause(duration); }); }
static void Unicode(NSRunningApplication *app, NSString *value) {
    // Unicode events avoid altering the user's clipboard and preserve input focus.
    for (NSUInteger offset = 0; offset < value.length;) {
        UniChar first = [value characterAtIndex:offset];
        if (first == '\r' || first == '\n') {
            Keyboard(app, @"return", 0); offset++;
            if (first == '\r' && offset < value.length && [value characterAtIndex:offset] == '\n') offset++;
            continue;
        }
        NSUInteger count = MIN((NSUInteger)20, value.length - offset);
        for (NSUInteger i = 0; i < count; i++) if ([value characterAtIndex:offset + i] == '\r' || [value characterAtIndex:offset + i] == '\n') { count = i; break; }
        if (offset + count < value.length && CFStringIsSurrogateHighCharacter([value characterAtIndex:offset + count - 1])) count--;
        UniChar chars[20]; [value getCharacters:chars range:NSMakeRange(offset, count)];
        CGEventRef down = CGEventCreateKeyboardEvent(EventSource(), 0, true); CGEventKeyboardSetUnicodeString(down, count, chars); Post(down, app);
        CGEventRef up = CGEventCreateKeyboardEvent(EventSource(), 0, false); if (up) { CGEventKeyboardSetUnicodeString(up, count, chars); CGEventPostToPid(app.processIdentifier, up); CFRelease(up); PostedAt = NowMs(); }
        offset += count;
    }
}
static void Paste(NSRunningApplication *app, NSString *value, NSString *format) {
    NSPasteboard *board = NSPasteboard.generalPasteboard;
    // Snapshot the user's clipboard contents so the paste can put them back.
    NSMutableArray<NSDictionary<NSPasteboardType, NSData *> *> *saved = [NSMutableArray array];
    for (NSPasteboardItem *item in board.pasteboardItems) {
        NSMutableDictionary<NSPasteboardType, NSData *> *copy = [NSMutableDictionary dictionary];
        for (NSPasteboardType type in item.types) { NSData *data = [item dataForType:type]; if (data) copy[type] = data; }
        if (copy.count) [saved addObject:copy];
    }
    @try {
        NSPasteboardItem *item = [NSPasteboardItem new];
        [item setString:value forType:NSPasteboardTypeString];
        NSData *encoded = [value dataUsingEncoding:NSUTF8StringEncoding];
        if ([format isEqualToString:@"md"] && encoded) [item setData:encoded forType:@"net.daringfireball.markdown"];
        if ([format isEqualToString:@"html"] && encoded) [item setData:encoded forType:NSPasteboardTypeHTML];
        [board clearContents]; [board writeObjects:@[item]];
        Keyboard(app, @"super+v", 0);
        // Give the target app time to read the pasteboard before restoring it.
        Pause(0.25);
    } @finally {
        [board clearContents];
        NSMutableArray<NSPasteboardItem *> *restore = [NSMutableArray array];
        for (NSDictionary<NSPasteboardType, NSData *> *entry in saved) {
            NSPasteboardItem *item = [NSPasteboardItem new];
            for (NSPasteboardType type in entry) [item setData:entry[type] forType:type];
            [restore addObject:item];
        }
        if (restore.count) [board writeObjects:restore];
    }
}
static NSDictionary *Action(NSDictionary *args) {
    Permissions(NO); GuardInteraction(args); NSRunningApplication *running = VerifiedApplication(Dict(args[@"app"])); Foreground(running);
    AXUIElementRef app = AXUIElementCreateApplication(running.processIdentifier);
    @try {
        id root; NSDictionary *window = Window(app, running.processIdentifier, &root, NO); CGRect rect = ReadRectangle(window[@"bounds"]);
        if (![window[@"windowId"] isEqual:args[@"windowId"]] || !SameRectangle(rect, ReadRectangle(Dict(args[@"windowBounds"])))) Fail(@"Approved window changed; read fresh app state before sending input");
        id selected = args[@"element"] ? ResolveElement(app, root, Dict(args[@"element"]), window[@"path"]) : nil;
        AXUIElementRef element = selected ? (__bridge AXUIElementRef)selected : NULL; NSString *name = Text(args[@"name"]);
        if (([name isEqualToString:@"press_key"] || [name isEqualToString:@"type_text"] || [name isEqualToString:@"paste"]) && args[@"focusedElement"]) {
            id observed = ResolveElement(app, root, Dict(args[@"focusedElement"]), window[@"path"]);
            id focused = CopyAttribute(app, kAXFocusedUIElementAttribute);
            if (!IsElement(focused) || !CFEqual((__bridge CFTypeRef)observed, (__bridge CFTypeRef)focused)) Fail(@"Focused element changed; request fresh state before typing");
        }
        if ([name isEqualToString:@"click"]) {
            NSString *button = Text(args[@"mouse_button"]); NSUInteger count = (NSUInteger)Numeric(args[@"click_count"], 1, 5);
            if (element && count == 1 && [button isEqualToString:@"left"] && !args[@"key"] && !args[@"duration"]) {
                Foreground(running); ActionStarted = YES; AXError error = AXUIElementPerformAction(element, kAXPressAction);
                if (error != kAXErrorActionUnsupported && error != kAXErrorNotImplemented) PostedAt = NowMs();
                if (error == kAXErrorSuccess) { Pause(0.12); return @{@"applied": @YES}; }
                if (error != kAXErrorActionUnsupported && error != kAXErrorNotImplemented) Fail(@"Accessibility press failed; action was not retried");
                ActionStarted = NO;
            }
            CGPoint point = element ? CGPointMake(CGRectGetMidX(ElementBounds(element)), CGRectGetMidY(ElementBounds(element))) : InputPoint(Dict(args[@"point"]), rect);
            if (!CGRectContainsPoint(rect, point)) Fail(@"Element click point is outside the approved window");
            double duration = args[@"duration"] ? Numeric(args[@"duration"], 0, 30) : 0.03;
            if (args[@"key"]) HoldChord(running, Text(args[@"key"]), YES, ^(CGEventFlags flags) { Mouse(running, point, button, count, flags, duration); });
            else Mouse(running, point, button, count, 0, duration);
        } else if ([name isEqualToString:@"perform_secondary_action"]) {
            if (!element) Fail(@"An accessibility element is required"); NSString *requested = Text(args[@"action"]);
            NSArray *actions = Describe(element, Text(args[@"element"][@"path"]), 0)[@"actions"];
            if (![actions filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"raw == %@", requested]].count) Fail(@"Element does not expose this action");
            Foreground(running); ActionStarted = YES; AXError error = AXUIElementPerformAction(element, (__bridge CFStringRef)requested); PostedAt = NowMs();
            if (error != kAXErrorSuccess) Fail(@"Accessibility action failed; action was not retried");
        } else if ([name isEqualToString:@"set_value"]) {
            if (!element) Fail(@"An accessibility element is required"); Foreground(running); Set(element, kAXValueAttribute, (__bridge CFStringRef)Text(args[@"value"]));
        } else if ([name isEqualToString:@"select_text"]) {
            if (!element || [Attribute(element, kAXSubroleAttribute) isEqualToString:@"AXSecureTextField"]) Fail(@"This field does not expose selectable text");
            id rawValue = CopyAttribute(element, kAXValueAttribute);
            if (![rawValue isKindOfClass:NSString.class] || [rawValue length] > 50000) Fail(@"The full text field value is unavailable or exceeds the selection limit");
            // Selection offsets refer to raw UTF-16 text, never the display summary.
            NSString *value = rawValue, *needle = Text(args[@"text"]), *prefix = Text(args[@"prefix"]), *suffix = Text(args[@"suffix"]);
            if (!needle.length) Fail(@"Selection text is required"); NSString *match = [NSString stringWithFormat:@"%@%@%@", prefix, needle, suffix];
            NSRange found = [value rangeOfString:match]; if (found.location == NSNotFound) Fail(@"Selection text is no longer present");
            NSRange rest = NSMakeRange(found.location + 1, value.length - found.location - 1);
            if ([value rangeOfString:match options:0 range:rest].location != NSNotFound) Fail(@"Selection text is ambiguous; provide a prefix or suffix");
            CFRange range = CFRangeMake((CFIndex)(found.location + prefix.length), (CFIndex)needle.length); NSString *mode = Text(args[@"selection"]);
            if ([mode isEqualToString:@"cursor_before"]) range.length = 0; else if ([mode isEqualToString:@"cursor_after"]) { range.location += range.length; range.length = 0; }
            AXValueRef selectedRange = AXValueCreate(kAXValueCFRangeType, &range);
            @try { Foreground(running); Set(element, kAXSelectedTextRangeAttribute, selectedRange); } @finally { CFRelease(selectedRange); }
        } else if ([name isEqualToString:@"scroll"]) {
            CGPoint point;
            if (element) { CGRect frame = ElementBounds(element); point = CGPointMake(CGRectGetMidX(frame), CGRectGetMidY(frame)); }
            else point = InputPoint(Dict(args[@"point"]), rect);
            if (!CGRectContainsPoint(rect, point)) Fail(@"Scroll target is outside the approved window");
            double amount = Numeric(args[@"pages"], 0.1, 10) * 650; NSString *direction = Text(args[@"direction"]);
            int32_t dy = [direction isEqualToString:@"up"] ? (int32_t)amount : [direction isEqualToString:@"down"] ? -(int32_t)amount : 0;
            int32_t dx = [direction isEqualToString:@"left"] ? (int32_t)amount : [direction isEqualToString:@"right"] ? -(int32_t)amount : 0;
            Post(CGEventCreateMouseEvent(EventSource(), kCGEventMouseMoved, point, kCGMouseButtonLeft), running); Pause(0.02);
            CGEventRef event = CGEventCreateScrollWheelEvent(EventSource(), kCGScrollEventUnitPixel, 2, dy, dx); CGEventSetLocation(event, point);
            CGEventSetIntegerValueField(event, kCGScrollWheelEventIsContinuous, 1); Post(event, running);
        } else if ([name isEqualToString:@"drag"]) {
            CGPoint from = InputPoint(Dict(args[@"from"]), rect), to = InputPoint(Dict(args[@"to"]), rect);
            Post(CGEventCreateMouseEvent(EventSource(), kCGEventLeftMouseDown, from, kCGMouseButtonLeft), running);
            @try { for (NSUInteger i = 1; i <= 12; i++) { double fraction = i / 12.0; CGPoint point = CGPointMake(from.x + (to.x - from.x) * fraction, from.y + (to.y - from.y) * fraction);
                Post(CGEventCreateMouseEvent(EventSource(), kCGEventLeftMouseDragged, point, kCGMouseButtonLeft), running); Pause(0.01); } }
            @finally { CGEventRef up = CGEventCreateMouseEvent(EventSource(), kCGEventLeftMouseUp, to, kCGMouseButtonLeft); if (up) { CGEventPost(kCGHIDEventTap, up); CFRelease(up); PostedAt = NowMs(); } }
        } else if ([name isEqualToString:@"press_key"]) Keyboard(running, Text(args[@"key"]), args[@"duration"] ? Numeric(args[@"duration"], 0, 30) : 0);
        else if ([name isEqualToString:@"type_text"]) Unicode(running, Text(args[@"text"]));
        else if ([name isEqualToString:@"paste"]) Paste(running, Text(args[@"text"]), Text(args[@"format"]));
        else Fail(@"Unknown native input operation");
        Pause(0.12); return @{@"applied": @YES};
    } @finally { CFRelease(app); }
}
static NSDictionary *Appshot(NSDictionary *args) {
    Permissions(YES); Check();
    NSArray *infos = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    CGWindowID requested = args[@"windowId"] ? (CGWindowID)Numeric(args[@"windowId"], 1, UINT32_MAX) : kCGNullWindowID;
    pid_t process = args[@"processId"] ? (pid_t)Numeric(args[@"processId"], 1, INT32_MAX) : NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    NSDictionary *selected = nil;
    for (NSDictionary *info in infos) {
        if ([info[(__bridge NSString *)kCGWindowLayer] integerValue] != 0) continue;
        if (requested != kCGNullWindowID ? [info[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] != requested
            : [info[(__bridge NSString *)kCGWindowOwnerPID] intValue] != process) continue;
        CGRect frame; if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)info[(__bridge NSString *)kCGWindowBounds], &frame) || frame.size.width <= 0 || frame.size.height <= 0) continue;
        selected = info; break;
    }
    if (!selected) Fail(@"The selected application window is no longer available");
    process = [selected[(__bridge NSString *)kCGWindowOwnerPID] intValue];
    NSRunningApplication *running = [NSRunningApplication runningApplicationWithProcessIdentifier:process];
    if (!running || running.terminated || process == getpid() || !running.bundleURL) Fail(@"The selected application is no longer available");
    NSDictionary *identity = Identity(running, running.bundleURL.path);
    CGWindowID identifier = [selected[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
    CGRect bounds; if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)selected[(__bridge NSString *)kCGWindowBounds], &bounds)) Fail(@"The selected window has no capture bounds");
    AppshotWindowDiagnostic(@"selected", process, identifier, bounds, infos);
    NSMutableDictionary *context = [@{@"capturedAt": @(NowMs()), @"appName": running.localizedName ?: @"Application", @"pid": @(process), @"windowId": @(identifier),
        @"windowTitle": Text(selected[(__bridge NSString *)kCGWindowName]), @"bounds": Rectangle(bounds)} mutableCopy];
    if (running.bundleIdentifier.length) context[@"bundleId"] = running.bundleIdentifier;
    AXUIElementRef application = AXUIElementCreateApplication(process);
    id root = nil; NSMutableArray *nodes = [NSMutableArray array]; BOOL truncated = NO;
    @try {
        for (id window in Children(application, kAXWindowsAttribute)) {
            if (!IsElement(window)) continue;
            CGWindowID candidate = WindowIdentifier((__bridge AXUIElementRef)window);
            if ((candidate == identifier || (candidate == kCGNullWindowID && SameRectangle(ElementBounds((__bridge AXUIElementRef)window), bounds)))
                && SameRectangle(ElementBounds((__bridge AXUIElementRef)window), bounds)) { root = window; break; }
        }
        if (root) {
            NSUInteger budget = 0; Walk((__bridge AXUIElementRef)root, [NSString stringWithFormat:@"w%u", identifier], 0, nodes, &budget, &truncated);
            NSMutableArray *lines = [NSMutableArray array];
            for (NSDictionary *node in nodes) {
                NSMutableArray *parts = [NSMutableArray array];
                for (NSString *key in @[@"role", @"title", @"label", @"value", @"description"]) if (Text(node[key]).length) [parts addObject:node[key]];
                if (parts.count) [lines addObject:[parts componentsJoinedByString:@" · "]];
            }
            NSString *tree = [lines componentsJoinedByString:@"\n"]; if (tree.length > 50000) { tree = [tree substringToIndex:50000]; truncated = YES; }
            context[@"accessibilityText"] = tree; context[@"treeTruncated"] = @(truncated);
            NSString *document = Attribute((__bridge AXUIElementRef)root, kAXDocumentAttribute);
            if (document.length) context[@"url"] = document;
            id focused = CopyAttribute(application, kAXFocusedUIElementAttribute);
            if (IsElement(focused) && ![Attribute((__bridge AXUIElementRef)focused, kAXSubroleAttribute) isEqualToString:@"AXSecureTextField"]) {
                id window = CopyAttribute((__bridge AXUIElementRef)focused, kAXWindowAttribute);
                if (IsElement(window) && WindowIdentifier((__bridge AXUIElementRef)window) == identifier) {
                    NSString *selection = Attribute((__bridge AXUIElementRef)focused, kAXSelectedTextAttribute);
                    if (selection.length) context[@"selectedText"] = selection;
                }
            }
        } else context[@"accessibilityUnavailableReason"] = @"The selected window does not expose an accessibility tree";
        // Attachment captures keep the lossless PNG contract their consumers validate.
        NSDictionary *image = Capture(process, identifier, bounds, NO);
        VerifiedApplication(identity);
        NSArray *fresh = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
        if (!SelectWindow(fresh, process, identifier, bounds)) {
            AppshotWindowDiagnostic(@"post-validation-rejected", process, identifier, bounds, fresh);
            Fail(@"The selected window moved or closed during capture; capture it again");
        }
        if (root) {
            NSMutableArray *confirmed = [NSMutableArray array]; NSUInteger budget = 0; BOOL changedTruncated = NO;
            Walk((__bridge AXUIElementRef)root, [NSString stringWithFormat:@"w%u", identifier], 0, confirmed, &budget, &changedTruncated);
            context[@"observationChanged"] = @(![nodes isEqualToArray:confirmed] || truncated != changedTruncated);
        }
        Check();
        if (!args[@"soundEnabled"] || [args[@"soundEnabled"] boolValue]) {
            NSString *soundPath = @"/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Screen Capture.aif";
            NSSound *sound = [[NSSound alloc] initWithContentsOfFile:soundPath byReference:YES];
            if (sound) [sound play];
        }
        return @{@"screenshot": image, @"context": context};
    } @finally { CFRelease(application); }
}
static inline int16_t AudioSampleToInt16(float sample) {
    sample = fmaxf(-1, fminf(1, sample));
    return (int16_t)lrintf(sample < 0 ? sample * 32768.0f : sample * 32767.0f);
}
@interface AudioCapture : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic) SCStream *stream;
@property(nonatomic) NSFileHandle *file;
@property(nonatomic) dispatch_queue_t queue;
@property(nonatomic) NSUInteger dataBytes;
@property(nonatomic) NSUInteger limitBytes;
@property(nonatomic) BOOL done;
@property(nonatomic) BOOL limitReached;
@property(nonatomic) BOOL stopRequested;
@property(nonatomic) NSError *error;
@end
@implementation AudioCapture
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error { (void)stream; self.error = error; self.done = YES; }
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)buffer ofType:(SCStreamOutputType)type {
    (void)stream;
    if (type != SCStreamOutputTypeAudio || self.done || !CMSampleBufferIsValid(buffer)) return;
    CMFormatDescriptionRef description = CMSampleBufferGetFormatDescription(buffer);
    const AudioStreamBasicDescription *format = description ? CMAudioFormatDescriptionGetStreamBasicDescription(description) : NULL;
    if (!format || format->mFormatID != kAudioFormatLinearPCM || !(format->mFormatFlags & kAudioFormatFlagIsFloat) || format->mBitsPerChannel != 32) return;
    CMBlockBufferRef block = CMSampleBufferGetDataBuffer(buffer);
    if (!block) return;
    size_t lengthAtOffset = 0, totalLength = 0; char *bytes = NULL;
    if (CMBlockBufferGetDataPointer(block, 0, &lengthAtOffset, &totalLength, &bytes) != kCMBlockBufferNoErr || !bytes || lengthAtOffset != totalLength) return;
    const float *source = (const float *)bytes;
    NSUInteger floats = totalLength / sizeof(float);
    if (!floats) return;
    UInt32 channels = format->mChannelsPerFrame ? format->mChannelsPerFrame : 1;
    BOOL planar = (format->mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
    NSMutableData *pcm = [NSMutableData data];
    int16_t pair[2];
    if (channels >= 2 && planar) {
        NSUInteger frames = floats / channels;
        for (NSUInteger frame = 0; frame < frames; frame++) {
            pair[0] = AudioSampleToInt16(source[frame]); pair[1] = AudioSampleToInt16(source[frames + frame]);
            [pcm appendBytes:pair length:sizeof(pair)];
        }
    } else if (channels >= 2) {
        NSUInteger frames = floats / channels;
        for (NSUInteger frame = 0; frame < frames; frame++) {
            pair[0] = AudioSampleToInt16(source[frame * channels]); pair[1] = AudioSampleToInt16(source[frame * channels + 1]);
            [pcm appendBytes:pair length:sizeof(pair)];
        }
    } else {
        for (NSUInteger index = 0; index < floats; index++) {
            pair[0] = AudioSampleToInt16(source[index]); pair[1] = pair[0];
            [pcm appendBytes:pair length:sizeof(pair)];
        }
    }
    if (!pcm.length || self.dataBytes >= self.limitBytes) { if (self.dataBytes >= self.limitBytes) { self.limitReached = YES; self.done = YES; } return; }
    if (self.dataBytes + pcm.length > self.limitBytes) {
        NSUInteger allowed = self.limitBytes - self.dataBytes; allowed -= allowed % (2 * sizeof(int16_t));
        [pcm setLength:allowed]; self.limitReached = YES;
    }
    if (pcm.length) { [self.file writeData:pcm]; self.dataBytes += pcm.length; }
    if (self.limitReached || self.dataBytes >= self.limitBytes) self.done = YES;
}
@end
static NSData *WavHeader(NSUInteger dataBytes) {
    unsigned char header[44] = {0};
    memcpy(header, "RIFF", 4); memcpy(header + 8, "WAVEfmt ", 8); memcpy(header + 36, "data", 4);
    UInt32 riff = (UInt32)(36 + dataBytes), size = (UInt32)dataBytes, rate = 24000, byteRate = 24000 * 4, fmtSize = 16;
    UInt16 audioFormat = 1, channels = 2, alignment = 4, bits = 16;
    memcpy(header + 4, &riff, 4); memcpy(header + 16, &fmtSize, 4); memcpy(header + 20, &audioFormat, 2);
    memcpy(header + 22, &channels, 2); memcpy(header + 24, &rate, 4); memcpy(header + 28, &byteRate, 4);
    memcpy(header + 32, &alignment, 2); memcpy(header + 34, &bits, 2); memcpy(header + 40, &size, 4);
    return [NSData dataWithBytes:header length:sizeof(header)];
}
static NSDictionary *RecordAudio(NSDictionary *args, NSData *leftover) {
    Permissions(YES);
    NSString *path = Text(args[@"path"]);
    if (!path.length || path.length > 4096) Fail(@"Audio recording needs an output path");
    double milliseconds = Numeric(args[@"maxDurationMs"], 100, 300000);
    OperationDeadline = milliseconds / 1000 + 20;
    __block BOOL found = NO; __block SCShareableContent *content = nil; __block NSError *failure = nil;
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *value, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{ content = value; failure = error; found = YES; });
    }];
    WaitUntil(^BOOL { return found; }, 4);
    if (failure || !content || !content.displays.count) Fail(@"ScreenCaptureKit could not enumerate displays for audio capture");
    SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:content.displays.firstObject excludingWindows:@[]];
    SCStreamConfiguration *configuration = [SCStreamConfiguration new];
    configuration.capturesAudio = YES; configuration.sampleRate = 24000; configuration.channelCount = 2;
    configuration.excludesCurrentProcessAudio = YES;
    AudioCapture *capture = [AudioCapture new];
    capture.limitBytes = (NSUInteger)(milliseconds / 1000 * 24000 * 4);
    capture.queue = dispatch_queue_create("computer-use.audio.output", DISPATCH_QUEUE_SERIAL);
    if (![NSFileManager.defaultManager createFileAtPath:path contents:nil attributes:nil]) Fail(@"Audio recording output could not be created");
    capture.file = [NSFileHandle fileHandleForWritingAtPath:path];
    if (!capture.file) Fail(@"Audio recording output could not be opened");
    [capture.file writeData:WavHeader(0)];
    capture.stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:capture];
    NSError *outputError = nil;
    if (![capture.stream addStreamOutput:capture type:SCStreamOutputTypeAudio sampleHandlerQueue:capture.queue error:&outputError]) {
        [capture.file closeFile]; [NSFileManager.defaultManager removeItemAtPath:path error:nil];
        Fail(@"ScreenCaptureKit audio output could not be attached");
    }
    __block BOOL started = NO; __block NSError *startError = nil;
    [capture.stream startCaptureWithCompletionHandler:^(NSError *error) { dispatch_async(dispatch_get_main_queue(), ^{ startError = error; started = YES; }); }];
    WaitUntil(^BOOL { return started || capture.done; }, 5);
    if (startError || (!started && capture.done)) {
        [capture.file closeFile]; [NSFileManager.defaultManager removeItemAtPath:path error:nil];
        Fail(@"System audio capture could not start");
    }
    fprintf(stderr, "klaus-audio-recording-started\n");
    dispatch_source_t stdinSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
    NSMutableData *pending = leftover.length ? [leftover mutableCopy] : [NSMutableData data];
    const BOOL alreadyStopped = [[[NSString alloc] initWithData:pending encoding:NSUTF8StringEncoding] containsString:@"\"stop\":true"];
    dispatch_source_set_event_handler(stdinSource, ^{
        char buffer[256]; ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
        if (count < 0) return;
        if (count == 0) { capture.stopRequested = YES; dispatch_source_cancel(stdinSource); return; }
        [pending appendBytes:buffer length:(NSUInteger)count];
        if (pending.length > 4096) [pending setLength:4096];
        if ([[[NSString alloc] initWithData:pending encoding:NSUTF8StringEncoding] containsString:@"\"stop\":true"]) {
            capture.stopRequested = YES; dispatch_source_cancel(stdinSource);
        }
    });
    dispatch_source_set_cancel_handler(stdinSource, ^{ capture.stopRequested = YES; });
    dispatch_resume(stdinSource);
    if (alreadyStopped) { capture.stopRequested = YES; dispatch_source_cancel(stdinSource); }
    @try {
        while (!capture.stopRequested && !capture.done) { Check(); Pause(0.05); }
        __block BOOL stopped = NO;
        [capture.stream stopCaptureWithCompletionHandler:^(NSError *error) { (void)error; dispatch_async(dispatch_get_main_queue(), ^{ stopped = YES; }); }];
        double drain = CFAbsoluteTimeGetCurrent() + 0.5;
        while (!stopped && CFAbsoluteTimeGetCurrent() < drain) [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        dispatch_sync(capture.queue, ^{});
        if (capture.error && !capture.stopRequested && !capture.limitReached) Fail(@"System audio capture failed");
        [capture.file seekToFileOffset:0]; [capture.file writeData:WavHeader(capture.dataBytes)]; [capture.file closeFile];
        Check();
        return @{@"path": path, @"durationMs": @((NSUInteger)(capture.dataBytes / 96.0)), @"sampleRate": @24000,
            @"channels": @2, @"bytes": @(capture.dataBytes + 44), @"limitReached": @(capture.limitReached)};
    } @catch (NSException *error) {
        dispatch_source_cancel(stdinSource);
        @try { [capture.stream stopCaptureWithCompletionHandler:^(NSError *streamError) { (void)streamError; }]; } @catch (NSException *ignored) { (void)ignored; }
        @try { [capture.file closeFile]; } @catch (NSException *ignored) { (void)ignored; }
        [NSFileManager.defaultManager removeItemAtPath:path error:nil];
        @throw error;
    }
}
static NSDictionary *ListApps(void) {
    NSMutableDictionary *apps = [NSMutableDictionary dictionary];
    for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
        if (!app.bundleURL || app.activationPolicy != NSApplicationActivationPolicyRegular) continue;
        NSMutableDictionary *entry = [Identity(app, app.localizedName ?: app.bundleURL.path) mutableCopy]; entry[@"running"] = @YES; apps[app.bundleURL.path] = entry;
        if (apps.count >= 80) break;
    }
    NSMetadataQuery *query = [NSMetadataQuery new]; query.predicate = [NSPredicate predicateWithFormat:@"kMDItemContentType == %@ AND kMDItemLastUsedDate >= %@", @"com.apple.application-bundle", [NSDate dateWithTimeIntervalSinceNow:-14 * 86400]];
    query.searchScopes = @[NSMetadataQueryLocalComputerScope];
    if ([query startQuery]) {
        @try { WaitUntil(^BOOL { return !query.isGathering; }, 2); }
        @catch (NSException *exception) { if (Cancelled) @throw exception; }
        [query disableUpdates];
        for (NSMetadataItem *item in query.results) {
            if (apps.count >= 80) break; NSString *path = [item valueForAttribute:(__bridge NSString *)kMDItemPath]; if (!path.length || apps[path]) continue;
            id date = [item valueForAttribute:(__bridge NSString *)kMDItemLastUsedDate];
            NSMutableDictionary *entry = [@{@"path": path, @"name": Clean([item valueForAttribute:(__bridge NSString *)kMDItemDisplayName]), @"running": @NO} mutableCopy];
            if ([date isKindOfClass:NSDate.class]) entry[@"lastUsed"] = [[NSISO8601DateFormatter new] stringFromDate:date];
            NSNumber *count = [item valueForAttribute:@"kMDItemUseCount"]; if ([count isKindOfClass:NSNumber.class]) entry[@"useCount"] = count; apps[path] = entry;
        }
        [query stopQuery];
    }
    return @{@"apps": [apps.allValues sortedArrayUsingDescriptors:@[[NSSortDescriptor sortDescriptorWithKey:@"name" ascending:YES selector:@selector(localizedCaseInsensitiveCompare:)]]]};
}
int main(void) {
    @autoreleasepool {
        Parent = getppid(); StartedAt = CFAbsoluteTimeGetCurrent(); signal(SIGTERM, Stop); signal(SIGINT, Stop); signal(SIGPIPE, SIG_IGN);
        [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSMutableData *input = [NSMutableData data]; NSMutableData *leftover = [NSMutableData data]; unsigned char chunk[8192]; ssize_t count;
        const unsigned char newlineByte = '\n'; NSData *newline = [NSData dataWithBytes:&newlineByte length:1];
        while ((count = read(STDIN_FILENO, chunk, sizeof(chunk))) > 0) {
            [input appendBytes:chunk length:(NSUInteger)count];
            // A framed request ends at its first newline; long-lived operations keep watching stdin.
            NSRange frame = [input rangeOfData:newline options:0 range:NSMakeRange(0, input.length)];
            if (frame.location != NSNotFound) {
                [leftover appendData:[input subdataWithRange:NSMakeRange(frame.location + 1, input.length - frame.location - 1)]];
                [input setLength:frame.location]; break;
            }
            if (input.length > 256 * 1024) return 2;
        }
        NSDictionary *request = Dict([NSJSONSerialization JSONObjectWithData:input options:0 error:nil]); NSMutableDictionary *response = [NSMutableDictionary dictionary];
        for (NSString *key in @[@"resourceId", @"operationId", @"generation", @"sequence"]) if (request[key]) response[key] = request[key];
        @try {
            if (!Text(request[@"resourceId"]).length || !Text(request[@"operationId"]).length) Fail(@"Native request identity is missing");
            Numeric(request[@"generation"], 1, 9007199254740991); Numeric(request[@"sequence"], 1, 9007199254740991);
            NSString *method = Text(request[@"method"]); NSDictionary *args = Dict(request[@"args"]); id result = nil;
            if ([method isEqualToString:@"promptLoginPassword"]) OperationDeadline = 180;
            if ([method isEqualToString:@"action"] && args[@"duration"]) OperationDeadline = fmax(OperationDeadline, 13 + Numeric(args[@"duration"], 0, 30) * ([Text(args[@"name"]) isEqualToString:@"click"] ? Numeric(args[@"click_count"], 1, 5) : 1));
            Check();
            if ([method isEqualToString:@"capabilities"]) result = @{@"version": @1, @"supported": @YES, @"autoUnlock": @YES, @"audio": @YES, @"permissions": @{@"accessibility": (AXIsProcessTrusted() ? @YES : @NO), @"screenRecording": @(CGPreflightScreenCaptureAccess()), @"input": @(CGPreflightPostEventAccess())}};
            else if ([method isEqualToString:@"loginPasswordPresence"]) result = @{@"hasLoginPassword": @([KlausSystemLockScreenPlatform() hasPassword])};
            else if ([method isEqualToString:@"promptLoginPassword"]) result = KlausPromptLoginPassword(KlausSystemLockScreenPlatform(), Text(request[@"operationId"]), ^{ Check(); });
            else if ([method isEqualToString:@"deleteLoginPassword"]) { Check(); [KlausSystemLockScreenPlatform() removePasswordOwnedBy:nil]; result = @{@"deleted": @YES}; }
            else if ([method isEqualToString:@"discardLoginPassword"]) {
                NSString *owner = Text(args[@"owner"]); if (![[NSUUID alloc] initWithUUIDString:owner]) Fail(@"Invalid password operation owner");
                Check(); [KlausSystemLockScreenPlatform() removePasswordOwnedBy:owner]; result = @{@"deleted": @YES};
            }
            else if ([method isEqualToString:@"resolve"]) result = Resolve(Text(args[@"input"]));
            else if ([method isEqualToString:@"listApps"]) result = ListApps();
            else if ([method isEqualToString:@"activate"]) result = Activate(args);
            else if ([method isEqualToString:@"state"]) result = State(args);
            else if ([method isEqualToString:@"appshot"]) result = Appshot(args);
            else if ([method isEqualToString:@"action"]) result = Action(args);
            else if ([method isEqualToString:@"recordAudio"]) result = RecordAudio(args, leftover);
            else Fail(@"Unknown Computer Use native method");
            Check(); response[@"ok"] = @YES; response[@"result"] = result ?: @{};
        } @catch (NSException *error) { response[@"ok"] = @NO; response[@"error"] = [error.name isEqualToString:@"ComputerUse"] ? error.reason : @"Computer Use native operation failed"; }
        @finally { if (InputSource) { CFRelease(InputSource); InputSource = NULL; } }
        response[@"postedAt"] = @(PostedAt);
        response[@"actionStarted"] = @(ActionStarted);
        if (CooldownUntil > 0) response[@"cooldownUntil"] = @(CooldownUntil);
        NSData *output = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
        if (!output || output.length > 24 * 1024 * 1024) return 3;
        const unsigned char *bytes = output.bytes; NSUInteger offset = 0;
        while (offset < output.length) { ssize_t written = write(STDOUT_FILENO, bytes + offset, output.length - offset); if (written <= 0) return 4; offset += (NSUInteger)written; }
        return 0;
    }
}
