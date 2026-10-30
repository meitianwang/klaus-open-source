import type { MacOsTool } from './types';

// Existing connector tool names, order, schemas and effect hints are a pinned product contract.
export const MACOS_TOOL_CONTRACTS: Record<'macos-finder' | 'macos-shortcuts' | 'macos-system' | 'macos-calendar' | 'macos-contacts' | 'macos-reminders' | 'macos-notes' | 'macos-mail' | 'macos-messages' | 'macos-safari' | 'macos-app-ui' | 'macos-photos', MacOsTool[]> = {
  "macos-finder": [
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Get POSIX paths of the items currently selected in the frontmost Finder window.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "get_selection"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Read Finder tags attached to a path. Returns array of tag names.",
      "inputSchema": {
        "properties": {
          "path": {
            "type": "string"
          }
        },
        "required": [
          "path"
        ],
        "type": "object"
      },
      "name": "get_tags"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Open Finder and highlight the given path (does not open/edit the file).",
      "inputSchema": {
        "properties": {
          "path": {
            "type": "string"
          }
        },
        "required": [
          "path"
        ],
        "type": "object"
      },
      "name": "reveal_file"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Replace Finder tags on a path. Pass an array of tag names (empty array clears tags).",
      "inputSchema": {
        "properties": {
          "path": {
            "type": "string"
          },
          "tags": {
            "items": {
              "type": "string"
            },
            "type": "array"
          }
        },
        "required": [
          "path",
          "tags"
        ],
        "type": "object"
      },
      "name": "set_tags"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Move a file/folder to the Trash (recoverable from Trash). Safer than rm. Path must exist.",
      "inputSchema": {
        "properties": {
          "path": {
            "type": "string"
          }
        },
        "required": [
          "path"
        ],
        "type": "object"
      },
      "name": "move_to_trash"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Read the Finder comment (aka Spotlight comment) attached to a path.",
      "inputSchema": {
        "properties": {
          "path": {
            "type": "string"
          }
        },
        "required": [
          "path"
        ],
        "type": "object"
      },
      "name": "get_comment"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Set the Finder comment on a path (overwrites any existing comment).",
      "inputSchema": {
        "properties": {
          "comment": {
            "type": "string"
          },
          "path": {
            "type": "string"
          }
        },
        "required": [
          "path",
          "comment"
        ],
        "type": "object"
      },
      "name": "set_comment"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Get file metadata: size (bytes), kind (file/folder/alias), creation and modification timestamps.",
      "inputSchema": {
        "properties": {
          "path": {
            "type": "string"
          }
        },
        "required": [
          "path"
        ],
        "type": "object"
      },
      "name": "get_file_info"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List the contents of a folder with Finder metadata (name, kind, size, tags). Non-recursive.",
      "inputSchema": {
        "properties": {
          "limit": {
            "default": 200,
            "type": "number"
          },
          "path": {
            "type": "string"
          }
        },
        "required": [
          "path"
        ],
        "type": "object"
      },
      "name": "list_folder"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Open a file with its default application (equivalent to macOS `open <path>`).",
      "inputSchema": {
        "properties": {
          "path": {
            "type": "string"
          }
        },
        "required": [
          "path"
        ],
        "type": "object"
      },
      "name": "open_file"
    }
  ],
  "macos-shortcuts": [
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List all installed Shortcuts on this Mac. Requires macOS 12 or later.",
      "inputSchema": {
        "properties": {
          "folder": {
            "description": "Optional folder filter",
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "list_shortcuts"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Run a Shortcut by exact name. Pass optional text input; returns text output if the shortcut produces any.",
      "inputSchema": {
        "properties": {
          "input": {
            "description": "Text input to pipe to the shortcut (optional)",
            "type": "string"
          },
          "name": {
            "description": "Exact Shortcut name",
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "run_shortcut"
    }
  ],
  "macos-system": [
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Read the current clipboard as plain text.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "read_clipboard"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Search local files with Spotlight (mdfind). Use raw Spotlight query syntax or a plain keyword.",
      "inputSchema": {
        "properties": {
          "limit": {
            "default": 50,
            "type": "number"
          },
          "onlyin": {
            "description": "Limit search to a directory (optional)",
            "type": "string"
          },
          "query": {
            "description": "Spotlight query (e.g. \"kMDItemKind == 'PDF document'\" or plain keyword)",
            "type": "string"
          }
        },
        "required": [
          "query"
        ],
        "type": "object"
      },
      "name": "spotlight_search"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Write plain text to the clipboard. Overwrites current contents.",
      "inputSchema": {
        "properties": {
          "text": {
            "type": "string"
          }
        },
        "required": [
          "text"
        ],
        "type": "object"
      },
      "name": "write_clipboard"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Take a screenshot. Defaults to fullscreen in the per-call Klaus workspace artifact directory. Optional `region` = \"x,y,w,h\" for a rectangular capture. Optional `path` for custom location.",
      "inputSchema": {
        "properties": {
          "path": {
            "description": "Absolute path. Defaults to the per-call Klaus workspace artifact directory.",
            "type": "string"
          },
          "region": {
            "description": "Rectangular region \"x,y,w,h\" (optional)",
            "type": "string"
          },
          "silent": {
            "default": true,
            "description": "Suppress shutter sound",
            "type": "boolean"
          }
        },
        "type": "object"
      },
      "name": "capture_screen"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Display a macOS system notification.",
      "inputSchema": {
        "properties": {
          "message": {
            "type": "string"
          },
          "subtitle": {
            "type": "string"
          },
          "title": {
            "type": "string"
          }
        },
        "required": [
          "title",
          "message"
        ],
        "type": "object"
      },
      "name": "show_notification"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List the names of currently running applications (from System Events).",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "list_running_apps"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Launch or activate an application by name (e.g. \"Safari\", \"Messages\", \"TextEdit\").",
      "inputSchema": {
        "properties": {
          "name": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "open_app"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Set system output volume (0–100).",
      "inputSchema": {
        "properties": {
          "level": {
            "description": "0 (mute) to 100 (max)",
            "type": "number"
          }
        },
        "required": [
          "level"
        ],
        "type": "object"
      },
      "name": "set_volume"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Show a macOS system dialog. Returns the button the user clicked, or an error if they canceled / timed out. Useful for confirmation before destructive actions or asking user for a quick decision.",
      "inputSchema": {
        "properties": {
          "buttons": {
            "description": "Up to 3 button labels (default: [\"OK\"])",
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "defaultButton": {
            "type": "string"
          },
          "message": {
            "type": "string"
          },
          "timeoutSeconds": {
            "default": 60,
            "type": "number"
          },
          "title": {
            "type": "string"
          }
        },
        "required": [
          "message"
        ],
        "type": "object"
      },
      "name": "show_dialog"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Request macOS screen locking using the system shortcut. A successful request does not confirm the locked state.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "lock_screen"
    }
  ],
  "macos-calendar": [
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List calendar events in a date range. If calendarName is omitted, searches all calendars.",
      "inputSchema": {
        "properties": {
          "calendarName": {
            "type": "string"
          },
          "endDate": {
            "description": "ISO 8601 datetime (inclusive)",
            "type": "string"
          },
          "limit": {
            "default": 100,
            "type": "number"
          },
          "startDate": {
            "description": "ISO 8601 datetime (inclusive)",
            "type": "string"
          }
        },
        "required": [
          "startDate",
          "endDate"
        ],
        "type": "object"
      },
      "name": "list_events"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Search calendar events by keyword in summary or notes, optionally bounded by a date range.",
      "inputSchema": {
        "properties": {
          "endDate": {
            "type": "string"
          },
          "limit": {
            "default": 50,
            "type": "number"
          },
          "query": {
            "type": "string"
          },
          "startDate": {
            "type": "string"
          }
        },
        "required": [
          "query"
        ],
        "type": "object"
      },
      "name": "search_events"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Create a new calendar event. `calendarName` defaults to the first calendar.",
      "inputSchema": {
        "properties": {
          "calendarName": {
            "type": "string"
          },
          "endDate": {
            "description": "ISO 8601 datetime",
            "type": "string"
          },
          "location": {
            "type": "string"
          },
          "notes": {
            "type": "string"
          },
          "startDate": {
            "description": "ISO 8601 datetime",
            "type": "string"
          },
          "title": {
            "type": "string"
          }
        },
        "required": [
          "title",
          "startDate",
          "endDate"
        ],
        "type": "object"
      },
      "name": "create_event"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Delete a calendar event by exact title match on a given start date.",
      "inputSchema": {
        "properties": {
          "startDate": {
            "description": "ISO 8601 datetime of the event to delete",
            "type": "string"
          },
          "title": {
            "type": "string"
          }
        },
        "required": [
          "title",
          "startDate"
        ],
        "type": "object"
      },
      "name": "delete_event"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List all calendars on this Mac (name + account).",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "list_calendars"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Get the full details of a single event by title + start date (first match). Returns all fields: calendar, summary, start/end, location, notes, attendees (by email), all-day flag.",
      "inputSchema": {
        "properties": {
          "startDate": {
            "description": "ISO 8601 datetime",
            "type": "string"
          },
          "title": {
            "type": "string"
          }
        },
        "required": [
          "title",
          "startDate"
        ],
        "type": "object"
      },
      "name": "get_event"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Update a calendar event: change title, time, location, or notes. Matches by current title + start date. Pass any combination of new* fields.",
      "inputSchema": {
        "properties": {
          "newEnd": {
            "description": "ISO 8601",
            "type": "string"
          },
          "newLocation": {
            "type": "string"
          },
          "newNotes": {
            "type": "string"
          },
          "newStart": {
            "description": "ISO 8601",
            "type": "string"
          },
          "newTitle": {
            "type": "string"
          },
          "startDate": {
            "description": "Current start date (ISO 8601) — used to locate the event",
            "type": "string"
          },
          "title": {
            "description": "Current title",
            "type": "string"
          }
        },
        "required": [
          "title",
          "startDate"
        ],
        "type": "object"
      },
      "name": "update_event"
    }
  ],
  "macos-contacts": [
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Search contacts by name. Returns display name, primary phone, primary email.",
      "inputSchema": {
        "properties": {
          "limit": {
            "default": 30,
            "type": "number"
          },
          "query": {
            "type": "string"
          }
        },
        "required": [
          "query"
        ],
        "type": "object"
      },
      "name": "search_contacts"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Read full contact details by exact name match.",
      "inputSchema": {
        "properties": {
          "name": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "read_contact"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Create a new contact. Pass at least firstName; optionally lastName, phone, email.",
      "inputSchema": {
        "properties": {
          "email": {
            "type": "string"
          },
          "firstName": {
            "type": "string"
          },
          "lastName": {
            "type": "string"
          },
          "organization": {
            "type": "string"
          },
          "phone": {
            "type": "string"
          }
        },
        "required": [
          "firstName"
        ],
        "type": "object"
      },
      "name": "create_contact"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List all contact groups.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "list_groups"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Update an existing contact by exact name match. Replaces primary phone / email / organization / name fields when provided.",
      "inputSchema": {
        "properties": {
          "name": {
            "description": "Current full name (first + last as displayed)",
            "type": "string"
          },
          "newEmail": {
            "description": "Replaces the first email entry (or creates one)",
            "type": "string"
          },
          "newFirstName": {
            "type": "string"
          },
          "newLastName": {
            "type": "string"
          },
          "newOrganization": {
            "type": "string"
          },
          "newPhone": {
            "description": "Replaces the first phone entry (or creates one)",
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "update_contact"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Delete a contact by exact name match. Irreversible.",
      "inputSchema": {
        "properties": {
          "name": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "delete_contact"
    }
  ],
  "macos-reminders": [
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List reminders in a given list. If listName is omitted, returns the names of all reminder lists instead. `completed=false` (default) skips completed items.",
      "inputSchema": {
        "properties": {
          "completed": {
            "default": false,
            "description": "Include completed reminders",
            "type": "boolean"
          },
          "limit": {
            "default": 100,
            "description": "Max reminders to return",
            "type": "number"
          },
          "listName": {
            "description": "Reminder list name (optional)",
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "list_reminders"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Search reminders across all lists by case-insensitive keyword match on name or body.",
      "inputSchema": {
        "properties": {
          "completed": {
            "default": false,
            "description": "Include completed reminders",
            "type": "boolean"
          },
          "limit": {
            "default": 50,
            "type": "number"
          },
          "query": {
            "description": "Search keyword",
            "type": "string"
          }
        },
        "required": [
          "query"
        ],
        "type": "object"
      },
      "name": "search_reminders"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Create a new reminder. `listName` defaults to the default list; `dueDate` is an ISO-8601 string (optional).",
      "inputSchema": {
        "properties": {
          "body": {
            "description": "Note / body text",
            "type": "string"
          },
          "dueDate": {
            "description": "ISO 8601 datetime, e.g. 2026-04-20T09:00:00",
            "type": "string"
          },
          "listName": {
            "type": "string"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "create_reminder"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Mark a reminder as completed. Matches the first reminder with the given name in the specified list.",
      "inputSchema": {
        "properties": {
          "listName": {
            "type": "string"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "complete_reminder"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Delete a reminder by name. Matches the first reminder with the given name in the specified list.",
      "inputSchema": {
        "properties": {
          "listName": {
            "type": "string"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "delete_reminder"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List all reminder lists (names only).",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "list_reminder_lists"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Update a reminder: change its name, due date, body, or priority. Matches the first reminder with the given name.",
      "inputSchema": {
        "properties": {
          "listName": {
            "type": "string"
          },
          "name": {
            "description": "Current name of the reminder",
            "type": "string"
          },
          "newBody": {
            "type": "string"
          },
          "newDueDate": {
            "description": "ISO 8601 datetime, or empty string to clear",
            "type": "string"
          },
          "newName": {
            "type": "string"
          },
          "priority": {
            "description": "0 = none, 1 = high, 5 = medium, 9 = low",
            "type": "number"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "update_reminder"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Create a new reminder list.",
      "inputSchema": {
        "properties": {
          "name": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "create_reminder_list"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Delete a reminder list (and all reminders inside it). Irreversible.",
      "inputSchema": {
        "properties": {
          "name": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "delete_reminder_list"
    }
  ],
  "macos-notes": [
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List notes (name + modified date). Optionally filter by folder. Results are body-free; use read_note to get content.",
      "inputSchema": {
        "properties": {
          "folderName": {
            "type": "string"
          },
          "limit": {
            "default": 100,
            "type": "number"
          }
        },
        "type": "object"
      },
      "name": "list_notes"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Search notes by keyword in title or body. Returns name + snippet.",
      "inputSchema": {
        "properties": {
          "limit": {
            "default": 30,
            "type": "number"
          },
          "query": {
            "type": "string"
          }
        },
        "required": [
          "query"
        ],
        "type": "object"
      },
      "name": "search_notes"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Read the full body of a note by title (first match). Returns plain-text (HTML stripped).",
      "inputSchema": {
        "properties": {
          "folderName": {
            "description": "Optionally scope to a folder",
            "type": "string"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "read_note"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Create a new note. Body is plain text (line breaks preserved).",
      "inputSchema": {
        "properties": {
          "body": {
            "type": "string"
          },
          "folderName": {
            "type": "string"
          },
          "title": {
            "type": "string"
          }
        },
        "required": [
          "title",
          "body"
        ],
        "type": "object"
      },
      "name": "create_note"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Update a note: change its title, body, or move it to another folder. Matches first note with the given title (optionally scoped to `folderName`). Pass any combination of newTitle/newBody/newFolder.",
      "inputSchema": {
        "properties": {
          "folderName": {
            "description": "Optional: restrict search to this folder",
            "type": "string"
          },
          "newBody": {
            "description": "Plain text (line breaks preserved) — replaces the entire body",
            "type": "string"
          },
          "newFolder": {
            "description": "Move the note to this folder",
            "type": "string"
          },
          "newTitle": {
            "type": "string"
          },
          "title": {
            "description": "Current title of the note to update",
            "type": "string"
          }
        },
        "required": [
          "title"
        ],
        "type": "object"
      },
      "name": "update_note"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Delete a note by title. Matches the first note with the given title (optionally scoped to folderName). Recovery depends on the Notes account; do not assume the note can be recovered.",
      "inputSchema": {
        "properties": {
          "folderName": {
            "type": "string"
          },
          "title": {
            "type": "string"
          }
        },
        "required": [
          "title"
        ],
        "type": "object"
      },
      "name": "delete_note"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Append content to the end of an existing note (does not overwrite). Adds a line break before the new content. Matches the first note with the given title.",
      "inputSchema": {
        "properties": {
          "content": {
            "description": "Plain text to append",
            "type": "string"
          },
          "folderName": {
            "type": "string"
          },
          "title": {
            "type": "string"
          }
        },
        "required": [
          "title",
          "content"
        ],
        "type": "object"
      },
      "name": "append_to_note"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List all Notes folders (including nested) across accounts. Returns folder name + parent path.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "list_folders"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Create a new Notes folder. If `accountName` is omitted, creates in the default account (usually iCloud).",
      "inputSchema": {
        "properties": {
          "accountName": {
            "description": "iCloud / On My Mac / account name (optional)",
            "type": "string"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "create_folder"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Rename a Notes folder.",
      "inputSchema": {
        "properties": {
          "newName": {
            "type": "string"
          },
          "oldName": {
            "type": "string"
          }
        },
        "required": [
          "oldName",
          "newName"
        ],
        "type": "object"
      },
      "name": "rename_folder"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Delete a folder and the notes inside it. Recovery depends on the Notes account; do not assume the deleted contents can be recovered.",
      "inputSchema": {
        "properties": {
          "name": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "delete_folder"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List attachments on a note (name, creation date, content identifier). Use save_attachment to export one.",
      "inputSchema": {
        "properties": {
          "folderName": {
            "type": "string"
          },
          "noteTitle": {
            "type": "string"
          }
        },
        "required": [
          "noteTitle"
        ],
        "type": "object"
      },
      "name": "list_attachments"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Save an attachment from a note to a local file path. Matches attachment by name (first match).",
      "inputSchema": {
        "properties": {
          "attachmentName": {
            "type": "string"
          },
          "folderName": {
            "type": "string"
          },
          "noteTitle": {
            "type": "string"
          },
          "savePath": {
            "description": "Absolute path where the file will be written",
            "type": "string"
          }
        },
        "required": [
          "noteTitle",
          "attachmentName",
          "savePath"
        ],
        "type": "object"
      },
      "name": "save_attachment"
    }
  ],
  "macos-mail": [
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List all mailboxes (across accounts). Returns account + mailbox name pairs.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "list_mailboxes"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Search mail messages by keyword in subject. Returns sender, subject, date, mailbox, and message id.",
      "inputSchema": {
        "properties": {
          "limit": {
            "default": 30,
            "type": "number"
          },
          "mailbox": {
            "description": "Optional mailbox name (e.g. \"INBOX\")",
            "type": "string"
          },
          "query": {
            "type": "string"
          }
        },
        "required": [
          "query"
        ],
        "type": "object"
      },
      "name": "search_messages"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Read a specific message body by message id (from search_messages).",
      "inputSchema": {
        "properties": {
          "id": {
            "description": "Message id from search_messages",
            "type": "string"
          }
        },
        "required": [
          "id"
        ],
        "type": "object"
      },
      "name": "read_message"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Create a new mail draft (does not send). Opens in Mail so the user can review before sending.",
      "inputSchema": {
        "properties": {
          "bcc": {
            "type": "string"
          },
          "body": {
            "type": "string"
          },
          "cc": {
            "type": "string"
          },
          "subject": {
            "type": "string"
          },
          "to": {
            "description": "Recipient email address",
            "type": "string"
          }
        },
        "required": [
          "to",
          "subject",
          "body"
        ],
        "type": "object"
      },
      "name": "create_draft"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Submit an email once through the configured Mail account, without opening a review draft. A successful submission does not confirm delivery.",
      "inputSchema": {
        "properties": {
          "bcc": {
            "type": "string"
          },
          "body": {
            "type": "string"
          },
          "cc": {
            "type": "string"
          },
          "subject": {
            "type": "string"
          },
          "to": {
            "type": "string"
          }
        },
        "required": [
          "to",
          "subject",
          "body"
        ],
        "type": "object"
      },
      "name": "send_message"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Mark a specific message as read or unread (by id from search_messages).",
      "inputSchema": {
        "properties": {
          "id": {
            "type": "string"
          },
          "read": {
            "default": true,
            "description": "true = mark read, false = mark unread",
            "type": "boolean"
          }
        },
        "required": [
          "id"
        ],
        "type": "object"
      },
      "name": "mark_read"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Move a message to a different mailbox (e.g. to Archive or a user folder). Pass message id + target mailbox name and account.",
      "inputSchema": {
        "properties": {
          "id": {
            "type": "string"
          },
          "targetAccount": {
            "description": "Destination account name",
            "type": "string"
          },
          "targetMailbox": {
            "description": "Destination mailbox name (e.g. \"Archive\")",
            "type": "string"
          }
        },
        "required": [
          "id",
          "targetAccount",
          "targetMailbox"
        ],
        "type": "object"
      },
      "name": "move_message"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Delete a message (moves to the account's Trash / Deleted Messages mailbox).",
      "inputSchema": {
        "properties": {
          "id": {
            "type": "string"
          }
        },
        "required": [
          "id"
        ],
        "type": "object"
      },
      "name": "delete_message"
    }
  ],
  "macos-messages": [
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List recent Messages conversations (ordered by last message time). Requires Full Disk Access. Returns chat_identifier (phone/email/group id), display_name, last message snippet, timestamp.",
      "inputSchema": {
        "properties": {
          "limit": {
            "default": 20,
            "type": "number"
          }
        },
        "type": "object"
      },
      "name": "list_recent_conversations"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Read the last N messages with a contact or group. `chat_identifier` is a phone number / email / group id from list_recent_conversations. Requires Full Disk Access.",
      "inputSchema": {
        "properties": {
          "chat_identifier": {
            "type": "string"
          },
          "limit": {
            "default": 30,
            "type": "number"
          }
        },
        "required": [
          "chat_identifier"
        ],
        "type": "object"
      },
      "name": "read_conversation"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Full-text search across all Messages conversations (LIKE match on text column). Requires Full Disk Access. Returns sender, chat_identifier, text, timestamp.",
      "inputSchema": {
        "properties": {
          "limit": {
            "default": 50,
            "type": "number"
          },
          "query": {
            "type": "string"
          }
        },
        "required": [
          "query"
        ],
        "type": "object"
      },
      "name": "search_messages"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Submit a message once to a phone number, email, or buddy id via an enabled Messages account. Selects iMessage, SMS, then RCS before submission; does not retry after sending. Mainland China mobile numbers support +86 normalization. Requires Automation permission. Submission does not confirm delivery.",
      "inputSchema": {
        "properties": {
          "text": {
            "type": "string"
          },
          "to": {
            "description": "Phone number (e.g. +11234567890), email address, or buddy id",
            "type": "string"
          }
        },
        "required": [
          "to",
          "text"
        ],
        "type": "object"
      },
      "name": "send_message"
    }
  ],
  "macos-safari": [
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List all Safari windows and their tabs (index, URL, title). Returns JSON.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "list_tabs"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Get the URL, title and user-selected text of the frontmost Safari tab. If JavaScript selection access fails, selection is null and selectionError explains the refusal.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "get_active_tab"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Read the plain-text body of a Safari tab (front current tab by default, or positive window/tab indices from list_tabs). Requires Allow JavaScript from Apple Events in Safari Develop menu. Output is bounded to 1,000,000 UTF-16 units without splitting a character.",
      "inputSchema": {
        "properties": {
          "limit": {
            "default": 8000,
            "description": "Max characters to return",
            "type": "number"
          },
          "tab": {
            "description": "Tab index from list_tabs (default = current tab)",
            "type": "number"
          },
          "window": {
            "description": "Window index from list_tabs (default = front window)",
            "type": "number"
          }
        },
        "type": "object"
      },
      "name": "read_tab"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Open an http, https, file, or about:blank URL in Safari. By default opens in a new tab; set current=true to navigate the front tab. Creates a window when none exists.",
      "inputSchema": {
        "properties": {
          "current": {
            "default": false,
            "type": "boolean"
          },
          "url": {
            "type": "string"
          }
        },
        "required": [
          "url"
        ],
        "type": "object"
      },
      "name": "open_url"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Activate Safari and switch to a specific window/tab (indices from list_tabs).",
      "inputSchema": {
        "properties": {
          "tab": {
            "type": "number"
          },
          "window": {
            "type": "number"
          }
        },
        "required": [
          "window",
          "tab"
        ],
        "type": "object"
      },
      "name": "switch_to_tab"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Close a specific Safari tab by window/tab indices (from list_tabs).",
      "inputSchema": {
        "properties": {
          "tab": {
            "type": "number"
          },
          "window": {
            "type": "number"
          }
        },
        "required": [
          "window",
          "tab"
        ],
        "type": "object"
      },
      "name": "close_tab"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List Safari bookmarks (title, URL, folder path). Requires Full Disk Access to read ~/Library/Safari/Bookmarks.plist.",
      "inputSchema": {
        "properties": {
          "limit": {
            "default": 200,
            "type": "number"
          }
        },
        "type": "object"
      },
      "name": "list_bookmarks"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List recent Safari browsing history (newest first). Requires Full Disk Access to read ~/Library/Safari/History.db.",
      "inputSchema": {
        "properties": {
          "limit": {
            "default": 50,
            "type": "number"
          }
        },
        "type": "object"
      },
      "name": "list_history"
    }
  ],
  "macos-app-ui": [
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Probe App UI reads and System Events input status. Only this tool may report UI read access unavailable; missing windows or failed actions alone do not prove missing Accessibility permission. Input availability does not confirm a later action outcome.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "app_ui_check_permission"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List visible running macOS application processes using Accessibility metadata.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "app_ui_list_apps"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Return the currently frontmost macOS application process.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "app_ui_get_front_app"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Launch or activate a macOS application by name.",
      "inputSchema": {
        "properties": {
          "appName": {
            "type": "string"
          }
        },
        "required": [
          "appName"
        ],
        "type": "object"
      },
      "name": "app_ui_activate_app"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List windows for an app, including title, role/subrole, position, and size.",
      "inputSchema": {
        "properties": {
          "appName": {
            "description": "Application process name. Defaults to frontmost app.",
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "app_ui_list_windows"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Read a bounded Accessibility tree for an app window. Element paths belong to this app process, session, and assistant turn; use them immediately. No window is distinct from a permission error.",
      "inputSchema": {
        "properties": {
          "allowProcessFallback": {
            "default": false,
            "description": "When an app exposes no AXWindow, inspect the application process root. This can be slow for non-standard apps.",
            "type": "boolean"
          },
          "appName": {
            "description": "Application process name. Defaults to frontmost app.",
            "type": "string"
          },
          "maxDepth": {
            "default": 4,
            "type": "number"
          },
          "maxNodes": {
            "default": 200,
            "type": "number"
          },
          "windowIndex": {
            "default": 1,
            "type": "number"
          }
        },
        "type": "object"
      },
      "name": "app_ui_get_tree"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Find the first UI element in the front window whose accessible label contains query, optionally filtered by role.",
      "inputSchema": {
        "properties": {
          "appName": {
            "description": "Application process name. Defaults to frontmost app.",
            "type": "string"
          },
          "maxNodes": {
            "default": 300,
            "type": "number"
          },
          "query": {
            "type": "string"
          },
          "role": {
            "description": "Exact Accessibility role, e.g. AXButton, AXTextField, AXMenuItem.",
            "type": "string"
          }
        },
        "required": [
          "query"
        ],
        "type": "object"
      },
      "name": "app_ui_find_element"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Capture the primary display, or an explicit screen-point region, to a local PNG and return pixel dimensions plus screen-point mapping. Capture does not prove Accessibility or input permission. Mappings are local to this session and assistant turn.",
      "inputSchema": {
        "properties": {
          "appName": {
            "description": "Optional app to activate before capture.",
            "type": "string"
          },
          "path": {
            "description": "Absolute output path. Defaults to the per-call Klaus workspace artifact directory.",
            "type": "string"
          },
          "region": {
            "description": "Optional screencapture region \"x,y,w,h\".",
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "app_ui_capture_screen"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Click absolute screen coordinates through one System Events process click request per click. Coordinates are macOS screen points unless coordinateSpace is screenshotPixels. Mappings from app_ui_capture_screen belong to the current session and assistant turn; provide all six mapping fields together to use an explicit mapping. Dispatch acceptance does not confirm a visible outcome.",
      "inputSchema": {
        "properties": {
          "appName": {
            "description": "Optional app to activate before clicking.",
            "type": "string"
          },
          "clickCount": {
            "default": 1,
            "type": "number"
          },
          "coordinateSpace": {
            "default": "screenPoints",
            "enum": [
              "screenPoints",
              "screenshotPixels"
            ],
            "type": "string"
          },
          "coordinatesSpace": {
            "description": "Deprecated typo alias for coordinateSpace.",
            "enum": [
              "screenPoints",
              "screenshotPixels"
            ],
            "type": "string"
          },
          "dryRun": {
            "default": false,
            "description": "Resolve coordinates and check click injection permission without clicking.",
            "type": "boolean"
          },
          "screenshotPixelHeight": {
            "description": "Optional when coordinateSpace is screenshotPixels; defaults to latest app_ui_capture_screen mapping.",
            "type": "number"
          },
          "screenshotPixelWidth": {
            "description": "Optional when coordinateSpace is screenshotPixels; defaults to latest app_ui_capture_screen mapping.",
            "type": "number"
          },
          "screenshotScreenHeight": {
            "description": "Screen-point height of the screenshot. Defaults to latest app_ui_capture_screen mapping.",
            "type": "number"
          },
          "screenshotScreenWidth": {
            "description": "Screen-point width of the screenshot. Defaults to latest app_ui_capture_screen mapping.",
            "type": "number"
          },
          "screenshotScreenX": {
            "description": "Screen-point left edge of the screenshot. Defaults to latest app_ui_capture_screen mapping.",
            "type": "number"
          },
          "screenshotScreenY": {
            "description": "Screen-point top edge of the screenshot. Defaults to latest app_ui_capture_screen mapping.",
            "type": "number"
          },
          "x": {
            "type": "number"
          },
          "y": {
            "type": "number"
          }
        },
        "required": [
          "x",
          "y"
        ],
        "type": "object"
      },
      "name": "app_ui_click_at"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Resolve an element from a current snapshot path or query/role, then invoke one available click action per requested click. An uncertain result is not retried through another action. Use dryRun to inspect the target without clicking.",
      "inputSchema": {
        "properties": {
          "appName": {
            "description": "Application process name. Defaults to frontmost app.",
            "type": "string"
          },
          "clickCount": {
            "default": 1,
            "type": "number"
          },
          "dryRun": {
            "default": false,
            "description": "Resolve the target element without clicking.",
            "type": "boolean"
          },
          "elementPath": {
            "description": "Snapshot-relative path returned by app_ui_get_tree, e.g. \"1.3.2\".",
            "type": "string"
          },
          "query": {
            "description": "Fallback: accessible label contains this text.",
            "type": "string"
          },
          "role": {
            "description": "Fallback exact Accessibility role filter, e.g. AXButton.",
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "app_ui_click_element"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Replace a text field value through writable Accessibility metadata. When fallbackTyping is enabled, focus and a complete selection must be confirmed before insertion; the final value is read back. Unicode insertion requires writable selected text. Uncertain writes are never retried.",
      "inputSchema": {
        "properties": {
          "appName": {
            "description": "Application process name. Defaults to frontmost app.",
            "type": "string"
          },
          "elementPath": {
            "type": "string"
          },
          "fallbackTyping": {
            "default": true,
            "type": "boolean"
          },
          "query": {
            "type": "string"
          },
          "role": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "required": [
          "value"
        ],
        "type": "object"
      },
      "name": "app_ui_set_value"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Insert text into the focused element of the frontmost or named app. Writable selected text supports Unicode; the System Events keystroke fallback accepts ASCII only because other characters may be corrupted. Verify focus first. The result identifies the dispatch method and focused element; for confirmed whole-field replacement use app_ui_set_value.",
      "inputSchema": {
        "properties": {
          "appName": {
            "description": "Application process name. Defaults to frontmost app.",
            "type": "string"
          },
          "text": {
            "type": "string"
          }
        },
        "required": [
          "text"
        ],
        "type": "object"
      },
      "name": "app_ui_type_text"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Press a key or keyboard shortcut in the frontmost app or a named app. Modifiers: command/cmd, shift, option/alt, control/ctrl. Web pages can swallow browser shortcuts (e.g. cmd+L address-bar focus), so never drive browser navigation with shortcuts — use the browser tools (navigate/click/type) instead.",
      "inputSchema": {
        "properties": {
          "appName": {
            "description": "Application process name. Defaults to frontmost app.",
            "type": "string"
          },
          "dryRun": {
            "default": false,
            "description": "Resolve the key action without pressing it.",
            "type": "boolean"
          },
          "key": {
            "description": "Single printable ASCII character or named key: return, tab, escape, delete, left/right/up/down, home, end, pageup, pagedown, space.",
            "type": "string"
          },
          "modifiers": {
            "items": {
              "type": "string"
            },
            "type": "array"
          }
        },
        "required": [
          "key"
        ],
        "type": "object"
      },
      "name": "app_ui_press_key"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Select a menu item from an app menu path, e.g. [\"File\", \"New Window\"]. Requires exact visible menu labels.",
      "inputSchema": {
        "properties": {
          "appName": {
            "type": "string"
          },
          "menuPath": {
            "items": {
              "type": "string"
            },
            "minItems": 2,
            "type": "array"
          }
        },
        "required": [
          "appName",
          "menuPath"
        ],
        "type": "object"
      },
      "name": "app_ui_select_menu_item"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Wait until an app window exists or a UI element matching query/role appears. Returns the matched element summary.",
      "inputSchema": {
        "properties": {
          "appName": {
            "description": "Application process name. Defaults to frontmost app.",
            "type": "string"
          },
          "intervalMs": {
            "default": 300,
            "type": "number"
          },
          "query": {
            "type": "string"
          },
          "role": {
            "type": "string"
          },
          "timeoutMs": {
            "default": 10000,
            "type": "number"
          }
        },
        "type": "object"
      },
      "name": "app_ui_wait_for"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Open or activate an app and return explicit manual handoff instructions for actions Klaus should not complete automatically.",
      "inputSchema": {
        "properties": {
          "appName": {
            "type": "string"
          },
          "instructions": {
            "type": "string"
          }
        },
        "required": [
          "appName",
          "instructions"
        ],
        "type": "object"
      },
      "name": "app_ui_handoff"
    }
  ],
  "macos-photos": [
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Read Photos application identity and library count to test scripting read access. This does not prove write, Accessibility or PhotoKit permission.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "photos_check_permission"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Activate Photos to prepare for macOS permission prompts. Opening the app does not confirm a permission grant.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "photos_request_permission"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Request Photos Settings and prepare manual iCloud setup. Apple Account, authentication, storage mode and iCloud changes remain under user control; requesting a window does not confirm its contents.",
      "inputSchema": {
        "properties": {
          "downloadOriginals": {
            "default": true,
            "description": "Recommend Download Originals to this Mac when Klaus needs offline originals/export reliability.",
            "type": "boolean"
          },
          "openSystemSettings": {
            "default": false,
            "description": "Also open macOS Apple ID / iCloud settings as a fallback handoff target.",
            "type": "boolean"
          }
        },
        "type": "object"
      },
      "name": "photos_prepare_icloud_sync"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Find .photoslibrary bundles in common local locations. Does not switch libraries.",
      "inputSchema": {
        "properties": {
          "limit": {
            "default": 50,
            "type": "number"
          },
          "roots": {
            "description": "Optional directories to search.",
            "items": {
              "type": "string"
            },
            "type": "array"
          }
        },
        "type": "object"
      },
      "name": "photos_list_libraries"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Ask Photos to open a specific .photoslibrary directory. Any switch confirmation remains in Photos, and the current library path is not independently confirmed.",
      "inputSchema": {
        "properties": {
          "path": {
            "type": "string"
          }
        },
        "required": [
          "path"
        ],
        "type": "object"
      },
      "name": "photos_open_library"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Return best-effort information about the frontmost Photos.app instance and its version.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "photos_get_current_library"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Count the currently opened Photos library media items and containers. Counts reflect local Photos/iCloud metadata already synced to this Mac.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "photos_get_library_summary"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Reveal an asset or container in Photos.app. Uses Photos.app spotlight scripting and activates Photos.",
      "inputSchema": {
        "properties": {
          "assetId": {
            "type": "string"
          },
          "assetName": {
            "type": "string"
          },
          "containerId": {
            "type": "string"
          },
          "containerName": {
            "type": "string"
          },
          "containerType": {
            "enum": [
              "album",
              "folder"
            ],
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "photos_reveal_in_app"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List Photos albums and folders with id, name, parent, and item count where available.",
      "inputSchema": {
        "properties": {
          "limit": {
            "default": 200,
            "type": "number"
          }
        },
        "type": "object"
      },
      "name": "photos_list_albums"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "List Photos assets. Optionally scope to an album by id or name. Returns compact metadata.",
      "inputSchema": {
        "properties": {
          "albumId": {
            "type": "string"
          },
          "albumName": {
            "type": "string"
          },
          "favorite": {
            "type": "boolean"
          },
          "limit": {
            "default": 50,
            "type": "number"
          }
        },
        "type": "object"
      },
      "name": "photos_list_assets"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Read full scriptable metadata for a single Photos asset by id or name.",
      "inputSchema": {
        "properties": {
          "assetId": {
            "type": "string"
          },
          "assetName": {
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "photos_get_asset"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Read the currently selected media items in Photos.app.",
      "inputSchema": {
        "properties": {},
        "type": "object"
      },
      "name": "photos_get_selection"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "description": "Search Photos.app using the same search behavior as the Photos search field. Returns matching media items.",
      "inputSchema": {
        "properties": {
          "limit": {
            "default": 50,
            "type": "number"
          },
          "query": {
            "type": "string"
          }
        },
        "required": [
          "query"
        ],
        "type": "object"
      },
      "name": "photos_search"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Export rendered JPEGs for up to 200 assets into a unique directory inside destination. Validated files are published together; existing files are preserved.",
      "inputSchema": {
        "properties": {
          "assetIds": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "assetName": {
            "type": "string"
          },
          "destination": {
            "type": "string"
          }
        },
        "required": [
          "destination"
        ],
        "type": "object"
      },
      "name": "photos_export_preview"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Import up to 200 nonempty local files, optionally into an album. Duplicate checking is enabled by default; explicit skipDuplicates:false disables the native check and can import duplicates.",
      "inputSchema": {
        "properties": {
          "albumId": {
            "type": "string"
          },
          "albumName": {
            "type": "string"
          },
          "paths": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "skipDuplicates": {
            "default": true,
            "description": "Enable Photos duplicate checking. False skips that check and imports duplicates.",
            "type": "boolean"
          }
        },
        "required": [
          "paths"
        ],
        "type": "object"
      },
      "name": "photos_import_files"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Scan a local folder for at most 200 supported media files and import them, optionally into an album. Directory symlinks are not followed. Duplicate checking is enabled by default; scan truncation is reported.",
      "inputSchema": {
        "properties": {
          "albumId": {
            "type": "string"
          },
          "albumName": {
            "type": "string"
          },
          "folder": {
            "type": "string"
          },
          "recursive": {
            "default": false,
            "type": "boolean"
          },
          "skipDuplicates": {
            "default": true,
            "description": "Enable Photos duplicate checking. False skips that check and imports duplicates.",
            "type": "boolean"
          }
        },
        "required": [
          "folder"
        ],
        "type": "object"
      },
      "name": "photos_import_folder"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Export up to 200 assets as originals or rendered files into a unique directory inside destination. Return the actual directory and files after validation; existing files are preserved.",
      "inputSchema": {
        "properties": {
          "assetIds": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "assetName": {
            "type": "string"
          },
          "destination": {
            "type": "string"
          },
          "usingOriginals": {
            "default": true,
            "type": "boolean"
          }
        },
        "required": [
          "destination"
        ],
        "type": "object"
      },
      "name": "photos_export_assets"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Export an album containing at most 200 assets into a unique directory inside destination. For larger albums use explicit asset batches. Existing files are preserved.",
      "inputSchema": {
        "properties": {
          "albumId": {
            "type": "string"
          },
          "albumName": {
            "type": "string"
          },
          "destination": {
            "type": "string"
          },
          "usingOriginals": {
            "default": true,
            "type": "boolean"
          }
        },
        "required": [
          "destination"
        ],
        "type": "object"
      },
      "name": "photos_export_album"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Create a new Photos album, optionally inside a folder.",
      "inputSchema": {
        "properties": {
          "name": {
            "type": "string"
          },
          "parentFolderId": {
            "type": "string"
          },
          "parentFolderName": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "photos_create_album"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Create a new Photos folder, optionally inside another folder.",
      "inputSchema": {
        "properties": {
          "name": {
            "type": "string"
          },
          "parentFolderId": {
            "type": "string"
          },
          "parentFolderName": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "type": "object"
      },
      "name": "photos_create_folder"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Rename a Photos album or folder.",
      "inputSchema": {
        "properties": {
          "containerId": {
            "type": "string"
          },
          "containerName": {
            "type": "string"
          },
          "containerType": {
            "enum": [
              "album",
              "folder"
            ],
            "type": "string"
          },
          "newName": {
            "type": "string"
          }
        },
        "required": [
          "newName"
        ],
        "type": "object"
      },
      "name": "photos_rename_container"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Delete a Photos album or folder. This does not delete the media assets inside regular albums.",
      "inputSchema": {
        "properties": {
          "containerId": {
            "type": "string"
          },
          "containerName": {
            "type": "string"
          },
          "containerType": {
            "enum": [
              "album",
              "folder"
            ],
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "photos_delete_container"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Add one or more assets to a Photos album.",
      "inputSchema": {
        "properties": {
          "albumId": {
            "type": "string"
          },
          "albumName": {
            "type": "string"
          },
          "assetIds": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "assetName": {
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "photos_add_assets_to_album"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Prepare removal of assets from an album. Photos scripting does not expose a stable direct remove command, so Klaus opens the album/asset and returns handoff instructions.",
      "inputSchema": {
        "properties": {
          "albumId": {
            "type": "string"
          },
          "albumName": {
            "type": "string"
          },
          "assetIds": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "assetName": {
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "photos_remove_assets_from_album"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Prepare moving/reordering assets inside an album. This is a UI-only Photos operation and returns handoff state if automation cannot complete it safely.",
      "inputSchema": {
        "properties": {
          "albumId": {
            "type": "string"
          },
          "albumName": {
            "type": "string"
          },
          "assetIds": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "toIndex": {
            "type": "number"
          }
        },
        "type": "object"
      },
      "name": "photos_move_assets_in_album"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Duplicate a Photos media item.",
      "inputSchema": {
        "properties": {
          "assetId": {
            "type": "string"
          },
          "assetName": {
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "photos_duplicate_asset"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Set or clear favorite on one or more assets.",
      "inputSchema": {
        "properties": {
          "assetIds": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "assetName": {
            "type": "string"
          },
          "favorite": {
            "type": "boolean"
          }
        },
        "required": [
          "favorite"
        ],
        "type": "object"
      },
      "name": "photos_set_favorite"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Request the exact Hide or Unhide menu action for an identified asset. Resulting state and any confirmation remain unverified. A batch stops after an uncertain result instead of continuing into a dialog.",
      "inputSchema": {
        "properties": {
          "assetId": {
            "type": "string"
          },
          "assetIds": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "assetName": {
            "type": "string"
          },
          "hidden": {
            "type": "boolean"
          }
        },
        "required": [
          "hidden"
        ],
        "type": "object"
      },
      "name": "photos_set_hidden"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Update and read back scriptable metadata: title, description, keywords, favorite, date and location. Invalid fields fail before Photos starts; multiple fields are not an atomic transaction.",
      "inputSchema": {
        "properties": {
          "assetId": {
            "type": "string"
          },
          "assetName": {
            "type": "string"
          },
          "date": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "favorite": {
            "type": "boolean"
          },
          "keywords": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "location": {
            "properties": {
              "latitude": {
                "type": "number"
              },
              "longitude": {
                "type": "number"
              }
            },
            "type": "object"
          },
          "title": {
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "photos_update_metadata"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Resolve every requested id before writing, then update and read back the requested metadata. A missing id prevents all writes. Later failures can leave earlier updates applied and are never automatically replayed.",
      "inputSchema": {
        "properties": {
          "assetIds": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "date": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "favorite": {
            "type": "boolean"
          },
          "keywords": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "location": {
            "properties": {
              "latitude": {
                "type": "number"
              },
              "longitude": {
                "type": "number"
              }
            },
            "type": "object"
          },
          "title": {
            "type": "string"
          }
        },
        "required": [
          "assetIds"
        ],
        "type": "object"
      },
      "name": "photos_batch_update_metadata"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Request a controlled edit: rotate_clockwise, duplicate_selected, enhance, crop handoff, or open_edit. Exact selection is checked before UI input. A dispatched request does not confirm its visible result.",
      "inputSchema": {
        "properties": {
          "action": {
            "description": "rotate_clockwise | enhance | crop | duplicate_selected | open_edit",
            "type": "string"
          },
          "assetId": {
            "type": "string"
          },
          "assetName": {
            "type": "string"
          }
        },
        "required": [
          "action"
        ],
        "type": "object"
      },
      "name": "photos_apply_edit"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Best-effort UI automation to revert the selected asset to original in Photos.app.",
      "inputSchema": {
        "properties": {
          "assetId": {
            "type": "string"
          },
          "assetName": {
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "photos_revert_edits"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Run a controlled Photos action, including deletion requests. Before input, require a verified single selected asset and no pending confirmation sheet. Unsupported or uncertain actions return handoff instructions; no automatic confirmation is performed.",
      "inputSchema": {
        "properties": {
          "action": {
            "type": "string"
          },
          "assetId": {
            "type": "string"
          },
          "assetName": {
            "type": "string"
          }
        },
        "required": [
          "action"
        ],
        "type": "object"
      },
      "name": "photos_run_ui_action"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Open Photos.app to the closest relevant asset/container/search state and return manual next steps.",
      "inputSchema": {
        "properties": {
          "assetId": {
            "type": "string"
          },
          "assetName": {
            "type": "string"
          },
          "instructions": {
            "type": "string"
          },
          "query": {
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "photos_prepare_handoff"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Request the exact Photos deletion menu action for an identified asset. No automatic confirmation is sent and no completed library deletion is claimed. Batch work stops at the first pending confirmation or uncertain result.",
      "inputSchema": {
        "properties": {
          "assetId": {
            "type": "string"
          },
          "assetIds": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "assetName": {
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "photos_delete_assets"
    },
    {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Best-effort handoff for recovering items from Recently Deleted. Photos.app does not expose a stable scripting API for recovery.",
      "inputSchema": {
        "properties": {
          "instructions": {
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "photos_recover_recently_deleted"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Best-effort handoff for permanent deletion from Recently Deleted. This is intentionally separate from regular delete.",
      "inputSchema": {
        "properties": {
          "instructions": {
            "type": "string"
          }
        },
        "type": "object"
      },
      "name": "photos_permanently_delete_recently_deleted"
    },
    {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "description": "Process explicit ids through delete or hide requests. Stop after the first uncertain result or pending confirmation and return remaining ids. Never report an incomplete batch as completed.",
      "inputSchema": {
        "properties": {
          "action": {
            "enum": [
              "delete_assets",
              "set_hidden"
            ],
            "type": "string"
          },
          "assetIds": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "hidden": {
            "type": "boolean"
          }
        },
        "required": [
          "action",
          "assetIds"
        ],
        "type": "object"
      },
      "name": "photos_batch_destructive_action"
    }
  ]
};
