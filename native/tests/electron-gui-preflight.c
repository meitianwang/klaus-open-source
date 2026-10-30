#include <dlfcn.h>
#include <stdio.h>
#include <unistd.h>

// This test-only probe does not initialize AppKit or register an application.
// sandbox_check and its filter values follow Chromium/WebKit's Darwin SPI.
typedef int (*sandbox_check_fn)(pid_t, const char *, int, ...);

int main(void) {
    void *library = dlopen("/usr/lib/libsandbox.dylib", RTLD_NOW | RTLD_LOCAL);
    if (library == NULL) {
        fprintf(stderr, "Cannot load macOS sandbox inspection: %s\n", dlerror());
        return 1;
    }
    sandbox_check_fn check = (sandbox_check_fn)dlsym(library, "sandbox_check");
    const int *no_report = (const int *)dlsym(library, "SANDBOX_CHECK_NO_REPORT");
    if (check == NULL || no_report == NULL) {
        fprintf(stderr, "macOS sandbox inspection is unavailable\n");
        dlclose(library);
        return 1;
    }
    int sandboxed = check(getpid(), NULL, 0);
    if (sandboxed == 0) {
        dlclose(library);
        return 0;
    }
    if (sandboxed != 1) {
        fprintf(stderr, "Cannot determine the macOS sandbox state\n");
        dlclose(library);
        return 1;
    }
    const char *services[] = {
        "com.apple.coreservices.launchservicesd",
        "com.apple.windowserver.active",
    };
    int status = 0;
    for (unsigned int i = 0; i < sizeof(services) / sizeof(services[0]); ++i) {
        // SANDBOX_FILTER_GLOBAL_NAME is 2; suppress diagnostic side effects.
        int denied = check(getpid(), "mach-lookup", 2 | *no_report, services[i]);
        if (denied != 0) {
            fprintf(stderr, "%s mach-lookup: %s\n", services[i],
                    denied > 0 ? "denied by macOS sandbox" : "inspection failed");
            status = denied > 0 && status != 1 ? 2 : 1;
        }
    }
    dlclose(library);
    return status;
}
