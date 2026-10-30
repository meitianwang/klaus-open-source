#define main KlausComputerUseHelperMain
#import "../computer-use/klaus-computer-use-helper.m"
#undef main
#include <assert.h>

static NSUInteger Assertions = 0;
static void Expect(BOOL value) { Assertions++; assert(value); }
static void Refuses(void (^run)(void), NSString *message) {
    BOOL refused = NO; @try { run(); } @catch (NSException *error) { refused = [error.reason containsString:message]; } Expect(refused);
}
static NSDictionary *App(NSString *path, int pid, int windows, BOOL regular) {
    return @{@"path": path, @"pid": @(pid), @"name": @"Fixture", @"bundleId": @"test.fixture", @"windowCount": @(windows), @"regular": @(regular)};
}
static NSDictionary *Info(int pid, int identifier, int layer, CGRect bounds) {
    return @{(__bridge NSString *)kCGWindowOwnerPID: @(pid), (__bridge NSString *)kCGWindowNumber: @(identifier),
        (__bridge NSString *)kCGWindowLayer: @(layer), (__bridge NSString *)kCGWindowBounds: CFBridgingRelease(CGRectCreateDictionaryRepresentation(bounds))};
}
int main(void) {
    @autoreleasepool {
        Parent = getppid(); StartedAt = CFAbsoluteTimeGetCurrent();
        NSString *path = @"/Applications/Fixture.app", *other = @"/Applications/Other Fixture.app";
        NSDictionary *first = App(path, 11, 1, YES), *second = App(path, 22, 1, YES), *helper = App(path, 33, 0, NO), *different = App(other, 44, 1, YES);
        Expect([SelectApplication(@[first, second], path, 22)[@"pid"] intValue] == 22);
        Expect([SelectApplication(@[first, helper], path, 999)[@"pid"] intValue] == 11);
        Expect([SelectApplication(@[first, different], path, 44)[@"pid"] intValue] == 11);
        Expect([SelectApplication(@[first, helper], @"Fixture", 999)[@"pid"] intValue] == 11);
        Expect(SelectApplication(@[different], path, 44) == nil);
        Refuses(^{ SelectApplication(@[first, second], path, 999); }, @"ambiguous");
        Refuses(^{ SelectApplication(@[first, different], @"test.fixture", 11); }, @"ambiguous");
        CGRect bounds = CGRectMake(-100, 20, 500, 300), moved = CGRectOffset(bounds, 10, 0);
        NSDictionary *window = Info(11, 101, 0, bounds), *dialog = Info(11, 202, 3, bounds), *foreign = Info(22, 303, 0, bounds);
        Expect([SelectWindow(@[window, dialog, foreign], 11, 202, bounds) isEqual:dialog]);
        Expect([SelectWindow(@[dialog, window, foreign], 11, 101, bounds) isEqual:window]);
        Expect([SelectWindow(@[dialog], 11, 0, bounds) isEqual:dialog]);
        Expect(SelectWindow(@[foreign], 11, 0, bounds) == nil);
        Expect(SelectWindow(@[window, dialog], 11, 999, bounds) == nil);
        Expect(SelectWindow(@[window], 11, 101, moved) == nil);
        Refuses(^{ SelectWindow(@[window, dialog], 11, 0, bounds); }, @"ambiguous");
        Expect([Keys()[@"backspace"] intValue] == 51); Expect([Keys()[@"delete"] intValue] == 117);
        Expect([Keys()[@"kp_enter"] intValue] == 76); Expect([Keys()[@"kp_add"] intValue] == 69);
        Expect(ModifierCode(@"shift_r") == 60); Expect(ModifierCode(@"control_r") == 62);
        Expect(ModifierCode(@"alt_r") == 61); Expect(ModifierCode(@"meta_r") == 54);
        Expect((HeldFlags(@[@60]) & NX_DEVICERSHIFTKEYMASK) && !(HeldFlags(@[@60]) & NX_DEVICELSHIFTKEYMASK));
        Expect((HeldFlags(@[@56]) & NX_DEVICELSHIFTKEYMASK) && !(HeldFlags(@[@56]) & NX_DEVICERSHIFTKEYMASK));
        Expect((HeldFlags(@[@56, @60]) & (NX_DEVICELSHIFTKEYMASK | NX_DEVICERSHIFTKEYMASK)) == (NX_DEVICELSHIFTKEYMASK | NX_DEVICERSHIFTKEYMASK));
        Expect(HeldFlags(@[]) == 0);
        Expect(Modifier(@"Control_L") == 0); Expect(Modifier(@"control_l") == kCGEventFlagMaskControl);
        Expect(SameRectangle(bounds, CGRectOffset(bounds, 1, 0)));
        Expect(!SameRectangle(bounds, CGRectOffset(bounds, 2, 0)));
        Expect(EventSource() == EventSource());
        CGEventSourceStateID privateState = CGEventSourceGetSourceStateID(EventSource());
        Expect(privateState != kCGEventSourceStateHIDSystemState);
        Expect(privateState != kCGEventSourceStateCombinedSessionState);
        CFRelease(InputSource); InputSource = NULL;
        printf("{\"assertions\":%lu,\"realInputPosts\":0,\"realPrompts\":0}\n", (unsigned long)Assertions);
    }
    return 0;
}
