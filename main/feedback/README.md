# Feedback

`registerFeedbackHandlers(registry, service)` provides `feedback:submit`, `feedback:suggestion-submit`, `feedback:pick-attachments`, and `feedback:capture-screenshot`.

Construct `FeedbackService` with `workspaces`, `appVersion`, `serverUrl`, `token`, and `createFeedbackWindowAdapter(resolveAuthorizedMainWindow)`. The token callback belongs to the existing account service; this module never opens an authentication file. Optional environment, HTTP implementation, deadline and clock parameters support isolated fixtures. Call `releaseRenderer(senderId)` on renderer disposal, and await `close()` during shutdown.

Reports remain local under the configured `feedback/` or `suggestions/` directory even when delivery fails. The response distinguishes local persistence, server acceptance and actual mail delivery. An absent credential or HTTP 401 never falls back to SMTP. Other support-server failures can use explicitly configured SMTP, with the existing recipient/from/environment conventions and a JSON report attachment. No SMTP credential is bundled. Nodemailer is pinned to 10.0.1; only internally constructed text and Buffer attachments reach it, with file/URL access disabled and ordinary certificate validation retained.

Descriptions keep the existing 80,000-character limit. Attachment selection grants the requesting renderer at most eight files and 20 MiB per submission. Paths are canonicalized, deduplicated and checked against their selected file identity again through the opened descriptor. Submission cannot name an unselected file or reuse another renderer's grant. Cancelling/closing drains actual network sockets; a late picker cannot start a new submission.

Capture requires the caller's own visible, non-minimized main window. Hidden windows return a recoverable instruction to show the window. The service never shows/focuses a window or substitutes a desktop screenshot. Public Electron `capturePage` captures main content plus visible WebContentsViews, with parent clipping, ordering and layout-change rejection. It includes browser content without recording another application's pixels. See [Electron capturePage](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts).

## Isolated verification

```sh
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
node apps/desktop/scripts/run-import-feedback-test.mjs
```

Mac arm64 original output:

```text
external-agent-import: 20 passed, 0 failed, 0 info
feedback: 12 passed, 0 failed, 0 info
feedback-electron: 4 passed, 0 failed, 0 info
```

Windows x64 used the same Node suites, then `node apps/desktop/scripts/run-import-feedback-test.mjs --electron-only` through the already validated, temporary InteractiveToken/LeastPrivilege launcher structure in `scripts/smoke-windows-interactive.mjs`. It ran in the logged-in desktop session, with a unique task, no trigger, its own profile and finally cleanup. Original output:

```text
interactiveSessionId=1
feedback-electron: 4 passed, 0 failed, 0 info
interactive_exit_code=0
interactive_task_cleanup=removed
interactive_launcher_cleanup=removed
```

The pixel gate verifies hidden-window rejection, visible main pixels, embedded page pixels, hidden siblings, clipping and foreign-renderer rejection. `showInactive` is fixture setup only; the production capture function does not call it. Window focus stays false. Windows reported a real 122-pixel content height for the requested 120-pixel constructor height; assertions use measured client bounds. Earlier never-shown Windows capture attempts returned `UnknownVizError` in both Session 0 and Session 1, motivating the explicit visible-window precondition rather than an OS-wide fallback. Native picker selection itself is exercised through its injected result; this suite does not automate a user's real file dialog.

Actual loopback HTTP and SMTP cover cloud acceptance, 401, recipient rejection, report-only SMTP attachment, hanging-socket shutdown, attachment grants and size limits. No real support request or mail was sent. `npm install --prefix apps/desktop --save-exact nodemailer@10.0.1 --registry=https://registry.npmjs.org` returned `found 0 vulnerabilities`. Windows `npm ci` retained upstream deprecated-package notices; TypeScript builds emitted no compiler warnings. Its Electron download was restored from the existing official 44.2.0 cache only after matching the npm package checksum (`4021363e3090d67a144ebedb90765cf193b0e61f300c519c83f0174502a481da`).
