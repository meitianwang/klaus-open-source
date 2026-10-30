# Manual replacement and data recovery

Install Electron directly. Quit the existing Klaus process first, including its
tray/background process, then replace the macOS application or uninstall the old
Windows application without deleting its data and install the Electron package.
There is no Tauri transition release and no cross-framework automatic update.

The business-data root remains `~/.klaus`, or the resolved `KLAUS_CONFIG_DIR`.
Electron stores its application cache separately under `<configRoot>/electron`.
The engine still owns its session files, configuration, credentials and installed
plugin ledger. The client continues to reach those through named facade methods.
Do not import a second plugin ledger or convert WhatsApp state to a different SDK.

Before Electron first writes settings, startup creates
`<configRoot>/migration-backups/electron-settings-v1`. Its `settings.db` is an
SQLite online backup, including committed WAL transactions. It is not a raw copy
of a live database file. The snapshot records its hash, schema version and table
names, validates SQLite integrity and commits its completion record atomically.
An unsuccessful attempt stops startup; retrying does not overwrite a completed
backup. A fresh profile records that no previous database existed.

The backup directory is restricted to the current user before any data is written
(POSIX directory mode 0700 and files 0600; a current-user Windows ACL). It may
contain credentials present in historical settings rows. Keep it private; do not
attach it to bug reports. Runtime and tool output contain metadata, not its values.

The old local model role keys migrate transactionally to `model_tiers:local`.
An existing map, including an explicitly empty map, takes precedence. The old
keys remain available in the original snapshot. Windows host credential migration
separately preserves the encrypted blob, required Local State encryption fields
and any relevant legacy plaintext in its existing `windows-credentials` backup.
A key conflict blocks access rather than choosing an arbitrary key or discarding
the credential. System keychain items retain their existing service/account names.

The first release creates a separate Chromium browser profile. Browser login may
be repeated. It does not erase the old WebView profile or promise to import all
WebKit IndexedDB/localStorage data. Export any development draft that is still
needed before removing an old installation; do not publish an old export build.

## Inspect and recover a settings snapshot

Run `npm run build:main --prefix apps/desktop` once in the source checkout. These
commands use the same Electron SQLite runtime as the application:

```sh
node apps/desktop/scripts/profile-data.mjs inspect --snapshot /absolute/profile/migration-backups/electron-settings-v1
node apps/desktop/scripts/profile-data.mjs restore --snapshot /absolute/profile/migration-backups/electron-settings-v1 --new-profile /absolute/new-recovery-profile
```

Recovery requires a new directory. It never overwrites an existing profile and
restores only `settings.db`; it does not rewind engine histories, plugin files,
system keychain items, browser cookies or new files created after installation.
Inspect the separate recovered profile before deciding how to reconcile changes.
Retain both the current data and the previous installer during a manual rollback.
Do not copy a previous settings database over new user data or assume that an older
application can read every newer schema. Withdrawing an Electron update only
prevents new installations of that offer; it does not undo already installed data.

macOS automatic installation is available only when the active profile resolves
to the current operating-system account's default `~/.klaus`. The system updater
relaunches the application without its previous command-line arguments or custom
environment, so a separate `KLAUS_CONFIG_DIR` cannot be preserved by that restart.
For such a profile, quit and replace the application manually, then launch it
with the same profile configuration. The client refuses automatic installation
before handing anything to the system updater instead of opening another profile.
