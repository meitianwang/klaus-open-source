#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <mach/mach.h>

// Only presentation metadata and Mach rights cross this connection. Native
// window pixels stay in the WindowServer/Core Animation capture pipeline.
@protocol KlausPIPHostProtocol
- (void)publish:(NSDictionary *)presentation fence:(NSMachPort *)fence reply:(void (^)(BOOL))reply;
- (void)remove:(NSDictionary *)presentation;
- (void)failure:(NSDictionary *)failure;
@end

@protocol KlausPIPProducerProtocol
- (void)command:(NSDictionary *)command reply:(void (^)(BOOL))reply;
@end

@protocol KlausRemoteContext
+ (id)contextWithCGSConnection:(uint32_t)connection options:(NSDictionary *)options;
- (uint32_t)contextId;
- (void)setLayer:(CALayer *)layer;
- (mach_port_t)createFencePort;
- (void)setFencePort:(mach_port_t)port;
@end

@interface CALayer (KlausRemoteHosting)
- (void)setContextId:(uint32_t)contextID;
- (void)setFencePort:(mach_port_t)port;
@end

typedef void (*KlausPIPEventCallback)(uint64_t generation, const char *json);
int klaus_pip_service_main(void);
int klaus_pip_supported(void);
int klaus_pip_host_open(void *view, const char *helper, uint64_t generation, KlausPIPEventCallback event);
int klaus_pip_host_command(uint64_t generation, const char *json);
void klaus_pip_host_shutdown(uint64_t generation);
int klaus_pip_host_pending(uint64_t generation, int force);
char *klaus_pip_host_inspect(uint64_t generation);
void klaus_pip_free(char *value);
BOOL KlausPIPServeEndpoint(NSXPCListenerEndpoint *endpoint, NSString *name);
NSXPCListenerEndpoint *KlausPIPLookupEndpoint(NSString *name);

// JSON null is NSNull, which does not implement numeric conversion selectors.
// Normalize optionals at both JSON/XPC command boundaries before dispatch.
static inline id KlausPIPNormalizeJSON(id value) {
    if (!value || value == NSNull.null) return nil;
    if ([value isKindOfClass:NSDictionary.class]) {
        NSMutableDictionary *result = [NSMutableDictionary dictionary];
        for (id key in value) {
            id normalized = KlausPIPNormalizeJSON(value[key]);
            if ([key isKindOfClass:NSString.class] && normalized) result[key] = normalized;
        }
        return result;
    }
    if ([value isKindOfClass:NSArray.class]) {
        NSMutableArray *result = [NSMutableArray array];
        for (id child in value) { id normalized = KlausPIPNormalizeJSON(child); if (normalized) [result addObject:normalized]; }
        return result;
    }
    return value;
}

static inline NSString *KlausPIPString(id value) {
    return [value isKindOfClass:NSString.class] ? value : @"";
}
static inline CGFloat KlausPIPMaxSize(id value) {
    double number = [value respondsToSelector:@selector(doubleValue)] ? [value doubleValue] : 200;
    return isfinite(number) ? fmin(400, fmax(100, number)) : 200;
}
static inline NSXPCInterface *KlausPIPHostInterface(void) {
    NSXPCInterface *interface = [NSXPCInterface interfaceWithProtocol:@protocol(KlausPIPHostProtocol)];
    [interface setClasses:[NSSet setWithObjects:NSDictionary.class, NSMutableDictionary.class,
        NSArray.class, NSString.class, NSNumber.class, NSNull.class, nil]
            forSelector:@selector(publish:fence:reply:) argumentIndex:0 ofReply:NO];
    [interface setClasses:[NSSet setWithObject:NSMachPort.class]
            forSelector:@selector(publish:fence:reply:) argumentIndex:1 ofReply:NO];
    return interface;
}
