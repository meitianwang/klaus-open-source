# macOS connector services

The serving slices implement all ten `macos-finder` tools, both
`macos-shortcuts` tools, all ten `macos-system` tools, seven `macos-calendar`
tools, six `macos-contacts` tools, nine `macos-reminders` tools, and thirteen
`macos-notes` tools.
Mail contributes eight tools and Messages contributes four tools.
Safari contributes eight tools.
`MacOsConnectors` owns session identity, bounded ordering,
and tool dispatch. `MacOsCommandRunner` only executes a fixed list of macOS system
binaries. It has no engine, HTTP server, renderer command API, or shell execution
endpoint. No additional native binary or Cargo build is required.

## Host composition

Construct one shared `MacOsConnectors({configRoot, userHome, guardInteraction?})`.
The optional guard protects another host owner such as active recording. It runs
before any system call. The host remains responsible for connector preferences,
disabled tools, engine permission rules, authenticated HTTP MCP, and elicitation.

- `capability(id)` returns `{serverName, tools:[{name,readOnly,destructive}]}` only
  for a complete, installed implementation on macOS. Names are
  `klaus-macos-finder`, `klaus-macos-shortcuts`, `klaus-macos-system`,
  `klaus-macos-calendar`, `klaus-macos-contacts`, `klaus-macos-reminders`, and
  `klaus-macos-notes`, `klaus-macos-mail`, `klaus-macos-messages`, and
  `klaus-macos-safari`.
  This checks executable access and application bundles;
  it neither requests TCC permission nor claims that permission is granted.
- `tools(id)` returns independent tool definitions with the existing names,
  order, schemas, and four effect annotations. The lock description explicitly
  distinguishes sending a request from confirming the locked state.
  Notes deletion descriptions state that recovery depends on the account.
- `attachSession(sessionId)` creates a fresh native resource and generation.
- `call(id, name, args, context)` returns the MCP `{content:[{type:'text',text}]}`
  shape. Context contains the trusted `sessionId`, `turnId`, `signal`,
  `assertCurrent`, `elicit`, and optional session `workdir`. Never populate this
  workdir from untrusted request metadata. Relative Finder paths require it.
- `detachSession(sessionId, deadlineMs=5000)` and `close(deadlineMs=5000)` return
  `{complete:boolean}`. A false result retains the closing owner and forbids
  reattachment. Retry drain, not the operation. Stop the HTTP owner before
  detaching its connector resources; stop all HTTP servers before final close.

The queue holds at most 64 operations across all owners and starts one at a time.
Queued cancellation removes the operation immediately. Running cancellation
propagates to its owned process group. Each native request has `resourceId`,
`operationId`, `generation`, and increasing `sequence`; a multi-command tool keeps
its operation ID and increments sequence at each system boundary. Every boundary
checks the current turn both before and after completion.

The runner concurrently drains stdout and stderr, limits each to 8 MiB and input
to 1 MiB, and defaults to a 30-second deadline. Shortcuts run uses 120 seconds.
Dialogs are limited to 600 seconds with five seconds of process cleanup slack.
Cancellation sends SIGTERM to its private process group, then SIGKILL after
500 ms. Results settle after the direct child and its streams close. If a child
exits with inherited pipes still open, the runner terminates its owned group and
closes retained endpoints rather than waiting indefinitely for an XPC service.
Cancellation cannot undo an Apple event or an already started Shortcut; the error
explicitly states that effects may already have occurred. No automatic retry runs.

## Data behavior

Finder tags use the real binary metadata attribute, including color indexes.
Malformed attributes fail; they are not represented as an empty tag list. Tag
replacement rejects invalid input before writing. Temporary conversion files are
private and removed after completion or cancellation.

Selection and directory data use JSON framing so tabs and newlines in names are
preserved. Directory enumeration is non-recursive and bounded to 2,000 entries.
Foundation reads actual tag names, including custom tags; the old seven-color
Finder label property cannot provide that information. File metadata and comments
keep the existing output fields. File URLs may canonicalize `/var` to
`/private/var`; consumers comparing filesystem identities should resolve them.

Shortcut text input is passed only on stdin. Command failure does not log or
echo the full argument list. Missing shortcuts return the actual CLI error.

System clipboard calls preserve raw text and pass writes on stdin. Spotlight
uses NUL-delimited paths and limits returned entries to 500. Screenshots write
into a private sibling directory, validate a bounded PNG, and publish by rename
only after checking the owner. Default output uses the trusted workspace's
`.klaus/artifacts/screenshots`, a session's `artifacts/screenshots`, or the
configured `connector-artifacts/screenshots` fallback. Failed captures preserve
an existing requested destination and remove their unpublished output.

Notification and application activation report requests, not unseen OS state.
Volume changes read back the actual value. Dialog cancellation and timeout are
errors, distinct from any configured button label. Screen locking sends the
[Apple-documented Control-Command-Q request](https://support.apple.com/en-us/102650)
through the guarded System Events owner. Its response has `requested:true` and
`locked:null`; it does not claim that the screen became locked. Permission and
dispatch failures propagate without automatic retry.

Calendar, Contacts, and Reminders bind their Apple bundle IDs. They first open
in the background and wait for a bounded, read-only version request to succeed.
Only that readiness read retries a cold-application error, at most four times.
The actual operation is sent once; a late failure cannot trigger a duplicate
create or update. Queued or in-flight cancellation prevents the next boundary.
Availability never opens an app or requests Automation permission.

Organizer arrays use Foundation JSON serialization, preserving names, notes,
null fields, and booleans without delimiter parsing. Single-contact details
retain their text output. Calendar results keep their existing fields and local
date display; date-only inputs denote UTC midnight, explicit offsets are honored,
and naive date-times use the local timezone. Invalid dates and nonexistent local
times fail before opening the app. AppleScript date precision is one second.
Calendar range changes validate before changing other fields and move endpoints
in an order that avoids a transient inverted range; a new start alone preserves
the duration. A Calendar delete retains its existing all-exact-matches behavior;
contact and reminder matching acts on the first exact match. Readiness does not
prove database permission, writeability, or account synchronization.

Notes uses the application's `plaintext` property for reads and snippets. HTML
writes escape text once, preserve line breaks, and include the current or new
heading when replacing a body. Folder enumeration includes nested paths with a
32-level and 2,000-folder limit. Attachment results include the native content
identifier. Export writes into a private sibling directory, validates a regular
file of at most 1 GiB, and publishes only after checking the current owner.
Missing files, symlinks, cancellation, and application failures leave an existing
destination untouched before publication. Notes account behavior determines
whether deletion is recoverable; see [Apple's deletion guidance](https://support.apple.com/guide/notes/delete-a-note-not5585d71a8/mac).
The destructive annotation remains enabled for note and folder deletion.

Mail traverses nested mailboxes with 32-level and 2,000-mailbox limits. Permission
and scripting failures propagate instead of becoming a false not-found result.
Drafts are visible and saved. Direct sends require Mail's native success result,
but report submission rather than confirmed delivery. Messages first selects an
enabled account and recipient in a read-only operation, then checks that account
again and sends once. It never switches transport or recipient after attempting
a send. Phone normalization preserves email punctuation. Both sending tool
descriptions explicitly describe this submission boundary.

Messages reads only the trusted `userHome/Library/Messages/chat.db` path. SQL uses
the fixed read-only sqlite3 executable, `query_only`, escaped values, bounded
queries, and stdin rather than command arguments. Missing or inaccessible files
produce a concrete Full Disk Access hint; malformed data fails. The current
plain-text query does not decode `attributedBody` or media, and marks missing
text as unsupported content. Conversation reads return chronological order.

Safari uses its fixed `/Applications/Safari.app` bundle and the same bounded
readiness check. Tab metadata and page text use JSON framing. Invalid indices
fail before opening the app; missing windows and tabs fail explicitly. Opening
a URL accepts http, https, file, or about:blank, and creates a window when needed.
Navigation and closing are never retried. An unavailable selection returns
`selection:null` with `selectionError`; an empty string represents a real empty
selection. Page reads require Safari's JavaScript from Apple Events permission,
preserve whitespace, and cap UTF-16 output without splitting surrogate pairs.

Safari bookmark and history paths come only from the trusted user home. Bookmarks
use bounded plutil conversion of binary or XML files, including data/date values
that JSON cannot directly represent. Folder traversal preserves the total count
and fails at its depth/node budget rather than silently truncating the tree.
History uses the same read-only database adapter as Messages. Neither operation
launches Safari, changes preferences, or silently replaces permission failures
with empty results.

App UI uses System Events with the same bounded command owner. Accessibility
snapshots and screenshot mappings belong to one session and assistant turn.
Element paths additionally verify the application PID and element metadata
immediately before use; a failed refresh removes the previous snapshot. Actions
check the frontmost process and never replay an uncertain mutation through a
different action. A zero-window response does not imply permission refusal.

Text replacement chooses a writable AX value or confirms focus and Select All
before its typing fallback, then reads back the full value. Text insertion uses
writable AX selected text for Unicode. System Events keystroke fallback accepts
ASCII only: the owned native fixture observed Unicode corruption through that
path. Key dispatch and clicks report a request, without inferring the visible
outcome. Captures publish a validated private PNG atomically, use primary-display
geometry by default, and return explicit pixel-to-screen mapping. Mapping a
cached screenshot fails after the turn or display geometry changes.

Photos adds 38 tools through the same application and interaction owner. Read
results use JSON, including keyword arrays and nullable location/altitude values.
Names that identify multiple objects require an explicit ID. Batch metadata
resolves all IDs before changing anything, reads back each requested value, and
does not replay a write after failure. Several field writes are not a transaction;
a later failure can leave earlier fields changed.

Photos duplicate checking is enabled for omitted or true `skipDuplicates`.
Explicit false sends the native `skip check duplicates true` flag, which imports
duplicates. The committed default and description correct the inverse meaning
of that native flag while keeping the previous implicit duplicate-checking
behavior. File imports accept at most 200 regular files. Folder scans limit
depth, visited entries and media count, and do not follow directory symlinks.
Exports accept at most 200 assets, validate local regular files in a private
directory, then publish a unique subdirectory inside the requested destination.
The result names the actual directory and preserves existing destination files.
Larger work must use explicit batches. Timeouts or cancellation cannot undo an
Apple Event already delivered to Photos; they drain the owned command process
and must not be interpreted as proof that the application rolled back its work.

Photos UI actions recheck the exact selected asset, frontmost process, focused
editor, and pending sheets. Clockwise rotation follows Apple's documented
Option-Command-R shortcut. Exact enabled menu actions are chosen before the
single dispatch; missing localized menu labels produce a handoff. Delete, hide
and revert dispatches do not claim a confirmed library state. Batch UI work stops
at an uncertain result or confirmation and returns the remaining IDs. Crop,
album reordering/removal, Recently Deleted and iCloud account settings preserve
their explicit manual handoff. No authentication or confirmation is bypassed.

## Verification

Run from the repository root:

```
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
node apps/desktop/scripts/run-macos-connectors-test.mjs
node apps/desktop/scripts/run-macos-connectors-electron-test.mjs
node apps/desktop/scripts/run-macos-system-test.mjs
node apps/desktop/scripts/run-macos-system-electron-test.mjs
node apps/desktop/scripts/run-macos-organizers-test.mjs
node apps/desktop/scripts/run-macos-notes-test.mjs
node apps/desktop/scripts/run-macos-communications-test.mjs
node apps/desktop/scripts/run-macos-safari-test.mjs
node apps/desktop/scripts/run-macos-app-ui-test.mjs
node apps/desktop/scripts/run-macos-app-ui-electron-test.mjs
node apps/desktop/scripts/run-macos-photos-test.mjs
```

The unit suite includes actual processes, concurrent pipe/input pressure,
overflow termination, a child ignoring SIGTERM, an inherited-pipe descendant,
queue capacity, cancellation before dispatch, generation reuse, current-turn
checks, malformed metadata and permission failures. It pins the committed tool
contract without requiring another client's executable.

The normal Electron fixture touches only its own temporary Finder folder. It
checks real tag/color storage, unusual filenames, directory metadata, comments,
reveal/selection, opening the folder, and owner drain. It does not run any user's
Shortcut or read the clipboard. Real trash recovery requires
`KLAUS_FINDER_TRASH_FIXTURE=1` on a dedicated test account with Trash access;
without it the report explicitly marks that check as informational, not passed.

The initial macOS 26.6 run moved its unique fixture into Trash, but direct Python
and normal Electron recovery returned EPERM. Finder recovery then remained in
its stopping state after cancellation. That run is not a successful recovery
test. The exact remaining fixture and command evidence are tracked in the local
handoff record; no other Trash entries or Finder windows were changed.

The System unit suite uses injected clipboard, volume, notification, dialog, and
lock operations. It covers framing, path containment, unpublished capture
cleanup, cancellation, measured results, and permission refusal. The normal
Electron System fixture captures an eight-point region of its own colored
window, checks actual PNG pixels, limits a real Spotlight query to its temporary
directory, and drains the owner. It does not read the user's clipboard, change
volume, post notifications, display dialogs, or lock this working machine. Real
locked-state acceptance belongs to a dedicated test account.

The organizer suite compiles every action against installed application
dictionaries without executing it, executes actual Foundation serialization and
date construction on synthetic values, and covers contract hashes, readiness,
permission rejection, cancellation/drain, no mutation replay, field framing,
invalid inputs, and unconfirmed outcomes. These checks do not constitute live
Calendar/Contacts/Reminders record CRUD acceptance. Such acceptance must use a
dedicated test account and uniquely owned records, with cleanup confirmed after
the application has saved them. The suite reads no private database contents.

The Notes suite compiles all thirteen action scripts against the installed
dictionary and checks text framing, escaping, destination validation, and actual
temporary export files with injected application output. Delayed exports test
owner close and unpublished cleanup. It does not access user notes or claim live
Notes record or attachment export acceptance.

The communications suite compiles all Mail actions and the Messages selection
and send scripts without sending. It verifies delivery wording, no send retry,
recipient validation, owner close, and malformed results. A real sqlite3 fixture
uses an isolated home and database, checks quoted identifiers and LIKE queries,
and compares database hashes after read-only calls. It does not access real
Messages history, read private mail, create a user draft, or send to any person.

The Safari suite compiles every tab action against its installed dictionary,
checks framing, cancellation, bounded traversal, and uncertain-mutation refusal,
and executes the actual plutil and SQLite paths against uniquely owned fixtures.
It verifies original file bytes are unchanged and removes those fixtures. It
never reads the user's Safari bookmarks/history or operates existing tabs. Live
tab navigation and JavaScript permission acceptance require a dedicated browser
profile or test account; dictionary compilation alone does not prove them.

The App UI unit suite covers input validation, snapshot identity, capture mapping,
permission refusal, and cancellation while a native operation is still draining.
Only macOS compiles generated scripts against the installed dictionaries. The
normal Electron fixture builds its own native application, then checks actual
AX tree reads, field replacement, selected Unicode text, Select All, a menu and
button counter, screenshot pixels, mapped coordinate input, and cancellation.
It terminates its own process and removes its private application and profile.
It never targets the user's existing application windows or clipboard. These
checks demonstrate the owned native target, not every third-party application's
Accessibility implementation.

The Photos suite exercises all 38 named entrypoints with injected application
results, compiles their native scripts only on macOS, and uses actual owned
files for bounded scans, export publication, failed-export preservation and
cancellation/drain. It opens no real Photos library and performs no private
record CRUD, editing, import, or deletion. Those application and TCC acceptance
checks require a dedicated test account and uniquely owned media. The supported
UI dispatch mechanism is separately exercised by the App UI native fixture.

## Platform and acceptance scope

All twelve macOS services expose 131 tools, including the documented handoffs.
Windows and Linux report these macOS services unavailable. Their host tests run
the platform-independent validation and isolated file fixtures; installed macOS
dictionary compilation and native GUI fixtures are explicitly platform-specific.
