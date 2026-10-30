#import <AppKit/AppKit.h>

@interface SyntheticApplication : NSObject <NSApplicationDelegate>
@property(nonatomic) NSWindow *window;
@end
@implementation SyntheticApplication
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    NSString *output = NSBundle.mainBundle.infoDictionary[@"KlausFixtureOutput"];
    if (![output isKindOfClass:NSString.class] || ![output containsString:@"klaus-computer-use-electron-"]) { [NSApp terminate:nil]; return; }
    [@{ @"pid": @(NSProcessInfo.processInfo.processIdentifier) } writeToFile:output atomically:YES];
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(300, 250, 420, 240)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"Klaus Native Computer Use Synthetic Target";
    NSTextField *label = [NSTextField labelWithString:@"Only synthetic fixture content"];
    label.frame = NSMakeRect(30, 100, 350, 40); [self.window.contentView addSubview:label];
    [self.window makeKeyAndOrderFront:nil];
    [NSRunningApplication.currentApplication activateWithOptions:0];
    [NSTimer scheduledTimerWithTimeInterval:45 repeats:NO block:^(NSTimer *timer) { (void)timer; [NSApp terminate:nil]; }];
}
@end
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        SyntheticApplication *delegate = [SyntheticApplication new]; NSApp.delegate = delegate; [NSApp run];
    }
    return 0;
}
