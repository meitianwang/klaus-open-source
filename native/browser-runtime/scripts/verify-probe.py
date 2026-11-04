#!/usr/bin/env python3
"""Reject incomplete native-profile probe results."""

import json
from pathlib import Path
import sys

REQUIRED = ("ok", "prefs", "personal_data_manager", "password_store", "web_contents", "electron_context_web_contents", "profile_network_context", "electron_network_context")


def verify(result):
    if not isinstance(result, dict) or result.get("probe") != "native-profile":
        raise ValueError("Unexpected native profile probe result")
    missing = [key for key in REQUIRED if result.get(key) is not True]
    if missing:
        raise ValueError("Native profile checks failed: " + ", ".join(missing))
    if result.get("electron_bridge") is not False:
        raise ValueError("The native profile probe exposed an Electron bridge")
    if result.get("extension_system_state") != "native_services_initialized_dispatch_incomplete":
        raise ValueError("Unexpected extension service state for the Phase 1 probe")


if __name__ == "__main__":
    try:
        result = json.loads(Path(sys.argv[1]).read_text())
        verify(result)
        print(json.dumps(result, indent=2))
    except (ValueError, OSError, IndexError) as error:
        print("error:", error, file=sys.stderr)
        sys.exit(1)
