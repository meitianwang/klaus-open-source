#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../permissions/KlausPermissions.h"
#include "../permissions/KlausPermissionGuide.h"

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
    if (argc == 2 && strcmp(argv[1], "guide-geometry") == 0) {
        // Wide System Settings window: anchor to trailing content area (offset by 230pt sidebar) directly below.
        CGRect wide = klaus_permission_guide_target_frame(
            CGRectMake(200, 300, 715, 540),
            CGRectMake(0, 40, 1440, 835),
            120
        );
        // Bottom-clamped window near screen bottom edge: must stay inside visible screen frame.
        CGRect clamped = klaus_permission_guide_target_frame(
            CGRectMake(200, 60, 715, 540),
            CGRectMake(0, 40, 1440, 835),
            120
        );
        // Narrow window: align to full window leading edge.
        CGRect narrow = klaus_permission_guide_target_frame(
            CGRectMake(100, 300, 420, 400),
            CGRectMake(0, 40, 1440, 835),
            110
        );
        // Coordinate conversion from top-left CG space to bottom-left AppKit space.
        CGRect converted = klaus_permission_guide_convert_cg_rect(
            CGRectMake(100, 200, 715, 540),
            CGRectMake(0, 0, 1440, 900),
            CGRectMake(0, 0, 1440, 900)
        );
        printf("{\"wide\":[%.1f,%.1f,%.1f,%.1f],\"clamped\":[%.1f,%.1f,%.1f,%.1f],\"narrow\":[%.1f,%.1f,%.1f,%.1f],\"converted\":[%.1f,%.1f,%.1f,%.1f]}\n",
            wide.origin.x, wide.origin.y, wide.size.width, wide.size.height,
            clamped.origin.x, clamped.origin.y, clamped.size.width, clamped.size.height,
            narrow.origin.x, narrow.origin.y, narrow.size.width, narrow.size.height,
            converted.origin.x, converted.origin.y, converted.size.width, converted.size.height);
        return 0;
    }
    assert(argc == 3);
    Target = atoi(argv[1]); Status = atoi(argv[2]);
    OSStatus result = klaus_automation_permission_probe(Lookup, Query);
    printf("{\"osStatus\":%d,\"queries\":%d}\n", (int)result, Queries);
    return 0;
}
