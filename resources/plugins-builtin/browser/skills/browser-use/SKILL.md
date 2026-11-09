---
name: browser-use
description: Operate browser pages, inspect live tabs and page content, fill forms, upload or download files, and verify browser interactions with screenshots. Use for tasks in the in-app browser or the user's connected Chrome.
---

Browser control is a host MCP server named `klaus-browser`. Every operation is
one tool: `mcp__klaus-browser__<operation>`, such as
`mcp__klaus-browser__navigate`, `mcp__klaus-browser__ax_state` or
`mcp__klaus-browser__ax_action`. These tools are deferred and are not in the
initial tool list. Activate them with `tool_search` before first use — search by
capability, or load exact names with
`select:mcp__klaus-browser__navigate,mcp__klaus-browser__ax_state`. The host
owns the browser connection and tab handles. Do not launch a separate browser,
import an unrelated automation client, or obtain browser credentials from files
to work around a browser-tool error.

## Choose the right surface

Honor explicit browser intent. When the user asks to open, show, navigate to,
visually inspect, or interact with a page, use the browser operations. For a
semantic read of a linked resource without browser intent, prefer an available
connector, API or CLI that can reach that resource; use the browser when UI work
remains.

Navigation accepts HTTP, HTTPS and `about:blank`; privileged URL schemes are
rejected. Create an empty tab with `mcp__klaus-browser__tabs`, `action: new`,
and no URL. Local file paths are upload inputs, not supported navigation URLs.

Read [the operation guide](references/operations.md) before driving a page. Read
[files and tab ownership](references/files-and-tabs.md) for uploads, downloads,
existing user tabs, or task cleanup.

## Choose the browser and bind the tab

1. Honor the browser or tab the user selected. Resolve the complete tab mention
   with `mcp__klaus-browser__resolve_tab`, then use its exact browser ID and tab
   handle. A stale mention is an error; do not open a replacement tab.
2. For tasks involving an existing account or logged-in page, list connected
   browsers and select the required external `browserId`. The built-in browser
   has separate sign-in state. A capability query does not select a browser.
3. If no browser was specified, the `mcp__klaus-browser__browser_for_url`
   operation can inspect tab and history evidence to choose a browser. Inspect
   its returned reason and failures.
4. List the selected browser's task tabs. User-tab discovery and history require
   an external browser. Claim the user's exact existing tab before controlling it.
5. Keep browser and tab identity explicit when working with several pages. An
   external connection failure must remain an error; do not switch to the built-in
   browser and continue on a different page.

## Observe and act: accessibility-first

- `ax_state` is the primary observation. It renders the page as accessibility
  text with integer element indices, and always includes the title, URL, the
  focused element and any selected text. After the first read of a document it
  returns a diff (`~` changed, `+` added, plus removed ID ranges); pass
  `disableDiffing: true` for the full tree. Capture waits for the page to
  settle first — do not add sleeps around it.
- `ax_action` is the primary interaction, addressing an `elementIndex` from the
  latest `ax_state` with real browser input: `click` (count, button, held key
  or modifier combination such as `super` or `shift+a`, hold duration),
  `type_text`, `set_value`, `paste`, `press_key` (xdotool-style keys such as
  `Return` or `super+c`), `scroll`, `select_text`, `secondary_action` (only
  names the state exposes, such as `Expand`, `Collapse` or `Scroll to Visible`)
  and `drag`.
- Indices belong to the state that returned them. After any action or
  navigation, read `ax_state` again instead of reusing old indices. A failed
  action returns the fresh accessibility state with the error — re-derive the
  target from it instead of repeating the same action blindly.
- Batch multi-step interactions in one `REPL` call. The REPL binds the browser
  tools as async functions and adds a hierarchical `browser` API:
  `browser.getState()`, `browser.getTab(id)` with `tab.ax.write()`,
  `tab.ax.get()`, `tab.ax.click(target)`, `tab.ax.typeText(index, text)`,
  `tab.ax.pressKey(index, key)`, `tab.ax.paste(index, text)`,
  `tab.ax.scroll(target, direction, pages)`,
  `tab.ax.performSecondaryAction(index, name)`, `tab.content.text()`,
  `tab.dev.console()` and more; `browser.docs()` prints the full reference.
- Use `snapshot`, `read_page`, `locator` and the named click, type, form,
  checkbox, select, upload and download operations for structured reads and
  stable criteria-based targeting; they complement the index workflow. A page
  script does not reproduce trusted pointer or keyboard input. Use coordinates
  only when the target cannot be addressed by index or name, and obtain a
  current screenshot before choosing them.
- Navigate with the navigation operation. Page typing does not address a browser
  address bar. Never type browser shortcuts or a URL into a web page to navigate.
- For named-element workflows, wait for the specific element, URL or load state
  needed by the next action. Use a bounded timeout and inspect what timed out
  before retrying.
- If a target is covered or disabled, inspect the page and resolve the
  condition. Do not bypass it with script or substitute a different action.
- Verify the resulting page state. For visual work, capture a screenshot and
  inspect it as proof of what the user would see; the result reports `scale`
  (image pixels per CSS pixel), so divide image-measured coordinates by scale
  before clicking them. Keep actual saved artifact paths when a result is to be
  shared.
- Read console and network diagnostics to distinguish a failed request from a
  page that is still loading. Preserve the reported error and body availability;
  an empty or truncated result does not establish that no error occurred.

## Capability and error handling

Query the `mcp__klaus-browser__capabilities` operation before relying on
backend-specific operations. It reports the requested browser's supported
operations and mode limits; it does not switch the active browser. Check
`selectedBrowserId` or call `select_browser` explicitly. GIF recording
(`gif_creator`), shortcut discovery (`shortcuts_list`), shortcut execution
(`shortcuts_execute`) and a separate image-upload tool (`upload_image`) are
unavailable operations. Use `file_upload` for real file inputs; it is not GIF
recording or a shortcut service.

Read-only refusal, ownership denial, missing tabs, disconnected transports, and
page script exceptions describe different failures. Retain that distinction when
reporting an incomplete task. Do not repeat the same mutation after an ambiguous
transport failure until the current page establishes whether it already happened.
