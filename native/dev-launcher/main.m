//
//  main.m
//  klaus-dev-launcher
//
//  A small native helper that launches an immutable .app bundle through
//  NSWorkspaceOpenConfiguration, reports lifecycle events over stdout as NDJSON,
//  and monitors the exact NSRunningApplication instance until it exits.
//

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <unistd.h>

// 8 MiB matches the bounded JSON contract on the JS side.
static const NSUInteger kMaxInputBytes = 8 * 1024 * 1024;
static const NSUInteger kMaxPathBytes = 4096;
static const NSUInteger kMaxArgumentCount = 64;
static const NSUInteger kMaxArgumentBytes = 4096;
static const NSUInteger kMaxEnvironmentKeyBytes = 256;
static const NSUInteger kMaxEnvironmentValueBytes = 64 * 1024;
static const NSTimeInterval kLaunchTimeoutSeconds = 120.0;
static const NSTimeInterval kTerminationPollSeconds = 0.5;

static BOOL gFinished = NO;
static int gExitCode = 1;

#pragma mark - Validation helpers

static void EmitLine(NSDictionary *event) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:&error];
  if (!data) return;

  if (fwrite(data.bytes, 1, data.length, stdout) != data.length) {
    // Ignore write errors; the parent may have closed the pipe.
  }
  fputc('\n', stdout);
  fflush(stdout);
}

static void EmitError(NSString *message) {
  EmitLine(@{@"type": @"error", @"message": message});
}

static void Finish(int code) {
  gExitCode = code;
  gFinished = YES;
  CFRunLoopStop(CFRunLoopGetMain());
}

static BOOL IsValidAbsolutePath(NSString *value) {
  if (![value isKindOfClass:[NSString class]] || value.length == 0) return NO;
  if (value.length > kMaxPathBytes) return NO;
  if (![value isAbsolutePath]) return NO;
  // JSON may contain embedded NUL via \u0000.
  if ([value rangeOfString:@"\0"].location != NSNotFound) return NO;
  return YES;
}

static BOOL IsValidEnvironmentKey(NSString *value) {
  if (![value isKindOfClass:[NSString class]] || value.length == 0) return NO;
  if (value.length > kMaxEnvironmentKeyBytes) return NO;
  if ([value rangeOfString:@"="].location != NSNotFound) return NO;
  if ([value rangeOfString:@"\0"].location != NSNotFound) return NO;
  // Restrict to printable ASCII so we do not pass arbitrary control sequences.
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithRange:NSMakeRange(0x21, 0x5E)]; // '!'-'~'
  NSCharacterSet *disallowed = [allowed invertedSet];
  if ([value rangeOfCharacterFromSet:disallowed].location != NSNotFound) return NO;
  return YES;
}

static BOOL IsValidEnvironmentValue(NSString *value) {
  if (![value isKindOfClass:[NSString class]]) return NO;
  if (value.length > kMaxEnvironmentValueBytes) return NO;
  if ([value rangeOfString:@"\0"].location != NSNotFound) return NO;
  return YES;
}

static NSData *ReadStdin(void) {
  NSMutableData *buffer = [NSMutableData data];
  uint8_t chunk[65536];

  while (YES) {
    ssize_t count = read(STDIN_FILENO, chunk, sizeof(chunk));
    if (count > 0) {
      if (buffer.length + (NSUInteger)count > kMaxInputBytes) {
        EmitError(@"Input exceeded 8 MiB limit.");
        Finish(1);
        return nil;
      }
      [buffer appendBytes:chunk length:(NSUInteger)count];
    } else if (count == 0) {
      break;
    } else if (errno == EINTR) {
      continue;
    } else {
      EmitError(@"Failed to read stdin.");
      Finish(1);
      return nil;
    }
  }

  return buffer;
}

static NSDictionary *ParsePayload(NSData *data) {
  NSError *error = nil;
  id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (![object isKindOfClass:[NSDictionary class]]) {
    EmitError(@"Payload must be a JSON object.");
    return nil;
  }

  NSDictionary *payload = object;

  // bundlePath: absolute path to the .app bundle.
  NSString *bundlePath = payload[@"bundlePath"];
  if (!IsValidAbsolutePath(bundlePath)) {
    EmitError(@"bundlePath must be an absolute path.");
    return nil;
  }
  if (![bundlePath hasSuffix:@".app"]) {
    EmitError(@"bundlePath must reference a .app bundle.");
    return nil;
  }

  // arguments: array of strings, each absolute, passed to the new instance.
  id rawArgs = payload[@"arguments"];
  if (![rawArgs isKindOfClass:[NSArray class]] || [rawArgs count] == 0) {
    EmitError(@"arguments must be a non-empty array of strings.");
    return nil;
  }
  if ([rawArgs count] > kMaxArgumentCount) {
    EmitError(@"arguments contains too many entries.");
    return nil;
  }
  NSMutableArray<NSString *> *arguments = [NSMutableArray arrayWithCapacity:[rawArgs count]];
  for (id item in rawArgs) {
    if (![item isKindOfClass:[NSString class]] ||
        ![item isAbsolutePath] ||
        [item length] > kMaxArgumentBytes ||
        [item rangeOfString:@"\0"].location != NSNotFound) {
      EmitError(@"Each argument must be an absolute string without embedded NUL.");
      return nil;
    }
    [arguments addObject:item];
  }

  // environment: string -> string, no NUL values.
  id rawEnv = payload[@"environment"];
  if (![rawEnv isKindOfClass:[NSDictionary class]]) {
    EmitError(@"environment must be a JSON object mapping strings to strings.");
    return nil;
  }
  NSMutableDictionary<NSString *, NSString *> *environment = [NSMutableDictionary dictionaryWithCapacity:[rawEnv count]];
  for (id key in rawEnv) {
    id value = rawEnv[key];
    if (!IsValidEnvironmentKey(key) || !IsValidEnvironmentValue(value)) {
      EmitError(@"Invalid environment entry.");
      return nil;
    }
    environment[key] = value;
  }

  // logDirectory: absolute directory used for helper diagnostics only.
  NSString *logDirectory = payload[@"logDirectory"];
  if (!IsValidAbsolutePath(logDirectory)) {
    EmitError(@"logDirectory must be an absolute path.");
    return nil;
  }

  // Validate the .app bundle and locate its executable.
  NSURL *bundleURL = [NSURL fileURLWithPath:bundlePath isDirectory:YES];
  NSFileManager *fm = [NSFileManager defaultManager];
  BOOL isDirectory = NO;
  if (![fm fileExistsAtPath:bundlePath isDirectory:&isDirectory] || !isDirectory) {
    EmitError(@"bundlePath does not exist or is not a directory.");
    return nil;
  }

  NSBundle *bundle = [NSBundle bundleWithURL:bundleURL];
  NSURL *executableURL = bundle.executableURL;
  if (!executableURL) {
    EmitError(@"Could not determine the bundle executable.");
    return nil;
  }
  if (![fm fileExistsAtPath:executableURL.path]) {
    EmitError(@"Bundle executable does not exist.");
    return nil;
  }

  // Ensure the log directory exists so the caller may capture app output there.
  if (![fm fileExistsAtPath:logDirectory isDirectory:&isDirectory] || !isDirectory) {
    NSError *createError = nil;
    if (![fm createDirectoryAtPath:logDirectory withIntermediateDirectories:YES attributes:nil error:&createError]) {
      EmitError([NSString stringWithFormat:@"Could not create logDirectory: %@", createError.localizedDescription]);
      return nil;
    }
  }

  return @{
    @"bundlePath": bundlePath,
    @"bundleURL": bundleURL,
    @"arguments": [arguments copy],
    @"environment": [environment copy],
  };
}

#pragma mark - Lifecycle observer

@interface LauncherObserver : NSObject
@property (nonatomic, strong) NSRunningApplication *application;
@property (nonatomic, assign) BOOL reportedTerminated;
@property (nonatomic, assign) pid_t launchedPID;
@end

@implementation LauncherObserver

- (void)reportTermination {
  if (self.reportedTerminated) return;
  self.reportedTerminated = YES;

  @try {
    [self.application removeObserver:self forKeyPath:@"terminated"];
  } @catch (NSException *) {
    // Already removed or never added.
  }

  EmitLine(@{
    @"type": @"terminated",
    @"pid": @(self.launchedPID),
  });

  Finish(0);
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context {
  #pragma unused(object, change, context)
  if ([keyPath isEqualToString:@"terminated"] && self.application.isTerminated) {
    [self reportTermination];
  }
}

- (void)poll:(NSTimer *)timer {
  #pragma unused(timer)
  if (self.application.isTerminated) {
    [self reportTermination];
  }
}

@end

#pragma mark - Main

int main(int argc, const char *argv[]) {
  #pragma unused(argc, argv)
  // Terminal signals are handled by the parent through the authenticated
  // application channel. Keep observing until that application's real exit.
  signal(SIGINT, SIG_IGN);
  signal(SIGTERM, SIG_IGN);

  @autoreleasepool {
    NSData *input = ReadStdin();
    if (gFinished) return gExitCode;

    NSDictionary *payload = ParsePayload(input);
    if (!payload) {
      if (!gFinished) Finish(1);
      return gExitCode;
    }

    NSURL *bundleURL = payload[@"bundleURL"];
    NSArray<NSString *> *arguments = payload[@"arguments"];
    NSDictionary<NSString *, NSString *> *environment = payload[@"environment"];

    NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
    configuration.createsNewApplicationInstance = YES;
    configuration.allowsRunningApplicationSubstitution = NO;
    configuration.activates = YES;
    configuration.addsToRecentItems = NO;
    configuration.arguments = arguments;
    configuration.environment = environment;

    LauncherObserver *observer = [[LauncherObserver alloc] init];

    __block BOOL completionReceived = NO;

    NSTimer *timeoutTimer = [NSTimer scheduledTimerWithTimeInterval:kLaunchTimeoutSeconds
                                                            repeats:NO
                                                              block:^(NSTimer * _Nonnull timer) {
      #pragma unused(timer)
      if (completionReceived) return;
      EmitError(@"Timed out waiting for NSWorkspace launch completion.");
      Finish(1);
    }];

    [[NSWorkspace sharedWorkspace] openApplicationAtURL:bundleURL
                                          configuration:configuration
                                      completionHandler:^(NSRunningApplication *app, NSError *error) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (completionReceived) return;
        completionReceived = YES;
        [timeoutTimer invalidate];

        if (error) {
          EmitError([NSString stringWithFormat:@"Launch failed: %@", error.localizedDescription]);
          Finish(1);
          return;
        }

        if (!app) {
          EmitError(@"Launch completed but no running application was returned.");
          Finish(1);
          return;
        }

        observer.application = app;
        observer.launchedPID = app.processIdentifier;
        if (observer.launchedPID <= 0) {
          EmitError(@"The application exited before its launch identity was available.");
          Finish(1);
          return;
        }

        EmitLine(@{
          @"type": @"launched",
          @"pid": @(observer.launchedPID),
        });

        if (app.isTerminated) {
          [observer reportTermination];
          return;
        }

        [app addObserver:observer
              forKeyPath:@"terminated"
                 options:NSKeyValueObservingOptionNew
                 context:NULL];

        [NSTimer scheduledTimerWithTimeInterval:kTerminationPollSeconds
                                         target:observer
                                       selector:@selector(poll:)
                                       userInfo:nil
                                        repeats:YES];
      });
    }];

    while (!gFinished) {
      @autoreleasepool {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                  beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.25]];
      }
    }
  }

  return gExitCode;
}
