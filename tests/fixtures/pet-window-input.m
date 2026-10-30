#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <IOKit/hidsystem/ev_keymap.h>
#include <unistd.h>

static void Key(CGKeyCode key, bool down, CGEventFlags flags) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, key, down);
    if (key == 54 || key == 55 || key == 56 || key == 58 || key == 60 || key == 61 || key == kVK_Control) CGEventSetType(event, kCGEventFlagsChanged);
    CGEventSetFlags(event, flags); CGEventPost(kCGHIDEventTap, event); CFRelease(event); usleep(60000);
}
static void Mouse(CGEventType type, CGPoint point, CGEventFlags flags) {
    CGEventRef event = CGEventCreateMouseEvent(NULL, type, point, type == kCGEventRightMouseDown || type == kCGEventRightMouseUp ? kCGMouseButtonRight : kCGMouseButtonLeft);
    CGEventSetFlags(event, flags); CGEventPost(kCGHIDEventTap, event); CFRelease(event); usleep(50000);
}
@interface FixtureView : NSView
@end
@implementation FixtureView
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)acceptsFirstMouse:(__unused NSEvent *)event { return YES; }
- (void)mouseDown:(__unused NSEvent *)event { printf("{\"event\":\"click\"}\n"); fflush(stdout); }
- (void)keyDown:(NSEvent *)event { printf("{\"event\":\"key\",\"code\":%u}\n", event.keyCode); fflush(stdout); }
@end
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "window") == 0) {
            [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
            NSRect area = NSScreen.mainScreen.visibleFrame;
            NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(area.origin.x + 40, area.origin.y + 40, 260, 180) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
            window.contentView = [[FixtureView alloc] initWithFrame:NSMakeRect(0, 0, 260, 180)];
            window.title = @"Companion foreground fixture"; [window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
            printf("ready:%d\n", getpid()); fflush(stdout);
            NSRect content = [window convertRectToScreen:window.contentView.bounds];
            printf("{\"event\":\"ready\",\"pid\":%d,\"window\":%ld,\"x\":%.0f,\"y\":%.0f,\"width\":%.0f,\"height\":%.0f}\n", getpid(), (long)window.windowNumber, content.origin.x, CGDisplayBounds(CGMainDisplayID()).size.height - NSMaxY(content), content.size.width, content.size.height); fflush(stdout);
            [NSTimer scheduledTimerWithTimeInterval:100 repeats:NO block:^(__unused NSTimer *timer) { [NSApp terminate:nil]; }];
            [NSApp run]; return 0;
        }
        if (argc < 3) return 2;
        pid_t target = (pid_t)strtol(argv[1], NULL, 10);
        NSRunningApplication *foreground = NSWorkspace.sharedWorkspace.frontmostApplication;
        if (target <= 0 || foreground.processIdentifier != target) {
            fprintf(stderr, "pet-window-input: foreground rejected expected=%d observed=%d active=%d terminated=%d\n", target, foreground.processIdentifier, foreground.active, foreground.terminated);
            return 3;
        }
        NSString *mode = [NSString stringWithUTF8String:argv[2]];
        if ([mode isEqual:@"move"]) {
            if (argc != 5) return 2;
            CGPoint point = CGPointMake(strtod(argv[3], NULL), strtod(argv[4], NULL));
            if (!isfinite(point.x) || !isfinite(point.y)) return 2;
            Mouse(kCGEventMouseMoved, point, 0);
        } else if ([mode isEqual:@"click"] || [mode isEqual:@"drag"] || [mode isEqual:@"alt-drag"]) {
            bool drag = ![mode isEqual:@"click"];
            if (argc != (drag ? 7 : 5)) return 2;
            CGPoint start = CGPointMake(strtod(argv[3], NULL), strtod(argv[4], NULL));
            CGPoint end = drag ? CGPointMake(strtod(argv[5], NULL), strtod(argv[6], NULL)) : start;
            if (!isfinite(start.x) || !isfinite(start.y) || !isfinite(end.x) || !isfinite(end.y)) return 2;
            CGEventRef initial = CGEventCreate(NULL); CGPoint previous = CGEventGetLocation(initial); CFRelease(initial);
            CGEventFlags flags = [mode isEqual:@"alt-drag"] ? kCGEventFlagMaskAlternate : 0;
            Mouse(kCGEventMouseMoved, start, flags); Mouse(kCGEventLeftMouseDown, start, flags);
            if (drag) for (int step = 1; step <= 8; step++) Mouse(kCGEventLeftMouseDragged, CGPointMake(start.x + (end.x - start.x) * step / 8, start.y + (end.y - start.y) * step / 8), flags);
            Mouse(kCGEventLeftMouseUp, end, flags); Mouse(kCGEventMouseMoved, previous, 0);
        } else if ([mode isEqual:@"right-click"]) {
            if (argc != 5) return 2;
            CGPoint point = CGPointMake(strtod(argv[3], NULL), strtod(argv[4], NULL));
            if (!isfinite(point.x) || !isfinite(point.y)) return 2;
            Mouse(kCGEventMouseMoved, point, 0); Mouse(kCGEventRightMouseDown, point, 0); Mouse(kCGEventRightMouseUp, point, 0);
        } else if ([mode isEqual:@"escape"] || [mode isEqual:@"menu-first"] || [mode isEqual:@"enter"]) {
            CGKeyCode key = [mode isEqual:@"escape"] ? kVK_Escape : kVK_Return;
            if ([mode isEqual:@"menu-first"]) { Key(kVK_DownArrow, true, 0); Key(kVK_DownArrow, false, 0); }
            Key(key, true, 0); Key(key, false, 0);
        } else if ([mode isEqual:@"text"]) {
            NSString *text = @"pet-fixture";
            for (NSUInteger index = 0; index < text.length; index++) {
                if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != target) return 3;
                UniChar character = [text characterAtIndex:index];
                for (int down = 1; down >= 0; down--) { CGEventRef event = CGEventCreateKeyboardEvent(NULL, 0, down != 0); CGEventKeyboardSetUnicodeString(event, 1, &character); CGEventSetFlags(event, 0); CGEventPost(kCGHIDEventTap, event); CFRelease(event); }
                usleep(20000);
            }
        } else if ([mode isEqual:@"mini-shortcut"]) {
            CGEventFlags control = kCGEventFlagMaskControl | NX_DEVICELCTLKEYMASK;
            CGEventFlags alternate = control | kCGEventFlagMaskAlternate | NX_DEVICELALTKEYMASK;
            CGEventFlags shift = alternate | kCGEventFlagMaskShift | NX_DEVICELSHIFTKEYMASK;
            Key(kVK_Control, true, control);
            Key(kVK_Option, true, alternate);
            Key(kVK_Shift, true, shift);
            Key(kVK_ANSI_Y, true, shift); Key(kVK_ANSI_Y, false, shift);
            Key(kVK_Shift, false, alternate);
            Key(kVK_Option, false, control);
            Key(kVK_Control, false, 0);
        } else if ([mode isEqual:@"option-space"]) {
            CGEventFlags alternate = kCGEventFlagMaskAlternate | NX_DEVICELALTKEYMASK;
            Key(kVK_Option, true, alternate);
            if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != target) { Key(kVK_Option, false, 0); return 3; }
            Key(kVK_Space, true, alternate); Key(kVK_Space, false, alternate);
            Key(kVK_Option, false, 0);
        } else if ([mode isEqual:@"check"]) {
            printf("foreground:%d\n", foreground.processIdentifier);
        } else if ([mode isEqual:@"chord"] || [mode isEqual:@"reverse"] || [mode isEqual:@"single"] || [mode isEqual:@"combo"] || [mode isEqual:@"alt-chord"] || [mode isEqual:@"shift-chord"]) {
            bool alt = [mode isEqual:@"alt-chord"], shift = [mode isEqual:@"shift-chord"], reverse = [mode isEqual:@"reverse"];
            CGKeyCode left = shift ? 56 : alt ? 58 : 55, right = shift ? 60 : alt ? 61 : 54;
            CGEventFlags aggregate = shift ? kCGEventFlagMaskShift : alt ? kCGEventFlagMaskAlternate : kCGEventFlagMaskCommand;
            CGEventFlags leftFlag = shift ? NX_DEVICELSHIFTKEYMASK : alt ? NX_DEVICELALTKEYMASK : NX_DEVICELCMDKEYMASK;
            CGEventFlags rightFlag = shift ? NX_DEVICERSHIFTKEYMASK : alt ? NX_DEVICERALTKEYMASK : NX_DEVICERCMDKEYMASK;
            CGKeyCode first = reverse ? right : left, second = reverse ? left : right;
            CGEventFlags firstFlag = reverse ? rightFlag : leftFlag;
            Key(first, true, aggregate | firstFlag);
            bool combo = [mode isEqual:@"combo"];
            if (combo) Key(0, true, aggregate | firstFlag);
            if (![mode isEqual:@"single"]) {
                Key(second, true, aggregate | leftFlag | rightFlag);
                if (combo) Key(0, false, aggregate | leftFlag | rightFlag);
                Key(second, false, aggregate | firstFlag);
            }
            Key(first, false, 0);
        } else return 2;
        printf("pet-window-input: pid=%d mode=%s\n", target, mode.UTF8String);
        return 0;
    }
}
