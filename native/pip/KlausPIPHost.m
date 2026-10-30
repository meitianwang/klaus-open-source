#import "KlausPIP.h"
#import <ApplicationServices/ApplicationServices.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <signal.h>
#import <dlfcn.h>
#import <errno.h>
#import <fcntl.h>
#import <sys/stat.h>
#import <unistd.h>

@class KlausPIPHost;

@protocol KlausPIPNativeFilter
+ (id)filterWithName:(NSString *)name;
@end
@interface CALayer (KlausPIPBackdrop)
- (void)setGroupName:(NSString *)name;
- (void)setScale:(double)scale;
- (void)setWindowServerAware:(BOOL)aware;
- (void)setAllowsInPlaceFiltering:(BOOL)allowed;
- (void)setCaptureOnly:(BOOL)captureOnly;
@end

static id KlausPIPFilter(NSString *name, NSDictionary *parameters) {
    Class filterClass = NSClassFromString(@"CAFilter");
    if (![filterClass respondsToSelector:@selector(filterWithName:)]) return nil;
    id filter = [(id<KlausPIPNativeFilter>)filterClass filterWithName:name];
    @try { for (NSString *key in parameters) [filter setValue:parameters[key] forKey:key]; }
    @catch (NSException *exception) { (void)exception; return nil; }
    return filter;
}

static CALayer *KlausPIPBackdrop(void) {
    CALayer *layer = [NSClassFromString(@"CABackdropLayer") new];
    if ([layer respondsToSelector:@selector(setGroupName:)]) [layer setGroupName:NSUUID.UUID.UUIDString];
    if ([layer respondsToSelector:@selector(setScale:)]) [layer setScale:1];
    if ([layer respondsToSelector:@selector(setWindowServerAware:)]) [layer setWindowServerAware:YES];
    if ([layer respondsToSelector:@selector(setAllowsInPlaceFiltering:)]) [layer setAllowsInPlaceFiltering:NO];
    if ([layer respondsToSelector:@selector(setCaptureOnly:)]) [layer setCaptureOnly:NO];
    return layer;
}

API_AVAILABLE(macos(14.0))
@interface KlausPIPPanel : NSPanel
@end
@implementation KlausPIPPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

API_AVAILABLE(macos(14.0))
@interface KlausPIPItem : NSObject
@property(nonatomic, copy) NSDictionary *metadata;
@property(nonatomic) CALayer *positionLayer;
@property(nonatomic) CALayer *appearanceLayer;
@property(nonatomic) CALayer *contentLayer;
@property(nonatomic) CALayer *completionLayer;
@property(nonatomic) CALayer *completionIcon;
@property(nonatomic) CALayer *completionIconDim;
@property(nonatomic) CALayer *completionBadge;
@property(nonatomic) CALayer *completionCheck;
@property(nonatomic) CGSize sourceSize;
@property(nonatomic) CGRect frame;
@property(nonatomic) CGPoint velocity;
@property(nonatomic) CGPoint target;
@property(nonatomic) BOOL initialized;
@property(nonatomic) BOOL exiting;
@property(nonatomic) BOOL completed;
@property(nonatomic) NSUInteger generation;
- (void)appear:(BOOL)exiting;
@end

API_AVAILABLE(macos(14.0))
@interface KlausPIPInteractionView : NSView
@property(nonatomic, weak) KlausPIPHost *host;
@property(nonatomic) NSTrackingArea *mouseTracking;
@end

API_AVAILABLE(macos(14.0))
@interface KlausPIPHost : NSObject <KlausPIPHostProtocol>
@property(nonatomic, weak) NSWindow *owner;
@property(nonatomic) KlausPIPPanel *panel;
@property(nonatomic) KlausPIPPanel *controlPanel;
@property(nonatomic) KlausPIPInteractionView *interactionView;
@property(nonatomic) NSMutableDictionary<NSString *, KlausPIPItem *> *items;
@property(nonatomic) NSMutableArray<NSString *> *order;
@property(nonatomic) NSMutableDictionary<NSString *, NSDictionary *> *sources;
@property(nonatomic) NSDictionary *layout;
@property(nonatomic) NSDictionary *preferences;
@property(nonatomic) NSMutableArray<NSDictionary *> *pendingCommands;
@property(nonatomic) NSTask *serviceTask;
@property(nonatomic) NSMutableSet<NSTask *> *ownedTasks;
@property(nonatomic, copy) NSString *helperPath;
@property(nonatomic, copy) NSString *diagnosticPath;
@property(nonatomic) uint64_t generation;
@property(nonatomic) NSUInteger pendingLookups;
@property(nonatomic) BOOL commandInFlight;
@property(nonatomic) NSUInteger commandTicket;
@property(nonatomic) NSXPCConnection *connection;
@property(nonatomic) NSPipe *serviceOutput;
@property(nonatomic) NSMutableData *bootstrapData;
@property(nonatomic) NSUInteger serviceGeneration;
@property(nonatomic) NSUInteger reconnectAttempts;
@property(nonatomic) BOOL stopped;
@property(nonatomic) KlausPIPEventCallback event;
@property(nonatomic) CGFloat maxDisplaySize;
@property(nonatomic, copy) NSString *anchor;
@property(nonatomic) BOOL floating;
@property(nonatomic) CGRect envelope;
@property(nonatomic) NSRect hideFrame;
@property(nonatomic) NSRect placementFrame;
@property(nonatomic) CALayer *controls;
@property(nonatomic) CALayer *fogBackdrop;
@property(nonatomic) CALayer *fogMaskSource;
@property(nonatomic) CALayer *fogShadowBackdrop;
@property(nonatomic) CALayer *fogShadowMaskSource;
@property(nonatomic) CATextLayer *hideLabel;
@property(nonatomic) CALayer *placementIcon;
@property(nonatomic) id globalMonitor;
@property(nonatomic) id localMonitor;
@property(nonatomic) NSMutableArray *observers;
@property(nonatomic) NSTimer *motionTimer;
@property(nonatomic) CFTimeInterval lastMotionTime;
@property(nonatomic, copy) NSString *pressedID;
@property(nonatomic, copy) NSString *pressedControl;
@property(nonatomic) CGPoint initialPointer;
@property(nonatomic) CGPoint lastPointer;
@property(nonatomic) CGPoint dragOrigin;
@property(nonatomic) CGFloat initialSize;
@property(nonatomic) BOOL resizing;
@property(nonatomic) BOOL dragging;
@property(nonatomic) BOOL menuOpen;
@property(nonatomic, copy) NSArray<NSString *> *lastActiveTaskIDs;
- (void)handle:(NSDictionary *)command;
- (BOOL)relayout:(BOOL)animated;
- (void)emit:(NSDictionary *)event;
- (void)hover;
- (void)hoverAtPoint:(CGPoint)point;
- (CGPoint)contentPointForEvent:(NSEvent *)event;
- (NSString *)itemAtPoint:(CGPoint)point;
- (void)mouseDown:(NSEvent *)event;
- (void)mouseDragged:(NSEvent *)event;
- (void)mouseUp:(NSEvent *)event;
- (BOOL)resizeAtPoint:(CGPoint)point;
- (void)shutdown;
- (int)pending:(BOOL)force;
- (void)flushCommands;
@end

static NSRect KlausPIPRect(NSDictionary *value) {
    if (![value isKindOfClass:NSDictionary.class]) return NSZeroRect;
    return NSMakeRect([value[@"x"] doubleValue], [value[@"y"] doubleValue],
                      [value[@"width"] doubleValue], [value[@"height"] doubleValue]);
}

static BOOL KlausPIPValidFrame(CGRect frame) {
    return !CGRectIsNull(frame) && !CGRectIsInfinite(frame) &&
        isfinite(frame.origin.x) && isfinite(frame.origin.y) &&
        isfinite(frame.size.width) && isfinite(frame.size.height) &&
        isfinite(CGRectGetMaxX(frame)) && isfinite(CGRectGetMaxY(frame)) &&
        frame.size.width > 0 && frame.size.height > 0;
}

static NSString *KlausPIPDiagnosticString(id value, NSUInteger limit) {
    NSString *text = [value isKindOfClass:NSString.class] ? value : @"";
    return text.length > limit ? [text substringToIndex:limit] : text;
}

static void KlausPIPAppendDiagnostic(NSString *path, NSDictionary *entry) {
    if (!path.length) return;
    @try {
        NSData *json = [NSJSONSerialization dataWithJSONObject:entry options:0 error:nil];
        if (!json || json.length > 32 * 1024) return;
        NSMutableData *line = [json mutableCopy];
        const char newline = '\n';
        [line appendBytes:&newline length:1];
        int fd = open(path.fileSystemRepresentation, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC | O_NOFOLLOW, 0600);
        if (fd < 0) { NSLog(@"[pip] diagnostic open failed: %d", errno); return; }
        struct stat info;
        if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != geteuid() || info.st_nlink != 1) {
            close(fd); return;
        }
        if (fchmod(fd, 0600) != 0) { close(fd); return; }
        if (info.st_size > 4 * 1024 * 1024 && ftruncate(fd, 0) != 0) { close(fd); return; }
        const unsigned char *bytes = line.bytes;
        NSUInteger offset = 0;
        while (offset < line.length) {
            ssize_t count = write(fd, bytes + offset, line.length - offset);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) break;
            offset += (NSUInteger)count;
        }
        if (offset != line.length || fsync(fd) != 0) NSLog(@"[pip] diagnostic write failed: %d", errno);
        close(fd);
    } @catch (NSException *exception) {
        NSLog(@"[pip] diagnostic serialization failed: %@: %@", exception.name, exception.reason);
    }
}

static NSImage *KlausPIPImage(NSString *dataURL) {
    if (![dataURL hasPrefix:@"data:image/"] || dataURL.length > 32 * 1024 * 1024) return nil;
    NSRange separator = [dataURL rangeOfString:@";base64,"];
    if (separator.location == NSNotFound) return nil;
    NSData *data = [[NSData alloc] initWithBase64EncodedString:[dataURL substringFromIndex:NSMaxRange(separator)] options:0];
    if (!data) return nil;
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
    if (!source) return nil;
    NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
    double width = [properties[(__bridge NSString *)kCGImagePropertyPixelWidth] doubleValue];
    double height = [properties[(__bridge NSString *)kCGImagePropertyPixelHeight] doubleValue];
    BOOL valid = isfinite(width) && isfinite(height) && width > 0 && height > 0 &&
        width <= 8192 && height <= 8192 && width * height <= 16 * 1024 * 1024;
    CGImageRef image = valid ? CGImageSourceCreateImageAtIndex(source, 0, NULL) : NULL;
    CFRelease(source);
    NSImage *result = image ? [[NSImage alloc] initWithCGImage:image size:NSZeroSize] : nil;
    if (image) CGImageRelease(image);
    return result;
}

static CGImageRef KlausPIPCGImage(NSImage *image) {
    return [image CGImageForProposedRect:NULL context:nil hints:nil];
}

static void KlausPIPAnimatePosition(CALayer *layer, CGPoint target, double stiffness, double damping) {
    CGPoint from = layer.presentationLayer ? layer.presentationLayer.position : layer.position;
    layer.position = target;
    CASpringAnimation *animation = [CASpringAnimation animationWithKeyPath:@"position"];
    animation.mass = 1; animation.stiffness = stiffness; animation.damping = damping;
    animation.fromValue = [NSValue valueWithPoint:from];
    animation.toValue = [NSValue valueWithPoint:target];
    animation.duration = animation.settlingDuration;
    [layer addAnimation:animation forKey:@"klaus-pip-position"];
}

static void KlausPIPCompletionSpring(CALayer *layer, NSString *key, id from, id to) {
    CASpringAnimation *animation = [CASpringAnimation animationWithKeyPath:key];
    animation.mass = 1; animation.stiffness = 170; animation.damping = 18;
    animation.fromValue = from; animation.toValue = to;
    animation.duration = animation.settlingDuration;
    [layer addAnimation:animation forKey:[@"klaus-pip-completion-" stringByAppendingString:key]];
}

@implementation KlausPIPItem
- (instancetype)init {
    self = [super init];
    if (self) {
        _positionLayer = [CALayer layer];
        _appearanceLayer = [CALayer layer];
        _positionLayer.anchorPoint = CGPointZero;
        _appearanceLayer.anchorPoint = CGPointZero;
        _appearanceLayer.shadowColor = NSColor.blackColor.CGColor;
        _appearanceLayer.shadowOpacity = 0.16;
        _appearanceLayer.shadowRadius = 10;
        _appearanceLayer.shadowOffset = CGSizeMake(0, -6);
        [_positionLayer addSublayer:_appearanceLayer];
    }
    return self;
}
- (void)appear:(BOOL)exiting {
    CGFloat start = exiting ? 1 : 0.72;
    CGFloat finish = exiting ? 0.72 : 1;
    CASpringAnimation *scale = [CASpringAnimation animationWithKeyPath:@"transform.scale"];
    scale.mass = 1; scale.stiffness = 185; scale.damping = 18;
    scale.fromValue = @(start); scale.toValue = @(finish);
    scale.duration = scale.settlingDuration;
    CABasicAnimation *opacity = [CABasicAnimation animationWithKeyPath:@"opacity"];
    opacity.fromValue = @(exiting ? 1 : 0); opacity.toValue = @(exiting ? 0 : 1);
    opacity.duration = exiting ? 0.22 : 0.20;
    opacity.timingFunction = [CAMediaTimingFunction functionWithName:exiting ? kCAMediaTimingFunctionEaseIn : kCAMediaTimingFunctionEaseOut];
    CIFilter *blur = [CIFilter filterWithName:@"CIGaussianBlur"];
    blur.name = @"klausPIPAppearanceBlur";
    [blur setValue:@(exiting ? 18 : 0) forKey:kCIInputRadiusKey];
    self.appearanceLayer.filters = @[blur];
    CABasicAnimation *blurAnimation = [CABasicAnimation animationWithKeyPath:@"filters.klausPIPAppearanceBlur.inputRadius"];
    blurAnimation.fromValue = @(exiting ? 0 : 18); blurAnimation.toValue = @(exiting ? 18 : 0);
    blurAnimation.duration = exiting ? 0.24 : 0.28;
    CAAnimationGroup *group = [CAAnimationGroup animation];
    group.animations = @[scale, opacity, blurAnimation];
    group.duration = fmax(scale.settlingDuration, blurAnimation.duration);
    self.appearanceLayer.opacity = exiting ? 0 : 1;
    self.appearanceLayer.transform = CATransform3DMakeScale(finish, finish, 1);
    [self.appearanceLayer addAnimation:group forKey:@"klaus-pip-appearance"];
}
@end

@implementation KlausPIPInteractionView
- (BOOL)isOpaque { return NO; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { (void)event; return YES; }
- (void)updateTrackingAreas {
    [super updateTrackingAreas];
    if (self.mouseTracking) [self removeTrackingArea:self.mouseTracking];
    self.mouseTracking = [[NSTrackingArea alloc] initWithRect:NSZeroRect
        options:NSTrackingMouseEnteredAndExited | NSTrackingMouseMoved | NSTrackingActiveAlways | NSTrackingInVisibleRect
        owner:self userInfo:nil];
    [self addTrackingArea:self.mouseTracking];
}
- (NSView *)hitTest:(NSPoint)point {
    if ([self.host itemAtPoint:point] || [self.host resizeAtPoint:point] ||
        NSPointInRect(point, self.host.hideFrame) || NSPointInRect(point, self.host.placementFrame)) return self;
    return nil;
}
- (void)mouseDown:(NSEvent *)event { [self.host mouseDown:event]; }
- (void)mouseDragged:(NSEvent *)event { [self.host mouseDragged:event]; }
- (void)mouseUp:(NSEvent *)event { [self.host mouseUp:event]; }
- (void)mouseMoved:(NSEvent *)event { [self.host hoverAtPoint:[self.host contentPointForEvent:event]]; }
- (void)mouseEntered:(NSEvent *)event { [self mouseMoved:event]; }
- (void)mouseExited:(NSEvent *)event { [self mouseMoved:event]; }
- (void)rightMouseDown:(NSEvent *)event { (void)event; [self.host performSelector:@selector(showHideMenu)]; }
- (void)resetCursorRects {
    for (NSString *identifier in self.host.order) {
        KlausPIPItem *item = self.host.items[identifier];
        if (!item.positionLayer.hidden && !item.exiting) [self addCursorRect:item.frame cursor:NSCursor.openHandCursor];
    }
}
@end

@implementation KlausPIPHost
- (instancetype)init {
    self = [super init];
    if (self) {
        _items = [NSMutableDictionary dictionary]; _sources = [NSMutableDictionary dictionary];
        _order = [NSMutableArray array]; _pendingCommands = [NSMutableArray array];
        _ownedTasks = [NSMutableSet set];
        _bootstrapData = [NSMutableData data]; _observers = [NSMutableArray array];
        _maxDisplaySize = 200; _anchor = @"bottom-right"; _preferences = @{};
    }
    return self;
}
- (void)emit:(NSDictionary *)event {
    if (!self.event || self.stopped) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    NSString *json = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
    if (json) self.event(self.generation, json.UTF8String);
}
- (NSString *)label:(NSString *)name fallback:(NSString *)fallback {
    NSString *label = KlausPIPString(self.preferences[@"labels"][name]);
    return label.length ? label : fallback;
}
- (void)updateState {
    NSMutableSet *active = [NSMutableSet set];
    for (KlausPIPItem *item in self.items.allValues) if (!item.exiting && !item.completed) {
        NSString *session = KlausPIPString(item.metadata[@"sessionId"]);
        if (session.length) [active addObject:session];
    }
    NSArray *ids = [active.allObjects sortedArrayUsingSelector:@selector(compare:)];
    if (![ids isEqual:self.lastActiveTaskIDs]) {
        self.lastActiveTaskIDs = ids;
        [self emit:@{@"type": @"state", @"activeTaskIds": ids}];
    }
}
- (void)ensurePanels {
    if (self.panel) return;
    NSWindowStyleMask style = NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel;
    self.panel = [[KlausPIPPanel alloc] initWithContentRect:NSMakeRect(0, 0, 1, 1) styleMask:style backing:NSBackingStoreBuffered defer:NO];
    self.controlPanel = [[KlausPIPPanel alloc] initWithContentRect:NSMakeRect(0, 0, 1, 1) styleMask:style backing:NSBackingStoreBuffered defer:NO];
    for (KlausPIPPanel *panel in @[self.panel, self.controlPanel]) {
        panel.opaque = NO; panel.backgroundColor = NSColor.clearColor; panel.hasShadow = NO;
        panel.hidesOnDeactivate = NO; panel.releasedWhenClosed = NO;
        panel.collectionBehavior = NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorTransient;
        panel.acceptsMouseMovedEvents = YES;
    }
    // Both native surfaces route their painted regions to the same controller.
    // A transparent controls window cannot receive clicks for pixels painted
    // exclusively in the content window below it.
    KlausPIPInteractionView *contentView = [[KlausPIPInteractionView alloc] initWithFrame:NSMakeRect(0, 0, 1, 1)];
    contentView.host = self; contentView.wantsLayer = YES;
    self.panel.contentView = contentView;
    self.interactionView = [[KlausPIPInteractionView alloc] initWithFrame:NSMakeRect(0, 0, 1, 1)];
    self.interactionView.host = self;
    self.interactionView.wantsLayer = YES;
    self.controlPanel.contentView = self.interactionView;
    self.controls = [CALayer layer];
    self.controls.opacity = 0;
    [self.interactionView.layer addSublayer:self.controls];
    [self createControlFog];
    self.hideLabel = [CATextLayer layer];
    self.hideLabel.alignmentMode = kCAAlignmentCenter;
    self.hideLabel.fontSize = 12;
    self.hideLabel.contentsScale = self.owner.backingScaleFactor ?: 2;
    NSFont *font = [NSFont systemFontOfSize:12 weight:NSFontWeightSemibold];
    self.hideLabel.font = (__bridge CFTypeRef)font;
    [self.controls addSublayer:self.hideLabel];
    self.placementIcon = [CALayer layer];
    self.placementIcon.contentsGravity = kCAGravityResizeAspect;
    [self.controls addSublayer:self.placementIcon];
    __weak KlausPIPHost *weakSelf = self;
    self.globalMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskMouseMoved | NSEventMaskLeftMouseDragged handler:^(NSEvent *event) {
        (void)event; [weakSelf hover];
    }];
    self.localMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskMouseMoved | NSEventMaskLeftMouseDragged handler:^NSEvent *(NSEvent *event) {
        [weakSelf hover]; return event;
    }];
    for (NSNotificationName name in @[NSWindowDidMoveNotification, NSWindowDidResizeNotification,
        NSWindowDidMiniaturizeNotification, NSWindowDidDeminiaturizeNotification, NSWindowDidChangeScreenNotification,
        NSWindowDidChangeBackingPropertiesNotification, NSWindowWillCloseNotification]) {
        id observer = [NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            KlausPIPHost *host = weakSelf;
            if (!host || note.object != host.owner) return;
            if ([note.name isEqualToString:NSWindowWillCloseNotification]) {
                [host emit:@{@"type": @"ownerClosed"}]; [host shutdown]; host.owner = nil;
            } else [host relayout:NO];
        }];
        [self.observers addObject:observer];
    }
}
- (void)createControlFog {
    self.fogBackdrop = KlausPIPBackdrop();
    self.fogMaskSource = [CALayer layer];
    self.fogMaskSource.backgroundColor = NSColor.blackColor.CGColor;
    id maskBlur = KlausPIPFilter(@"gaussianBlur", @{@"inputRadius": @14});
    if (maskBlur) self.fogMaskSource.filters = @[maskBlur];
    id blur = nil;
    if (@available(macOS 26.0, *)) {
        self.fogMaskSource.name = [@"klaus-pip-control-mask-" stringByAppendingString:NSUUID.UUID.UUIDString];
        blur = KlausPIPFilter(@"variableBlur", @{@"inputRadius": @6, @"inputFade": @YES,
            @"inputNormalizeEdges": @YES, @"inputSourceSublayerName": self.fogMaskSource.name});
        [self.fogBackdrop addSublayer:self.fogMaskSource];
    } else {
        blur = KlausPIPFilter(@"gaussianBlur", @{@"inputRadius": @6, @"inputNormalizeEdges": @YES});
        self.fogBackdrop.mask = [CALayer layer];
        [self.fogBackdrop.mask addSublayer:self.fogMaskSource];
    }
    if (blur && self.fogBackdrop) {
        self.fogBackdrop.filters = @[blur];
        [self.controls addSublayer:self.fogBackdrop];
    }
    id curve = KlausPIPFilter(@"luminanceCurveMap", @{@"inputValues": @[@0, @(-1.75), @0.09, @2.4], @"inputAmount": @1});
    id alpha = KlausPIPFilter(@"luminanceToAlpha", @{@"inputPremultipliedValues": @NO});
    self.fogShadowBackdrop = KlausPIPBackdrop();
    if (curve && alpha && self.fogShadowBackdrop) {
        self.fogShadowBackdrop.filters = @[curve, alpha];
        self.fogShadowBackdrop.opacity = .12;
        self.fogShadowBackdrop.mask = [CALayer layer];
        self.fogShadowMaskSource = [CALayer layer];
        self.fogShadowMaskSource.backgroundColor = NSColor.blackColor.CGColor;
        id shadowBlur = KlausPIPFilter(@"gaussianBlur", @{@"inputRadius": @14});
        if (shadowBlur) self.fogShadowMaskSource.filters = @[shadowBlur];
        [self.fogShadowBackdrop.mask addSublayer:self.fogShadowMaskSource];
        [self.controls addSublayer:self.fogShadowBackdrop];
    }
}
- (void)closePipe:(NSPipe *)pipe {
    NSFileHandle *handle = pipe.fileHandleForReading;
    handle.readabilityHandler = nil;
    @try { [handle closeFile]; } @catch (NSException *exception) { (void)exception; }
}
- (void)connectService {
    if (self.connection || self.serviceTask.running || self.stopped) return;
    [self pending:NO];
    if (self.ownedTasks.count >= 4 || self.pendingLookups >= 4) {
        [self emit:@{@"type": @"error", @"message": @"The previous preview producer has not exited."}];
        return;
    }
    self.serviceGeneration++;
    NSUInteger generation = self.serviceGeneration;
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:self.helperPath];
    task.arguments = @[];
    NSPipe *output = [NSPipe pipe], *diagnostics = [NSPipe pipe];
    self.serviceOutput = output; task.standardOutput = output;
    task.standardError = diagnostics;
    task.standardInput = NSFileHandle.fileHandleWithNullDevice;
    self.serviceTask = task; self.bootstrapData = [NSMutableData data];
    [self.ownedTasks addObject:task];
    __weak KlausPIPHost *weakSelf = self;
    diagnostics.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
        // Drain the pipe without queuing arbitrary diagnostics on the UI thread.
        NSData *data = nil;
        @try { data = handle.availableData; } @catch (NSException *exception) { (void)exception; return; }
        if (!data.length) { handle.readabilityHandler = nil; [handle closeFile]; }
    };
    output.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
        NSData *data = nil;
        @try { data = handle.availableData; } @catch (NSException *exception) { (void)exception; return; }
        if (!data.length) { handle.readabilityHandler = nil; [handle closeFile]; return; }
        dispatch_async(dispatch_get_main_queue(), ^{
            KlausPIPHost *host = weakSelf;
            if (!host || host.stopped || host.serviceGeneration != generation) {
                handle.readabilityHandler = nil; [handle closeFile]; return;
            }
            [host.bootstrapData appendData:data];
            if (host.bootstrapData.length > 4096) {
                [host emit:@{@"type": @"error", @"message": @"The preview producer returned an invalid endpoint."}];
                [host serviceDisconnected:generation]; return;
            }
            NSString *line = [[NSString alloc] initWithData:host.bootstrapData encoding:NSUTF8StringEncoding];
            NSRange newline = [line rangeOfString:@"\n"];
            if (!line || newline.location == NSNotFound) return;
            handle.readabilityHandler = nil; [handle closeFile];
            NSString *name = [line substringToIndex:newline.location];
            if (![name hasPrefix:@"com.klaus.pip."] || name.length > 128) {
                [host serviceDisconnected:generation]; return;
            }
            host.pendingLookups++;
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                NSXPCListenerEndpoint *endpoint = KlausPIPLookupEndpoint(name);
                dispatch_async(dispatch_get_main_queue(), ^{
                    KlausPIPHost *current = weakSelf;
                    if (current) current.pendingLookups--;
                    if (!current || current.stopped || current.serviceGeneration != generation) return;
                    if (!endpoint) { [current serviceDisconnected:generation]; return; }
                    NSXPCConnection *connection = [[NSXPCConnection alloc] initWithListenerEndpoint:endpoint];
                    current.connection = connection;
                    connection.exportedInterface = KlausPIPHostInterface(); connection.exportedObject = current;
                    connection.remoteObjectInterface = [NSXPCInterface interfaceWithProtocol:@protocol(KlausPIPProducerProtocol)];
                    connection.invalidationHandler = ^{
                        dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf serviceDisconnected:generation]; });
                    };
                    connection.interruptionHandler = connection.invalidationHandler;
                    [connection resume];
                    [current.pendingCommands insertObject:@{@"type": @"preferences", @"maxDisplaySize": @(current.maxDisplaySize)} atIndex:0];
                    [current flushCommands];
                });
            });
        });
    };
    task.terminationHandler = ^(NSTask *terminated) {
        dispatch_async(dispatch_get_main_queue(), ^{
            KlausPIPHost *host = weakSelf;
            [host closePipe:output]; [host closePipe:diagnostics];
            [host.ownedTasks removeObject:terminated];
            [host serviceDisconnected:generation];
        });
    };
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        [self closePipe:output]; [self closePipe:diagnostics];
        [self.ownedTasks removeObject:task]; self.serviceTask = nil;
        [self emit:@{@"type": @"error", @"message": error.localizedDescription ?: @"The preview producer could not start."}];
        [self serviceDisconnected:generation];
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        KlausPIPHost *host = weakSelf;
        if (host && host.serviceGeneration == generation && !host.connection && task.running) {
            [host emit:@{@"type": @"error", @"message": @"The preview producer connection timed out."}];
            [host serviceDisconnected:generation];
        }
    });
}
- (void)serviceDisconnected:(NSUInteger)generation {
    if (self.stopped || self.serviceGeneration != generation) return;
    self.serviceGeneration++; self.commandInFlight = NO; self.commandTicket++;
    [self closePipe:self.serviceOutput]; self.serviceOutput = nil;
    [self.connection invalidate]; self.connection = nil;
    if (self.serviceTask.running) [self.serviceTask terminate]; self.serviceTask = nil;
    for (NSString *identifier in self.items.allKeys) {
        if (self.items[identifier].completed) [self.sources removeObjectForKey:identifier];
        if (self.items[identifier].metadata[@"contextId"]) [self discard:identifier notifyProducer:NO animated:NO];
    }
    [self.pendingCommands removeAllObjects];
    [self emit:@{@"type": @"error", @"message": @"The native Computer Use preview connection was interrupted."}];
    if (self.sources.count && self.reconnectAttempts < 3) {
        NSTimeInterval delay = pow(2, self.reconnectAttempts++);
        NSUInteger nextGeneration = self.serviceGeneration;
        __weak KlausPIPHost *weakSelf = self;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            KlausPIPHost *host = weakSelf;
            if (!host || host.stopped || host.serviceGeneration != nextGeneration) return;
            [host.pendingCommands addObjectsFromArray:host.sources.allValues];
            [host connectService];
        });
    }
}
- (void)flushCommands {
    if (!self.connection || self.stopped || self.commandInFlight || !self.pendingCommands.count) return;
    NSDictionary *command = self.pendingCommands.firstObject;
    [self.pendingCommands removeObjectAtIndex:0];
    self.commandInFlight = YES;
    NSUInteger generation = self.serviceGeneration, ticket = ++self.commandTicket;
    __weak KlausPIPHost *weakSelf = self;
    [[self.connection remoteObjectProxyWithErrorHandler:^(NSError *error) {
        (void)error;
        dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf serviceDisconnected:generation]; });
    }] command:command reply:^(BOOL accepted) {
        dispatch_async(dispatch_get_main_queue(), ^{
            KlausPIPHost *host = weakSelf;
            if (!host || host.stopped || host.serviceGeneration != generation || host.commandTicket != ticket) return;
            host.commandInFlight = NO;
            if (!accepted) { [host serviceDisconnected:generation]; return; }
            [host flushCommands];
        });
    }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        KlausPIPHost *host = weakSelf;
        if (host && !host.stopped && host.commandInFlight && host.serviceGeneration == generation && host.commandTicket == ticket) {
            [host emit:@{@"type": @"error", @"message": @"The preview producer acknowledgement timed out."}];
            [host serviceDisconnected:generation];
        }
    });
}
- (void)send:(NSDictionary *)command {
    if (self.stopped) return;
    if (self.pendingCommands.count >= 63) {
        [self emit:@{@"type": @"error", @"message": @"The native preview command queue is full."}];
        [self serviceDisconnected:self.serviceGeneration]; return;
    }
    [self.pendingCommands addObject:command];
    if (self.connection) [self flushCommands]; else [self connectService];
}
- (void)publish:(NSDictionary *)presentation fence:(NSMachPort *)fence reply:(void (^)(BOOL))reply {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSString *identifier = KlausPIPString(presentation[@"presentationId"]);
        NSDictionary *expected = self.sources[identifier];
        if (self.stopped || !expected || ![expected[@"sourceToken"] isEqual:presentation[@"sourceToken"]] || ![expected[@"contentRevision"] isEqual:presentation[@"contentRevision"]]) { reply(NO); return; }
        KlausPIPItem *item = self.items[identifier];
        if (item && [item.metadata[@"sourceToken"] isEqual:presentation[@"sourceToken"]] &&
            [item.metadata[@"revision"] unsignedIntegerValue] > [presentation[@"revision"] unsignedIntegerValue]) { reply(NO); return; }
        if (![presentation[@"contextId"] unsignedIntValue]) { reply(NO); return; }
        if (!item && self.items.count >= 32) {
            [self emit:@{@"type": @"error", @"message": @"Native preview card capacity was exceeded.",
                @"sessionId": presentation[@"sessionId"] ?: @"", @"presentationId": identifier,
                @"epoch": presentation[@"epoch"] ?: @0, @"contentRevision": presentation[@"contentRevision"] ?: @0}];
            [self discard:identifier notifyProducer:YES animated:NO]; reply(NO); return;
        }
        BOOL fresh = !item;
        if (!item) item = [self makeItem:identifier];
        uint32_t contextID = [presentation[@"contextId"] unsignedIntValue];
        if (!item.contentLayer || [item.metadata[@"contextId"] unsignedIntValue] != contextID) {
            Class layerClass = NSClassFromString(@"CALayerHost");
            CALayer *layer = layerClass ? [layerClass layer] : nil;
            if (!layer || ![layer respondsToSelector:@selector(setContextId:)]) {
                [self emit:@{@"type": @"error", @"sessionId": KlausPIPString(presentation[@"sessionId"]),
                             @"message": @"Native remote layer hosting is unavailable."}];
                [self discard:identifier notifyProducer:YES animated:NO]; reply(NO); return;
            }
            [layer setContextId:contextID];
            [self installContent:layer item:item];
        }
        if (fence && [item.contentLayer respondsToSelector:@selector(setFencePort:)]) [item.contentLayer setFencePort:fence.machPort];
        item.metadata = presentation;
        item.sourceSize = CGSizeMake([presentation[@"width"] doubleValue], [presentation[@"height"] doubleValue]);
        self.reconnectAttempts = 0;
        if (![self relayout:!fresh]) { reply(NO); return; }
        if (fresh) [item appear:NO];
        [self updateState];
        [self emit:@{@"type": @"ready", @"sessionId": KlausPIPString(presentation[@"sessionId"]),
                     @"presentationId": identifier, @"epoch": presentation[@"epoch"] ?: @0,
                     @"contentRevision": presentation[@"contentRevision"] ?: @0}];
        reply(YES);
    });
}
- (void)remove:(NSDictionary *)presentation {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSString *identifier = KlausPIPString(presentation[@"presentationId"]);
        if (![self.sources[identifier][@"sourceToken"] isEqual:presentation[@"sourceToken"]] ||
            ![self.sources[identifier][@"contentRevision"] isEqual:presentation[@"contentRevision"]]) return;
        [self discard:identifier notifyProducer:YES animated:YES];
    });
}
- (void)failure:(NSDictionary *)failure {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSString *identifier = KlausPIPString(failure[@"presentationId"]);
        if (![self.sources[identifier][@"sourceToken"] isEqual:failure[@"sourceToken"]] ||
            ![self.sources[identifier][@"contentRevision"] isEqual:failure[@"contentRevision"]]) return;
        [self emit:failure];
        [self discard:identifier notifyProducer:YES animated:NO];
    });
}
- (KlausPIPItem *)makeItem:(NSString *)identifier {
    [self ensurePanels];
    KlausPIPItem *item = [KlausPIPItem new];
    self.items[identifier] = item; [self.order insertObject:identifier atIndex:0];
    [self.panel.contentView.layer addSublayer:item.positionLayer];
    return item;
}
- (void)installContent:(CALayer *)layer item:(KlausPIPItem *)item {
    [item.contentLayer removeFromSuperlayer];
    layer.anchorPoint = CGPointZero;
    layer.cornerRadius = 8; layer.cornerCurve = kCACornerCurveContinuous; layer.masksToBounds = YES;
    item.contentLayer = layer; [item.appearanceLayer addSublayer:layer];
}
- (NSArray<KlausPIPItem *> *)visibleItems {
    NSMutableArray *result = [NSMutableArray array];
    BOOL hiddenAll = [self.preferences[@"alwaysHidePictureInPicture"] boolValue];
    NSDictionary *visibilities = [self.preferences[@"taskVisibilities"] isKindOfClass:NSDictionary.class] ? self.preferences[@"taskVisibilities"] : @{};
    NSString *session = KlausPIPString(self.layout[@"sessionId"]);
    for (NSString *identifier in self.order) {
        KlausPIPItem *item = self.items[identifier];
        NSString *itemSession = KlausPIPString(item.metadata[@"sessionId"]);
        id visibility = visibilities[itemSession];
        BOOL taskHidden = ([visibility isKindOfClass:NSNumber.class] && ![visibility boolValue]) || [visibility isEqual:@"hidden"];
        BOOL matches = self.floating || [KlausPIPString(self.layout[@"presentationScope"]) isEqualToString:@"all"] || [session isEqualToString:itemSession];
        if (item.contentLayer && !item.exiting && !hiddenAll && !taskHidden && matches && result.count < 5) [result addObject:item];
    }
    return result;
}
- (CGPoint)screenAnchor:(NSString *)alignment {
    if (self.floating || !self.owner) {
        NSScreen *screen = self.owner.screen ?: NSScreen.mainScreen;
        NSRect bounds = NSInsetRect(screen.visibleFrame, 16, 16);
        return CGPointMake([alignment hasSuffix:@"right"] ? NSMaxX(bounds) : NSMinX(bounds),
                           [alignment hasPrefix:@"top"] ? NSMaxY(bounds) : NSMinY(bounds));
    }
    CGPoint point = CGPointZero;
    BOOL found = NO;
    for (NSDictionary *anchor in self.layout[@"anchors"]) if ([anchor[@"alignment"] isEqual:alignment]) {
        point = CGPointMake([anchor[@"point"][@"x"] doubleValue], [anchor[@"point"][@"y"] doubleValue]); found = YES; break;
    }
    if (!found) {
        NSDictionary *keys = @{@"top-left": @"topLeft", @"top-right": @"topRight", @"bottom-left": @"bottomLeft", @"bottom-right": @"bottomRight"};
        NSDictionary *rect = self.layout[@"anchorRects"][keys[alignment]];
        if (rect) point = KlausPIPRect(rect).origin;
        else {
            NSRect bounds = KlausPIPRect(self.layout[@"anchorRect"] ?: self.layout[@"containerRect"]);
            point = CGPointMake([alignment hasSuffix:@"right"] ? NSMaxX(bounds) : NSMinX(bounds),
                                [alignment hasPrefix:@"top"] ? NSMinY(bounds) : NSMaxY(bounds));
        }
    }
    NSView *content = self.owner.contentView;
    point.y = content.bounds.size.height - point.y;
    point = [content convertPoint:point toView:nil];
    return [self.owner convertPointToScreen:point];
}
- (CGSize)sizeForItem:(KlausPIPItem *)item {
    CGFloat width = item.sourceSize.width, height = item.sourceSize.height;
    if (!isfinite(width) || !isfinite(height) || width <= 0 || height <= 0) return CGSizeMake(self.maxDisplaySize, self.maxDisplaySize);
    CGFloat scale = self.maxDisplaySize / fmax(width, height);
    return CGSizeMake(fmax(1, width * scale), fmax(1, height * scale));
}
- (void)failLayout:(NSString *)detail exception:(NSException *)exception context:(NSDictionary *)context {
    @try {
        NSMutableArray<NSString *> *stack = [NSMutableArray array];
        for (NSString *symbol in exception.callStackSymbols ?: @[]) {
            if (stack.count >= 24) break;
            [stack addObject:KlausPIPDiagnosticString(symbol, 512)];
        }
        KlausPIPAppendDiagnostic(self.diagnosticPath, @{
            @"atMs": @((long long)(NSDate.date.timeIntervalSince1970 * 1000)),
            @"pid": @(getpid()), @"kind": exception ? @"window-exception" : @"invalid-frame",
            @"message": KlausPIPDiagnosticString(detail, 4096),
            @"exception": exception ? @{
                @"name": KlausPIPDiagnosticString(exception.name, 256),
                @"reason": KlausPIPDiagnosticString(exception.reason, 4096),
                @"callStackSymbols": stack,
            } : NSNull.null,
            @"context": context ?: @{},
        });
    } @catch (NSException *loggingException) {
        NSLog(@"[pip] diagnostic construction failed: %@: %@", loggingException.name, loggingException.reason);
    }
    NSLog(@"[pip] %@", detail);
    @try { [self.panel orderOut:nil]; [self.controlPanel orderOut:nil]; }
    @catch (NSException *hideException) { NSLog(@"[pip] hiding failed: %@: %@", hideException.name, hideException.reason); }
    [self emit:@{@"type": @"error", @"message": detail}];
}
- (BOOL)relayout:(BOOL)animated {
    if (!self.panel || self.stopped) return NO;
    NSArray<KlausPIPItem *> *visible = [self visibleItems];
    BOOL hostVisible = self.floating || ([self.layout[@"visible"] boolValue] && self.owner && !self.owner.miniaturized && self.owner.visible);
    if (!visible.count || !hostVisible) {
        [self.panel orderOut:nil]; [self.controlPanel orderOut:nil]; return YES;
    }
    if (self.owner && !self.floating) {
        if (self.panel.parentWindow != self.owner) {
            [self.panel.parentWindow removeChildWindow:self.panel];
            [self.controlPanel.parentWindow removeChildWindow:self.controlPanel];
            [self.owner addChildWindow:self.panel ordered:NSWindowAbove];
            [self.owner addChildWindow:self.controlPanel ordered:NSWindowAbove];
        }
        self.panel.level = self.owner.level; self.controlPanel.level = self.owner.level;
    } else {
        [self.panel.parentWindow removeChildWindow:self.panel];
        [self.controlPanel.parentWindow removeChildWindow:self.controlPanel];
        self.panel.level = NSFloatingWindowLevel; self.controlPanel.level = NSFloatingWindowLevel;
    }
    CGPoint anchor = [self screenAnchor:self.anchor];
    if (self.dragging) anchor = self.dragOrigin;
    BOOL right = [self.anchor hasSuffix:@"right"], top = [self.anchor hasPrefix:@"top"];
    NSMutableArray<NSValue *> *frames = [NSMutableArray array];
    CGRect envelope = CGRectNull;
    for (NSUInteger index = 0; index < visible.count; index++) {
        CGSize size = [self sizeForItem:visible[index]];
        CGRect frame = CGRectMake(anchor.x - (right ? size.width : 0) + (right ? -28 : 28) * index,
                                   anchor.y - (top ? size.height : 0) + (top ? -22 : 22) * index, size.width, size.height);
        [frames addObject:[NSValue valueWithRect:frame]]; envelope = CGRectUnion(envelope, frame);
    }
    envelope = CGRectInset(envelope, -32, -36);
    NSScreen *screen = self.owner.screen ?: NSScreen.mainScreen;
    for (NSScreen *candidate in NSScreen.screens) if (CGRectContainsPoint(candidate.frame, anchor)) { screen = candidate; break; }
    CGRect allowed = screen.visibleFrame;
    CGFloat dx = envelope.origin.x < allowed.origin.x ? allowed.origin.x - envelope.origin.x :
        (CGRectGetMaxX(envelope) > CGRectGetMaxX(allowed) ? CGRectGetMaxX(allowed) - CGRectGetMaxX(envelope) : 0);
    CGFloat dy = envelope.origin.y < allowed.origin.y ? allowed.origin.y - envelope.origin.y :
        (CGRectGetMaxY(envelope) > CGRectGetMaxY(allowed) ? CGRectGetMaxY(allowed) - CGRectGetMaxY(envelope) : 0);
    envelope = CGRectOffset(envelope, dx, dy);
    NSMutableArray<NSString *> *sessions = [NSMutableArray array];
    NSMutableArray<NSString *> *presentations = [NSMutableArray array];
    NSMutableArray<NSString *> *sourceKinds = [NSMutableArray array];
    for (KlausPIPItem *item in visible) {
        NSString *session = KlausPIPDiagnosticString(item.metadata[@"sessionId"], 128);
        NSString *presentation = KlausPIPDiagnosticString(item.metadata[@"presentationId"], 128);
        if (session.length) [sessions addObject:session];
        if (presentation.length) [presentations addObject:presentation];
        [sourceKinds addObject:item.metadata[@"contextId"] ? @"window" : @"browser"];
    }
    NSMutableDictionary *context = [@{
        @"stage": @"geometry", @"frame": NSStringFromRect(envelope),
        @"anchor": NSStringFromPoint(anchor), @"screenFrame": NSStringFromRect(screen.frame),
        @"allowedFrame": NSStringFromRect(allowed), @"ownerFrame": NSStringFromRect(self.owner.frame),
        @"panelFrameBefore": NSStringFromRect(self.panel.frame),
        @"controlsFrameBefore": NSStringFromRect(self.controlPanel.frame),
        @"ownerWindowNumber": @(self.owner.windowNumber), @"generation": @(self.generation),
        @"hostId": KlausPIPDiagnosticString(self.layout[@"hostId"], 128),
        @"floating": @(self.floating), @"sessionIds": sessions,
        @"presentationIds": presentations, @"sourceKinds": sourceKinds,
    } mutableCopy];
    if (!KlausPIPValidFrame(envelope)) {
        [self failLayout:[NSString stringWithFormat:@"Native preview layout has an invalid frame: %@", NSStringFromRect(envelope)]
              exception:nil context:context];
        return NO;
    }
    CGPoint previousOrigin = self.envelope.origin;
    NSString *stage = @"preview";
    @try {
        [self.panel setFrame:envelope display:YES];
        stage = @"controls";
        [self.controlPanel setFrame:envelope display:YES];
    } @catch (NSException *exception) {
        context[@"stage"] = stage;
        @try {
            context[@"panelFrameAtException"] = NSStringFromRect(self.panel.frame);
            context[@"controlsFrameAtException"] = NSStringFromRect(self.controlPanel.frame);
        } @catch (NSException *frameException) {
            context[@"frameReadError"] = KlausPIPDiagnosticString(frameException.reason, 512);
        }
        [self failLayout:[NSString stringWithFormat:@"Native preview %@ window layout failed (%@): %@; frame %@",
            stage, exception.name ?: @"unknown", exception.reason ?: @"unknown", NSStringFromRect(envelope)]
              exception:exception context:context];
        return NO;
    }
    self.envelope = envelope;
    [CATransaction begin]; [CATransaction setDisableActions:YES];
    for (KlausPIPItem *item in self.items.allValues) if (!item.exiting) item.positionLayer.hidden = ![visible containsObject:item];
    for (NSUInteger index = 0; index < visible.count; index++) {
        KlausPIPItem *item = visible[index];
        CGRect frame = CGRectOffset(frames[index].rectValue, dx - envelope.origin.x, dy - envelope.origin.y);
        item.frame = frame; item.target = frame.origin;
        item.positionLayer.zPosition = 100 - index;
        item.positionLayer.bounds = (CGRect){CGPointZero, frame.size};
        item.appearanceLayer.frame = (CGRect){CGPointZero, frame.size};
        CGPathRef shadow = CGPathCreateWithRoundedRect(item.appearanceLayer.bounds, 8, 8, NULL);
        item.appearanceLayer.shadowPath = shadow; CGPathRelease(shadow);
        if (item.metadata[@"contextId"]) {
            item.contentLayer.bounds = (CGRect){CGPointZero, item.sourceSize};
            item.contentLayer.transform = CATransform3DMakeScale(frame.size.width / fmax(1, item.sourceSize.width), frame.size.height / fmax(1, item.sourceSize.height), 1);
        } else { item.contentLayer.transform = CATransform3DIdentity; item.contentLayer.frame = (CGRect){CGPointZero, frame.size}; }
        item.contentLayer.position = CGPointZero;
        if (item.initialized) {
            CGPoint translated = CGPointMake(item.positionLayer.position.x + previousOrigin.x - envelope.origin.x,
                                              item.positionLayer.position.y + previousOrigin.y - envelope.origin.y);
            item.positionLayer.position = translated;
        }
        if (!animated || !item.initialized || self.resizing) item.positionLayer.position = frame.origin;
        else if (self.dragging) {
            if (index == 0) item.positionLayer.position = frame.origin;
            else KlausPIPAnimatePosition(item.positionLayer, frame.origin, 260 / (1 + index * 0.18), 32 / (1 + index * 0.08));
        } else KlausPIPAnimatePosition(item.positionLayer, frame.origin, index ? 150 / (1 + index * .18) : 320, index ? 30 / (1 + index * .08) : 42);
        item.initialized = YES;
        if (item.completionLayer) {
            item.completionLayer.frame = item.appearanceLayer.bounds;
            CGFloat iconSize = 50;
            item.completionIcon.frame = CGRectMake((frame.size.width - iconSize) / 2, (frame.size.height - iconSize) / 2, iconSize, iconSize);
            item.completionIconDim.frame = item.completionIcon.frame;
            item.completionIconDim.mask.frame = item.completionIconDim.bounds;
            item.completionCheck.position = item.completionCheck.transform.m11 < .9 ?
                CGPointMake(frame.size.width / 2 + 18, frame.size.height / 2 - 18) :
                CGPointMake(frame.size.width / 2, frame.size.height / 2);
            item.completionBadge.position = CGPointMake(frame.size.width / 2 + 18, frame.size.height / 2 - 18);
        }
    }
    KlausPIPItem *lead = visible.firstObject;
    CGFloat buttonY = CGRectGetMaxY(lead.frame) - 28;
    NSString *hide = [self label:@"hide" fallback:@"Hide"];
    CGFloat labelWidth = MAX(22, ceil([hide sizeWithAttributes:@{NSFontAttributeName: [NSFont systemFontOfSize:12 weight:NSFontWeightSemibold]}].width) + 16);
    self.hideFrame = NSMakeRect(NSMinX(lead.frame) + 6, buttonY, labelWidth, 22);
    BOOL placementAvailable = self.floating || KlausPIPString(self.preferences[@"labels"][@"placement"]).length > 0;
    self.placementFrame = placementAvailable ? NSMakeRect(NSMaxX(self.hideFrame) + 1, buttonY, 22, 22) : NSZeroRect;
    self.placementIcon.hidden = !placementAvailable;
    self.controls.frame = self.interactionView.bounds;
    self.hideLabel.frame = NSInsetRect(self.hideFrame, 0, 3); self.hideLabel.string = hide;
    NSColor *ink = [lead.metadata[@"luminance"] doubleValue] > 0.58 ? NSColor.blackColor : NSColor.whiteColor;
    self.hideLabel.foregroundColor = ink.CGColor;
    NSImage *symbol = [NSImage imageWithSystemSymbolName:self.floating ? @"arrow.down.right.and.arrow.up.left" : @"pip.enter" accessibilityDescription:nil];
    NSImageSymbolConfiguration *configuration = [NSImageSymbolConfiguration configurationWithPaletteColors:@[ink]];
    symbol = [symbol imageWithSymbolConfiguration:configuration];
    self.placementIcon.contents = (__bridge id)KlausPIPCGImage(symbol);
    self.placementIcon.frame = NSInsetRect(self.placementFrame, 3, 3);
    NSRect controlShape = placementAvailable ? NSUnionRect(self.hideFrame, self.placementFrame) : self.hideFrame;
    controlShape = NSInsetRect(controlShape, -18, -10);
    self.fogBackdrop.frame = NSInsetRect(controlShape, -22, -22);
    self.fogBackdrop.mask.frame = self.fogBackdrop.bounds;
    self.fogMaskSource.frame = NSInsetRect(self.fogBackdrop.bounds, 22, 22);
    self.fogMaskSource.cornerRadius = self.fogMaskSource.bounds.size.height / 2;
    self.fogShadowBackdrop.frame = self.fogBackdrop.frame;
    self.fogShadowBackdrop.mask.frame = self.fogShadowBackdrop.bounds;
    self.fogShadowMaskSource.frame = self.fogMaskSource.frame;
    self.fogShadowMaskSource.cornerRadius = self.fogMaskSource.cornerRadius;
    [CATransaction commit];
    [self.panel orderFront:nil]; [self.controlPanel orderWindow:NSWindowAbove relativeTo:self.panel.windowNumber];
    [self.controlPanel invalidateCursorRectsForView:self.interactionView];
    [self.panel invalidateCursorRectsForView:self.panel.contentView]; [self hover];
    return YES;
}
- (NSString *)itemAtPoint:(CGPoint)point {
    for (KlausPIPItem *item in [self visibleItems]) if (CGRectContainsPoint(item.frame, point)) return item.metadata[@"presentationId"];
    return nil;
}
- (CGPoint)pointerInContent { return [self.controlPanel convertPointFromScreen:NSEvent.mouseLocation]; }
- (CGPoint)screenPointForEvent:(NSEvent *)event {
    return event.window ? [event.window convertPointToScreen:event.locationInWindow] : event.locationInWindow;
}
- (CGPoint)contentPointForEvent:(NSEvent *)event {
    return [self.controlPanel convertPointFromScreen:[self screenPointForEvent:event]];
}
- (BOOL)resizeAtPoint:(CGPoint)point {
    KlausPIPItem *item = [self visibleItems].firstObject;
    if (!item) return NO;
    // The diagonal corner opposite the dock anchor is the resize handle.
    CGPoint corner = CGPointMake([self.anchor hasSuffix:@"right"] ? CGRectGetMinX(item.frame) : CGRectGetMaxX(item.frame),
                                 [self.anchor hasPrefix:@"top"] ? CGRectGetMinY(item.frame) : CGRectGetMaxY(item.frame));
    return fabs(point.x - corner.x) <= 10 && fabs(point.y - corner.y) <= 10;
}
- (void)hover {
    [self hoverAtPoint:[self pointerInContent]];
}
- (void)hoverAtPoint:(CGPoint)point {
    if (!self.controlPanel.visible || self.stopped) return;
    BOOL controlHit = NSPointInRect(point, self.hideFrame) || NSPointInRect(point, self.placementFrame);
    BOOL over = [self itemAtPoint:point] != nil || controlHit || [self resizeAtPoint:point];
    [CATransaction begin]; [CATransaction setAnimationDuration:0.16];
    self.controls.opacity = over && !self.dragging && !self.resizing ? 1 : 0;
    self.hideLabel.opacity = NSPointInRect(point, self.hideFrame) ? 1 : .7;
    self.placementIcon.opacity = NSPointInRect(point, self.placementFrame) ? 1 : .7;
    [CATransaction commit];
    if ([self resizeAtPoint:point]) {
        if (@available(macOS 15.0, *)) {
            BOOL right = [self.anchor hasSuffix:@"right"], top = [self.anchor hasPrefix:@"top"];
            NSCursorFrameResizePosition corner = top ? (right ? NSCursorFrameResizePositionBottomLeft : NSCursorFrameResizePositionBottomRight) :
                (right ? NSCursorFrameResizePositionTopLeft : NSCursorFrameResizePositionTopRight);
            [[NSCursor frameResizeCursorFromPosition:corner inDirections:NSCursorFrameResizeDirectionsAll] set];
        }
        else [NSCursor.crosshairCursor set];
    } else if (over) [(controlHit ? NSCursor.pointingHandCursor : (self.dragging ? NSCursor.closedHandCursor : NSCursor.openHandCursor)) set];
}
- (void)mouseDown:(NSEvent *)event {
    CGPoint point = [self contentPointForEvent:event];
    [self hoverAtPoint:point];
    self.initialPointer = [self screenPointForEvent:event]; self.lastPointer = self.initialPointer;
    self.initialSize = self.maxDisplaySize; self.resizing = [self resizeAtPoint:point];
    self.pressedControl = NSPointInRect(point, self.hideFrame) ? @"hide" : (NSPointInRect(point, self.placementFrame) ? @"placement" : nil);
    self.pressedID = [self itemAtPoint:point];
    self.dragOrigin = [self screenAnchor:self.anchor];
    if (self.pressedID && ![self.order.firstObject isEqual:self.pressedID] && !self.pressedControl && !self.resizing) {
        [self.order removeObject:self.pressedID]; [self.order insertObject:self.pressedID atIndex:0]; [self relayout:YES];
    }
}
- (void)mouseDragged:(NSEvent *)event {
    CGPoint pointer = [self screenPointForEvent:event];
    if (self.resizing) {
        CGFloat dx = (pointer.x - self.initialPointer.x) * ([self.anchor hasSuffix:@"right"] ? -1 : 1);
        CGFloat dy = (pointer.y - self.initialPointer.y) * ([self.anchor hasPrefix:@"top"] ? -1 : 1);
        self.maxDisplaySize = KlausPIPMaxSize(@(self.initialSize + (fabs(dx) > fabs(dy) ? dx : dy)));
        [self relayout:NO];
    } else if (self.pressedID && !self.pressedControl && hypot(pointer.x - self.initialPointer.x, pointer.y - self.initialPointer.y) > 3) {
        self.dragging = YES;
        self.dragOrigin = CGPointMake(self.dragOrigin.x + pointer.x - self.lastPointer.x,
                                      self.dragOrigin.y + pointer.y - self.lastPointer.y);
        [self relayout:YES];
    }
    self.lastPointer = pointer;
}
- (void)mouseUp:(NSEvent *)event {
    CGPoint point = [self contentPointForEvent:event];
    if (self.resizing) {
        self.resizing = NO;
        [self emit:@{@"type": @"resize", @"maxDisplaySize": @(self.maxDisplaySize)}];
        if (self.connection) [self send:@{@"type": @"preferences", @"maxDisplaySize": @(self.maxDisplaySize)}];
    } else if (self.dragging) {
        CGPoint location = self.dragOrigin;
        double distance = DBL_MAX;
        NSString *selected = self.anchor;
        for (NSString *anchor in @[@"top-left", @"top-right", @"bottom-left", @"bottom-right"]) {
            CGPoint point = [self screenAnchor:anchor];
            double candidate = hypot(location.x - point.x, location.y - point.y);
            if (candidate < distance) { distance = candidate; selected = anchor; }
        }
        self.anchor = selected; self.dragging = NO;
        [self emit:@{@"type": @"placement", @"anchor": selected, @"hostId": self.floating ? @"klaus-floating" : @"klaus-main-thread"}];
    } else if ([self.pressedControl isEqualToString:@"hide"] && NSPointInRect(point, self.hideFrame)) [self showHideMenu];
    else if ([self.pressedControl isEqualToString:@"placement"] && NSPointInRect(point, self.placementFrame)) {
        self.floating = !self.floating;
        [self emit:@{@"type": @"placement", @"anchor": self.anchor, @"hostId": self.floating ? @"klaus-floating" : @"klaus-main-thread"}];
    } else if (self.pressedID && !self.pressedControl) [self focus:self.pressedID];
    self.pressedID = nil; self.pressedControl = nil; [self relayout:YES];
}
- (void)showHideMenu {
    NSMenu *menu = [NSMenu new];
    NSMenuItem *task = [[NSMenuItem alloc] initWithTitle:[self label:@"hideForTask" fallback:@"Hide for this chat"] action:@selector(hideTask:) keyEquivalent:@""];
    NSMenuItem *all = [[NSMenuItem alloc] initWithTitle:[self label:@"hideForAllActiveTasks" fallback:@"Hide for all active chats"] action:@selector(hideAll:) keyEquivalent:@""];
    task.target = self; all.target = self; [menu addItem:task]; [menu addItem:all];
    self.menuOpen = YES;
    [menu popUpMenuPositioningItem:nil atLocation:NSMakePoint(NSMinX(self.hideFrame), NSMinY(self.hideFrame)) inView:self.interactionView];
    self.menuOpen = NO;
}
- (void)hideTask:(id)sender {
    (void)sender;
    NSString *session = KlausPIPString([self visibleItems].firstObject.metadata[@"sessionId"]);
    if (!session.length) return;
    NSMutableDictionary *preferences = [self.preferences mutableCopy];
    NSMutableDictionary *visibility = [preferences[@"taskVisibilities"] mutableCopy] ?: [NSMutableDictionary dictionary];
    visibility[session] = @NO; preferences[@"taskVisibilities"] = visibility; self.preferences = preferences;
    [self emit:@{@"type": @"visibility", @"scope": @"task", @"sessionId": session, @"visible": @NO}]; [self relayout:YES];
}
- (void)hideAll:(id)sender {
    (void)sender;
    NSMutableDictionary *preferences = [self.preferences mutableCopy]; preferences[@"alwaysHidePictureInPicture"] = @YES; self.preferences = preferences;
    [self emit:@{@"type": @"visibility", @"scope": @"all", @"visible": @NO}]; [self relayout:YES];
}
- (void)focus:(NSString *)identifier {
    KlausPIPItem *item = self.items[identifier];
    [self emit:@{@"type": @"focus", @"presentationId": identifier,
                 @"sessionId": KlausPIPString(item.metadata[@"sessionId"]),
                 @"tabId": item.metadata[@"tabId"] ?: @"", @"epoch": item.metadata[@"epoch"] ?: @0,
                 @"contentRevision": item.metadata[@"contentRevision"] ?: @0}];
    pid_t pid = [item.metadata[@"pid"] intValue];
    uint32_t windowID = [item.metadata[@"windowId"] unsignedIntValue];
    if (pid > 0) {
        NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
        [application activateWithOptions:0];
        AXUIElementRef app = AXUIElementCreateApplication(pid);
        CFTypeRef value = NULL;
        if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &value) == kAXErrorSuccess) {
            AXError (*getWindow)(AXUIElementRef, CGWindowID *) = dlsym(RTLD_DEFAULT, "_AXUIElementGetWindow");
            for (id candidate in (__bridge NSArray *)value) {
                uint32_t number = 0;
                if (getWindow && getWindow((__bridge AXUIElementRef)candidate, &number) == kAXErrorSuccess && number == windowID) {
                    AXUIElementSetAttributeValue((__bridge AXUIElementRef)candidate, kAXMinimizedAttribute, kCFBooleanFalse);
                    AXUIElementPerformAction((__bridge AXUIElementRef)candidate, kAXRaiseAction); break;
                }
            }
            CFRelease(value);
        }
        CFRelease(app);
    }
}
- (void)complete:(KlausPIPItem *)item {
    if (item.completed || item.exiting) return;
    item.completed = YES; item.generation++;
    NSUInteger generation = item.generation;
    CALayer *overlay = [CALayer layer]; overlay.frame = item.appearanceLayer.bounds;
    overlay.backgroundColor = [NSColor colorWithWhite:0 alpha:0.17].CGColor;
    overlay.cornerRadius = 8; overlay.masksToBounds = YES;
    item.completionLayer = overlay; [item.appearanceLayer addSublayer:overlay];
    CGFloat iconSize = 50;
    CALayer *icon = [CALayer layer];
    NSImage *appIcon = [NSRunningApplication runningApplicationWithProcessIdentifier:[item.metadata[@"pid"] intValue]].icon;
    if (!appIcon) appIcon = [NSImage imageWithSystemSymbolName:@"globe" accessibilityDescription:nil];
    icon.contents = (__bridge id)KlausPIPCGImage(appIcon); icon.contentsGravity = kCAGravityResizeAspect;
    icon.frame = CGRectMake((item.frame.size.width - iconSize) / 2, (item.frame.size.height - iconSize) / 2, iconSize, iconSize);
    item.completionIcon = icon; [overlay addSublayer:icon];
    CALayer *iconDim = [CALayer layer]; iconDim.frame = icon.frame;
    iconDim.backgroundColor = NSColor.blackColor.CGColor; iconDim.opacity = 0;
    iconDim.mask = [CALayer layer]; iconDim.mask.frame = iconDim.bounds;
    iconDim.mask.contents = icon.contents; iconDim.mask.contentsGravity = kCAGravityResizeAspect;
    item.completionIconDim = iconDim; [overlay addSublayer:iconDim];
    CALayer *badge = [CALayer layer]; badge.bounds = CGRectMake(0, 0, 17.5, 17.5);
    badge.position = CGPointMake(item.frame.size.width / 2 + 18, item.frame.size.height / 2 - 18);
    badge.cornerRadius = 8.75; badge.backgroundColor = [NSColor colorWithRed:0 green:230.0/255 blue:45.0/255 alpha:1].CGColor;
    badge.shadowColor = NSColor.blackColor.CGColor; badge.shadowOpacity = .8; badge.shadowRadius = 4; badge.shadowOffset = CGSizeZero;
    badge.opacity = 0; item.completionBadge = badge; [overlay addSublayer:badge];
    CALayer *check = [CALayer layer];
    NSImage *symbol = [[NSImage imageWithSystemSymbolName:@"checkmark" accessibilityDescription:nil]
        imageWithSymbolConfiguration:[NSImageSymbolConfiguration configurationWithPointSize:18 weight:NSFontWeightBold]];
    check.backgroundColor = NSColor.whiteColor.CGColor;
    check.mask = [CALayer layer]; check.mask.frame = CGRectMake(0, 0, 18, 18);
    check.mask.contents = (__bridge id)KlausPIPCGImage(symbol); check.mask.contentsGravity = kCAGravityResizeAspect;
    check.frame = CGRectMake(item.frame.size.width / 2 - 9, item.frame.size.height / 2 - 9, 18, 18);
    check.opacity = 0; item.completionCheck = check; [overlay addSublayer:check];
    CABasicAnimation *reveal = [CABasicAnimation animationWithKeyPath:@"opacity"];
    reveal.fromValue = @0; reveal.toValue = @1; reveal.duration = .35;
    reveal.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
    [overlay addAnimation:reveal forKey:@"klaus-pip-completion-reveal"];
    __weak KlausPIPHost *weakSelf = self;
    __weak KlausPIPItem *weakItem = item;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        KlausPIPItem *current = weakItem;
        if (!current || current.generation != generation || !current.completed) return;
        [CATransaction begin]; [CATransaction setAnimationDuration:0.25];
        current.completionIconDim.opacity = .65; current.completionCheck.opacity = 1;
        KlausPIPCompletionSpring(current.completionCheck, @"transform.scale", @0.01, @1);
        [CATransaction commit];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            if (current.generation != generation || !current.completed) return;
            [CATransaction begin]; [CATransaction setAnimationDuration:0.25];
            current.completionIconDim.opacity = 0; current.completionBadge.opacity = 1;
            current.completionCheck.backgroundColor = [NSColor colorWithWhite:0 alpha:.5].CGColor;
            CGPoint center = CGPointMake(current.frame.size.width / 2, current.frame.size.height / 2);
            CGPoint corner = CGPointMake(center.x + 18, center.y - 18);
            current.completionCheck.transform = CATransform3DMakeScale(.5, .5, 1);
            current.completionCheck.position = corner;
            KlausPIPCompletionSpring(current.completionCheck, @"transform.scale", @1, @0.5);
            KlausPIPCompletionSpring(current.completionCheck, @"position", [NSValue valueWithPoint:center], [NSValue valueWithPoint:corner]);
            KlausPIPCompletionSpring(current.completionBadge, @"position", [NSValue valueWithPoint:center], [NSValue valueWithPoint:corner]);
            [CATransaction commit];
        });
    });
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        KlausPIPItem *current = weakItem;
        if (current && current.generation == generation && current.completed) [weakSelf discard:current.metadata[@"presentationId"] notifyProducer:YES animated:YES];
    });
}
- (void)discard:(NSString *)identifier notifyProducer:(BOOL)notify animated:(BOOL)animated {
    KlausPIPItem *item = self.items[identifier];
    if (!item || item.exiting) {
        if (notify && self.sources[identifier]) {
            [self.sources removeObjectForKey:identifier];
            NSIndexSet *pending = [self.pendingCommands indexesOfObjectsPassingTest:^BOOL(NSDictionary *command, NSUInteger index, BOOL *stop) {
                (void)index; (void)stop; return [command[@"presentationId"] isEqual:identifier];
            }];
            [self.pendingCommands removeObjectsAtIndexes:pending];
            if (self.connection) [self send:@{@"type": @"remove", @"presentationIds": @[identifier]}];
        }
        return;
    }
    item.exiting = YES; item.generation++;
    NSUInteger generation = item.generation;
    [self.order removeObject:identifier];
    if (animated && !item.positionLayer.hidden) [item appear:YES];
    [self updateState];
    __weak KlausPIPHost *weakSelf = self;
    void (^finish)(void) = ^{
        KlausPIPHost *host = weakSelf;
        if (!host || host.items[identifier] != item || item.generation != generation || !item.exiting) return;
        [item.positionLayer removeFromSuperlayer]; [host.items removeObjectForKey:identifier];
        if (notify && host.sources[identifier]) {
            [host.sources removeObjectForKey:identifier];
            if (host.connection) [host send:@{@"type": @"remove", @"presentationIds": @[identifier]}];
        }
        [host relayout:YES];
    };
    if (animated) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.75 * NSEC_PER_SEC)), dispatch_get_main_queue(), finish);
    else finish();
}
- (void)handle:(NSDictionary *)command {
    if (self.stopped) return;
    NSString *type = KlausPIPString(command[@"type"]);
    if ([type isEqualToString:@"diagnostics"]) {
        NSString *path = KlausPIPString(command[@"path"]);
        if (path.length < 4096 && path.isAbsolutePath && [path.lastPathComponent isEqualToString:@"computer-use-pip-crash.log"])
            self.diagnosticPath = path;
    } else if ([type isEqualToString:@"layout"]) {
        self.layout = command;
        NSString *anchor = KlausPIPString(command[@"anchor"]);
        if (anchor.length && !self.dragging && !self.resizing) self.anchor = anchor;
        [self relayout:[command[@"animated"] boolValue]];
    } else if ([type isEqualToString:@"preferences"]) {
        self.preferences = command;
        self.maxDisplaySize = KlausPIPMaxSize(command[@"maxDisplaySize"]);
        NSString *anchor = KlausPIPString(command[@"anchor"]);
        if (anchor.length) self.anchor = anchor;
        NSString *hostID = KlausPIPString(command[@"hostId"]);
        if (hostID.length) self.floating = [hostID isEqualToString:@"klaus-floating"];
        if (self.connection) [self send:command]; [self relayout:YES];
    } else if ([type isEqualToString:@"upsertWindow"]) {
        NSString *identifier = KlausPIPString(command[@"presentationId"]);
        if (!identifier.length) return;
        if (!self.sources[identifier] && self.sources.count >= 32) {
            [self emit:@{@"type": @"error", @"message": @"Native preview source capacity was exceeded."}]; return;
        }
        NSMutableDictionary *source = [command mutableCopy];
        NSDictionary *previous = self.sources[identifier];
        BOOL sameSource = previous &&
            [(previous[@"epoch"] ?: @0) isEqual:(command[@"epoch"] ?: @0)] &&
            [(previous[@"pid"] ?: @0) isEqual:(command[@"pid"] ?: @0)] &&
            [(previous[@"windowId"] ?: @0) isEqual:(command[@"windowId"] ?: @0)] &&
            [(previous[@"associatedWindowIds"] ?: @[]) isEqual:(command[@"associatedWindowIds"] ?: @[])];
        source[@"sourceToken"] = sameSource ? previous[@"sourceToken"] : NSUUID.UUID.UUIDString;
        self.sources[identifier] = source;
        KlausPIPItem *item = self.items[identifier];
        if (item.exiting) {
            [item.positionLayer removeFromSuperlayer]; [self.items removeObjectForKey:identifier];
            [self.order removeObject:identifier]; item = nil;
        }
        if (item.completed) { item.completed = NO; item.generation++; [item.completionLayer removeFromSuperlayer]; item.completionLayer = nil; }
        [self send:source];
    } else if ([type isEqualToString:@"upsertBrowser"]) {
        NSString *identifier = KlausPIPString(command[@"presentationId"]);
        if (!identifier.length) return;
        if (!self.items[identifier] && self.items.count >= 32) {
            [self emit:@{@"type": @"error", @"message": @"Native preview card capacity was exceeded."}]; return;
        }
        NSImage *image = KlausPIPImage(KlausPIPString(command[@"dataUrl"]));
        CGImageRef raster = KlausPIPCGImage(image);
        if (!image || !raster) {
            [self emit:@{@"type": @"error", @"sessionId": KlausPIPString(command[@"sessionId"]), @"presentationId": identifier, @"epoch": command[@"epoch"] ?: @0,
                @"contentRevision": command[@"contentRevision"] ?: @0, @"message": @"The browser preview image could not be decoded within the image limits."}];
            return;
        }
        KlausPIPItem *item = self.items[identifier];
        if (item.exiting) {
            [item.positionLayer removeFromSuperlayer]; [self.items removeObjectForKey:identifier];
            [self.order removeObject:identifier]; item = nil;
        }
        BOOL fresh = !item;
        if (!item) item = [self makeItem:identifier];
        item.generation++; item.completed = NO; item.exiting = NO;
        [item.completionLayer removeFromSuperlayer]; item.completionLayer = nil;
        if (!item.contentLayer || item.metadata[@"contextId"]) {
            CALayer *layer = [CALayer layer]; layer.contentsGravity = kCAGravityResizeAspect;
            [self installContent:layer item:item];
        }
        item.contentLayer.contents = (__bridge id)raster;
        item.sourceSize = CGSizeMake(CGImageGetWidth(raster), CGImageGetHeight(raster));
        item.metadata = command;
        if (![self.order containsObject:identifier]) [self.order insertObject:identifier atIndex:0];
        if (![self relayout:!fresh]) return;
        if (fresh) [item appear:NO]; [self updateState];
        [self emit:@{@"type": @"ready", @"sessionId": KlausPIPString(command[@"sessionId"]),
                     @"presentationId": identifier, @"epoch": command[@"epoch"] ?: @0,
                     @"contentRevision": command[@"contentRevision"] ?: @0}];
    } else if ([type isEqualToString:@"remove"]) {
        NSMutableSet *identifiers = [NSMutableSet setWithArray:[command[@"presentationIds"] isKindOfClass:NSArray.class] ? command[@"presentationIds"] : @[]];
        if ([command[@"allForSession"] boolValue]) {
            for (NSString *identifier in self.sources.allKeys) if ([self.sources[identifier][@"sessionId"] isEqual:command[@"sessionId"]]) [identifiers addObject:identifier];
            for (NSString *identifier in self.items.allKeys) if ([self.items[identifier].metadata[@"sessionId"] isEqual:command[@"sessionId"]]) [identifiers addObject:identifier];
        }
        for (NSString *identifier in identifiers) {
            NSDictionary *metadata = self.sources[identifier] ?: self.items[identifier].metadata;
            if (command[@"throughEpoch"] && [metadata[@"epoch"] unsignedLongLongValue] > [command[@"throughEpoch"] unsignedLongLongValue]) continue;
            [self discard:identifier notifyProducer:YES animated:YES];
        }
    } else if ([type isEqualToString:@"endSession"]) {
        for (NSString *identifier in self.sources.allKeys) {
            NSDictionary *source = self.sources[identifier];
            if (!self.items[identifier] && [source[@"sessionId"] isEqual:command[@"sessionId"]] &&
                (!command[@"throughEpoch"] || [source[@"epoch"] unsignedLongLongValue] <= [command[@"throughEpoch"] unsignedLongLongValue])) {
                [self discard:identifier notifyProducer:YES animated:NO];
            }
        }
        for (KlausPIPItem *item in self.items.allValues) {
            NSDictionary *owningSource = self.sources[KlausPIPString(item.metadata[@"presentationId"])];
            if (command[@"throughEpoch"] && [owningSource[@"epoch"] unsignedLongLongValue] > [command[@"throughEpoch"] unsignedLongLongValue]) continue;
            if ([item.metadata[@"sessionId"] isEqual:command[@"sessionId"]] &&
                (!command[@"throughEpoch"] || [item.metadata[@"epoch"] unsignedLongLongValue] <= [command[@"throughEpoch"] unsignedLongLongValue])) [self complete:item];
        }
        if (self.connection) {
            NSMutableDictionary *freeze = [command mutableCopy]; freeze[@"type"] = @"freezeSession"; [self send:freeze];
        }
        [self updateState];
    } else if ([type isEqualToString:@"cursor"]) {
        if (self.connection) [self send:command];
    } else if ([type isEqualToString:@"shutdown"]) [self shutdown];
}
- (void)shutdown {
    if (self.stopped) return;
    self.stopped = YES; self.serviceGeneration++;
    if (self.globalMonitor) [NSEvent removeMonitor:self.globalMonitor];
    if (self.localMonitor) [NSEvent removeMonitor:self.localMonitor];
    self.globalMonitor = nil; self.localMonitor = nil;
    for (id observer in self.observers) [NSNotificationCenter.defaultCenter removeObserver:observer];
    [self.observers removeAllObjects]; [self.motionTimer invalidate];
    self.serviceOutput.fileHandleForReading.readabilityHandler = nil;
    [self closePipe:self.serviceOutput]; self.serviceOutput = nil;
    [self.connection invalidate]; self.connection = nil;
    for (NSTask *task in self.ownedTasks) if (task.running) [task terminate];
    self.serviceTask = nil;
    [self.panel.parentWindow removeChildWindow:self.panel]; [self.controlPanel.parentWindow removeChildWindow:self.controlPanel];
    [self.panel close]; [self.controlPanel close]; self.panel = nil; self.controlPanel = nil;
    [self.items removeAllObjects]; [self.order removeAllObjects]; [self.sources removeAllObjects];
    [self.pendingCommands removeAllObjects]; self.event = NULL;
}
- (int)pending:(BOOL)force {
    for (NSTask *task in self.ownedTasks.allObjects) {
        if (!task.running) { [self.ownedTasks removeObject:task]; continue; }
        if (force) kill(task.processIdentifier, SIGKILL);
    }
    return (int)(self.ownedTasks.count + self.pendingLookups);
}
@end

static KlausPIPHost *KlausPIPSharedHost API_AVAILABLE(macos(14.0));

int klaus_pip_supported(void) {
    if (@available(macOS 14.0, *)) return NSClassFromString(@"CAContext") != nil && NSClassFromString(@"CALayerHost") != nil;
    return 0;
}

int klaus_pip_host_open(void *view, const char *helper, uint64_t generation, KlausPIPEventCallback event) {
    @autoreleasepool {
        if (@available(macOS 14.0, *)) {
            if (!NSThread.isMainThread || !NSApp || !view || !helper || !generation || !event || !klaus_pip_supported()) return 0;
            if (KlausPIPSharedHost && (!KlausPIPSharedHost.stopped || [KlausPIPSharedHost pending:NO])) return 0;
            NSView *nativeView = (__bridge NSView *)view;
            if (![nativeView isKindOfClass:NSView.class] || !nativeView.window) return 0;
            NSString *helperPath = [NSString stringWithUTF8String:helper];
            if (!helperPath.isAbsolutePath || ![NSFileManager.defaultManager isExecutableFileAtPath:helperPath]) return 0;
            KlausPIPSharedHost = [KlausPIPHost new];
            KlausPIPSharedHost.owner = nativeView.window;
            KlausPIPSharedHost.helperPath = helperPath;
            KlausPIPSharedHost.generation = generation;
            KlausPIPSharedHost.event = event;
            return 1;
        }
    }
    return 0;
}
int klaus_pip_host_command(uint64_t generation, const char *json) {
    @autoreleasepool {
        if (@available(macOS 14.0, *)) {
            if (!NSThread.isMainThread || !json || !KlausPIPSharedHost || KlausPIPSharedHost.stopped || KlausPIPSharedHost.generation != generation) return 0;
            NSData *data = [[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding];
            NSDictionary *command = data ? KlausPIPNormalizeJSON([NSJSONSerialization JSONObjectWithData:data options:0 error:nil]) : nil;
            if (![command isKindOfClass:NSDictionary.class]) return 0;
            @try { [KlausPIPSharedHost handle:command]; }
            @catch (NSException *exception) { (void)exception; return 0; }
            return 1;
        }
    }
    return 0;
}
void klaus_pip_host_shutdown(uint64_t generation) {
    if (!NSThread.isMainThread) {
        dispatch_async(dispatch_get_main_queue(), ^{ klaus_pip_host_shutdown(generation); }); return;
    }
    if (@available(macOS 14.0, *)) {
        if (KlausPIPSharedHost.generation == generation) [KlausPIPSharedHost shutdown];
    }
}
int klaus_pip_host_pending(uint64_t generation, int force) {
    if (!NSThread.isMainThread) return -1;
    if (@available(macOS 14.0, *)) {
        if (!KlausPIPSharedHost || KlausPIPSharedHost.generation != generation) return 0;
        return [KlausPIPSharedHost pending:force != 0];
    }
    return 0;
}

char *klaus_pip_host_inspect(uint64_t generation) {
    if (!NSThread.isMainThread) return NULL;
    @autoreleasepool {
        if (@available(macOS 14.0, *)) {
            KlausPIPHost *host = KlausPIPSharedHost;
            if (!host || host.generation != generation) return strdup("{}");
            NSMutableArray *pids = [NSMutableArray array], *items = [NSMutableArray array];
            for (NSTask *task in host.ownedTasks) if (task.running) [pids addObject:@(task.processIdentifier)];
            for (NSString *identifier in host.order) {
                KlausPIPItem *item = host.items[identifier];
                [items addObject:@{@"id": identifier, @"visible": @(!item.positionLayer.hidden && !item.exiting),
                    @"completed": @(item.completed), @"contextId": item.metadata[@"contextId"] ?: @0,
                    @"framesReceived": item.metadata[@"framesReceived"] ?: @0, @"framesEnqueued": item.metadata[@"framesEnqueued"] ?: @0,
                    @"appearanceOpacity": @((item.appearanceLayer.presentationLayer ?: item.appearanceLayer).opacity),
                    @"appearanceAnimating": @([item.appearanceLayer animationForKey:@"klaus-pip-appearance"] != nil),
                    @"x": @(item.frame.origin.x), @"y": @(item.frame.origin.y),
                    @"width": @(item.frame.size.width), @"height": @(item.frame.size.height)}];
            }
            NSDictionary *report = @{@"stopped": @(host.stopped), @"producerPids": pids,
                @"pendingLookups": @(host.pendingLookups), @"queuedCommands": @(host.pendingCommands.count),
                @"commandInFlight": @(host.commandInFlight), @"items": items,
                @"panelWindowId": @(host.panel.windowNumber), @"ownerWindowId": @(host.owner.windowNumber), @"panelVisible": @(host.panel.visible)};
            NSData *data = [NSJSONSerialization dataWithJSONObject:report options:0 error:nil];
            return strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
        }
    }
    return strdup("{}");
}
void klaus_pip_free(char *value) { free(value); }
