# Browser operations

The engine exposes `browser_*` tools; the host MCP server also exposes named
operations under `mcp__klaus-browser__*`. Use the tool schema actually returned in
the session. A native operation can internally call its MCP transport; that is
one browser action, not a reason to repeat the action manually.

Names below refer to host operations unless a complete native tool name is
shown. A host operation name does not guarantee a matching native tool. Use
only tools exposed and permitted in this session; internal transport tools are
not an alternate entry point around the native tool or a policy denial.

## Native and host contracts

| Operation | Native tool input | Host MCP input |
| --- | --- | --- |
| Select browser | `browser_select_browser`: required `deviceId` | `select_browser`: `browserId` (also accepts `deviceId` or `id`) |
| Upload files | `browser_file_upload`: required `paths` array | `file_upload`: `files` array (also accepts `paths` or `path`) |
| Ordered actions | `browser_batch`: required `actions` array; each action needs `type` | `batch`: `operations` array (also accepts `actions` or `steps`) |
| Wait | Exposed `browser_locator` action `wait_for`, or `browser_computer` action `wait`, using that tool's schema | `wait_for` with its declared subject fields |
| Download | `browser_download` starts a download or uses `waitOnly`; it has no ID-based cancel input | `download` supports `action: wait` or `action: cancel` with the owned download ID |

There is no standalone native `browser_wait_for`, `browser_capabilities`,
`browser_back`, `browser_forward` or `browser_reload` tool. `browser_for_url` is
also a host-only operation. Do not manufacture these tools by adding a prefix.
Use a host-only operation only when its actual allowed MCP tool is exposed;
otherwise report the limitation. Host navigation permits `about:blank`, while
native navigation validates HTTP(S). To create an empty native tab, use
`browser_tabs` with `action: new` and omit the URL.

## Result envelopes

For an ordinary host MCP runtime response, operation data is under
`structuredContent.value`. A partially failed batch has `isError: true`,
`structuredContent.partial: true`, and `structuredContent.error`; its completed
work remains in `structuredContent.value.completed`, `.stopped`, and `.results`.

A native structured result places the runtime response under `output.response`.
A partial batch has `output.ok: false`, `output.response.partial: true`, and
`output.response.error`; completed work remains in
`output.response.value.completed`, `.stopped`, and `.results`. The tool is also
marked failed. Native model-facing text can serialize the operation value
directly, without those wrappers. Inspect the actual presented error and value;
early validation or transport failures can use a separate error output. Never
infer success merely because one expected wrapper is absent.

For native upload results, browser acceptance and observation are
`output.response.value.acknowledged` and `.observation.state`; host MCP uses
`structuredContent.value.acknowledged` and `.observation.state`. In native
value-only model text, those fields appear directly as `acknowledged` and
`observation.state`. Acceptance is distinct from the website finishing upload.

## Discovery and navigation

- `list_connected_browsers` lists the built-in browser and reachable external
  instances with stable browser IDs.
- `select_browser` changes this task's selected browser. `capabilities` only
  inspects one. `browser_for_url` chooses using observed tab and history evidence.
- `tabs` lists, creates, selects or closes task-owned tabs. `tabs` with
  `action: user`, `tabs_content`, `history`, `claim_tab` and `mark_tab` require an
  external browser. Pass the selected external browser ID when making an
  explicit one-call request.
- `navigate`, `back`, `forward` and `reload` act on the addressed tab. Navigation
  accepts HTTP(S) and `about:blank`. Privileged URL schemes are rejected.
- `resolve_tab` verifies a complete user-selected tab mention, including original
  title and URL. Preserve its returned IDs; a failed resolution must not create a
  replacement tab.

## Read and interact

- `snapshot` and `read_page` return page identity, structural content and element
  refs. Scope long reads, check truncation, and read the remaining relevant portion.
- `locator` accepts CSS, refs and accessible criteria. `options` carries action
  settings on native tools. `count` and text reads do not establish clickability.
  A locator action must target one element unless an explicit index narrows it.
- `click` sends pointer input. `type` targets an editable field, with `clear` to
  replace existing content. `locator` with `action: fill` replaces content;
  `action: press` presses its `value` key combination.
- `form_input` fills fields in order, retaining a concrete failure if a field
  fails. Submission requires an explicit submit target.
- `set_checked` verifies checkbox/radio state. `select_option` addresses a native
  select by option value, label or index; use a real click for a custom menu.
- `computer` handles pointer movement, drag, key combinations and scroll. An
  inner scrolling region may require a current point or named target. Keys are
  a combination such as `Meta+A` or a list of key names, not a JSON-encoded string.
- `wait_for` accepts one subject: an element state, URL, load state, or bounded
  duration. `networkidle` means a quiet observation window, not that every server
  connection has closed.
- `batch` runs ordered operations and stops at the first failure. Inspect its
  `completed` and `stopped` fields before deciding which actions remain. A stopped
  batch has a failed tool result with `partial: true`; completed results remain
  available. Failure does not roll back earlier actions, so do not repeat them.

## Evaluation and diagnostics

`eval` accepts a JavaScript expression. To perform an asynchronous read, use an
async function expression with `args`, or an invoked async expression such as
`(async () => { const text = document.body.innerText; return text; })()`.
Bare top-level `await`, top-level `return`, and TypeScript syntax are not page
expressions. Do not retry syntax errors as browser transport failures.

Prefer structured reads and named UI actions. For `readOnly` or `isolated`, the
host uses a separate page world and refuses execution whose side effects cannot
be excluded. It does not silently retry in the page's writable world.

`console` can filter levels and recent entries. `network` can filter URLs and
request bounded response bodies. Check body truncation, unavailable/evicted body
errors, counts and history eviction. Raw page-scoped `cdp` supports diagnostics
and event cursors; it does not bypass target ownership, navigation, permissions,
downloads or file-upload boundaries.

## Capture and viewport

`screenshot` captures a tab, a named element, or a CSS-pixel clip. Check that the
clip intersects visible pixels and respects the image budget. A saved capture
returns its actual path; `save: false` is transient. Do not invent an artifact
path. Restore a temporary viewport override with `resize` and `reset: true`.
