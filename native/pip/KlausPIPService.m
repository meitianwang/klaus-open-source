#import "KlausPIP.h"
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <AVFoundation/AVFoundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreMedia/CoreMedia.h>
#import <dlfcn.h>
#import <signal.h>
#import <servers/bootstrap.h>
#import <xpc/xpc.h>
#import <errno.h>

@class KlausPIPService;

API_AVAILABLE(macos(14.0))
@interface KlausPIPCapture : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, weak) KlausPIPService *service;
@property(nonatomic, copy) NSDictionary *source;
@property(nonatomic) SCStream *stream;
@property(nonatomic) id<KlausRemoteContext> context;
@property(nonatomic) CALayer *rootLayer;
@property(nonatomic) AVSampleBufferDisplayLayer *displayLayer;
@property(nonatomic) CAShapeLayer *cursorLayer;
@property(nonatomic) NSUInteger generation;
@property(nonatomic) NSUInteger revision;
@property(nonatomic) BOOL invalidated;
@property(nonatomic) BOOL published;
@property(nonatomic) BOOL publishing;
@property(nonatomic) NSUInteger framesReceived;
@property(nonatomic) NSUInteger framesEnqueued;
@property(nonatomic) BOOL publicationPending;
@property(nonatomic) NSUInteger publicationTicket;
@property(nonatomic) BOOL configuring;
@property(nonatomic) BOOL frozen;
@property(nonatomic) CGRect sourceBounds;
@property(nonatomic) CGSize displaySize;
@property(nonatomic, copy) NSString *geometryKey;
@property(nonatomic) CFTimeInterval lastLuminanceSample;
@property(nonatomic) double luminance;
@property(nonatomic) CGWindowID resolvedWindowID;
@property(nonatomic) AXObserverRef accessibilityObserver;
@property(nonatomic) AXUIElementRef accessibilityApplication;
- (void)refresh;
- (void)invalidate;
- (void)setCursor:(NSDictionary *)cursor;
- (void)handleCaptureError:(NSError *)error;
@end

API_AVAILABLE(macos(14.0))
@interface KlausPIPService : NSObject <NSXPCListenerDelegate, KlausPIPProducerProtocol>
@property(nonatomic) NSXPCListener *listener;
@property(nonatomic) NSXPCConnection *connection;
@property(nonatomic) NSMutableDictionary<NSString *, KlausPIPCapture *> *captures;
@property(nonatomic) NSTimer *geometryTimer;
@property(nonatomic) CGFloat maxDisplaySize;
@property(nonatomic) dispatch_source_t parentMonitor;
@property(nonatomic) pid_t parentPid;
@property(nonatomic) BOOL stopped;
- (void)reportFailure:(NSString *)message source:(NSDictionary *)source;
@end

API_AVAILABLE(macos(14.0))
static void KlausPIPGeometryChanged(AXObserverRef observer, AXUIElementRef element,
                                   CFStringRef notification, void *context) {
    (void)observer; (void)element; (void)notification;
    KlausPIPCapture *capture = (__bridge KlausPIPCapture *)context;
    [capture refresh];
}

static CGWindowID KlausPIPApplicationWindow(pid_t pid, CFStringRef attribute) {
    AXError (*windowIDForElement)(AXUIElementRef, CGWindowID *) = dlsym(RTLD_DEFAULT, "_AXUIElementGetWindow");
    if (pid <= 0 || !windowIDForElement) return kCGNullWindowID;
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    CFTypeRef window = NULL;
    CGWindowID identifier = kCGNullWindowID;
    if (AXUIElementCopyAttributeValue(application, attribute, &window) == kAXErrorSuccess &&
        window && CFGetTypeID(window) == AXUIElementGetTypeID()) {
        windowIDForElement((AXUIElementRef)window, &identifier);
    }
    if (window) CFRelease(window);
    CFRelease(application);
    return identifier;
}

static BOOL KlausPIPMatchesRequestedBounds(SCWindow *window, NSDictionary *bounds) API_AVAILABLE(macos(14.0));
static BOOL KlausPIPMatchesRequestedBounds(SCWindow *window, NSDictionary *bounds) {
    if (![bounds isKindOfClass:NSDictionary.class]) return NO;
    for (NSString *key in @[@"x", @"y", @"width", @"height"]) {
        if (![bounds[key] isKindOfClass:NSNumber.class] || !isfinite([bounds[key] doubleValue])) return NO;
    }
    CGRect frame = window.frame;
    // Mapping bounds come from the operation's screenshot. Allow rounding to
    // backing pixels, but do not guess a document from an unrelated rectangle.
    return [bounds[@"width"] doubleValue] > 0 && [bounds[@"height"] doubleValue] > 0 &&
        fabs(frame.origin.x - [bounds[@"x"] doubleValue]) <= 2 &&
        fabs(frame.origin.y - [bounds[@"y"] doubleValue]) <= 2 &&
        fabs(frame.size.width - [bounds[@"width"] doubleValue]) <= 2 &&
        fabs(frame.size.height - [bounds[@"height"] doubleValue]) <= 2;
}

static BOOL KlausPIPAlreadyStopped(NSError *error) API_AVAILABLE(macos(14.0));
static BOOL KlausPIPAlreadyStopped(NSError *error) {
    return [error.domain isEqualToString:SCStreamErrorDomain] && error.code == SCStreamErrorAttemptToStopStreamState;
}

@implementation KlausPIPCapture
- (instancetype)init {
    self = [super init];
    if (self) {
        _rootLayer = [CALayer layer];
        _displayLayer = [AVSampleBufferDisplayLayer layer];
        _displayLayer.videoGravity = AVLayerVideoGravityResizeAspect;
        _displayLayer.backgroundColor = NSColor.clearColor.CGColor;
        [_rootLayer addSublayer:_displayLayer];
        _cursorLayer = [CAShapeLayer layer];
        CGMutablePathRef path = CGPathCreateMutable();
        CGPathMoveToPoint(path, NULL, 0, 0);
        CGPathAddLineToPoint(path, NULL, 0, 19);
        CGPathAddLineToPoint(path, NULL, 5, 14);
        CGPathAddLineToPoint(path, NULL, 9, 22);
        CGPathAddLineToPoint(path, NULL, 12, 20);
        CGPathAddLineToPoint(path, NULL, 8, 12);
        CGPathAddLineToPoint(path, NULL, 15, 12);
        CGPathCloseSubpath(path);
        _cursorLayer.path = path;
        CGPathRelease(path);
        _cursorLayer.fillColor = NSColor.blackColor.CGColor;
        _cursorLayer.strokeColor = NSColor.whiteColor.CGColor;
        _cursorLayer.lineWidth = 1;
        _cursorLayer.hidden = YES;
        [_rootLayer addSublayer:_cursorLayer];
        _luminance = 0.3;
    }
    return self;
}
- (BOOL)prepareContext {
    if (self.context) return YES;
    Class contextClass = NSClassFromString(@"CAContext");
    uint32_t (*mainConnection)(void) = dlsym(RTLD_DEFAULT, "CGSMainConnectionID");
    if (!contextClass || !mainConnection ||
        ![contextClass respondsToSelector:@selector(contextWithCGSConnection:options:)]) return NO;
    id<KlausRemoteContext> context = [(id<KlausRemoteContext>)contextClass
                                     contextWithCGSConnection:mainConnection() options:@{}];
    if (!context || ![(id)context respondsToSelector:@selector(contextId)] ||
        ![(id)context respondsToSelector:@selector(setLayer:)]) return NO;
    self.context = context;
    [context setLayer:self.rootLayer];
    return YES;
}
- (void)observeApplication:(pid_t)pid {
    if (self.accessibilityObserver || pid <= 0) return;
    AXObserverRef observer = NULL;
    if (AXObserverCreate(pid, KlausPIPGeometryChanged, &observer) != kAXErrorSuccess) return;
    self.accessibilityObserver = observer;
    self.accessibilityApplication = AXUIElementCreateApplication(pid);
    for (NSString *notification in @[(__bridge NSString *)kAXWindowCreatedNotification,
          (__bridge NSString *)kAXFocusedWindowChangedNotification,
          (__bridge NSString *)kAXMainWindowChangedNotification,
          (__bridge NSString *)kAXWindowResizedNotification,
          (__bridge NSString *)kAXUIElementDestroyedNotification]) {
        AXObserverAddNotification(observer, self.accessibilityApplication,
                                  (__bridge CFStringRef)notification, (__bridge void *)self);
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), kCFRunLoopCommonModes);
}
- (void)refresh {
    if (self.invalidated || self.configuring || self.frozen || !self.service.connection) return;
    self.configuring = YES;
    NSUInteger generation = self.generation;
    __weak KlausPIPCapture *weakSelf = self;
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO
        completionHandler:^(SCShareableContent *content, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            KlausPIPCapture *capture = weakSelf;
            if (!capture || capture.invalidated || capture.generation != generation) return;
            capture.configuring = NO;
            if (error) {
                [capture handleCaptureError:error];
                return;
            }
            [capture configureWithContent:content];
        });
    }];
}
- (void)configureWithContent:(SCShareableContent *)content {
    uint32_t requestedID = [self.source[@"windowId"] unsignedIntValue];
    pid_t pid = [self.source[@"pid"] intValue];
    SCWindow *target = nil;
    for (SCWindow *window in content.windows) {
        if (requestedID && window.windowID == requestedID &&
            (!pid || window.owningApplication.processID == pid)) { target = window; break; }
    }
    if (!requestedID) {
        NSMutableArray<SCWindow *> *candidates = [NSMutableArray array];
        for (SCWindow *window in content.windows) {
            if (window.owningApplication.processID == pid && window.windowLayer == 0 &&
                window.frame.size.width > 1 && window.frame.size.height > 1) [candidates addObject:window];
        }
        for (SCWindow *window in candidates) {
            if (KlausPIPMatchesRequestedBounds(window, self.source[@"bounds"])) { target = window; break; }
        }
        // An approved app target may arrive before a screenshot/window ID.
        // Resolve the app's actual operation window before enumeration order.
        for (NSString *attribute in @[(__bridge NSString *)kAXFocusedWindowAttribute,
                                      (__bridge NSString *)kAXMainWindowAttribute]) {
            if (target) break;
            CGWindowID identifier = KlausPIPApplicationWindow(pid, (__bridge CFStringRef)attribute);
            for (SCWindow *window in candidates) {
                if (identifier && window.windowID == identifier) { target = window; break; }
            }
        }
        if (!target) for (SCWindow *window in candidates) {
            if (!target || (!target.isOnScreen && window.isOnScreen)) target = window;
        }
    }
    if (!target) {
        if (self.published || self.resolvedWindowID) {
            [[self.service.connection remoteObjectProxy] remove:self.source];
        } else {
            [self.service reportFailure:@"The Computer Use source window is unavailable." source:self.source];
        }
        [self invalidate];
        return;
    }
    pid = target.owningApplication.processID;
    self.resolvedWindowID = target.windowID;
    [self observeApplication:pid];
    NSMutableDictionary *resolved = [self.source mutableCopy];
    resolved[@"windowId"] = @(target.windowID);
    resolved[@"pid"] = @(pid);
    self.source = resolved;
    NSMutableArray<SCWindow *> *windows = [NSMutableArray arrayWithObject:target];
    NSArray *associated = [self.source[@"associatedWindowIds"] isKindOfClass:NSArray.class]
        ? self.source[@"associatedWindowIds"] : @[];
    CGRect bounds = target.frame;
    for (SCWindow *window in content.windows) {
        if (window.windowID == target.windowID || window.owningApplication.processID != pid) continue;
        BOOL explicitAssociation = [associated containsObject:@(window.windowID)];
        // Floating windows and menus belong to the active owner, independent
        // document windows do not. Explicit engine ownership wins when known.
        BOOL transient = window.isOnScreen && window.windowLayer > 0 &&
            CGRectIntersectsRect(CGRectInset(target.frame, -32, -32), window.frame);
        if (explicitAssociation || transient) {
            [windows addObject:window];
            bounds = CGRectUnion(bounds, window.frame);
        }
    }
    CGFloat maxSize = self.service.maxDisplaySize;
    NSMutableArray *ids = [NSMutableArray array];
    for (SCWindow *window in windows) [ids addObject:@(window.windowID)];
    NSString *key = [NSString stringWithFormat:@"%@:%@:%g", ids, NSStringFromRect(bounds), maxSize];
    if ([self.geometryKey isEqualToString:key] && self.stream) return;
    if (![self prepareContext]) {
        [self.service reportFailure:@"Native remote Core Animation hosting is unavailable." source:self.source];
        [self invalidate];
        return;
    }
    SCContentFilter *filter;
    SCDisplay *display = nil;
    for (SCDisplay *candidate in content.displays) {
        if (CGRectContainsPoint(candidate.frame, CGPointMake(CGRectGetMidX(bounds), CGRectGetMidY(bounds)))) {
            display = candidate;
            break;
        }
    }
    BOOL composite = windows.count > 1 && display != nil && target.isOnScreen;
    if (composite) filter = [[SCContentFilter alloc] initWithDisplay:display includingWindows:windows];
    else { filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target]; bounds = target.frame; }
    CGFloat scale = maxSize / fmax(bounds.size.width, bounds.size.height);
    CGSize size = CGSizeMake(fmax(1, bounds.size.width * scale), fmax(1, bounds.size.height * scale));
    SCStreamConfiguration *configuration = [SCStreamConfiguration new];
    configuration.pixelFormat = kCVPixelFormatType_32BGRA;
    configuration.showsCursor = NO;
    configuration.queueDepth = 5;
    configuration.minimumFrameInterval = CMTimeMake(1, 60);
    configuration.capturesAudio = NO;
    configuration.ignoreShadowsSingleWindow = YES;
    configuration.ignoreShadowsDisplay = YES;
    configuration.shouldBeOpaque = NO;
    if (@available(macOS 14.2, *)) configuration.includeChildWindows = NO;
    // Capture at native backing scale while presenting in AppKit points.
    CGFloat backingScale = fmax(1, filter.pointPixelScale);
    configuration.width = MAX(1, (NSInteger)ceil(size.width * backingScale));
    configuration.height = MAX(1, (NSInteger)ceil(size.height * backingScale));
    if (composite) configuration.sourceRect = CGRectOffset(bounds, -display.frame.origin.x, -display.frame.origin.y);
    self.sourceBounds = bounds;
    self.displaySize = size;
    self.geometryKey = key;
    self.revision += 1;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    self.rootLayer.frame = (CGRect){CGPointZero, size};
    self.displayLayer.frame = self.rootLayer.bounds;
    [CATransaction commit];
    [CATransaction flush];
    if (self.stream) {
        self.configuring = YES;
        NSUInteger generation = self.generation;
        __weak KlausPIPCapture *weakSelf = self;
        [self.stream updateContentFilter:filter completionHandler:^(NSError *filterError) {
            dispatch_async(dispatch_get_main_queue(), ^{
                KlausPIPCapture *capture = weakSelf;
                if (!capture || capture.invalidated || capture.generation != generation) return;
                if (filterError) {
                    capture.configuring = NO;
                    [capture handleCaptureError:filterError];
                    return;
                }
                [capture.stream updateConfiguration:configuration completionHandler:^(NSError *configurationError) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        KlausPIPCapture *current = weakSelf;
                        if (!current || current.invalidated || current.generation != generation) return;
                        current.configuring = NO;
                        if (configurationError) {
                            [current handleCaptureError:configurationError];
                        } else [current publish];
                    });
                }];
            });
        }];
    } else {
        SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:self];
        self.stream = stream;
        NSError *outputError = nil;
        if (![stream addStreamOutput:self type:SCStreamOutputTypeScreen sampleHandlerQueue:dispatch_get_main_queue()
                               error:&outputError]) {
            [self handleCaptureError:outputError];
            return;
        }
        __weak KlausPIPCapture *weakSelf = self;
        [stream startCaptureWithCompletionHandler:^(NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{
                KlausPIPCapture *capture = weakSelf;
                if (!capture || capture.invalidated || capture.stream != stream) return;
                if (error) {
                    [capture handleCaptureError:error];
                }
            });
        }];
    }
}
- (void)publish {
    if (self.invalidated || !self.context || !self.service.connection || !self.framesEnqueued) return;
    if (self.publishing) { self.publicationPending = YES; return; }
    self.publishing = YES; self.publicationPending = NO;
    NSUInteger ticket = ++self.publicationTicket;
    NSMutableDictionary *presentation = [self.source mutableCopy];
    presentation[@"contextId"] = @([self.context contextId]);
    presentation[@"width"] = @(self.displaySize.width);
    presentation[@"height"] = @(self.displaySize.height);
    presentation[@"revision"] = @(self.revision);
    presentation[@"luminance"] = @(self.luminance);
    presentation[@"framesReceived"] = @(self.framesReceived);
    presentation[@"framesEnqueued"] = @(self.framesEnqueued);
    mach_port_t fencePort = MACH_PORT_NULL;
    if ([(id)self.context respondsToSelector:@selector(createFencePort)] &&
        [(id)self.context respondsToSelector:@selector(setFencePort:)]) {
        fencePort = [self.context createFencePort];
    }
    NSMachPort *fence = fencePort ? [[NSMachPort alloc] initWithMachPort:fencePort options:NSMachPortDeallocateSendRight] : nil;
    // Publish the producer fence after committing its layer changes. The host
    // consumes this fence; the producer must not wait on the same fence.
    [CATransaction flush];
    __weak KlausPIPCapture *weakSelf = self;
    [[self.service.connection remoteObjectProxyWithErrorHandler:^(NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            KlausPIPCapture *capture = weakSelf;
            if (!capture || capture.invalidated || capture.publicationTicket != ticket) return;
            [capture.service reportFailure:error.localizedDescription source:capture.source];
            [capture invalidate];
        });
    }] publish:presentation fence:fence reply:^(BOOL accepted) {
        dispatch_async(dispatch_get_main_queue(), ^{
            KlausPIPCapture *capture = weakSelf;
            if (!capture || capture.invalidated || capture.publicationTicket != ticket) return;
            capture.publishing = NO; capture.published = accepted;
            if (capture.publicationPending) [capture publish];
        });
    }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        KlausPIPCapture *capture = weakSelf;
        if (!capture || capture.invalidated || !capture.publishing || capture.publicationTicket != ticket) return;
        [capture.service reportFailure:@"The preview host acknowledgement timed out." source:capture.source];
        [capture invalidate];
    });
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
        ofType:(SCStreamOutputType)type {
    if (self.invalidated || self.frozen || stream != self.stream || type != SCStreamOutputTypeScreen ||
        !CMSampleBufferIsValid(sampleBuffer)) return;
    NSArray *attachments = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, NO);
    NSNumber *status = attachments.firstObject[SCStreamFrameInfoStatus];
    if (status && status.integerValue != SCFrameStatusComplete) return;
    if (self.displayLayer.status == AVQueuedSampleBufferRenderingStatusFailed) {
        [self.service reportFailure:self.displayLayer.error.localizedDescription ?: @"Preview video rendering failed." source:self.source];
        [self invalidate]; return;
    }
    self.framesReceived++;
    if (self.displayLayer.sampleBufferRenderer.readyForMoreMediaData) {
        [self.displayLayer.sampleBufferRenderer enqueueSampleBuffer:sampleBuffer]; self.framesEnqueued++;
    }
    // A frame must exist before the host may describe a presentation as live.
    if (!self.published && !self.configuring) [self publish];
    CFTimeInterval now = CACurrentMediaTime();
    if (now - self.lastLuminanceSample > 0.3) {
        self.lastLuminanceSample = now;
        CVPixelBufferRef image = CMSampleBufferGetImageBuffer(sampleBuffer);
        if (image && CVPixelBufferLockBaseAddress(image, kCVPixelBufferLock_ReadOnly) == kCVReturnSuccess) {
            size_t width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image);
            size_t rowBytes = CVPixelBufferGetBytesPerRow(image);
            const uint8_t *base = CVPixelBufferGetBaseAddress(image);
            double total = 0;
            NSUInteger samples = 0;
            if (base && width && height) for (size_t x = 0; x < width; x += MAX((size_t)1, width / 12)) {
                const uint8_t *pixel = base + MIN(height - 1, height / 12) * rowBytes + x * 4;
                total += (0.0722 * pixel[0] + 0.7152 * pixel[1] + 0.2126 * pixel[2]) / 255.0;
                samples++;
            }
            CVPixelBufferUnlockBaseAddress(image, kCVPixelBufferLock_ReadOnly);
            double luminance = samples ? total / samples : self.luminance;
            if (fabs(luminance - self.luminance) > 0.15) { self.luminance = luminance; [self publish]; }
        }
    }
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self.invalidated || stream != self.stream) return;
        // The delegate reports a stream that has already stopped. Do not ask
        // ScreenCaptureKit to stop it again during resource cleanup.
        self.stream = nil;
        [self handleCaptureError:error];
    });
}
- (BOOL)sourceHasDisappeared {
    if (!self.resolvedWindowID) return NO;
    pid_t pid = [self.source[@"pid"] intValue];
    if (pid > 0 && kill(pid, 0) == -1 && errno == ESRCH) return YES;
    CFArrayRef descriptions = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, self.resolvedWindowID);
    // A failed metadata lookup is not proof that a source disappeared. Keep
    // reporting the capture failure unless absence is positively established.
    if (!descriptions) return NO;
    BOOL missing = CFArrayGetCount(descriptions) == 0;
    CFRelease(descriptions);
    return missing;
}
- (void)handleCaptureError:(NSError *)error {
    if (self.invalidated) return;
    BOOL permissionFailure = [error.domain isEqualToString:SCStreamErrorDomain] &&
        (error.code == SCStreamErrorUserDeclined || error.code == SCStreamErrorMissingEntitlements);
    if (!permissionFailure && [self sourceHasDisappeared]) {
        [[self.service.connection remoteObjectProxy] remove:self.source];
    } else {
        [self.service reportFailure:error.localizedDescription source:self.source];
    }
    [self invalidate];
}
- (void)setCursor:(NSDictionary *)cursor {
    CGFloat scale = self.displaySize.width / fmax(1, self.sourceBounds.size.width);
    CGPoint point = CGPointMake([cursor[@"x"] doubleValue], [cursor[@"y"] doubleValue]);
    BOOL active = [cursor[@"active"] boolValue] && CGRectContainsPoint(self.sourceBounds, point);
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    self.cursorLayer.hidden = !active;
    self.cursorLayer.position = CGPointMake((point.x - self.sourceBounds.origin.x) * scale,
                                            (point.y - self.sourceBounds.origin.y) * scale);
    [CATransaction commit];
}
- (void)invalidate {
    if (self.invalidated) return;
    self.invalidated = YES;
    self.generation++;
    SCStream *stream = self.stream;
    self.stream = nil;
    [stream stopCaptureWithCompletionHandler:^(NSError *error) {
        if (error && !KlausPIPAlreadyStopped(error)) NSLog(@"[pip] Stop capture: %@", error);
    }];
    [self.context setLayer:nil];
    self.context = nil;
    [self.displayLayer flushAndRemoveImage];
    if (self.accessibilityObserver) {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(self.accessibilityObserver), kCFRunLoopCommonModes);
        CFRelease(self.accessibilityObserver);
        self.accessibilityObserver = NULL;
    }
    if (self.accessibilityApplication) { CFRelease(self.accessibilityApplication); self.accessibilityApplication = NULL; }
}
@end

@implementation KlausPIPService
- (instancetype)init {
    self = [super init];
    if (self) { _captures = [NSMutableDictionary dictionary]; _maxDisplaySize = 200; }
    return self;
}
- (BOOL)listener:(NSXPCListener *)listener shouldAcceptNewConnection:(NSXPCConnection *)connection {
    (void)listener;
    // The endpoint is delivered only over the inherited parent pipe; the PID
    // check also rejects a leaked endpoint handed to an unrelated process.
    if (connection.processIdentifier != self.parentPid || self.connection || self.stopped) return NO;
    self.connection = connection;
    connection.exportedInterface = [NSXPCInterface interfaceWithProtocol:@protocol(KlausPIPProducerProtocol)];
    connection.exportedObject = self;
    connection.remoteObjectInterface = KlausPIPHostInterface();
    __weak KlausPIPService *weakSelf = self;
    connection.invalidationHandler = ^{
        dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf shutdown]; });
    };
    connection.interruptionHandler = connection.invalidationHandler;
    [connection resume];
    self.geometryTimer = [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *timer) {
        (void)timer;
        for (KlausPIPCapture *capture in weakSelf.captures.allValues) [capture refresh];
    }];
    return YES;
}
- (void)reportFailure:(NSString *)message source:(NSDictionary *)source {
    NSString *detail = message.length ? message : @"Native Computer Use capture failed.";
    NSLog(@"[pip] %@", detail);
    [[self.connection remoteObjectProxy] failure:@{@"type": @"error", @"message": detail,
        @"sessionId": KlausPIPString(source[@"sessionId"]), @"presentationId": KlausPIPString(source[@"presentationId"]),
        @"sourceToken": KlausPIPString(source[@"sourceToken"]), @"epoch": source[@"epoch"] ?: @0,
        @"contentRevision": source[@"contentRevision"] ?: @0}];
}
- (void)command:(NSDictionary *)command reply:(void (^)(BOOL))reply {
    NSDictionary *normalized = KlausPIPNormalizeJSON(command);
    if (![normalized isKindOfClass:NSDictionary.class]) { reply(NO); return; }
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self.stopped) { reply(NO); return; }
        [self handleCommand:normalized]; reply(YES);
    });
}
- (void)handleCommand:(NSDictionary *)command {
    NSString *type = KlausPIPString(command[@"type"]);
    if ([type isEqualToString:@"upsertWindow"]) {
        NSString *identifier = KlausPIPString(command[@"presentationId"]);
        if (!identifier.length || !KlausPIPString(command[@"sessionId"]).length) return;
        KlausPIPCapture *existing = self.captures[identifier];
        if (!existing && self.captures.count >= 32) {
            [self reportFailure:@"Native capture source capacity was exceeded." source:command]; return;
        }
        // Preview must not cause a new permission prompt or guess permission.
        if (!CGPreflightScreenCaptureAccess()) {
            [existing invalidate]; [self.captures removeObjectForKey:identifier];
            [self reportFailure:@"Screen Recording permission is required for a live preview." source:command]; return;
        }
        if (existing && !existing.invalidated &&
            [existing.source[@"sourceToken"] isEqual:command[@"sourceToken"]] &&
            [existing.source[@"pid"] isEqual:command[@"pid"]] &&
            (!command[@"windowId"] || [existing.source[@"windowId"] isEqual:command[@"windowId"]])) {
            existing.source = command;
            existing.frozen = NO;
            [existing refresh];
            if (existing.published) [existing publish];
            return;
        }
        [existing invalidate];
        KlausPIPCapture *capture = [KlausPIPCapture new];
        capture.source = command;
        capture.service = self;
        self.captures[identifier] = capture;
        [capture refresh];
    } else if ([type isEqualToString:@"preferences"]) {
        self.maxDisplaySize = KlausPIPMaxSize(command[@"maxDisplaySize"]);
        for (KlausPIPCapture *capture in self.captures.allValues) [capture refresh];
    } else if ([type isEqualToString:@"cursor"]) {
        for (KlausPIPCapture *capture in self.captures.allValues)
            if ([capture.source[@"sessionId"] isEqual:command[@"sessionId"]]) [capture setCursor:command];
    } else if ([type isEqualToString:@"freezeSession"]) {
        for (KlausPIPCapture *capture in self.captures.allValues) {
            if (![capture.source[@"sessionId"] isEqual:command[@"sessionId"]] ||
                (command[@"throughEpoch"] && [capture.source[@"epoch"] unsignedLongLongValue] > [command[@"throughEpoch"] unsignedLongLongValue])) continue;
            capture.frozen = YES;
            capture.generation++;
            capture.configuring = NO;
            SCStream *stream = capture.stream;
            capture.stream = nil;
            capture.geometryKey = nil;
            [stream stopCaptureWithCompletionHandler:^(NSError *error) {
                if (error && !KlausPIPAlreadyStopped(error)) NSLog(@"[pip] Freeze capture: %@", error);
            }];
        }
    } else if ([type isEqualToString:@"remove"] || [type isEqualToString:@"endSession"]) {
        NSArray *ids = [command[@"presentationIds"] isKindOfClass:NSArray.class] ? command[@"presentationIds"] : @[];
        for (NSString *identifier in self.captures.allKeys) {
            KlausPIPCapture *capture = self.captures[identifier];
            if (command[@"throughEpoch"] && [capture.source[@"epoch"] unsignedLongLongValue] > [command[@"throughEpoch"] unsignedLongLongValue]) continue;
            if ([ids containsObject:identifier] || ([type isEqualToString:@"endSession"] &&
                [capture.source[@"sessionId"] isEqual:command[@"sessionId"]])) {
                [capture invalidate];
                [self.captures removeObjectForKey:identifier];
            }
        }
    } else if ([type isEqualToString:@"shutdown"]) [self shutdown];
}
- (void)shutdown {
    if (self.stopped) return;
    self.stopped = YES;
    if (self.parentMonitor) dispatch_source_cancel(self.parentMonitor);
    [self.geometryTimer invalidate];
    for (KlausPIPCapture *capture in self.captures.allValues) [capture invalidate];
    [self.captures removeAllObjects];
    [self.connection invalidate];
    self.connection = nil;
    [self.listener invalidate];
    // The helper is intentionally a dedicated process. Finishing its run loop
    // releases the WindowServer contexts even after the application crashes.
    exit(0);
}
@end

int klaus_pip_service_main(void) {
    @autoreleasepool {
        if (@available(macOS 14.0, *)) {
        pid_t parent = getppid();
        if (parent <= 1) return 1;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        KlausPIPService *service = [KlausPIPService new];
        service.parentPid = parent;
        service.listener = [NSXPCListener anonymousListener];
        service.listener.delegate = service;
        [service.listener resume];
        NSString *rendezvous = [@"com.klaus.pip." stringByAppendingString:NSUUID.UUID.UUIDString];
        if (!KlausPIPServeEndpoint(service.listener.endpoint, rendezvous)) {
            NSLog(@"[pip] Could not create the native XPC endpoint rendezvous."); return 1;
        }
        printf("%s\n", rendezvous.UTF8String);
        fflush(stdout);
        service.parentMonitor = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)parent,
                                                       DISPATCH_PROC_EXIT, dispatch_get_main_queue());
        if (!service.parentMonitor) return 1;
        dispatch_source_set_event_handler(service.parentMonitor, ^{ [service shutdown]; });
        dispatch_resume(service.parentMonitor);
        if (getppid() != parent || kill(parent, 0) != 0) { [service shutdown]; return 1; }
        [NSApp run];
        } else {
            fprintf(stderr, "Native Computer Use picture-in-picture requires macOS 14 or later.\n");
            return 1;
        }
    }
    return 0;
}
