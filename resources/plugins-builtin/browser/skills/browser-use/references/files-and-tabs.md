# Files and task-owned tabs

## Upload

Use `file_upload` with absolute regular-file paths and the real input or chooser
control. Hidden `input[type=file]` elements are valid upload targets; changing
their CSS is unnecessary. Multiple files require a multiple-file input or
chooser. Do not type a path into a native file dialog.

When the target is a file input, the host supplies files directly through the
browser protocol without opening a chooser. For a chooser control, it arms the
chooser listener before clicking, then supplies files to the identified input.
Observe the returned delivery state and diagnostics, then verify the resulting
preview, filename or attachment state. Browser acceptance does not establish
that the site's server completed the upload. Use `paths` on native
`browser_file_upload`; the host MCP operation also accepts `files`.
See [result envelopes](operations.md#result-envelopes) for the receipt location.

`acknowledged` records browser acceptance. `observation.state` separately reports
`attached`, `input-empty`, `input-detached`, `different-files`, or `unavailable`.
An unavailable observation does not prove that a file was rejected. Cancellation
or a disconnected transport also cannot undo a file selection already accepted
by the page; inspect the current attachment state before repeating it.

If the extension reports that local-file access is disallowed, follow the
reported extension settings instructions. Do not start an HTTP server, fetch a
local file into the page, fabricate a `DataTransfer`, or call a site's internal
handler as a workaround for an upload-tool failure. Report the concrete blocker.

## Download

Use `download` for URLs or original page media. Keep the returned page-owned
download ID. The host MCP operation can poll or cancel that ID instead of
starting the download again. Native `browser_download` supports `waitOnly` for
the page's active download but has no ID-based cancel input; do not assume
MCP-only fields are accepted by the native tool. If multiple downloads make the
active download ambiguous, inspect the available host schema or report the limit.
Wait for a completed local file before reporting a saved artifact. A filename
or partial file alone is not completion. External Chrome can attribute only the
downloads owned by its extension operation; arbitrary human downloads may be
unavailable.

## Ownership and cleanup

List task tabs before finalization. A user tab must be claimed explicitly, and a
tab owned by another task cannot be claimed. Preserve the user's working context.
Use `mark_tab` for an external-browser deliverable or handoff, then finalize task
tabs with the explicit keep list as needed. Close only disposable task-owned tabs.

The built-in browser's visibility belongs to the foreground conversation.
Background tasks must not take focus. External Chrome remains the user's own
window, and the host cannot hide it. An intentional visibility or ownership
refusal is not a reason to switch browsers or bypass the task boundary.
