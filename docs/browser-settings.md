# Browser settings and local data

The browser settings page owns link destinations, full URL display, annotation screenshots, browsing history, download history and website permissions. Agent browser control follows the built-in Browser plugin state. Changing that state waits for the engine mutation receipt; manual pages remain usable when agent control is disabled.

The in-app browser uses the standard Electron distribution. The application does not require a modified Electron or Chromium runtime.

## Profile import

Profile discovery reads supported browser directories and optional profile metadata only when requested. An access denial remains distinct from an empty profile list. Import jobs belong to the requesting application window and are cancelled when that owner closes. Snapshots include stage, counts and structured errors, never decrypted rows. Cookies, passwords and history are selected by default; extensions require an explicit choice.

SQLite source snapshots validate the database and its WAL/SHM sidecars before and after copying. History writes use bounded transactions and stable visit identities. Repeated imports report unchanged rows as successful no-ops. Cookie writes preserve partition keys through the browsing session, including the cross-site ancestor flag. Cancellation stops between bounded transactions; completed writes remain in the receipt.

Small standalone helpers decrypt supported source formats on macOS and Windows. They are prepared automatically for development and explicitly staged and checked for packaging. Discovery never accesses browser encryption keys. Windows application-bound encrypted entries are reported as unsupported; connected Chrome can continue using its existing login state. The application does not bypass source-browser or operating-system protection.

## Passwords and autofill

The host encrypts saved passwords and address/contact fields through operating-system encryption. It refuses a plaintext storage backend. Lists contain metadata; revealing, copying and editing a password require explicit user action. Copy stays in the host. The settings editor preserves the selected record identity when changing its website, username or password.

Autofill requires a real user gesture and a trusted chooser, even for a single entry. The host identifies the exact sender frame and document and sends values only to that frame. Navigation revokes pending fills. A submitted credential can be saved after a normal login redirect, using its frozen original origin and explicit confirmation. Window destruction and shutdown revoke pending work.

## Extensions

Extension management uses Electron session extensions and records actual load acknowledgements. It restores enabled registrations at startup, reports load errors and preserves the user-selected source directory when removing a registration. Electron supports a subset of Chrome extension APIs. Extensions requiring additional APIs can run in connected Chrome; copying files alone is never reported as installation success.

## Validation

`node scripts/audit-runtime-channels.mjs` exercises the production renderer, bridge and engine, including settings persistence, plugin transitions, history, permissions, annotations and synthetic imports. The synthetic credential fixture uses its own authenticated encryption key and never reads a real browser password or the user keychain.

Focused host suites include `browser-settings`, `browser-history`, `browser-profile-import`, `browser-profile-import-service`, `browser-profile-import-helper`, `browser-credentials` and `browser-extensions`. On macOS, `browser-profile-decryptor` prepares a separate synthetic helper. The real Electron fixtures cover gesture-bound autofill, login redirects and extension lifecycle. Packaging validates helper target, production mode, source identity and file integrity.
