#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#include <unistd.h>

// Only fixed synthetic strings are posted, and only while the test app is foreground.
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3 && argc != 5) return 2;
        pid_t target = (pid_t)strtol(argv[1], NULL, 10);
        NSString *mode = [NSString stringWithUTF8String:argv[2]];
        if (target <= 0 || ![@[@"text", @"blocked", @"secure", @"password", @"click"] containsObject:mode]) return 2;
        if ([mode isEqual:@"click"]) {
            if (argc != 5 || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != target) return 3;
            CGPoint point = CGPointMake(strtod(argv[3], NULL), strtod(argv[4], NULL));
            if (!isfinite(point.x) || !isfinite(point.y)) return 2;
            CGEventRef original = CGEventCreate(NULL); CGPoint previous = CGEventGetLocation(original); CFRelease(original);
            CGEventType types[] = { kCGEventMouseMoved, kCGEventLeftMouseDown, kCGEventLeftMouseUp };
            for (int index = 0; index < 3; index++) {
                CGEventRef event = CGEventCreateMouseEvent(NULL, types[index], point, kCGMouseButtonLeft);
                CGEventSetIntegerValueField(event, kCGMouseEventClickState, 1); CGEventPost(kCGHIDEventTap, event); CFRelease(event); usleep(50000);
            }
            CGEventRef restore = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, previous, kCGMouseButtonLeft);
            CGEventPost(kCGHIDEventTap, restore); CFRelease(restore);
            fprintf(stdout, "synthetic-input: pid=%d mode=click\n", target); return 0;
        }
        NSString *text = [mode isEqual:@"text"] ? @"hello sk-fixture0123456789abcdef world" : [mode isEqual:@"blocked"] ? @"excluded-fixture" : [mode isEqual:@"password"] ? @"dom-private-fixture-password" : @"private-fixture-password";
        BOOL secure = [mode isEqual:@"secure"];
        if (secure && EnableSecureEventInput() != noErr) return 4;
        for (NSUInteger index = 0; index < text.length; index++) {
            if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != target) {
                fprintf(stderr, "recording-input: synthetic app is not foreground\n");
                if (secure) DisableSecureEventInput(); return 3;
            }
            UniChar character = [text characterAtIndex:index];
            for (int down = 1; down >= 0; down--) {
                CGEventRef event = CGEventCreateKeyboardEvent(NULL, 0, down != 0);
                CGEventKeyboardSetUnicodeString(event, 1, &character); CGEventSetFlags(event, 0);
                CGEventPost(kCGHIDEventTap, event); CFRelease(event);
            }
            usleep(15000);
        }
        if (secure) DisableSecureEventInput();
        fprintf(stdout, "synthetic-input: pid=%d mode=%s\n", target, mode.UTF8String); return 0;
    }
}
