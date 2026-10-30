#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include "../permissions/KlausPermissions.h"

static int32_t Target;
static OSStatus Status;
static int Queries;

static int32_t Lookup(void) { return Target; }
static OSStatus Query(const AEAddressDesc *target, AEEventClass eventClass, AEEventID eventId, Boolean askUserIfNeeded) {
    Queries++;
    assert(!askUserIfNeeded);
    assert(eventClass == typeWildCard && eventId == typeWildCard);
    // The probe must address the running target by PID: Apple's query resolves the
    // target to a running process, and a bundle-id descriptor measured procNotFound
    // even while System Events ran.
    assert(target->descriptorType == typeKernelProcessID);
    pid_t pid = 0;
    assert(AEGetDescDataSize(target) == (Size)sizeof(pid));
    assert(AEGetDescData(target, &pid, sizeof(pid)) == noErr);
    assert(pid == Target);
    return Status;
}

int main(int argc, char **argv) {
    assert(argc == 3);
    Target = atoi(argv[1]); Status = atoi(argv[2]);
    OSStatus result = klaus_automation_permission_probe(Lookup, Query);
    printf("{\"osStatus\":%d,\"queries\":%d}\n", (int)result, Queries);
    return 0;
}
