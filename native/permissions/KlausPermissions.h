#pragma once
#include <stdint.h>

// Passive observations. They run inside the Electron main process, on a native worker,
// and never ask for consent, launch a target, or present a dialog.
int32_t klaus_automation_permission_status(void);
int32_t klaus_photos_permission_status(void);
int32_t klaus_location_permission_status(void);
int32_t klaus_notification_permission_status(void);

// Explicit consent requests, driven by the user pressing a "grant" button. Unlike the
// passive probes these MAY present the system dialog (and for Automation may launch the
// target). Each returns the raw authorization status after the user answered.
int32_t klaus_automation_request_consent(void);
int32_t klaus_photos_request_authorization(void);
int32_t klaus_notification_request_authorization(void);

#ifdef KLAUS_PERMISSIONS_TESTING
#include <CoreServices/CoreServices.h>
typedef int32_t (*KlausAutomationTargetLookup)(void);
typedef OSStatus (*KlausAutomationPermissionQuery)(const AEAddressDesc *, AEEventClass, AEEventID, Boolean);
OSStatus klaus_automation_permission_probe(KlausAutomationTargetLookup lookup, KlausAutomationPermissionQuery query);
#endif
