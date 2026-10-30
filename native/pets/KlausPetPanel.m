#import <AppKit/AppKit.h>
#include "KlausPetPanel.h"
#include "KlausAppshotShortcut.h"
#import <IOKit/hidsystem/ev_keymap.h>

static NSWindow *PetPanel(void *pointer) {
    if (![NSThread isMainThread] || pointer == NULL) return nil;
    NSView *view = (__bridge NSView *)pointer;
    NSWindow *window = view.window;
    return window;
}

bool klaus_pet_panel_configure(void *view) {
    NSWindow *panel = PetPanel(view);
    if (panel == nil) return false;
    panel.canHide = NO;
    panel.hidesOnDeactivate = NO;
    if ([panel respondsToSelector:@selector(setFloatingPanel:)]) [(NSPanel *)panel setFloatingPanel:YES];
    if ([panel respondsToSelector:@selector(setBecomesKeyOnlyIfNeeded:)]) [(NSPanel *)panel setBecomesKeyOnlyIfNeeded:YES];
    // Electron owns activation policy when the panel's focusability changes.
    panel.acceptsMouseMovedEvents = YES;
    return true;
}

bool klaus_pet_panel_focus(void *view, bool active) {
    NSWindow *panel = PetPanel(view);
    if (panel == nil) return false;
    if (active) [panel makeKeyAndOrderFront:nil];
    else if (panel.isKeyWindow) [panel resignKeyWindow];
    return true;
}

int32_t klaus_pet_capture_active_application(void) {
    if (![NSThread isMainThread]) return 0;
    NSRunningApplication *application = NSWorkspace.sharedWorkspace.frontmostApplication;
    return application != nil && application.processIdentifier != NSProcessInfo.processInfo.processIdentifier ? application.processIdentifier : 0;
}

bool klaus_pet_restore_active_application(int32_t pid) {
    if (![NSThread isMainThread] || pid <= 0 || pid == NSProcessInfo.processInfo.processIdentifier) return false;
    NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (application == nil || application.terminated) return false;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    NSApplicationActivationOptions options = 0;
    if (@available(macOS 14.0, *)) {} else { options = NSApplicationActivateIgnoringOtherApps; }
    return [application activateWithOptions:options];
#pragma clang diagnostic pop
}

static NSMutableDictionary<NSNumber *, NSArray *> *PetOutsideObservers;
static uint32_t PetNextOutsideObserver = 1;
static bool PetContainsWindow(NSWindow *owner, NSWindow *candidate) {
    for (NSWindow *window = candidate; window != nil; window = window.parentWindow) { if (window == owner) return true; }
    return false;
}
uint32_t klaus_pet_observe_outside_clicks(void *view, void (*callback)(void *, int32_t), void *context) {
    NSWindow *window = PetPanel(view);
    if (window == nil || callback == NULL) return 0;
    __weak NSWindow *owner = window;
    void (^notify)(int32_t) = ^(int32_t windowNumber) {
        NSWindow *panel = owner;
        if (panel == nil || !panel.visible || panel.attachedSheet != nil || PetContainsWindow(panel, NSApp.modalWindow)) return;
        callback(context, windowNumber);
    };
    NSEventMask mask = NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown;
    id local = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event) {
        if (owner != nil && event.window != nil && !PetContainsWindow(owner, event.window)) {
            NSWindow *root = event.window; while (root.parentWindow != nil) root = root.parentWindow;
            notify((int32_t)root.windowNumber);
        }
        return event;
    }];
    id global = [NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(__unused NSEvent *event) { notify(0); }];
    if (local == nil || global == nil) {
        if (local != nil) [NSEvent removeMonitor:local];
        if (global != nil) [NSEvent removeMonitor:global];
        return 0;
    }
    if (PetOutsideObservers == nil) PetOutsideObservers = [NSMutableDictionary dictionary];
    uint32_t token = PetNextOutsideObserver++;
    if (token == 0) token = PetNextOutsideObserver++;
    PetOutsideObservers[@(token)] = @[local, global];
    return token;
}
void klaus_pet_stop_outside_clicks(uint32_t token) {
    if (![NSThread isMainThread]) return;
    for (id monitor in PetOutsideObservers[@(token)]) [NSEvent removeMonitor:monitor];
    [PetOutsideObservers removeObjectForKey:@(token)];
}

static NSMutableDictionary<NSNumber *, NSArray *> *PetDragObservers;
static uint32_t PetNextDragObserver = 1;
uint32_t klaus_pet_begin_window_drag(void *view, double pointer_x, double pointer_y, bool has_origin_bounds, double x, double y, double width, double height, void (*callback)(void *, double, double, bool, bool), void *context) {
    NSWindow *window = PetPanel(view);
    if (window == nil || callback == NULL || NSScreen.screens.count != 1) return 0;
    __weak NSWindow *owner = window;
    NSRect initial = window.frame;
    CGFloat desktopHeight = NSScreen.screens.firstObject.frame.size.height;
    NSPoint initialPointer = NSMakePoint(pointer_x, desktopHeight - pointer_y);
    __block BOOL active = YES;
    __block BOOL sawButtonDown = CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft);
    void (^move)(NSEvent *) = ^(NSEvent *event) {
        NSWindow *panel = owner;
        if (!active || panel == nil) return;
        NSPoint pointer = NSEvent.mouseLocation;
        NSRect frame = panel.frame, area = panel.screen.visibleFrame;
        frame.origin.x = initial.origin.x + pointer.x - initialPointer.x;
        frame.origin.y = initial.origin.y + pointer.y - initialPointer.y;
        CGFloat minimumX = has_origin_bounds ? x : area.origin.x;
        CGFloat maximumX = has_origin_bounds ? x + width : NSMaxX(area) - frame.size.width;
        CGFloat minimumY = has_origin_bounds ? desktopHeight - y - height - frame.size.height : area.origin.y;
        CGFloat maximumY = has_origin_bounds ? desktopHeight - y - frame.size.height : NSMaxY(area) - frame.size.height;
        frame.origin.x = MAX(minimumX, MIN(frame.origin.x, maximumX));
        frame.origin.y = MAX(minimumY, MIN(frame.origin.y, maximumY));
        [panel setFrameOrigin:frame.origin];
        BOOL ended = event.type == NSEventTypeLeftMouseUp;
        if (ended) active = NO;
        callback(context, frame.origin.x, desktopHeight - NSMaxY(frame), ended, (event.modifierFlags & NSEventModifierFlagOption) != 0);
    };
    NSEventMask mask = NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp;
    id local = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event) { move(event); return event; }];
    id global = [NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(NSEvent *event) { move(event); }];
    if (local == nil || global == nil) { if (local != nil) [NSEvent removeMonitor:local]; if (global != nil) [NSEvent removeMonitor:global]; return 0; }
    if (PetDragObservers == nil) PetDragObservers = [NSMutableDictionary dictionary];
    uint32_t token = PetNextDragObserver++; if (token == 0) token = PetNextDragObserver++;
    NSTimer *releaseTimer = [NSTimer timerWithTimeInterval:0.05 repeats:YES block:^(__unused NSTimer *timer) {
        if (!active) return;
        if (CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft)) { sawButtonDown = YES; return; }
        if (!sawButtonDown) return;
        NSEvent *release = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:NSEvent.mouseLocation modifierFlags:NSEvent.modifierFlags timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:0 context:nil eventNumber:0 clickCount:1 pressure:0];
        move(release);
    }];
    [[NSRunLoop mainRunLoop] addTimer:releaseTimer forMode:NSRunLoopCommonModes];
    PetDragObservers[@(token)] = @[local, global, releaseTimer];
    return token;
}
void klaus_pet_stop_window_drag(uint32_t token) {
    if (![NSThread isMainThread]) return;
    for (id monitor in PetDragObservers[@(token)]) { if ([monitor isKindOfClass:NSTimer.class]) [(NSTimer *)monitor invalidate]; else [NSEvent removeMonitor:monitor]; }
    [PetDragObservers removeObjectForKey:@(token)];
}

static NSMutableDictionary<NSNumber *, NSArray *> *AppshotShortcutObservers;
static uint32_t AppshotNextShortcutObserver = 1;
uint32_t klaus_appshot_observe_shortcut(uint32_t modifier, void (*callback)(void *), void *context) {
    if (![NSThread isMainThread] || callback == NULL || modifier > 2) return 0;
    const uint64_t allSides = NX_DEVICELCMDKEYMASK | NX_DEVICERCMDKEYMASK | NX_DEVICELALTKEYMASK | NX_DEVICERALTKEYMASK | NX_DEVICELSHIFTKEYMASK | NX_DEVICERSHIFTKEYMASK | NX_DEVICELCTLKEYMASK | NX_DEVICERCTLKEYMASK;
    __block KlausAppshotShortcut state = {0};
    state.left = modifier == 0 ? NX_DEVICELCMDKEYMASK : modifier == 1 ? NX_DEVICELALTKEYMASK : NX_DEVICELSHIFTKEYMASK;
    state.right = modifier == 0 ? NX_DEVICERCMDKEYMASK : modifier == 1 ? NX_DEVICERALTKEYMASK : NX_DEVICERSHIFTKEYMASK;
    state.modifiers = allSides | NSEventModifierFlagShift | NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagCommand | NSEventModifierFlagFunction;
    uint64_t aggregate = modifier == 0 ? NSEventModifierFlagCommand : modifier == 1 ? NSEventModifierFlagOption : NSEventModifierFlagShift;
    state.blocked = (NSEvent.modifierFlags & state.modifiers) != 0;
    for (int key = 0; key < 128; key++) {
        if (key == 54 || key == 55 || key == 56 || key == 58 || key == 59 || key == 60 || key == 61 || key == 62 || key == 63) continue;
        if (CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, (CGKeyCode)key)) state.held[key / 64] |= UINT64_C(1) << (key % 64);
    }
    void (^observe)(NSEvent *) = ^(NSEvent *event) {
        // Aggregate bits identify a family; device bits identify its two physical keys.
        uint64_t flags = event.modifierFlags & ~aggregate;
        bool changed = event.type == NSEventTypeFlagsChanged;
        int key = changed ? -1 : event.keyCode;
        if (KlausAppshotShortcutStep(&state, flags, key, event.type == NSEventTypeKeyDown, changed)) callback(context);
    };
    NSEventMask mask = NSEventMaskFlagsChanged | NSEventMaskKeyDown | NSEventMaskKeyUp;
    id local = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event) { observe(event); return event; }];
    id global = [NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(NSEvent *event) { observe(event); }];
    if (local == nil || global == nil) { if (local != nil) [NSEvent removeMonitor:local]; if (global != nil) [NSEvent removeMonitor:global]; return 0; }
    if (AppshotShortcutObservers == nil) AppshotShortcutObservers = [NSMutableDictionary dictionary];
    uint32_t token = AppshotNextShortcutObserver++; if (token == 0) token = AppshotNextShortcutObserver++;
    AppshotShortcutObservers[@(token)] = @[local, global];
    return token;
}
void klaus_appshot_stop_shortcut(uint32_t token) {
    if (![NSThread isMainThread]) return;
    for (id monitor in AppshotShortcutObservers[@(token)]) [NSEvent removeMonitor:monitor];
    [AppshotShortcutObservers removeObjectForKey:@(token)];
}
uint32_t klaus_pet_input_observer_count(void) { return (uint32_t)(PetOutsideObservers.count + PetDragObservers.count + AppshotShortcutObservers.count); }

int32_t klaus_pet_window_number(void *view) { return (int32_t)PetPanel(view).windowNumber; }
