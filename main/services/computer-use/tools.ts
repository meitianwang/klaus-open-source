// Tool names, schemas and effect annotations retain the committed desktop contract.
// Auto-unlock availability is explicit until a native implementation is verified.
export const COMPUTER_USE_TOOLS = [
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "List the apps on this computer. Returns the set of apps that are currently running, as well as any that have been used in the last 14 days, including details on usage frequency",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {},
      "type": "object"
    },
    "name": "list_apps"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Start an app use session if needed, then return its settled screenshot and accessibility tree. Call once per assistant turn before interacting. Input tools return updated state automatically; derive element indices from that latest state. Do not add manual delays before reading state. If accessibility omits content or remains unchanged, inspect the screenshot to judge the visible result. After an uncertain action or stale-state error, read fresh state before deciding whether to repeat input. If display-name resolution fails, use the exact application path or bundle ID from list_apps.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "app": {
          "description": "App name, full app path, or unambiguous bundle identifier",
          "type": "string"
        },
        "disable_diff": {
          "description": "Return the full accessibility tree instead of the changes since the state you were last shown",
          "type": "boolean"
        }
      },
      "required": [
        "app"
      ],
      "type": "object"
    },
    "name": "get_app_state"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Click an element by index or pixel coordinates from the latest screenshot. Omit element_index when using x and y. Returns the updated screenshot and accessibility state.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "app": {
          "description": "App name, full app path, or unambiguous bundle identifier",
          "type": "string"
        },
        "click_count": {
          "description": "Number of clicks. Defaults to 1",
          "type": "integer"
        },
        "key": {
          "description": "Optional key or '+'-separated chord held across the entire click sequence, then released. Use Shift for range selection or super for individual selection on macOS. Available on macOS.",
          "type": "string"
        },
        "duration": {
          "description": "Seconds to hold each mouse press before releasing it, from 0 to 30. Available on macOS.",
          "type": "number"
        },
        "element_index": {
          "description": "Element index to click",
          "type": "string"
        },
        "mouse_button": {
          "description": "Mouse button to click. Defaults to left.",
          "enum": [
            "left",
            "right",
            "middle",
            "l",
            "r",
            "m"
          ],
          "type": "string"
        },
        "x": {
          "description": "X coordinate in screenshot pixel coordinates",
          "type": "number"
        },
        "y": {
          "description": "Y coordinate in screenshot pixel coordinates",
          "type": "number"
        }
      },
      "required": [
        "app"
      ],
      "type": "object"
    },
    "name": "click"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Invoke a secondary accessibility action exposed by an element",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "action": {
          "description": "Secondary accessibility action name",
          "type": "string"
        },
        "app": {
          "description": "App name, full app path, or unambiguous bundle identifier",
          "type": "string"
        },
        "element_index": {
          "description": "Element identifier",
          "type": "string"
        }
      },
      "required": [
        "app",
        "element_index",
        "action"
      ],
      "type": "object"
    },
    "name": "perform_secondary_action"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Set the value of a settable accessibility element",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "app": {
          "description": "App name, full app path, or unambiguous bundle identifier",
          "type": "string"
        },
        "element_index": {
          "description": "Element identifier",
          "type": "string"
        },
        "value": {
          "description": "Value to assign",
          "type": "string"
        }
      },
      "required": [
        "app",
        "element_index",
        "value"
      ],
      "type": "object"
    },
    "name": "set_value"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Select text inside a text element, or place the text cursor before or after it. Provide text exactly as it appears in the accessibility tree, including any Markdown formatting. If the text is not unique, provide surrounding prefix or suffix text to disambiguate it.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "app": {
          "description": "App name or bundle identifier",
          "type": "string"
        },
        "element_index": {
          "description": "Text element identifier",
          "type": "string"
        },
        "prefix": {
          "description": "Optional text immediately before the target, used to disambiguate repeated matches",
          "type": "string"
        },
        "selection": {
          "description": "Whether to select the text or place the cursor before or after it. Defaults to text.",
          "enum": [
            "text",
            "cursor_before",
            "cursor_after"
          ],
          "type": "string"
        },
        "suffix": {
          "description": "Optional text immediately after the target, used to disambiguate repeated matches",
          "type": "string"
        },
        "text": {
          "description": "Target text as shown in the accessibility tree",
          "type": "string"
        }
      },
      "required": [
        "app",
        "element_index",
        "text"
      ],
      "type": "object"
    },
    "name": "select_text"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Scroll an element or a screenshot point in a direction by a number of pages",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "app": {
          "description": "App name, full app path, or unambiguous bundle identifier",
          "type": "string"
        },
        "direction": {
          "description": "Scroll direction: up, down, left, or right",
          "type": "string"
        },
        "element_index": {
          "description": "Element identifier to scroll. Omit when scrolling at x and y.",
          "type": "string"
        },
        "pages": {
          "description": "Number of pages to scroll. Fractional values are supported. Defaults to 1",
          "type": "number"
        },
        "x": {
          "description": "X coordinate in screenshot pixel coordinates; used only without element_index",
          "type": "number"
        },
        "y": {
          "description": "Y coordinate in screenshot pixel coordinates; used only without element_index",
          "type": "number"
        }
      },
      "required": [
        "app",
        "direction"
      ],
      "type": "object"
    },
    "name": "scroll"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Drag from one point to another using pixel coordinates",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "app": {
          "description": "App name, full app path, or unambiguous bundle identifier",
          "type": "string"
        },
        "from_x": {
          "description": "Start X coordinate",
          "type": "number"
        },
        "from_y": {
          "description": "Start Y coordinate",
          "type": "number"
        },
        "to_x": {
          "description": "End X coordinate",
          "type": "number"
        },
        "to_y": {
          "description": "End Y coordinate",
          "type": "number"
        }
      },
      "required": [
        "app",
        "from_x",
        "from_y",
        "to_x",
        "to_y"
      ],
      "type": "object"
    },
    "name": "drag"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Press and release a key or '+'-separated chord using X Window keysym-style names. Whitespace around '+' is ignored. Examples: a, Return, Tab, super+c, Control_L+a, Page_Down, Next, super+comma, KP_0. Standalone modifiers are released before this call ends; they do not stay held for a later click. Returns updated state after the UI settles.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "app": {
          "description": "App name, full app path, or unambiguous bundle identifier",
          "type": "string"
        },
        "key": {
          "description": "Key or key combination to press",
          "type": "string"
        },
        "duration": {
          "description": "Seconds to hold the key before releasing it, from 0 to 30. The key is released even if the operation is cancelled.",
          "type": "number"
        }
      },
      "required": [
        "app",
        "key"
      ],
      "type": "object"
    },
    "name": "press_key"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Type literal text into the currently focused control in the specified app. Newlines simulate Return and may submit a message or form. Check the returned screenshot and accessibility state to confirm the result.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "app": {
          "description": "App name, full app path, or unambiguous bundle identifier",
          "type": "string"
        },
        "text": {
          "description": "Literal text to type",
          "type": "string"
        }
      },
      "required": [
        "app",
        "text"
      ],
      "type": "object"
    },
    "name": "type_text"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Paste literal text into the currently focused control through the system pasteboard, then restore the user's clipboard. Newlines paste as-is and do not submit a message or form. format md or html additionally offers Markdown or HTML flavors to apps that accept them. Returns the updated screenshot and accessibility state.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "app": {
          "description": "App name, full app path, or unambiguous bundle identifier",
          "type": "string"
        },
        "format": {
          "description": "Pasteboard flavor to offer: text, md, or html. Defaults to text.",
          "enum": [
            "text",
            "md",
            "html"
          ],
          "type": "string"
        },
        "text": {
          "description": "Literal text to paste",
          "type": "string"
        }
      },
      "required": [
        "app",
        "text"
      ],
      "type": "object"
    },
    "name": "paste"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Record the computer's audio output across apps, not the microphone or a single app. Only one recording can be active. Capture stops automatically at max_duration_ms; call stop_audio_recording to retrieve the result. Preserve the user's system volume and mute state; never change them to capture audio.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "max_duration_ms": {
          "description": "Capture limit in milliseconds, from 100 to 300000. Defaults to 60000.",
          "type": "integer"
        }
      },
      "type": "object"
    },
    "name": "start_audio_recording"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Stop the active system audio recording and return it as 24 kHz stereo WAV audio.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {},
      "type": "object"
    },
    "name": "stop_audio_recording"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Read the user's standing Computer Use policy: blocked apps, saved always-allowed apps, and lock-screen auto-unlock. Other local apps can be used after approval. Read this before changing it, because the setter replaces whole lists.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {},
      "type": "object"
    },
    "name": "get_computer_use_policy"
  },
  {
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Record blocked apps, always-allowed apps and lock-screen auto-unlock. Saved app approvals skip the app question; other local apps remain available after approval. Each list is replaced as given, so read the current policy first and send the full list; an omitted field is left alone. Takes effect on the next action, without restarting.",
    "inputSchema": {
      "additionalProperties": false,
      "properties": {
        "auto_unlock": {
          "description": "Arm lock-screen auto-unlock attempts on macOS. Arming without a stored password opens a native secure password dialog and stores it in the keychain; never ask for the password in chat or pass it here. Disarming deletes the stored password. macOS may still require manual unlocking.",
          "type": "boolean"
        },
        "blocked_apps": {
          "description": "Apps that must never be operated, replacing the current list. An empty array blocks nothing. Matching is by substring, so \"terminal\" also covers \"iTerm2 Terminal\"",
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "always_allowed_apps": {
          "description": "Apps that may be used without asking again, replacing the saved app approvals. Other local apps remain available after approval. An empty array clears saved approvals.",
          "items": {
            "type": "string"
          },
          "type": "array"
        }
      },
      "type": "object"
    },
    "name": "set_computer_use_policy"
  }
] as const;
