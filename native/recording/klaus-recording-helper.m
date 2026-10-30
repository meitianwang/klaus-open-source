#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <QuartzCore/QuartzCore.h>
#include <signal.h>
#include <unistd.h>

// This process only observes approved input and emits semantic, redacted events.
// The TypeScript host owns consent, recording files, sessions and MCP dispatch.
static const NSUInteger MaxLine = 64 * 1024;
static const NSUInteger MaxQueuedEvents = 256;
static const NSUInteger MaxQueuedBytes = 1024 * 1024;

static NSString *String(id value) { return [value isKindOfClass:NSString.class] ? value : @""; }
static NSString *Metadata(NSString *value) { return value.length <= 512 ? value : [value substringToIndex:512]; }
static NSString *Token(NSString *value) {
    NSString *result = [[value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] lowercaseString];
    while ([result hasSuffix:@"/"]) result = [result substringToIndex:result.length - 1];
    return result;
}
static BOOL Integer(id value, double minimum, double maximum) {
    if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
    double number = [value doubleValue]; return isfinite(number) && floor(number) == number && number >= minimum && number <= maximum;
}
static NSDictionary *Capabilities(void) {
    return @{@"version": @1, @"supported": @YES,
        @"permissions": @{@"accessibility": AXIsProcessTrusted() ? @YES : @NO,
            @"inputMonitoring": CGPreflightListenEventAccess() ? @YES : @NO}};
}
static NSString *Redact(NSString *text) {
    static NSArray<NSArray<NSString *> *> *patterns;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ patterns = @[
        @[@"sk-[A-Za-z0-9_-]{16,}", @"[REDACTED_API_KEY]"],
        @[@"AKIA[0-9A-Z]{16}", @"[REDACTED_AWS_KEY]"],
        @[@"(?i)bearer [A-Za-z0-9._~+/-]{20,}", @"[REDACTED_BEARER_TOKEN]"],
        @[@"\\b(?:\\d[ -]?){13,16}\\b", @"[REDACTED_CREDIT_CARD]"]]; });
    NSString *result = text;
    for (NSArray *pair in patterns) {
        NSRegularExpression *expression = [NSRegularExpression regularExpressionWithPattern:pair[0] options:0 error:nil];
        result = [expression stringByReplacingMatchesInString:result options:0 range:NSMakeRange(0, result.length) withTemplate:pair[1]];
    }
    return result;
}
static NSString *Attribute(AXUIElementRef element, CFStringRef name) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value) return @"";
    NSString *text = CFGetTypeID(value) == CFStringGetTypeID() ? [(__bridge NSString *)value copy] : @"";
    CFRelease(value);
    if (text.length > 2048) text = [text substringToIndex:2048];
    return Redact(text);
}
static NSString *WindowTitle(pid_t pid) {
    AXUIElementRef app = AXUIElementCreateApplication(pid); if (!app) return @"";
    AXUIElementSetMessagingTimeout(app, 0.1);
    CFTypeRef window = NULL; NSString *title = @"";
    if (AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &window) == kAXErrorSuccess && window) {
        if (CFGetTypeID(window) == AXUIElementGetTypeID()) {
            AXUIElementSetMessagingTimeout((AXUIElementRef)window, 0.1);
            title = Attribute((AXUIElementRef)window, kAXTitleAttribute);
        }
        CFRelease(window);
    }
    CFRelease(app); return title;
}
static NSDictionary *Target(CGPoint point, pid_t expectedPid) {
    AXUIElementRef system = AXUIElementCreateSystemWide(); if (!system) return @{};
    AXUIElementSetMessagingTimeout(system, 0.1);
    AXUIElementRef element = NULL; NSDictionary *result = @{};
    if (AXUIElementCopyElementAtPosition(system, point.x, point.y, &element) == kAXErrorSuccess && element) {
        pid_t pid = 0;
        // An application may move or lose foreground while the formatter is queued.
        if (AXUIElementGetPid(element, &pid) == kAXErrorSuccess && pid == expectedPid) {
            AXUIElementSetMessagingTimeout(element, 0.1);
            NSString *role = Attribute(element, kAXRoleAttribute), *title = Attribute(element, kAXTitleAttribute);
            if (!title.length) title = Attribute(element, kAXDescriptionAttribute);
            result = @{@"role": role, @"title": title};
        }
        CFRelease(element);
    }
    CFRelease(system); return result;
}

@interface Recorder : NSObject
@property(nonatomic) NSString *identifier;
@property(nonatomic) NSNumber *generation;
@property(nonatomic) BOOL started;
@property(nonatomic) BOOL capturing;
@property(nonatomic) BOOL stopping;
@property(nonatomic) CFMachPortRef tap;
@property(nonatomic) CFRunLoopSourceRef source;
@property(nonatomic) NSTimer *timer;
@property(nonatomic) CFTimeInterval began;
@property(nonatomic) CFTimeInterval lastAckAt;
@property(nonatomic) double maxDuration;
@property(nonatomic) NSArray<NSString *> *blocked;
@property(nonatomic) NSSet<NSNumber *> *allowedPids;
@property(nonatomic) NSUInteger rawPending;
@property(nonatomic) dispatch_queue_t formatter;
@property(nonatomic) dispatch_queue_t writer;
@property(nonatomic) NSMutableArray<NSDictionary *> *pending;
@property(nonatomic) NSUInteger pendingBytes;
@property(nonatomic) NSUInteger sequence;
@property(nonatomic) NSDictionary *inFlight;
@property(nonatomic) NSUInteger suppressed;
// The following fields are confined to the formatter queue.
@property(nonatomic) NSDictionary *foreground;
@property(nonatomic) NSString *windowTitle;
@property(nonatomic) NSMutableString *text;
@property(nonatomic) NSNumber *lastTextAt;
@property(nonatomic) NSDictionary *mouseDown;
@property(nonatomic) BOOL secure;
@property(nonatomic) NSMutableSet<NSString *> *excluded;
- (void)command:(NSDictionary *)command;
- (void)raw:(NSDictionary *)event;
- (void)emit:(NSDictionary *)event;
- (void)finish:(NSString *)mode reason:(NSString *)reason;
- (void)fatal:(NSString *)reason;
@end

static CGEventRef Capture(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *context) {
    (void)proxy;
    Recorder *recorder = (__bridge Recorder *)context;
    if (recorder.stopping) return event;
    if (type == kCGEventTapDisabledByTimeout) { [recorder finish:@"error" reason:@"native-event-tap-timeout"]; return event; }
    if (type == kCGEventTapDisabledByUserInput) { [recorder finish:@"error" reason:@"native-input-access-lost"]; return event; }
    NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!app || app.processIdentifier <= 0) return event;
    if (recorder.allowedPids.count && ![recorder.allowedPids containsObject:@(app.processIdentifier)]) return event;
    NSString *name = Metadata(app.localizedName ?: @""), *bundle = Metadata(app.bundleIdentifier ?: @"");
    BOOL blocked = NO;
    for (NSString *needle in recorder.blocked) if ([Token(name) containsString:needle] || [Token(bundle) containsString:needle]) { blocked = YES; break; }
    NSMutableDictionary *raw = [@{@"pid": @(app.processIdentifier), @"app": @{@"name": name, @"bundleId": bundle},
        @"ts": @((uint64_t)((CACurrentMediaTime() - recorder.began) * 1000)), @"blocked": @(blocked)} mutableCopy];
    if (blocked) { raw[@"kind"] = @"excluded"; [recorder raw:raw]; return event; }
    if (type == kCGEventKeyDown) {
        raw[@"kind"] = @"key";
        // Do not copy password text into any queue, including the formatter queue.
        if (IsSecureEventInputEnabled()) raw[@"secure"] = @YES;
        else {
            UniChar buffer[32]; UniCharCount length = 0;
            CGEventKeyboardGetUnicodeString(event, 0, &length, NULL);
            if (length > 32) { [recorder finish:@"error" reason:@"native-input-text-limit"]; return event; }
            CGEventKeyboardGetUnicodeString(event, 32, &length, buffer);
            raw[@"text"] = [[NSString alloc] initWithCharacters:buffer length:MIN(length, 32)];
            raw[@"keycode"] = @(CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode));
            raw[@"flags"] = @(CGEventGetFlags(event));
        }
    } else {
        CGPoint point = CGEventGetLocation(event);
        raw[@"kind"] = type == kCGEventLeftMouseDown ? @"left-down" : type == kCGEventLeftMouseUp ? @"left-up" : @"right-down";
        raw[@"x"] = @(point.x); raw[@"y"] = @(point.y);
        raw[@"clicks"] = @(MAX(1, CGEventGetIntegerValueField(event, kCGMouseEventClickState)));
    }
    [recorder raw:raw]; return event;
}

@implementation Recorder
- (instancetype)init {
    if ((self = [super init])) {
        _formatter = dispatch_queue_create("klaus.recording.format", DISPATCH_QUEUE_SERIAL);
        _writer = dispatch_queue_create("klaus.recording.output", DISPATCH_QUEUE_SERIAL);
        _pending = [NSMutableArray array]; _text = [NSMutableString string]; _excluded = [NSMutableSet set];
        _foreground = @{}; _windowTitle = @""; _blocked = @[]; _allowedPids = [NSSet set];
    }
    return self;
}
- (void)fatal:(NSString *)reason {
    // A broken/overfull pipe is a failed capture, never a successful truncated recording.
    fprintf(stderr, "recording-helper: %s\n", reason.UTF8String); fflush(stderr); exit(2);
}
- (void)sendNext {
    if (self.inFlight || !self.pending.count) return;
    NSDictionary *frame = self.pending.firstObject; [self.pending removeObjectAtIndex:0];
    NSData *data = frame[@"data"]; self.pendingBytes -= data.length;
    self.inFlight = frame; self.lastAckAt = CACurrentMediaTime();
    dispatch_async(self.writer, ^{
        const uint8_t *bytes = data.bytes; NSUInteger offset = 0;
        while (offset < data.length) {
            ssize_t count = write(STDOUT_FILENO, bytes + offset, data.length - offset);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) { [self fatal:@"event-output-closed"]; return; }
            offset += (NSUInteger)count;
        }
    });
}
- (void)emit:(NSDictionary *)event {
    // Queue validation and sequence assignment happen on the native main thread.
    dispatch_async(dispatch_get_main_queue(), ^{
        NSMutableDictionary *value = [event mutableCopy];
        value[@"recordingId"] = self.identifier ?: @""; value[@"generation"] = self.generation ?: @0;
        value[@"seq"] = @(++self.sequence);
        NSError *error = nil; NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
        if (!json || error || json.length > MaxLine) { [self fatal:@"native-event-invalid"]; return; }
        NSMutableData *line = [json mutableCopy]; [line appendBytes:"\n" length:1];
        if (self.pending.count >= MaxQueuedEvents || self.pendingBytes + line.length > MaxQueuedBytes) { [self fatal:@"native-event-backpressure"]; return; }
        [self.pending addObject:@{@"data": line, @"seq": value[@"seq"], @"terminal": @([value[@"type"] isEqual:@"ended"])}];
        self.pendingBytes += line.length; [self sendNext];
    });
}
- (void)flushText {
    if (!self.text.length) return;
    [self emit:@{@"type": @"event", @"event": @{@"type": @"keyboard.text_input", @"ts": self.lastTextAt ?: @0,
        @"app": self.foreground[@"app"] ?: @{}, @"window": self.windowTitle, @"text": Redact(self.text)}}];
    [self.text setString:@""];
}
- (void)format:(NSDictionary *)raw {
    @autoreleasepool {
        NSString *kind = raw[@"kind"];
        if ([kind isEqual:@"tick"]) {
            if ([raw[@"ts"] unsignedLongLongValue] > self.lastTextAt.unsignedLongLongValue + 1500) [self flushText];
            return;
        }
        NSMutableDictionary *sanitized = [raw mutableCopy];
        sanitized[@"app"] = @{@"name": Redact(String(raw[@"app"][@"name"])), @"bundleId": Redact(String(raw[@"app"][@"bundleId"]))};
        raw = sanitized;
        BOOL changed = ![self.foreground[@"pid"] isEqual:raw[@"pid"]] || ![self.foreground[@"app"] isEqual:raw[@"app"]];
        if (changed) { [self flushText]; self.mouseDown = nil; self.foreground = raw; self.windowTitle = @""; }
        if ([raw[@"blocked"] boolValue]) {
            self.suppressed++;
            NSString *identifier = String(raw[@"app"][@"bundleId"]);
            if (![self.excluded containsObject:identifier]) {
                if (self.excluded.count >= 256) { [self fatal:@"excluded-app-limit"]; return; }
                [self.excluded addObject:identifier];
                [self emit:@{@"type": @"event", @"event": @{@"type": @"recording.excludedApp", @"ts": raw[@"ts"], @"app": raw[@"app"]}}];
            }
            return;
        }
        pid_t pid = [raw[@"pid"] intValue];
        if (changed || [kind isEqual:@"foreground"]) {
            NSString *title = WindowTitle(pid);
            if (changed || ![title isEqual:self.windowTitle]) {
                [self flushText]; self.windowTitle = title;
                [self emit:@{@"type": @"event", @"event": @{@"type": @"window.changed", @"ts": raw[@"ts"], @"app": raw[@"app"], @"window": title}}];
            }
            if ([kind isEqual:@"foreground"]) return;
        }
        if ([kind isEqual:@"key"]) {
            if ([raw[@"secure"] boolValue]) {
                [self.text setString:@""];
                if (!self.secure) [self emit:@{@"type": @"event", @"event": @{@"type": @"secureInput", @"ts": raw[@"ts"], @"app": raw[@"app"]}}];
                self.secure = YES; return;
            }
            self.secure = NO;
            CGEventFlags flags = [raw[@"flags"] unsignedLongLongValue];
            NSMutableArray *modifiers = [NSMutableArray array];
            if (flags & kCGEventFlagMaskCommand) [modifiers addObject:@"command"];
            if (flags & kCGEventFlagMaskControl) [modifiers addObject:@"control"];
            if (flags & kCGEventFlagMaskAlternate) [modifiers addObject:@"option"];
            NSString *text = String(raw[@"text"]); NSInteger code = [raw[@"keycode"] integerValue];
            NSDictionary *names = @{@36:@"Return", @48:@"Tab", @49:@"Space", @51:@"Delete", @53:@"Escape", @115:@"Home", @116:@"PageUp", @117:@"ForwardDelete", @119:@"End", @121:@"PageDown", @123:@"ArrowLeft", @124:@"ArrowRight", @125:@"ArrowDown", @126:@"ArrowUp"};
            NSString *key = names[@(code)] ?: text;
            if (modifiers.count || (names[@(code)] && code != 49 && code != 51)) {
                [self flushText]; if (flags & kCGEventFlagMaskShift) [modifiers addObject:@"shift"];
                [self emit:@{@"type": @"event", @"event": @{@"type": @"keyboard.shortcut", @"ts": raw[@"ts"], @"app": raw[@"app"], @"window": self.windowTitle, @"key": Redact(key), @"modifiers": modifiers}}];
            } else if (code == 51) {
                if (self.text.length) [self.text deleteCharactersInRange:[self.text rangeOfComposedCharacterSequenceAtIndex:self.text.length - 1]];
            } else if (text.length) {
                if (self.text.length + text.length > 16 * 1024) { [self fatal:@"text-buffer-limit"]; return; }
                [self.text appendString:text]; self.lastTextAt = raw[@"ts"];
            }
            return;
        }
        [self flushText];
        if ([kind isEqual:@"left-down"]) { self.mouseDown = raw; return; }
        if (![kind isEqual:@"left-up"] && ![kind isEqual:@"right-down"]) return;
        if ([kind isEqual:@"left-up"] && !self.mouseDown) return;
        CGPoint point = CGPointMake([raw[@"x"] doubleValue], [raw[@"y"] doubleValue]);
        NSMutableDictionary *event = [@{@"type": [kind isEqual:@"right-down"] ? @"mouse.context_menu" : @"mouse.click",
            @"ts": raw[@"ts"], @"app": raw[@"app"], @"window": self.windowTitle, @"target": Target(point, pid)} mutableCopy];
        if ([kind isEqual:@"left-up"]) {
            event[@"button"] = @"left"; event[@"clickCount"] = raw[@"clicks"];
            if (self.mouseDown && hypot(point.x - [self.mouseDown[@"x"] doubleValue], point.y - [self.mouseDown[@"y"] doubleValue]) > 8) {
                event[@"type"] = @"mouse.drag";
                event[@"origin"] = @{@"x": self.mouseDown[@"x"], @"y": self.mouseDown[@"y"]};
                event[@"destination"] = @{@"x": raw[@"x"], @"y": raw[@"y"]};
            }
            self.mouseDown = nil;
        }
        [self emit:@{@"type": @"event", @"event": event}];
    }
}
- (void)raw:(NSDictionary *)event {
    if (self.stopping) return;
    if (self.rawPending >= 32) { [self fatal:@"native-input-backpressure"]; return; }
    self.rawPending++;
    dispatch_async(self.formatter, ^{
        [self format:event];
        dispatch_async(dispatch_get_main_queue(), ^{ self.rawPending--; });
    });
}
- (void)disable {
    if (self.tap) { CGEventTapEnable(self.tap, false); CFMachPortInvalidate(self.tap); }
    if (self.source) { CFRunLoopRemoveSource(CFRunLoopGetMain(), self.source, kCFRunLoopCommonModes); CFRelease(self.source); self.source = NULL; }
    if (self.tap) { CFRelease(self.tap); self.tap = NULL; }
}
- (void)finish:(NSString *)mode reason:(NSString *)reason {
    if (self.stopping) return;
    self.stopping = YES; [self disable];
    dispatch_async(self.formatter, ^{
        if ([mode isEqual:@"discard"]) [self.text setString:@""]; else [self flushText];
        if (self.capturing) [self emit:@{@"type": @"event", @"event": @{@"type": @"session.ended", @"ts": @((uint64_t)((CACurrentMediaTime() - self.began) * 1000)), @"discarded": @([mode isEqual:@"discard"])}}];
        [self emit:@{@"type": @"ended", @"mode": mode, @"reason": reason, @"suppressedEventCount": @(self.suppressed)}];
    });
}
- (void)policy:(NSDictionary *)command {
    id blocked = command[@"blockedApps"] ?: @[], allowed = command[@"allowedProcessIds"] ?: @[];
    if (![blocked isKindOfClass:NSArray.class] || [blocked count] > 256 || ![allowed isKindOfClass:NSArray.class] || [allowed count] > 32) { [self fatal:@"policy-invalid"]; return; }
    NSMutableArray *normalized = [NSMutableArray array];
    for (id value in blocked) {
        if (![value isKindOfClass:NSString.class] || [value length] > 256) { [self fatal:@"policy-invalid"]; return; }
        NSString *token = Token(value); if (token.length) [normalized addObject:token];
    }
    for (id pid in allowed) if (!Integer(pid, 1, INT32_MAX)) { [self fatal:@"policy-invalid"]; return; }
    self.blocked = normalized; self.allowedPids = [NSSet setWithArray:allowed];
}
- (void)command:(NSDictionary *)command {
    NSString *type = String(command[@"type"]);
    if ([type isEqual:@"start"]) {
        if (self.started || self.stopping) { [self fatal:@"recording-already-started"]; return; }
        NSString *identifier = String(command[@"recordingId"]);
        NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"] invertedSet];
        if (!identifier.length || identifier.length > 128 || [identifier rangeOfCharacterFromSet:invalid].location != NSNotFound || !Integer(command[@"generation"], 1, 9007199254740991)) { [self fatal:@"identity-invalid"]; return; }
        self.identifier = identifier; self.generation = command[@"generation"]; self.started = YES;
        self.began = CACurrentMediaTime(); self.maxDuration = 30 * 60;
        if (command[@"maxDurationMs"]) {
            if (!Integer(command[@"maxDurationMs"], 1, 30 * 60 * 1000)) { [self fatal:@"duration-invalid"]; return; }
            self.maxDuration = [command[@"maxDurationMs"] doubleValue] / 1000;
        }
        [self policy:command];
        self.timer = [NSTimer scheduledTimerWithTimeInterval:0.25 repeats:YES block:^(NSTimer *timer) {
            (void)timer;
            if (self.inFlight && CACurrentMediaTime() - self.lastAckAt > 5) { [self fatal:@"event-ack-timeout"]; return; }
            if (self.stopping) return;
            if (CACurrentMediaTime() - self.began >= self.maxDuration) { [self finish:@"stop" reason:@"duration-limit"]; return; }
            [self raw:@{@"kind": @"tick", @"ts": @((uint64_t)((CACurrentMediaTime() - self.began) * 1000))}];
            NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
            if (!app || (self.allowedPids.count && ![self.allowedPids containsObject:@(app.processIdentifier)])) return;
            BOOL blocked = NO;
            for (NSString *needle in self.blocked) if ([Token(app.localizedName ?: @"") containsString:needle] || [Token(app.bundleIdentifier ?: @"") containsString:needle]) { blocked = YES; break; }
            [self raw:@{@"kind": @"foreground", @"pid": @(app.processIdentifier), @"app": @{@"name": Metadata(app.localizedName ?: @""), @"bundleId": Metadata(app.bundleIdentifier ?: @"")}, @"blocked": @(blocked), @"ts": @((uint64_t)((CACurrentMediaTime() - self.began) * 1000))}];
        }];
        if (!CGPreflightListenEventAccess() || !AXIsProcessTrusted()) { [self finish:@"error" reason:@"macos-input-monitoring-or-accessibility-permission-required"]; return; }
        CGEventMask mask = CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp) | CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventKeyDown);
        self.tap = CGEventTapCreate(kCGHIDEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, Capture, (__bridge void *)self);
        if (!self.tap) { [self finish:@"error" reason:@"macos-event-tap-refused"]; return; }
        self.source = CFMachPortCreateRunLoopSource(NULL, self.tap, 0);
        if (!self.source) { [self finish:@"error" reason:@"macos-event-tap-source-failed"]; return; }
        CFRunLoopAddSource(CFRunLoopGetMain(), self.source, kCFRunLoopCommonModes); CGEventTapEnable(self.tap, true);
        self.capturing = YES;
        [self emit:@{@"type": @"ready", @"capabilities": Capabilities()}];
        [self emit:@{@"type": @"event", @"event": @{@"type": @"session.started", @"ts": @0}}];
        return;
    }
    if (!self.started || ![command[@"recordingId"] isEqual:self.identifier] || ![command[@"generation"] isEqual:self.generation]) { [self fatal:@"identity-mismatch"]; return; }
    if ([type isEqual:@"ack"]) {
        if (!self.inFlight || ![command[@"seq"] isEqual:self.inFlight[@"seq"]]) { [self fatal:@"event-ack-order"]; return; }
        BOOL terminal = [self.inFlight[@"terminal"] boolValue]; self.inFlight = nil;
        if (terminal) { [self.timer invalidate]; exit(0); }
        [self sendNext];
    } else if ([type isEqual:@"stop"]) {
        NSString *mode = String(command[@"mode"]), *reason = String(command[@"reason"]);
        if (![@[@"stop", @"discard"] containsObject:mode] || !reason.length || reason.length > 128) { [self fatal:@"stop-invalid"]; return; }
        [self finish:mode reason:reason];
    } else if ([type isEqual:@"policy"]) {
        if (self.stopping) return;
        [self policy:command];
        dispatch_async(self.formatter, ^{ [self flushText]; [self emit:@{@"type": @"policy", @"operationId": String(command[@"operationId"])}]; });
    } else [self fatal:@"command-invalid"];
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
        if (argc == 2 && strcmp(argv[1], "--capabilities") == 0) {
            NSData *data = [NSJSONSerialization dataWithJSONObject:Capabilities() options:0 error:nil];
            fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); return 0;
        }
        if (argc != 1) { fprintf(stderr, "recording-helper: unexpected arguments\n"); return 2; }
        [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        Recorder *recorder = [Recorder new];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ if (!recorder.started) [recorder fatal:@"start-timeout"]; });
        dispatch_semaphore_t slots = dispatch_semaphore_create(16);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            NSMutableData *buffer = [NSMutableData data]; NSData *newline = [NSData dataWithBytes:"\n" length:1];
            uint8_t bytes[4096];
            for (;;) {
                ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
                if (count < 0 && errno == EINTR) continue;
                if (count <= 0) { dispatch_async(dispatch_get_main_queue(), ^{ [recorder fatal:@"host-input-closed"]; }); return; }
                [buffer appendBytes:bytes length:(NSUInteger)count];
                for (;;) {
                    NSRange end = [buffer rangeOfData:newline options:0 range:NSMakeRange(0, buffer.length)];
                    if (end.location == NSNotFound) break;
                    if (end.location > MaxLine) { [recorder fatal:@"command-too-large"]; return; }
                    NSData *line = [buffer subdataWithRange:NSMakeRange(0, end.location)];
                    [buffer replaceBytesInRange:NSMakeRange(0, end.location + 1) withBytes:NULL length:0];
                    id value = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
                    if (![value isKindOfClass:NSDictionary.class]) { [recorder fatal:@"command-json-invalid"]; return; }
                    if (dispatch_semaphore_wait(slots, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC))) { [recorder fatal:@"command-backpressure"]; return; }
                    dispatch_async(dispatch_get_main_queue(), ^{ [recorder command:value]; dispatch_semaphore_signal(slots); });
                }
                if (buffer.length > MaxLine) { [recorder fatal:@"command-too-large"]; return; }
            }
        });
        [NSApp run]; return 0;
    }
}
