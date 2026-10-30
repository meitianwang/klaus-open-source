#import <AppKit/AppKit.h>

@interface AppUiSynthetic : NSObject <NSApplicationDelegate>
@property(nonatomic) NSWindow *window;
@property(nonatomic) NSTextField *field;
@property(nonatomic) NSButton *button;
@property(nonatomic) NSString *output;
@property(nonatomic) NSInteger clicks;
@property(nonatomic) NSInteger menus;
@end
@implementation AppUiSynthetic
- (void)record {
    NSText *editor = self.field.currentEditor;
    NSRange selection = editor ? editor.selectedRange : NSMakeRange(0, 0);
    NSDictionary *state = @{ @"pid": @(NSProcessInfo.processInfo.processIdentifier), @"clicks": @(self.clicks),
        @"menus": @(self.menus), @"text": self.field.stringValue ?: @"", @"selectionLength": @(selection.length),
        @"selectionStart": @(selection.location), @"focused": @([NSRunningApplication currentApplication].active) };
    NSData *data = [NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
    [data writeToFile:self.output atomically:YES];
}
- (void)buttonAction:(id)sender { (void)sender; self.clicks += 1; [self record]; }
- (void)menuAction:(id)sender { (void)sender; self.menus += 1; [self record]; }
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    self.output = NSBundle.mainBundle.infoDictionary[@"KlausFixtureOutput"];
    if (![self.output isKindOfClass:NSString.class] || ![self.output containsString:@"app-ui-electron-fixture-"]) { [NSApp terminate:nil]; return; }
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(180, 200, 440, 260)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"Klaus App UI Owned Target";
    self.window.contentView.wantsLayer = YES;
    self.window.contentView.layer.backgroundColor = [NSColor colorWithSRGBRed:0.1 green:0.6 blue:0.3 alpha:1].CGColor;
    self.field = [[NSTextField alloc] initWithFrame:NSMakeRect(35, 150, 350, 30)];
    self.field.stringValue = @"Owned initial text"; self.field.identifier = @"klaus-owned-input";
    self.field.accessibilityLabel = @"Owned input"; [self.window.contentView addSubview:self.field];
    self.button = [NSButton buttonWithTitle:@"Owned Button" target:self action:@selector(buttonAction:)];
    self.button.frame = NSMakeRect(35, 65, 180, 40); self.button.identifier = @"klaus-owned-button";
    [self.window.contentView addSubview:self.button];
    NSMenu *menu = [NSMenu new];
    NSMenuItem *application = [[NSMenuItem alloc] initWithTitle:@"Fixture" action:NULL keyEquivalent:@""];
    NSMenu *applicationMenu = [[NSMenu alloc] initWithTitle:@"Fixture"];
    [applicationMenu addItemWithTitle:@"Quit" action:@selector(terminate:) keyEquivalent:@"q"];
    application.submenu = applicationMenu; [menu addItem:application];
    NSMenuItem *edit = [[NSMenuItem alloc] initWithTitle:@"Edit" action:NULL keyEquivalent:@""];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    edit.submenu = editMenu; [menu addItem:edit];
    NSMenuItem *actions = [[NSMenuItem alloc] initWithTitle:@"Owned Actions" action:NULL keyEquivalent:@""];
    NSMenu *actionsMenu = [[NSMenu alloc] initWithTitle:@"Owned Actions"];
    NSMenuItem *action = [[NSMenuItem alloc] initWithTitle:@"Increment Owned Counter" action:@selector(menuAction:) keyEquivalent:@""];
    action.target = self; [actionsMenu addItem:action]; actions.submenu = actionsMenu; [menu addItem:actions]; NSApp.mainMenu = menu;
    [self.window makeKeyAndOrderFront:nil]; [self.window makeFirstResponder:self.field];
    [NSRunningApplication.currentApplication activateWithOptions:0];
    [self record];
    [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *timer) { (void)timer; [self record]; }];
    [NSTimer scheduledTimerWithTimeInterval:120 repeats:NO block:^(NSTimer *timer) { (void)timer; [NSApp terminate:nil]; }];
}
@end
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        AppUiSynthetic *delegate = [AppUiSynthetic new]; NSApp.delegate = delegate; [NSApp run];
    }
    return 0;
}
