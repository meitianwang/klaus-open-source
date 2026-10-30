#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

// Read only an explicitly identified window owned by this test's Electron PID.
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 4) return 2;
        pid_t pid = (pid_t)strtol(argv[1], NULL, 10);
        CGWindowID window = (CGWindowID)strtoul(argv[2], NULL, 10);
        NSArray *metadata = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, window));
        if (metadata.count != 1 || [metadata[0][(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid || pid <= 1) return 3;
        if (@available(macOS 14.0, *)) {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *content, NSError *error) {
            if (error) { fprintf(stderr, "%s\n", error.localizedDescription.UTF8String); exit(4); }
            SCWindow *target = nil;
            for (SCWindow *candidate in content.windows) if (candidate.windowID == window && candidate.owningApplication.processID == pid) { target = candidate; break; }
            if (!target) exit(4);
            SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
            SCStreamConfiguration *configuration = [SCStreamConfiguration new];
            configuration.width = (NSInteger)target.frame.size.width;
            configuration.height = (NSInteger)target.frame.size.height;
            configuration.showsCursor = NO; configuration.ignoreShadowsSingleWindow = YES;
            [SCScreenshotManager captureImageWithFilter:filter configuration:configuration completionHandler:^(CGImageRef image, NSError *captureError) {
                if (!image || captureError) { fprintf(stderr, "Could not capture the synthetic preview window: %s\n", captureError ? captureError.localizedDescription.UTF8String : "no image returned"); exit(4); }
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:image];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (![png writeToFile:@(argv[3]) atomically:YES]) exit(5);
        // WindowServer screenshots are color managed. Classify dominant colors,
        // not a guessed device profile that turns visible CSS green into RGB .51/.97/.37.
        NSUInteger red = 0, green = 0, blue = 0, samples = 0;
        for (NSInteger y = 0; y < bitmap.pixelsHigh; y += 2) for (NSInteger x = 0; x < bitmap.pixelsWide; x += 2) {
            NSColor *color = [[bitmap colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
            CGFloat r = color.redComponent, g = color.greenComponent, b = color.blueComponent;
            if (r > .55 && r - g > .25 && r - b > .25) red++;
            if (g > .55 && g - r > .25 && g - b > .25) green++;
            if (b > .55 && b - r > .25 && b - g > .25) blue++;
            samples++;
        }
        printf("{\"pid\":%d,\"windowId\":%u,\"width\":%ld,\"height\":%ld,\"red\":%lu,\"green\":%lu,\"blue\":%lu,\"samples\":%lu}\n",
            pid, window, (long)bitmap.pixelsWide, (long)bitmap.pixelsHigh, red, green, blue, samples);
                exit(0);
            }];
        }];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 7 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ exit(6); });
        [NSApp run];
        } else return 7;
    }
    return 1;
}
