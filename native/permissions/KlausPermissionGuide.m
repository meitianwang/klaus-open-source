#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <QuartzCore/QuartzCore.h>
#import <math.h>
#include "KlausPermissionGuide.h"

static NSString *const kSystemSettingsBundleId = @"com.apple.systempreferences";
static NSString *const kFilenamesPboardType = @"NSFilenamesPboardType";
static NSString *const kPromisedFileURLPboardType = @"com.apple.pasteboard.promised-file-url";

static const CGFloat kDefaultPanelWidth = 420.0;
static const CGFloat kSettingsSidebarWidth = 230.0;
static const CGFloat kSettingsSidebarMinWindowWidth = 500.0;
static const CGFloat kScreenInset = 12.0;
static const CGFloat kMinimumPanelHeight = 104.0;
static const CGFloat kMinimumDragDistance = 4.0;
static const CGFloat kLaunchMinimumScale = 0.58;
static const CGFloat kLaunchInitialAlpha = 0.9;
static const CFTimeInterval kLaunchDuration = 0.56;
static const double kLaunchSpringResponse = 0.56;
static const NSTimeInterval kTrackerPollInterval = 1.0 / 30.0;
static const NSInteger kMissingAppThreshold = 12;
static const NSInteger kMissingWindowThreshold = 24;

static NSString *StringOrNil(const char *value) {
    if (value == NULL || value[0] == '\0') return nil;
    return [NSString stringWithUTF8String:value];
}

static NSURL *ResolveAppBundleURL(NSString *explicitPath) {
    NSURL *candidate = nil;
    if (explicitPath.length > 0) {
        candidate = [[NSURL fileURLWithPath:explicitPath] URLByStandardizingPath];
    } else {
        candidate = [[[NSBundle mainBundle] bundleURL] URLByStandardizingPath];
    }
    if (candidate == nil) return nil;
    if (![[candidate.pathExtension lowercaseString] isEqualToString:@"app"]) return nil;
    if (![[NSFileManager defaultManager] fileExistsAtPath:candidate.path]) return nil;
    return candidate;
}

static NSString *DisplayNameForAppURL(NSURL *url) {
    NSString *name = [[NSFileManager defaultManager] displayNameAtPath:url.path];
    if (name.length == 0) {
        name = [[url URLByDeletingPathExtension] lastPathComponent];
    }
    if ([[name.pathExtension lowercaseString] isEqualToString:@"app"]) {
        name = [name stringByDeletingPathExtension];
    }
    return name.length > 0 ? name : @"Klaus";
}

static void ActivateApplication(NSRunningApplication *application) {
    if (application == nil || application.terminated) return;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    NSApplicationActivationOptions options = 0;
    if (@available(macOS 14.0, *)) {
        options = 0;
    } else {
        options = NSApplicationActivateIgnoringOtherApps;
    }
    [application activateWithOptions:options];
#pragma clang diagnostic pop
}

static void ActivateSystemSettings(void) {
    NSArray<NSRunningApplication *> *apps =
        [NSRunningApplication runningApplicationsWithBundleIdentifier:kSystemSettingsBundleId];
    ActivateApplication(apps.firstObject);
}

static CGRect ConvertCGToAppKitRect(CGRect cgRect, CGRect screenFrame, CGRect screenCGBounds) {
    CGFloat localX = cgRect.origin.x - screenCGBounds.origin.x;
    CGFloat localY = cgRect.origin.y - screenCGBounds.origin.y;
    return CGRectMake(
        screenFrame.origin.x + localX,
        CGRectGetMaxY(screenFrame) - localY - cgRect.size.height - 3.0,
        cgRect.size.width,
        cgRect.size.height
    );
}

static CGRect ComputeTargetPanelFrame(CGRect settingsFrame, CGRect screenVisibleFrame, CGFloat measuredHeight) {
    BOOL hasSidebar = settingsFrame.size.width > kSettingsSidebarMinWindowWidth;
    CGFloat contentMinX = hasSidebar ? (settingsFrame.origin.x + kSettingsSidebarWidth) : settingsFrame.origin.x;
    CGFloat availableWidth = hasSidebar ? MAX(260.0, settingsFrame.size.width - kSettingsSidebarWidth)
                                        : MAX(260.0, settingsFrame.size.width);
    CGFloat maxAllowedWidth = MAX(240.0, screenVisibleFrame.size.width - (kScreenInset * 2.0));
    CGFloat width = MIN(availableWidth, maxAllowedWidth);
    CGFloat height = MAX(kMinimumPanelHeight, measuredHeight);

    CGFloat originX = contentMinX;
    CGFloat originY = settingsFrame.origin.y - height + 4.0;

    CGFloat minX = screenVisibleFrame.origin.x + kScreenInset;
    CGFloat maxX = CGRectGetMaxX(screenVisibleFrame) - width - kScreenInset;
    originX = MAX(minX, MIN(originX, MAX(minX, maxX)));

    CGFloat minY = screenVisibleFrame.origin.y + kScreenInset;
    CGFloat maxY = CGRectGetMaxY(screenVisibleFrame) - height - kScreenInset;
    originY = MAX(minY, MIN(originY, MAX(minY, maxY)));

    return CGRectMake(originX, originY, width, height);
}

// MARK: - Pasteboard Writer

@interface KlausAppBundlePasteboardWriter : NSObject <NSPasteboardWriting>
@property (nonatomic, strong, readonly) NSURL *url;
- (instancetype)initWithURL:(NSURL *)url;
@end

@implementation KlausAppBundlePasteboardWriter

- (instancetype)initWithURL:(NSURL *)url {
    self = [super init];
    if (self) {
        _url = url;
    }
    return self;
}

- (NSArray<NSPasteboardType> *)writableTypesForPasteboard:(NSPasteboard *)pasteboard {
    (void)pasteboard;
    return @[
        NSPasteboardTypeFileURL,
        NSPasteboardTypeURL,
        kFilenamesPboardType,
        kPromisedFileURLPboardType,
        NSPasteboardTypeString,
    ];
}

- (nullable id)pasteboardPropertyListForType:(NSPasteboardType)type {
    if ([type isEqualToString:NSPasteboardTypeFileURL] ||
        [type isEqualToString:NSPasteboardTypeURL] ||
        [type isEqualToString:kPromisedFileURLPboardType]) {
        return self.url.absoluteString;
    }
    if ([type isEqualToString:kFilenamesPboardType]) {
        return @[ self.url.path ];
    }
    if ([type isEqualToString:NSPasteboardTypeString]) {
        return self.url.path;
    }
    return nil;
}

@end

// MARK: - Direction Arrow View

@interface KlausHeaderArrowView : NSView
- (void)setDragging:(BOOL)dragging;
@end

@implementation KlausHeaderArrowView {
    NSImageView *_iconView;
    NSTextField *_fallbackLabel;
    BOOL _dragging;
}

- (instancetype)initWithFrame:(NSRect)frameRect {
    self = [super initWithFrame:frameRect];
    if (self) {
        self.wantsLayer = YES;
        if (@available(macOS 11.0, *)) {
            NSImage *symbol = [NSImage imageWithSystemSymbolName:@"arrowshape.up.fill" accessibilityDescription:nil];
            NSImageSymbolConfiguration *config =
                [NSImageSymbolConfiguration configurationWithPointSize:14.0 weight:NSFontWeightBold];
            symbol = [symbol imageWithSymbolConfiguration:config];
            _iconView = [[NSImageView alloc] initWithFrame:NSZeroRect];
            _iconView.translatesAutoresizingMaskIntoConstraints = NO;
            _iconView.image = symbol;
            _iconView.contentTintColor = [NSColor controlAccentColor];
            _iconView.wantsLayer = YES;
            [self addSubview:_iconView];
            [NSLayoutConstraint activateConstraints:@[
                [_iconView.centerXAnchor constraintEqualToAnchor:self.centerXAnchor],
                [_iconView.centerYAnchor constraintEqualToAnchor:self.centerYAnchor],
                [_iconView.widthAnchor constraintEqualToConstant:18.0],
                [_iconView.heightAnchor constraintEqualToConstant:18.0],
            ]];
        } else {
            _fallbackLabel = [NSTextField labelWithString:@"▲"];
            _fallbackLabel.translatesAutoresizingMaskIntoConstraints = NO;
            _fallbackLabel.font = [NSFont systemFontOfSize:13.0 weight:NSFontWeightBold];
            _fallbackLabel.textColor = [NSColor controlAccentColor];
            _fallbackLabel.wantsLayer = YES;
            [self addSubview:_fallbackLabel];
            [NSLayoutConstraint activateConstraints:@[
                [_fallbackLabel.centerXAnchor constraintEqualToAnchor:self.centerXAnchor],
                [_fallbackLabel.centerYAnchor constraintEqualToAnchor:self.centerYAnchor],
            ]];
        }
    }
    return self;
}

- (NSSize)intrinsicContentSize {
    return NSMakeSize(20.0, 20.0);
}

- (void)viewDidMoveToWindow {
    [super viewDidMoveToWindow];
    if (self.window != nil) {
        [self applyAnimation];
    } else {
        [self targetLayer].transform = CATransform3DIdentity;
        [[self targetLayer] removeAllAnimations];
    }
}

- (CALayer *)targetLayer {
    NSView *view = _iconView != nil ? (NSView *)_iconView : (NSView *)_fallbackLabel;
    view.wantsLayer = YES;
    return view.layer;
}

- (void)setDragging:(BOOL)dragging {
    if (_dragging == dragging) return;
    _dragging = dragging;
    [self applyAnimation];
}

- (void)applyAnimation {
    CALayer *layer = [self targetLayer];
    if (layer == nil) return;
    [layer removeAllAnimations];

    if (_dragging) {
        CABasicAnimation *pulse = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
        pulse.fromValue = @(0.90);
        pulse.toValue = @(1.16);
        pulse.duration = 0.65;
        pulse.autoreverses = YES;
        pulse.repeatCount = HUGE_VALF;
        pulse.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
        [layer addAnimation:pulse forKey:@"klaus.guide.pulse"];
    } else {
        CABasicAnimation *bob = [CABasicAnimation animationWithKeyPath:@"transform.translation.y"];
        bob.fromValue = @(-1.5);
        bob.toValue = @(2.5);
        bob.duration = 0.48;
        bob.autoreverses = YES;
        bob.repeatCount = HUGE_VALF;
        bob.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
        [layer addAnimation:bob forKey:@"klaus.guide.bob"];
    }
}

@end

// MARK: - Draggable App Card View

@interface KlausAppDragCardView : NSView <NSDraggingSource>
@property (nonatomic, copy, nullable) void (^onDragStateChange)(BOOL dragging);
- (instancetype)initWithAppURL:(NSURL *)url dragLabel:(NSString *)dragLabel;
- (void)updateWithAppURL:(NSURL *)url dragLabel:(NSString *)dragLabel;
@end

@implementation KlausAppDragCardView {
    NSURL *_appURL;
    NSImageView *_appIconView;
    NSTextField *_appNameLabel;
    NSTextField *_dragHintLabel;
    NSPoint _mouseDownPoint;
    BOOL _hasMouseDown;
    BOOL _hasBegunDragging;
}

- (instancetype)initWithAppURL:(NSURL *)url dragLabel:(NSString *)dragLabel {
    self = [super initWithFrame:NSZeroRect];
    if (self) {
        _appURL = url;
        self.wantsLayer = YES;
        self.layer.cornerRadius = 14.0;
        self.layer.borderWidth = 1.0;

        _appIconView = [[NSImageView alloc] initWithFrame:NSZeroRect];
        _appIconView.translatesAutoresizingMaskIntoConstraints = NO;
        _appIconView.imageScaling = NSImageScaleProportionallyUpOrDown;
        _appIconView.wantsLayer = YES;
        _appIconView.layer.cornerRadius = 8.0;
        _appIconView.layer.masksToBounds = YES;

        _appNameLabel = [NSTextField labelWithString:@""];
        _appNameLabel.translatesAutoresizingMaskIntoConstraints = NO;
        _appNameLabel.font = [NSFont systemFontOfSize:15.0 weight:NSFontWeightMedium];
        _appNameLabel.textColor = [NSColor labelColor];
        _appNameLabel.lineBreakMode = NSLineBreakByTruncatingTail;

        NSStackView *trailingStack = [[NSStackView alloc] initWithFrame:NSZeroRect];
        trailingStack.translatesAutoresizingMaskIntoConstraints = NO;
        trailingStack.orientation = NSUserInterfaceLayoutOrientationVertical;
        trailingStack.alignment = NSLayoutAttributeCenterX;
        trailingStack.spacing = 2.0;

        if (@available(macOS 11.0, *)) {
            NSImage *hand = [NSImage imageWithSystemSymbolName:@"hand.draw" accessibilityDescription:nil];
            if (hand != nil) {
                NSImageSymbolConfiguration *cfg =
                    [NSImageSymbolConfiguration configurationWithPointSize:13.0 weight:NSFontWeightRegular];
                NSImageView *handView = [[NSImageView alloc] initWithFrame:NSZeroRect];
                handView.translatesAutoresizingMaskIntoConstraints = NO;
                handView.image = [hand imageWithSymbolConfiguration:cfg];
                handView.contentTintColor = [NSColor secondaryLabelColor];
                [trailingStack addArrangedSubview:handView];
            }
        }

        _dragHintLabel = [NSTextField labelWithString:@""];
        _dragHintLabel.translatesAutoresizingMaskIntoConstraints = NO;
        _dragHintLabel.font = [NSFont systemFontOfSize:10.0 weight:NSFontWeightRegular];
        _dragHintLabel.textColor = [NSColor secondaryLabelColor];
        [trailingStack addArrangedSubview:_dragHintLabel];

        [self addSubview:_appIconView];
        [self addSubview:_appNameLabel];
        [self addSubview:trailingStack];

        [NSLayoutConstraint activateConstraints:@[
            [self.heightAnchor constraintGreaterThanOrEqualToConstant:52.0],

            [_appIconView.leadingAnchor constraintEqualToAnchor:self.leadingAnchor constant:10.0],
            [_appIconView.centerYAnchor constraintEqualToAnchor:self.centerYAnchor],
            [_appIconView.widthAnchor constraintEqualToConstant:34.0],
            [_appIconView.heightAnchor constraintEqualToConstant:34.0],

            [_appNameLabel.leadingAnchor constraintEqualToAnchor:_appIconView.trailingAnchor constant:10.0],
            [_appNameLabel.centerYAnchor constraintEqualToAnchor:self.centerYAnchor],
            [_appNameLabel.trailingAnchor constraintLessThanOrEqualToAnchor:trailingStack.leadingAnchor constant:-10.0],

            [trailingStack.trailingAnchor constraintEqualToAnchor:self.trailingAnchor constant:-12.0],
            [trailingStack.centerYAnchor constraintEqualToAnchor:self.centerYAnchor],
        ]];

        [self updateWithAppURL:url dragLabel:dragLabel];
        [self refreshCardColors];
    }
    return self;
}

- (void)updateWithAppURL:(NSURL *)url dragLabel:(NSString *)dragLabel {
    _appURL = url;
    NSImage *icon = [[NSWorkspace sharedWorkspace] iconForFile:url.path];
    icon.size = NSMakeSize(34.0, 34.0);
    _appIconView.image = icon;
    _appNameLabel.stringValue = DisplayNameForAppURL(url);
    _dragHintLabel.stringValue = dragLabel.length > 0 ? dragLabel : @"Drag";
}

- (void)viewDidChangeEffectiveAppearance {
    [super viewDidChangeEffectiveAppearance];
    [self refreshCardColors];
}

- (void)refreshCardColors {
    void (^apply)(void) = ^{
        self.layer.backgroundColor = [[NSColor controlBackgroundColor] colorWithAlphaComponent:0.72].CGColor;
        self.layer.borderColor = [[NSColor labelColor] colorWithAlphaComponent:0.10].CGColor;
    };
    if (@available(macOS 11.0, *)) {
        [self.effectiveAppearance performAsCurrentDrawingAppearance:apply];
    } else {
        apply();
    }
}

- (void)resetCursorRects {
    [super resetCursorRects];
    [self addCursorRect:self.bounds cursor:[NSCursor openHandCursor]];
}

- (NSView *)hitTest:(NSPoint)point {
    return NSPointInRect(point, self.frame) ? self : nil;
}

- (void)mouseDown:(NSEvent *)event {
    _mouseDownPoint = [self convertPoint:event.locationInWindow fromView:nil];
    _hasMouseDown = YES;
    _hasBegunDragging = NO;
}

- (void)mouseDragged:(NSEvent *)event {
    if (_hasBegunDragging || !_hasMouseDown || _appURL == nil) return;
    NSPoint current = [self convertPoint:event.locationInWindow fromView:nil];
    CGFloat distance = hypot(current.x - _mouseDownPoint.x, current.y - _mouseDownPoint.y);
    if (distance <= kMinimumDragDistance) return;

    _hasBegunDragging = YES;
    [self beginAppDragWithEvent:event];
}

- (void)mouseUp:(NSEvent *)event {
    (void)event;
    _hasMouseDown = NO;
    _hasBegunDragging = NO;
}

- (void)beginAppDragWithEvent:(NSEvent *)event {
    KlausAppBundlePasteboardWriter *writer = [[KlausAppBundlePasteboardWriter alloc] initWithURL:_appURL];
    NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:writer];
    NSImage *icon = [[[NSWorkspace sharedWorkspace] iconForFile:_appURL.path] copy];
    icon.size = NSMakeSize(56.0, 56.0);

    NSPoint dragPoint = [self convertPoint:event.locationInWindow fromView:nil];
    NSRect dragFrame = NSMakeRect(dragPoint.x - 28.0, dragPoint.y - 28.0, 56.0, 56.0);
    [item setDraggingFrame:dragFrame contents:icon];

    NSDraggingSession *session = [self beginDraggingSessionWithItems:@[ item ] event:event source:self];
    session.animatesToStartingPositionsOnCancelOrFail = YES;
    session.draggingFormation = NSDraggingFormationNone;
}

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
    (void)session;
    (void)context;
    return NSDragOperationCopy;
}

- (BOOL)ignoreModifierKeysForDraggingSession:(NSDraggingSession *)session {
    (void)session;
    return YES;
}

- (void)draggingSession:(NSDraggingSession *)session willBeginAtPoint:(NSPoint)screenPoint {
    (void)session;
    (void)screenPoint;
    if (self.onDragStateChange != nil) self.onDragStateChange(YES);
}

- (void)draggingSession:(NSDraggingSession *)session
           endedAtPoint:(NSPoint)screenPoint
              operation:(NSDragOperation)operation {
    (void)session;
    (void)screenPoint;
    (void)operation;
    _hasMouseDown = NO;
    _hasBegunDragging = NO;
    if (self.onDragStateChange != nil) self.onDragStateChange(NO);
}

@end

// MARK: - System Settings Window Tracker

@interface KlausSettingsWindowTracker : NSObject
@property (nonatomic, copy, nullable) void (^onFrameChange)(CGRect frame);
@property (nonatomic, copy, nullable) void (^onTrackingEnded)(void);
@property (nonatomic, readonly) BOOL hasCurrentFrame;
@property (nonatomic, readonly) CGRect currentFrame;
- (void)startTracking;
- (void)stopTracking;
@end

static void KlausSettingsAXCallback(AXObserverRef observer,
                                    AXUIElementRef element,
                                    CFStringRef notification,
                                    void *refcon);

@implementation KlausSettingsWindowTracker {
    NSTimer *_pollTimer;
    AXObserverRef _appObserver;
    AXObserverRef _windowObserver;
    AXUIElementRef _observedWindow;
    BOOL _hasCurrentFrame;
    CGRect _currentFrame;
    BOOL _hasSeenApp;
    BOOL _hasSeenWindow;
    NSInteger _missingAppCount;
    NSInteger _missingWindowCount;
}

- (void)dealloc {
    [self stopTracking];
}

- (void)startTracking {
    [self stopTracking];
    __weak typeof(self) weakSelf = self;
    _pollTimer = [NSTimer timerWithTimeInterval:kTrackerPollInterval repeats:YES block:^(__unused NSTimer *timer) {
        [weakSelf pollTick];
    }];
    _pollTimer.tolerance = kTrackerPollInterval * 0.25;
    [[NSRunLoop mainRunLoop] addTimer:_pollTimer forMode:NSRunLoopCommonModes];
    [self pollTick];
}

- (void)stopTracking {
    [_pollTimer invalidate];
    _pollTimer = nil;

    if (_appObserver != NULL) {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(_appObserver), kCFRunLoopCommonModes);
        CFRelease(_appObserver);
        _appObserver = NULL;
    }
    if (_windowObserver != NULL) {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(_windowObserver), kCFRunLoopCommonModes);
        CFRelease(_windowObserver);
        _windowObserver = NULL;
    }
    if (_observedWindow != NULL) {
        CFRelease(_observedWindow);
        _observedWindow = NULL;
    }

    _hasCurrentFrame = NO;
    _currentFrame = CGRectZero;
    _hasSeenApp = NO;
    _hasSeenWindow = NO;
    _missingAppCount = 0;
    _missingWindowCount = 0;
}

- (void)pollTick {
    NSRunningApplication *app = [self runningSettingsApplication];
    if (app == nil) {
        if (_hasSeenApp || _hasCurrentFrame) {
            _missingAppCount += 1;
            if (_missingAppCount >= kMissingAppThreshold) {
                void (^ended)(void) = self.onTrackingEnded;
                [self stopTracking];
                if (ended != nil) ended();
            }
        }
        return;
    }

    _hasSeenApp = YES;
    _missingAppCount = 0;

    CGRect cgFrame = CGRectZero;
    BOOL foundWindow = [self windowServerFrameForPID:app.processIdentifier outFrame:&cgFrame];
    if (foundWindow) {
        _hasSeenWindow = YES;
        _missingWindowCount = 0;
        [self publishFrame:cgFrame];
    } else if (_hasSeenWindow) {
        _missingWindowCount += 1;
        if (_missingWindowCount >= kMissingWindowThreshold) {
            void (^ended)(void) = self.onTrackingEnded;
            [self stopTracking];
            if (ended != nil) ended();
            return;
        }
    }

    if (!AXIsProcessTrusted()) return;
    [self attachAccessibilityObserversForPID:app.processIdentifier];
}

- (nullable NSRunningApplication *)runningSettingsApplication {
    NSArray<NSRunningApplication *> *apps =
        [NSRunningApplication runningApplicationsWithBundleIdentifier:kSystemSettingsBundleId];
    for (NSRunningApplication *app in apps) {
        if (!app.terminated) return app;
    }
    return nil;
}

- (void)publishFrame:(CGRect)frame {
    if (_hasCurrentFrame && CGRectEqualToRect(_currentFrame, frame)) return;
    _hasCurrentFrame = YES;
    _currentFrame = frame;
    if (self.onFrameChange != nil) self.onFrameChange(frame);
}

- (BOOL)windowServerFrameForPID:(pid_t)pid outFrame:(CGRect *)outFrame {
    NSArray *windows = CFBridgingRelease(
        CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
                                   kCGNullWindowID)
    );
    if (![windows isKindOfClass:[NSArray class]]) return NO;

    BOOL found = NO;
    CGRect bestFrame = CGRectZero;
    CGFloat bestArea = 0.0;

    for (id item in windows) {
        if (![item isKindOfClass:[NSDictionary class]]) continue;
        NSDictionary *info = (NSDictionary *)item;
        NSNumber *ownerPID = info[(id)kCGWindowOwnerPID];
        if (ownerPID == nil || ownerPID.intValue != pid) continue;

        NSNumber *layer = info[(id)kCGWindowLayer];
        if (layer != nil && layer.integerValue != 0) continue;

        NSNumber *alpha = info[(id)kCGWindowAlpha];
        if (alpha != nil && alpha.doubleValue <= 0.0) continue;

        NSDictionary *boundsDict = info[(id)kCGWindowBounds];
        if (![boundsDict isKindOfClass:[NSDictionary class]]) continue;
        CGRect cgBounds = CGRectZero;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)boundsDict, &cgBounds)) continue;
        if (cgBounds.size.width <= 320.0 || cgBounds.size.height <= 240.0) continue;

        CGRect appKitRect = [self appKitFrameFromGlobalTopLeftRect:cgBounds];
        CGFloat area = appKitRect.size.width * appKitRect.size.height;
        if (!found || area > bestArea) {
            found = YES;
            bestArea = area;
            bestFrame = appKitRect;
        }
    }

    if (found && outFrame != NULL) {
        *outFrame = bestFrame;
    }
    return found;
}

- (CGRect)appKitFrameFromGlobalTopLeftRect:(CGRect)cgRect {
    NSScreen *bestScreen = nil;
    CGRect bestCGBounds = CGRectZero;
    CGFloat bestIntersectionArea = 0.0;

    for (NSScreen *screen in [NSScreen screens]) {
        NSNumber *screenNumber = screen.deviceDescription[@"NSScreenNumber"];
        if (![screenNumber isKindOfClass:[NSNumber class]]) continue;
        CGDirectDisplayID displayID = (CGDirectDisplayID)screenNumber.unsignedIntValue;
        CGRect displayBounds = CGDisplayBounds(displayID);
        CGRect intersection = CGRectIntersection(displayBounds, cgRect);
        if (CGRectIsNull(intersection) || CGRectIsEmpty(intersection)) continue;
        CGFloat area = intersection.size.width * intersection.size.height;
        if (bestScreen == nil || area > bestIntersectionArea) {
            bestScreen = screen;
            bestCGBounds = displayBounds;
            bestIntersectionArea = area;
        }
    }

    if (bestScreen == nil) return cgRect;
    return ConvertCGToAppKitRect(cgRect, bestScreen.frame, bestCGBounds);
}

- (void)attachAccessibilityObserversForPID:(pid_t)pid {
    AXUIElementRef appElement = AXUIElementCreateApplication(pid);
    if (appElement == NULL) return;

    if (_appObserver == NULL) {
        AXObserverRef observer = NULL;
        if (AXObserverCreate(pid, KlausSettingsAXCallback, &observer) == kAXErrorSuccess && observer != NULL) {
            _appObserver = observer;
            AXObserverAddNotification(_appObserver, appElement, kAXMainWindowChangedNotification, (__bridge void *)self);
            AXObserverAddNotification(_appObserver, appElement, kAXFocusedWindowChangedNotification, (__bridge void *)self);
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(_appObserver), kCFRunLoopCommonModes);
        }
    }

    AXUIElementRef window = [self copyMainWindowForAppElement:appElement];
    CFRelease(appElement);
    if (window == NULL) return;

    if (_observedWindow != NULL && CFEqual(window, _observedWindow)) {
        CFRelease(window);
        [self readAXWindowFrame];
        return;
    }

    if (_observedWindow != NULL) CFRelease(_observedWindow);
    _observedWindow = window;

    if (_windowObserver != NULL) {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(_windowObserver), kCFRunLoopCommonModes);
        CFRelease(_windowObserver);
        _windowObserver = NULL;
    }

    AXObserverRef winObserver = NULL;
    if (AXObserverCreate(pid, KlausSettingsAXCallback, &winObserver) == kAXErrorSuccess && winObserver != NULL) {
        _windowObserver = winObserver;
        AXObserverAddNotification(_windowObserver, _observedWindow, kAXMovedNotification, (__bridge void *)self);
        AXObserverAddNotification(_windowObserver, _observedWindow, kAXResizedNotification, (__bridge void *)self);
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(_windowObserver), kCFRunLoopCommonModes);
    }

    [self readAXWindowFrame];
}

- (nullable AXUIElementRef)copyMainWindowForAppElement:(AXUIElementRef)appElement {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(appElement, kAXMainWindowAttribute, &value) == kAXErrorSuccess && value != NULL) {
        return (AXUIElementRef)value;
    }
    if (AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute, &value) == kAXErrorSuccess && value != NULL) {
        return (AXUIElementRef)value;
    }
    if (AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute, &value) == kAXErrorSuccess && value != NULL) {
        NSArray *list = CFBridgingRelease(value);
        if ([list isKindOfClass:[NSArray class]] && list.count > 0) {
            AXUIElementRef first = (__bridge AXUIElementRef)list.firstObject;
            CFRetain(first);
            return first;
        }
    }
    return NULL;
}

- (void)readAXWindowFrame {
    if (_observedWindow == NULL) return;
    CFTypeRef posVal = NULL;
    CFTypeRef sizeVal = NULL;
    if (AXUIElementCopyAttributeValue(_observedWindow, kAXPositionAttribute, &posVal) != kAXErrorSuccess || posVal == NULL) {
        return;
    }
    if (AXUIElementCopyAttributeValue(_observedWindow, kAXSizeAttribute, &sizeVal) != kAXErrorSuccess || sizeVal == NULL) {
        CFRelease(posVal);
        return;
    }
    CGPoint origin = CGPointZero;
    CGSize size = CGSizeZero;
    BOOL okPos = CFGetTypeID(posVal) == AXValueGetTypeID() && AXValueGetValue((AXValueRef)posVal, kAXValueCGPointType, &origin);
    BOOL okSize = CFGetTypeID(sizeVal) == AXValueGetTypeID() && AXValueGetValue((AXValueRef)sizeVal, kAXValueCGSizeType, &size);
    CFRelease(posVal);
    CFRelease(sizeVal);
    if (!okPos || !okSize || size.width <= 320.0 || size.height <= 240.0) return;

    CGRect frame = [self appKitFrameFromGlobalTopLeftRect:CGRectMake(origin.x, origin.y, size.width, size.height)];
    [self publishFrame:frame];
}

@end

static void KlausSettingsAXCallback(AXObserverRef observer,
                                    AXUIElementRef element,
                                    CFStringRef notification,
                                    void *refcon) {
    (void)observer;
    (void)element;
    (void)notification;
    if (refcon == NULL) return;
    KlausSettingsWindowTracker *tracker = (__bridge KlausSettingsWindowTracker *)refcon;
    dispatch_async(dispatch_get_main_queue(), ^{
        [tracker pollTick];
    });
}

// MARK: - Floating Guidance Panel

@interface KlausPermissionGuidePanel : NSPanel
@property (nonatomic, copy, nullable) void (^onKeepSettingsVisible)(void);
@property (nonatomic, copy, nullable) void (^onReopenSettings)(void);
@property (nonatomic, copy, nullable) void (^onCloseRequested)(void);
@property (nonatomic, copy, nullable) void (^onDragStateChanged)(BOOL dragging);

- (instancetype)initWithAppURL:(NSURL *)appURL
                     paneTitle:(NSString *)paneTitle
                        prefix:(NSString *)prefix
                        middle:(NSString *)middle
                        suffix:(NSString *)suffix
                     dragLabel:(NSString *)dragLabel;

- (void)updateWithAppURL:(NSURL *)appURL
               paneTitle:(NSString *)paneTitle
                  prefix:(NSString *)prefix
                  middle:(NSString *)middle
                  suffix:(NSString *)suffix
               dragLabel:(NSString *)dragLabel;

- (void)setSettingsFrontmost:(BOOL)frontmost;
- (void)setDraggingPassthrough:(BOOL)dragging;
- (void)showAtSourceRect:(CGRect)sourceRect;
- (void)presentFromSourceRect:(CGRect)sourceRect toSettingsFrame:(CGRect)settingsFrame;
- (void)snapToSettingsFrame:(CGRect)settingsFrame;
- (void)stopAnimation;
@end

@implementation KlausPermissionGuidePanel {
    NSVisualEffectView *_backdropView;
    KlausHeaderArrowView *_arrowView;
    NSTextField *_titleLabel;
    NSButton *_reopenButton;
    NSButton *_closeButton;
    KlausAppDragCardView *_dragCard;

    NSTimer *_launchTimer;
    CFTimeInterval _launchStartTime;
    CGRect _launchFromFrame;
    CGRect _launchToFrame;
    BOOL _isAnimatingLaunch;
}

- (instancetype)initWithAppURL:(NSURL *)appURL
                     paneTitle:(NSString *)paneTitle
                        prefix:(NSString *)prefix
                        middle:(NSString *)middle
                        suffix:(NSString *)suffix
                     dragLabel:(NSString *)dragLabel {
    NSRect initialRect = NSMakeRect(0.0, 0.0, kDefaultPanelWidth, kMinimumPanelHeight);
    self = [super initWithContentRect:initialRect
                            styleMask:(NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel)
                              backing:NSBackingStoreBuffered
                                defer:NO];
    if (self) {
        self.level = NSFloatingWindowLevel;
        self.releasedWhenClosed = NO;
        self.opaque = NO;
        self.backgroundColor = [NSColor clearColor];
        self.hasShadow = YES;
        self.collectionBehavior =
            NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
        self.movableByWindowBackground = NO;
        self.hidesOnDeactivate = NO;
        self.canHide = NO;
        self.animationBehavior = NSWindowAnimationBehaviorUtilityWindow;

        [self buildContentViewWithAppURL:appURL dragLabel:dragLabel];
        [self updateWithAppURL:appURL
                     paneTitle:paneTitle
                        prefix:prefix
                        middle:middle
                        suffix:suffix
                     dragLabel:dragLabel];
    }
    return self;
}

- (void)buildContentViewWithAppURL:(NSURL *)appURL dragLabel:(NSString *)dragLabel {
    _backdropView = [[NSVisualEffectView alloc] initWithFrame:NSZeroRect];
    _backdropView.translatesAutoresizingMaskIntoConstraints = YES;
    _backdropView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    _backdropView.material = NSVisualEffectMaterialPopover;
    _backdropView.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    _backdropView.state = NSVisualEffectStateActive;
    _backdropView.wantsLayer = YES;
    _backdropView.layer.cornerRadius = 18.0;
    _backdropView.layer.masksToBounds = YES;
    _backdropView.layer.borderWidth = 1.0;

    _arrowView = [[KlausHeaderArrowView alloc] initWithFrame:NSZeroRect];
    _arrowView.translatesAutoresizingMaskIntoConstraints = NO;

    _titleLabel = [NSTextField wrappingLabelWithString:@""];
    _titleLabel.translatesAutoresizingMaskIntoConstraints = NO;
    _titleLabel.maximumNumberOfLines = 3;
    _titleLabel.selectable = NO;
    [_titleLabel setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow
                                          forOrientation:NSLayoutConstraintOrientationHorizontal];

    _reopenButton = [self makeIconButtonWithSymbol:@"gearshape.fill"
                                          fallback:@"⚙"
                                            action:@selector(handleReopenClick:)];
    _reopenButton.hidden = YES;

    _closeButton = [self makeIconButtonWithSymbol:@"xmark.circle.fill"
                                         fallback:@"✕"
                                           action:@selector(handleCloseClick:)];

    NSStackView *controlsStack = [NSStackView stackViewWithViews:@[ _reopenButton, _closeButton ]];
    controlsStack.translatesAutoresizingMaskIntoConstraints = NO;
    controlsStack.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    controlsStack.spacing = 4.0;
    controlsStack.alignment = NSLayoutAttributeCenterY;
    [controlsStack setHuggingPriority:NSLayoutPriorityRequired forOrientation:NSLayoutConstraintOrientationHorizontal];

    _dragCard = [[KlausAppDragCardView alloc] initWithAppURL:appURL dragLabel:dragLabel];
    _dragCard.translatesAutoresizingMaskIntoConstraints = NO;
    __weak typeof(self) weakSelf = self;
    _dragCard.onDragStateChange = ^(BOOL dragging) {
        __strong typeof(weakSelf) strongSelf = weakSelf;
        if (strongSelf == nil) return;
        [strongSelf->_arrowView setDragging:dragging];
        [strongSelf setDraggingPassthrough:dragging];
        if (strongSelf.onDragStateChanged != nil) strongSelf.onDragStateChanged(dragging);
    };

    [_backdropView addSubview:_arrowView];
    [_backdropView addSubview:_titleLabel];
    [_backdropView addSubview:controlsStack];
    [_backdropView addSubview:_dragCard];

    [NSLayoutConstraint activateConstraints:@[
        [_arrowView.leadingAnchor constraintEqualToAnchor:_backdropView.leadingAnchor constant:12.0],
        [_arrowView.topAnchor constraintEqualToAnchor:_backdropView.topAnchor constant:11.0],
        [_arrowView.widthAnchor constraintEqualToConstant:20.0],
        [_arrowView.heightAnchor constraintEqualToConstant:20.0],

        [_titleLabel.leadingAnchor constraintEqualToAnchor:_arrowView.trailingAnchor constant:6.0],
        [_titleLabel.topAnchor constraintEqualToAnchor:_backdropView.topAnchor constant:11.0],
        [_titleLabel.trailingAnchor constraintLessThanOrEqualToAnchor:controlsStack.leadingAnchor constant:-8.0],

        [controlsStack.trailingAnchor constraintEqualToAnchor:_backdropView.trailingAnchor constant:-10.0],
        [controlsStack.topAnchor constraintEqualToAnchor:_backdropView.topAnchor constant:10.0],

        [_dragCard.leadingAnchor constraintEqualToAnchor:_backdropView.leadingAnchor constant:12.0],
        [_dragCard.trailingAnchor constraintEqualToAnchor:_backdropView.trailingAnchor constant:-12.0],
        [_dragCard.topAnchor constraintEqualToAnchor:_titleLabel.bottomAnchor constant:10.0],
        [_dragCard.bottomAnchor constraintEqualToAnchor:_backdropView.bottomAnchor constant:-12.0],
    ]];

    self.contentView = _backdropView;
    [self refreshBorderColor];
}

- (NSButton *)makeIconButtonWithSymbol:(NSString *)symbolName fallback:(NSString *)fallback action:(SEL)action {
    NSButton *button = [[NSButton alloc] initWithFrame:NSZeroRect];
    button.translatesAutoresizingMaskIntoConstraints = NO;
    button.bordered = NO;
    button.bezelStyle = NSBezelStyleShadowlessSquare;
    button.target = self;
    button.action = action;

    if (@available(macOS 11.0, *)) {
        NSImage *img = [NSImage imageWithSystemSymbolName:symbolName accessibilityDescription:nil];
        NSImageSymbolConfiguration *cfg =
            [NSImageSymbolConfiguration configurationWithPointSize:16.0 weight:NSFontWeightSemibold];
        button.image = [img imageWithSymbolConfiguration:cfg];
        button.contentTintColor = [NSColor secondaryLabelColor];
    } else {
        button.title = fallback;
        button.font = [NSFont systemFontOfSize:13.0 weight:NSFontWeightSemibold];
    }

    [NSLayoutConstraint activateConstraints:@[
        [button.widthAnchor constraintEqualToConstant:22.0],
        [button.heightAnchor constraintEqualToConstant:22.0],
    ]];
    return button;
}

- (void)refreshBorderColor {
    void (^apply)(void) = ^{
        _backdropView.layer.borderColor = [[NSColor labelColor] colorWithAlphaComponent:0.14].CGColor;
    };
    if (@available(macOS 11.0, *)) {
        [_backdropView.effectiveAppearance performAsCurrentDrawingAppearance:apply];
    } else {
        apply();
    }
}

- (void)updateWithAppURL:(NSURL *)appURL
               paneTitle:(NSString *)paneTitle
                  prefix:(NSString *)prefix
                  middle:(NSString *)middle
                  suffix:(NSString *)suffix
               dragLabel:(NSString *)dragLabel {
    NSString *appName = DisplayNameForAppURL(appURL);
    NSString *pane = paneTitle.length > 0 ? paneTitle : @"Permission";
    NSString *p = prefix != nil ? prefix : @"Drag ";
    NSString *m = middle != nil ? middle : @" to the list above to allow ";
    NSString *s = suffix != nil ? suffix : @"";

    NSFont *regularFont = [NSFont systemFontOfSize:13.5 weight:NSFontWeightRegular];
    NSFont *boldFont = [NSFont systemFontOfSize:13.5 weight:NSFontWeightSemibold];
    NSDictionary *regularAttrs = @{
        NSFontAttributeName: regularFont,
        NSForegroundColorAttributeName: [NSColor labelColor],
    };
    NSDictionary *boldAttrs = @{
        NSFontAttributeName: boldFont,
        NSForegroundColorAttributeName: [NSColor labelColor],
    };

    NSMutableAttributedString *attributed = [[NSMutableAttributedString alloc] init];
    if (p.length > 0) [attributed appendAttributedString:[[NSAttributedString alloc] initWithString:p attributes:regularAttrs]];
    [attributed appendAttributedString:[[NSAttributedString alloc] initWithString:appName attributes:boldAttrs]];
    if (m.length > 0) [attributed appendAttributedString:[[NSAttributedString alloc] initWithString:m attributes:regularAttrs]];
    [attributed appendAttributedString:[[NSAttributedString alloc] initWithString:pane attributes:boldAttrs]];
    if (s.length > 0) [attributed appendAttributedString:[[NSAttributedString alloc] initWithString:s attributes:regularAttrs]];

    _titleLabel.attributedStringValue = attributed;
    [_dragCard updateWithAppURL:appURL dragLabel:dragLabel];
    [self refreshBorderColor];
}

- (void)setSettingsFrontmost:(BOOL)frontmost {
    _reopenButton.hidden = frontmost;
}

- (void)setDraggingPassthrough:(BOOL)dragging {
    self.ignoresMouseEvents = dragging;
    self.alphaValue = dragging ? 0.72 : 1.0;
    if (dragging) {
        [self orderBack:nil];
    } else {
        [self orderFrontRegardless];
    }
}

- (BOOL)canBecomeKeyWindow {
    return NO;
}

- (BOOL)canBecomeMainWindow {
    return NO;
}

- (void)becomeKeyWindow {
    [super becomeKeyWindow];
    if (self.onKeepSettingsVisible != nil) self.onKeepSettingsVisible();
}

- (void)becomeMainWindow {
    [super becomeMainWindow];
    if (self.onKeepSettingsVisible != nil) self.onKeepSettingsVisible();
}

- (void)sendEvent:(NSEvent *)event {
    if (event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeRightMouseDown) {
        NSPoint closePt = [_closeButton convertPoint:event.locationInWindow fromView:nil];
        BOOL hitClose = NSPointInRect(closePt, _closeButton.bounds);
        if (!hitClose && self.onKeepSettingsVisible != nil) {
            self.onKeepSettingsVisible();
        }
    }
    [super sendEvent:event];
}

- (void)handleReopenClick:(id)sender {
    (void)sender;
    if (self.onReopenSettings != nil) self.onReopenSettings();
}

- (void)handleCloseClick:(id)sender {
    (void)sender;
    if (self.onCloseRequested != nil) self.onCloseRequested();
}

- (CGFloat)measuredHeightForWidth:(CGFloat)width {
    CGFloat labelMaxWidth = MAX(140.0, width - 12.0 - 20.0 - 6.0 - 8.0 - 50.0 - 10.0);
    _titleLabel.preferredMaxLayoutWidth = labelMaxWidth;
    [_backdropView setFrameSize:NSMakeSize(width, 400.0)];
    [_backdropView layoutSubtreeIfNeeded];
    CGSize fitting = [_backdropView fittingSize];
    return MAX(kMinimumPanelHeight, ceil(fitting.height));
}

- (CGRect)targetFrameForSettingsFrame:(CGRect)settingsFrame {
    NSScreen *matchingScreen = nil;
    for (NSScreen *screen in [NSScreen screens]) {
        if (CGRectIntersectsRect(screen.frame, settingsFrame)) {
            matchingScreen = screen;
            break;
        }
    }
    CGRect visibleFrame = matchingScreen != nil ? matchingScreen.visibleFrame : settingsFrame;
    BOOL hasSidebar = settingsFrame.size.width > kSettingsSidebarMinWindowWidth;
    CGFloat availableWidth = hasSidebar ? MAX(260.0, settingsFrame.size.width - kSettingsSidebarWidth)
                                        : MAX(260.0, settingsFrame.size.width);
    CGFloat width = MIN(availableWidth, MAX(240.0, visibleFrame.size.width - (kScreenInset * 2.0)));
    CGFloat height = [self measuredHeightForWidth:width];
    return ComputeTargetPanelFrame(settingsFrame, visibleFrame, height);
}

- (CGRect)launchSourceFrameForRect:(CGRect)sourceRect {
    CGFloat height = [self measuredHeightForWidth:kDefaultPanelWidth];
    CGFloat launchWidth = MAX(sourceRect.size.width, kDefaultPanelWidth * kLaunchMinimumScale);
    CGFloat launchHeight = MAX(sourceRect.size.height, height * kLaunchMinimumScale);
    CGPoint center = CGPointMake(CGRectGetMidX(sourceRect), CGRectGetMidY(sourceRect));
    return CGRectMake(
        center.x - (launchWidth * 0.5),
        center.y - (launchHeight * 0.5),
        launchWidth,
        launchHeight
    );
}

- (void)showAtSourceRect:(CGRect)sourceRect {
    [self stopAnimation];
    _isAnimatingLaunch = NO;
    self.alphaValue = 1.0;
    if (CGRectIsEmpty(sourceRect)) {
        CGFloat height = [self measuredHeightForWidth:kDefaultPanelWidth];
        [self setContentSize:NSMakeSize(kDefaultPanelWidth, height)];
        [self center];
    } else {
        [self setFrame:[self launchSourceFrameForRect:sourceRect] display:NO];
    }
    [self orderFrontRegardless];
}

- (void)presentFromSourceRect:(CGRect)sourceRect toSettingsFrame:(CGRect)settingsFrame {
    [self stopAnimation];
    CGRect target = [self targetFrameForSettingsFrame:settingsFrame];
    if (CGRectIsEmpty(sourceRect)) {
        _isAnimatingLaunch = NO;
        self.alphaValue = 1.0;
        [self setFrame:target display:YES];
        [self orderFrontRegardless];
        return;
    }

    _isAnimatingLaunch = YES;
    _launchFromFrame = [self launchSourceFrameForRect:sourceRect];
    _launchToFrame = target;
    _launchStartTime = CACurrentMediaTime();
    self.alphaValue = kLaunchInitialAlpha;
    [self setFrame:_launchFromFrame display:NO];
    [self orderFrontRegardless];
    [self stepLaunchAnimation];

    __weak typeof(self) weakSelf = self;
    _launchTimer = [NSTimer timerWithTimeInterval:(1.0 / 60.0) repeats:YES block:^(__unused NSTimer *timer) {
        [weakSelf stepLaunchAnimation];
    }];
    [[NSRunLoop mainRunLoop] addTimer:_launchTimer forMode:NSRunLoopCommonModes];
}

- (void)snapToSettingsFrame:(CGRect)settingsFrame {
    CGRect target = [self targetFrameForSettingsFrame:settingsFrame];
    if (_isAnimatingLaunch) {
        _launchToFrame = target;
        return;
    }
    [self stopAnimation];
    [self setFrame:target display:YES];
    [self orderFrontRegardless];
}

- (void)stopAnimation {
    [_launchTimer invalidate];
    _launchTimer = nil;
    _isAnimatingLaunch = NO;
}

- (void)stepLaunchAnimation {
    CFTimeInterval elapsed = MAX(0.0, CACurrentMediaTime() - _launchStartTime);
    if (elapsed >= kLaunchDuration) {
        [self stopAnimation];
        self.alphaValue = 1.0;
        [self setFrame:_launchToFrame display:YES];
        return;
    }
    double omega = (2.0 * M_PI) / kLaunchSpringResponse;
    double rawProgress = 1.0 - exp(-omega * elapsed) * (1.0 + (omega * elapsed));
    CGFloat progress = (CGFloat)fmin(fmax(rawProgress, 0.0), 1.0);
    self.alphaValue = kLaunchInitialAlpha + ((1.0 - kLaunchInitialAlpha) * progress);

    CGFloat width = _launchFromFrame.size.width + ((_launchToFrame.size.width - _launchFromFrame.size.width) * progress);
    CGFloat height = _launchFromFrame.size.height + ((_launchToFrame.size.height - _launchFromFrame.size.height) * progress);

    CGPoint startCenter = CGPointMake(CGRectGetMidX(_launchFromFrame), CGRectGetMidY(_launchFromFrame));
    CGPoint endCenter = CGPointMake(CGRectGetMidX(_launchToFrame), CGRectGetMidY(_launchToFrame));
    CGFloat distance = hypot(endCenter.x - startCenter.x, endCenter.y - startCenter.y);
    CGFloat lift = fmin(120.0, fmax(36.0, distance * 0.16));
    CGPoint control = CGPointMake((startCenter.x + endCenter.x) * 0.5, fmax(startCenter.y, endCenter.y) + lift);

    CGFloat inv = 1.0 - progress;
    CGFloat cx = (inv * inv * startCenter.x) + (2.0 * inv * progress * control.x) + (progress * progress * endCenter.x);
    CGFloat cy = (inv * inv * startCenter.y) + (2.0 * inv * progress * control.y) + (progress * progress * endCenter.y);

    CGRect frame = CGRectMake(cx - (width * 0.5), cy - (height * 0.5), width, height);
    [self setFrame:frame display:YES];
}

@end

// MARK: - Singleton Controller

@interface KlausPermissionGuideController : NSObject
+ (instancetype)sharedController;
- (BOOL)showWithAppURL:(NSURL *)appURL
             paneTitle:(NSString *)paneTitle
                prefix:(NSString *)prefix
                middle:(NSString *)middle
                suffix:(NSString *)suffix
             dragLabel:(NSString *)dragLabel
             reopenURL:(nullable NSURL *)reopenURL
            sourceRect:(CGRect)sourceRect
         hasSourceRect:(BOOL)hasSourceRect;
- (void)closeWithRestorePreviousApp:(BOOL)restorePreviousApp;
- (BOOL)isVisible;
@end

@implementation KlausPermissionGuideController {
    KlausPermissionGuidePanel *_panel;
    KlausSettingsWindowTracker *_tracker;
    NSURL *_reopenURL;
    pid_t _previousFrontmostPID;
    CGRect _pendingSourceRect;
    BOOL _hasPendingSourceRect;
    id _workspaceObserver;
}

+ (instancetype)sharedController {
    static KlausPermissionGuideController *shared = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        shared = [[KlausPermissionGuideController alloc] init];
    });
    return shared;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _tracker = [[KlausSettingsWindowTracker alloc] init];
        __weak typeof(self) weakSelf = self;
        _tracker.onFrameChange = ^(CGRect frame) {
            [weakSelf handleTrackedSettingsFrame:frame];
        };
        _tracker.onTrackingEnded = ^{
            [weakSelf closeWithRestorePreviousApp:NO];
        };

        _workspaceObserver = [[[NSWorkspace sharedWorkspace] notificationCenter]
            addObserverForName:NSWorkspaceDidActivateApplicationNotification
                        object:nil
                         queue:[NSOperationQueue mainQueue]
                    usingBlock:^(__unused NSNotification *note) {
                        [weakSelf updateSettingsFrontmostState];
                    }];
    }
    return self;
}

- (void)dealloc {
    if (_workspaceObserver != nil) {
        [[[NSWorkspace sharedWorkspace] notificationCenter] removeObserver:_workspaceObserver];
    }
}

- (BOOL)showWithAppURL:(NSURL *)appURL
             paneTitle:(NSString *)paneTitle
                prefix:(NSString *)prefix
                middle:(NSString *)middle
                suffix:(NSString *)suffix
             dragLabel:(NSString *)dragLabel
             reopenURL:(nullable NSURL *)reopenURL
            sourceRect:(CGRect)sourceRect
         hasSourceRect:(BOOL)hasSourceRect {
    [self rememberPreviousFrontmostApp];
    _reopenURL = reopenURL;

    if (hasSourceRect) {
        _pendingSourceRect = sourceRect;
        _hasPendingSourceRect = YES;
    } else {
        NSPoint mouse = [NSEvent mouseLocation];
        _pendingSourceRect = CGRectMake(mouse.x - 16.0, mouse.y - 16.0, 32.0, 32.0);
        _hasPendingSourceRect = YES;
    }

    if (_panel == nil) {
        _panel = [[KlausPermissionGuidePanel alloc] initWithAppURL:appURL
                                                         paneTitle:paneTitle
                                                            prefix:prefix
                                                            middle:middle
                                                            suffix:suffix
                                                         dragLabel:dragLabel];
        __weak typeof(self) weakSelf = self;
        _panel.onKeepSettingsVisible = ^{
            [weakSelf keepSettingsVisible];
        };
        _panel.onReopenSettings = ^{
            [weakSelf reopenSettings];
        };
        _panel.onCloseRequested = ^{
            [weakSelf closeWithRestorePreviousApp:YES];
        };
    } else {
        [_panel updateWithAppURL:appURL
                       paneTitle:paneTitle
                          prefix:prefix
                          middle:middle
                          suffix:suffix
                       dragLabel:dragLabel];
    }

    [self updateSettingsFrontmostState];

    if (_tracker.hasCurrentFrame) {
        [self presentPanelForSettingsFrame:_tracker.currentFrame];
    } else {
        [_panel showAtSourceRect:_hasPendingSourceRect ? _pendingSourceRect : CGRectZero];
    }

    [_tracker startTracking];
    return YES;
}

- (void)closeWithRestorePreviousApp:(BOOL)restorePreviousApp {
    [_tracker stopTracking];
    if (_panel != nil) {
        [_panel stopAnimation];
        [_panel close];
        _panel = nil;
    }
    _hasPendingSourceRect = NO;
    _pendingSourceRect = CGRectZero;
    _reopenURL = nil;

    if (restorePreviousApp && _previousFrontmostPID > 0) {
        pid_t pid = _previousFrontmostPID;
        _previousFrontmostPID = 0;
        NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
        ActivateApplication(app);
    } else {
        _previousFrontmostPID = 0;
    }
}

- (BOOL)isVisible {
    return _panel != nil && _panel.visible;
}

- (void)rememberPreviousFrontmostApp {
    NSRunningApplication *frontmost = [NSWorkspace sharedWorkspace].frontmostApplication;
    if (frontmost == nil) return;
    if ([frontmost.bundleIdentifier isEqualToString:kSystemSettingsBundleId]) return;
    _previousFrontmostPID = frontmost.processIdentifier;
}

- (void)keepSettingsVisible {
    ActivateSystemSettings();
    [_panel orderFrontRegardless];
}

- (void)reopenSettings {
    if (_reopenURL != nil) {
        [[NSWorkspace sharedWorkspace] openURL:_reopenURL];
    }
    ActivateSystemSettings();
    [_panel orderFrontRegardless];
}

- (void)updateSettingsFrontmostState {
    if (_panel == nil) return;
    NSString *frontBundleId = [NSWorkspace sharedWorkspace].frontmostApplication.bundleIdentifier;
    BOOL settingsFrontmost = [frontBundleId isEqualToString:kSystemSettingsBundleId];
    [_panel setSettingsFrontmost:settingsFrontmost];
}

- (void)handleTrackedSettingsFrame:(CGRect)frame {
    [self presentPanelForSettingsFrame:frame];
}

- (void)presentPanelForSettingsFrame:(CGRect)settingsFrame {
    if (_panel == nil) return;
    if (_hasPendingSourceRect) {
        CGRect source = _pendingSourceRect;
        _hasPendingSourceRect = NO;
        [_panel presentFromSourceRect:source toSettingsFrame:settingsFrame];
    } else {
        [_panel snapToSettingsFrame:settingsFrame];
    }
}

@end

// MARK: - C Exports

bool klaus_permission_guide_show(const KlausPermissionGuideConfig *config) {
    if (config == NULL) return false;
    @autoreleasepool {
        NSString *paneTitle = StringOrNil(config->pane_title);
        NSString *prefix = StringOrNil(config->instruction_prefix);
        NSString *middle = StringOrNil(config->instruction_middle);
        NSString *suffix = StringOrNil(config->instruction_suffix);
        NSString *dragLabel = StringOrNil(config->drag_label);
        NSString *reopenURLString = StringOrNil(config->reopen_url);
        NSString *appPath = StringOrNil(config->app_path);

        NSURL *appURL = ResolveAppBundleURL(appPath);
        if (appURL == nil) return false;

        NSURL *reopenURL = reopenURLString.length > 0 ? [NSURL URLWithString:reopenURLString] : nil;
        CGRect sourceRect = config->has_source_rect
            ? CGRectMake(config->source_x, config->source_y, config->source_w, config->source_h)
            : CGRectZero;
        BOOL hasSourceRect = config->has_source_rect ? YES : NO;

        void (^run)(void) = ^{
            [[KlausPermissionGuideController sharedController] showWithAppURL:appURL
                                                                    paneTitle:paneTitle
                                                                       prefix:prefix
                                                                       middle:middle
                                                                       suffix:suffix
                                                                    dragLabel:dragLabel
                                                                    reopenURL:reopenURL
                                                                   sourceRect:sourceRect
                                                                hasSourceRect:hasSourceRect];
        };

        if ([NSThread isMainThread]) {
            run();
        } else {
            dispatch_async(dispatch_get_main_queue(), run);
        }
        return true;
    }
}

void klaus_permission_guide_close(bool restore_previous_app) {
    @autoreleasepool {
        BOOL restore = restore_previous_app ? YES : NO;
        void (^run)(void) = ^{
            [[KlausPermissionGuideController sharedController] closeWithRestorePreviousApp:restore];
        };
        if ([NSThread isMainThread]) {
            run();
        } else {
            dispatch_async(dispatch_get_main_queue(), run);
        }
    }
}

bool klaus_permission_guide_is_visible(void) {
    @autoreleasepool {
        if (![NSThread isMainThread]) return false;
        return [[KlausPermissionGuideController sharedController] isVisible] ? true : false;
    }
}

#ifdef KLAUS_PERMISSIONS_TESTING
CGRect klaus_permission_guide_target_frame(CGRect settings_frame, CGRect screen_visible_frame, double measured_height) {
    return ComputeTargetPanelFrame(settings_frame, screen_visible_frame, (CGFloat)measured_height);
}

CGRect klaus_permission_guide_convert_cg_rect(CGRect cg_rect, CGRect screen_frame, CGRect screen_cg_bounds) {
    return ConvertCGToAppKitRect(cg_rect, screen_frame, screen_cg_bounds);
}
#endif
