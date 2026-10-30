---
name: browser-use
description: Operate browser pages, inspect live tabs and page content, fill forms, upload or download files, and verify browser interactions with screenshots. Use for tasks in the in-app browser or the user's connected Chrome.
---

Use the session's browser tools. Their host owns the browser connection and tab
handles. Do not launch a separate browser, import an unrelated automation client,
or obtain browser credentials from files to work around a browser-tool error.

## Choose the right surface

Honor explicit browser intent. When the user asks to open, show, navigate to,
visually inspect, or interact with a page, use the browser tools. For a semantic
read of a linked resource without browser intent, prefer an available connector,
API or CLI that can reach that resource; use the browser when UI work remains.

The host accepts HTTP, HTTPS and `about:blank` navigation. Native navigation
accepts HTTP(S); create an empty native tab with `browser_tabs`, `action: new`,
and no URL. Local file paths are upload inputs, not supported navigation URLs.

Read [the operation guide](references/operations.md) before driving a page. Read
[files and tab ownership](references/files-and-tabs.md) for uploads, downloads,
existing user tabs, or task cleanup.

## Choose the browser and bind the tab

1. Honor the browser or tab the user selected. Resolve the complete tab mention
   with `browser_resolve_tab`, then use its exact browser ID and tab handle.
   A stale mention is an error; do not open a replacement tab.
2. For tasks involving an existing account or logged-in page, list connected
   browsers and select the required external `browserId`. The built-in browser
   has separate sign-in state. A capability query does not select a browser.
3. If no browser was specified, the host's `browser_for_url` operation can inspect tab and
   history evidence to choose a browser. Inspect its returned reason and failures.
4. List the selected browser's task tabs. User-tab discovery and history require
   an external browser. Claim the user's exact existing tab before controlling it.
5. Keep browser and tab identity explicit when working with several pages. An
   external connection failure must remain an error; do not switch to the built-in
   browser and continue on a different page.

## Observe, act, and verify

- Read a page snapshot or structural text before choosing a target. Prefer role,
  accessible name, label, placeholder, or a returned element ref. Narrow multiple
  matches by scope or index instead of clicking an arbitrary match.
- Use named click, type, form, checkbox, select, upload and download operations.
  A page script does not reproduce trusted pointer or keyboard input. Use
  coordinates only when the target cannot be named, and obtain a current screenshot
  before choosing them.
- Navigate with the navigation operation. Page typing does not address a browser
  address bar. Never type browser shortcuts or a URL into a web page to navigate.
- Wait for the specific element, URL or load state needed by the next action.
  Use a bounded timeout and inspect what timed out before retrying.
- Re-read after navigation or a re-render that invalidates a ref. If a target is
  covered or disabled, inspect the page and resolve the condition. Do not bypass
  it with script or substitute a different action.
- Verify the resulting page state. For visual work, capture a screenshot and
  inspect it. Keep actual saved artifact paths when a result is to be shared.
- Read console and network diagnostics to distinguish a failed request from a
  page that is still loading. Preserve the reported error and body availability;
  an empty or truncated result does not establish that no error occurred.

## Capability and error handling

When the session exposes the host `capabilities` operation, query it before
relying on backend-specific operations. Otherwise use the exposed tool schemas
and reported limits; do not invent a native capability tool. The host operation
reports the requested browser's supported operations and mode limits. It does not switch the active browser. Check `selectedBrowserId` or call
`select_browser` explicitly. Unimplemented GIF recording, shortcut discovery,
shortcut execution and separate image-upload tools remain explicit unavailable
operations. Use `file_upload` for real file inputs; it is not GIF recording or a
shortcut service.

Read-only refusal, ownership denial, missing tabs, disconnected transports, and
page script exceptions describe different failures. Retain that distinction when
reporting an incomplete task. Do not repeat the same mutation after an ambiguous
transport failure until the current page establishes whether it already happened.
