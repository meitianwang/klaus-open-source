#import "KlausPIP.h"
#import <dlfcn.h>
#import <servers/bootstrap.h>
#import <xpc/xpc.h>

@interface NSXPCListenerEndpoint (KlausEndpointTransport)
- (xpc_object_t)_endpoint;
- (void)_setEndpoint:(xpc_object_t)endpoint;
@end

typedef xpc_object_t (*KlausXPCPipeCreate)(mach_port_t, uint64_t);
typedef int (*KlausXPCPipeRoutine)(xpc_object_t, xpc_object_t, xpc_object_t *);
typedef int (*KlausXPCPipeReceive)(mach_port_t, xpc_object_t *);
typedef int (*KlausXPCPipeReply)(xpc_object_t);

NSXPCListenerEndpoint *KlausPIPLookupEndpoint(NSString *name) {
    KlausXPCPipeCreate create = dlsym(RTLD_DEFAULT, "xpc_pipe_create_from_port");
    KlausXPCPipeRoutine routine = dlsym(RTLD_DEFAULT, "xpc_pipe_routine");
    if (!create || !routine || ![NSXPCListenerEndpoint instancesRespondToSelector:@selector(_setEndpoint:)]) return nil;
    mach_port_t port = MACH_PORT_NULL;
    if (bootstrap_look_up(bootstrap_port, name.UTF8String, &port) != KERN_SUCCESS) return nil;
    xpc_object_t pipe = create(port, 0);
    mach_port_deallocate(mach_task_self(), port);
    if (!pipe) return nil;
    xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0), reply = nil;
    int result = routine(pipe, request, &reply);
    xpc_object_t raw = !result && reply ? xpc_dictionary_get_value(reply, "endpoint") : nil;
    if (!raw || xpc_get_type(raw) != XPC_TYPE_ENDPOINT) return nil;
    NSXPCListenerEndpoint *endpoint = [NSXPCListenerEndpoint new];
    [endpoint _setEndpoint:raw];
    return endpoint;
}
BOOL KlausPIPServeEndpoint(NSXPCListenerEndpoint *endpoint, NSString *name) {
    KlausXPCPipeReceive receive = dlsym(RTLD_DEFAULT, "xpc_pipe_receive");
    KlausXPCPipeReply replyRoutine = dlsym(RTLD_DEFAULT, "xpc_pipe_routine_reply");
    if (!receive || !replyRoutine || ![endpoint respondsToSelector:@selector(_endpoint)]) return NO;
    mach_port_t port = MACH_PORT_NULL;
    if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &port) != KERN_SUCCESS) return NO;
    if (mach_port_insert_right(mach_task_self(), port, port, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS) {
        mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1); return NO;
    }
    // A randomly named rendezvous is short lived. Launchd never owns or starts
    // the capture process; NSTask and the parent-death monitor own its lifetime.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    kern_return_t registration = bootstrap_register(bootstrap_port, (char *)name.UTF8String, port);
#pragma clang diagnostic pop
    if (registration != KERN_SUCCESS) {
        mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1);
        mach_port_deallocate(mach_task_self(), port); return NO;
    }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        xpc_object_t request = nil;
        int result = receive(port, &request);
        if (!result && request) {
            xpc_object_t reply = xpc_dictionary_create_reply(request);
            if (reply) {
                xpc_dictionary_set_value(reply, "endpoint", [endpoint _endpoint]);
                replyRoutine(reply);
            }
        }
        mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1);
        mach_port_deallocate(mach_task_self(), port);
    });
    return YES;
}
