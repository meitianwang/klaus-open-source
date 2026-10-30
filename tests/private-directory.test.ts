import { deepEqual, equal, rejects, throws } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { restrictPrivateDirectory } from '../main/app/private-directory';
import { FALLBACK_SCRIPT } from '../main/app/private-directory-windows';
import { ensureSettingsBackup, restoreSettingsBackup } from '../main/app/settings-backup';
import { prepareWindowsProfile } from '../main/app/windows-profile';
import { Harness } from './harness';

const h = new Harness(), roots: string[] = [];
process.exitCode = 1;
const script = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$rows=@()
foreach($path in $inputData.paths){
  $item=Get-Item -LiteralPath $path -Force
  $acl=if($item.PSIsContainer){[IO.Directory]::GetAccessControl($path)}else{[IO.File]::GetAccessControl($path)}
  if($inputData.grant){
    $inheritance=if($item.PSIsContainer){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity.User,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    $foreign=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($foreign,[Security.AccessControl.FileSystemRights]::Read,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    if($item.PSIsContainer){[IO.Directory]::SetAccessControl($path,$acl)}else{[IO.File]::SetAccessControl($path,$acl)}
    $acl=if($item.PSIsContainer){[IO.Directory]::GetAccessControl($path)}else{[IO.File]::GetAccessControl($path)}
  }
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value; inherited=$_.IsInherited; type=$_.AccessControlType.ToString(); rights=[int]$_.FileSystemRights; flags=[int]$_.InheritanceFlags} })
  $rows+=@{owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; user=$identity.User.Value; protected=$acl.AreAccessRulesProtected; rules=$rules}
}
ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress
`;
interface Acl { owner: string; user: string; protected: boolean; rules: Array<{ sid: string; inherited: boolean; type: string; rights: number; flags: number }> }
function acl(paths: string[], grant = false): Acl[] {
  const output = execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: JSON.stringify({ paths, grant }), encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(output) as Acl[];
}
function fixture(name = 'backup') {
  const root = mkdtempSync(join(tmpdir(), 'klaus-backup-acl-')); roots.push(root);
  const directory = join(root, name); mkdirSync(directory);
  const file = join(directory, 'settings.db'); writeFileSync(file, 'synthetic-private-bytes');
  return { root, directory, file };
}
function privateAcl(paths: string[]): void {
  const rows = acl(paths);
  equal(rows.length, paths.length);
  rows.forEach((row, index) => {
    equal(row.owner, row.user); equal(row.protected, true);
    deepEqual(row.rules, [{ sid: row.user, inherited: false, type: 'Allow', rights: 0x1f01ff, flags: lstatSync(paths[index]!).isDirectory() ? 3 : 0 }]);
  });
}

h.test('backup repair preserves every byte and narrows both the directory and existing files', () => {
  const f = fixture(), before = readFileSync(f.file);
  if (process.platform === 'win32') {
    const rows = acl([f.directory, f.file], true);
    equal(rows.every(row => row.rules.some(rule => rule.sid === 'S-1-1-0' && !rule.inherited)), true);
  } else { chmodSync(f.directory, 0o755); chmodSync(f.file, 0o644); }
  restrictPrivateDirectory(f.directory, f.root);
  deepEqual(readFileSync(f.file), before);
  if (process.platform === 'win32') privateAcl([f.directory, f.file]);
  else { equal(lstatSync(f.directory).mode & 0o7777, 0o700); equal(lstatSync(f.file).mode & 0o7777, 0o600); }
});
h.test('reusing a completed WAL snapshot repairs permissions without changing the saved snapshot', async () => {
  const f = fixture(); rmSync(f.file);
  const db = new DatabaseSync(f.file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE proof(value TEXT); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO proof VALUES ('committed-WAL-row')");
    const result = await ensureSettingsBackup(f.directory), database = join(result.directory, 'settings.db'), marker = join(result.directory, 'snapshot.json');
    const saved = readFileSync(database), record = readFileSync(marker);
    if (process.platform === 'win32') acl([result.directory, database, marker], true);
    else { chmodSync(result.directory, 0o755); chmodSync(database, 0o644); chmodSync(marker, 0o644); }
    equal((await ensureSettingsBackup(f.directory)).status, 'existing');
    deepEqual(readFileSync(database), saved); deepEqual(readFileSync(marker), record);
    if (process.platform === 'win32') privateAcl([result.directory, database, marker]);
    else for (const file of [database, marker]) equal(lstatSync(file).mode & 0o7777, 0o600);
    const restored = join(f.root, 'restored'); await restoreSettingsBackup(result.directory, restored);
    const copy = new DatabaseSync(join(restored, 'settings.db'), { readOnly: true });
    try { equal(copy.prepare('SELECT value FROM proof').get()?.value, 'committed-WAL-row'); } finally { copy.close(); }
    if (process.platform === 'win32') privateAcl([restored, join(restored, 'settings.db')]);
  } finally { db.close(); }
});
h.test('an outside directory is refused without changing its permissions or bytes', () => {
  const f = fixture(), other = fixture('foreign');
  const before = process.platform === 'win32' ? acl([other.directory, other.file]) : [lstatSync(other.directory).mode, lstatSync(other.file).mode];
  throws(() => restrictPrivateDirectory(other.directory, f.root), /OUTSIDE_ROOT/);
  const after = process.platform === 'win32' ? acl([other.directory, other.file]) : [lstatSync(other.directory).mode, lstatSync(other.file).mode];
  deepEqual(after, before); equal(readFileSync(other.file, 'utf8'), 'synthetic-private-bytes');
});
h.test('restoring a read-only backup produces a writable private database', async () => {
  const f = fixture(); rmSync(f.file);
  const db = new DatabaseSync(f.file); db.exec('CREATE TABLE proof(value TEXT)'); db.close();
  const snapshot = await ensureSettingsBackup(f.directory), file = join(snapshot.directory, 'settings.db'); chmodSync(file, 0o400);
  try {
    const restored = join(f.root, 'writable-restore'); await restoreSettingsBackup(snapshot.directory, restored);
    const copy = new DatabaseSync(join(restored, 'settings.db'));
    try { copy.exec("INSERT INTO proof VALUES ('new restored write')"); equal(copy.prepare('SELECT COUNT(*) AS total FROM proof').get()?.total, 1); } finally { copy.close(); }
    if (process.platform === 'win32') privateAcl([restored, join(restored, 'settings.db')]);
  } finally { chmodSync(file, 0o600); }
});
h.test('a hardlinked backup is refused before any directory permissions change', () => {
  const f = fixture(), sibling = join(f.root, 'external-file'); linkSync(f.file, sibling);
  const before = process.platform === 'win32' ? acl([f.directory, f.file]) : [lstatSync(f.directory).mode, lstatSync(f.file).mode];
  throws(() => restrictPrivateDirectory(f.directory, f.root), /HARDLINK/);
  const after = process.platform === 'win32' ? acl([f.directory, f.file]) : [lstatSync(f.directory).mode, lstatSync(f.file).mode];
  deepEqual(after, before); equal(readFileSync(sibling, 'utf8'), 'synthetic-private-bytes');
});
h.test('a junction or symlink inside the scope cannot redirect permission repair', () => {
  const f = fixture(), other = fixture('outside'), link = join(f.root, 'redirect');
  symlinkSync(other.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  const before = process.platform === 'win32' ? acl([other.directory, other.file]) : [lstatSync(other.directory).mode, lstatSync(other.file).mode];
  throws(() => restrictPrivateDirectory(link, f.root), /regular file or directory|REPARSE/);
  deepEqual(process.platform === 'win32' ? acl([other.directory, other.file]) : [lstatSync(other.directory).mode, lstatSync(other.file).mode], before);
});
h.test('unexpected nested directories cause preflight failure without a recursive repair', () => {
  const f = fixture(); mkdirSync(join(f.directory, 'nested')); writeFileSync(join(f.directory, 'nested', 'untouched'), 'nested');
  throws(() => restrictPrivateDirectory(f.directory, f.root), /regular file or directory/);
  equal(readFileSync(join(f.directory, 'nested', 'untouched'), 'utf8'), 'nested');
});
h.test('path text crosses the Windows command as data and cannot execute PowerShell', () => {
  const f = fixture("中文 ' $(throw 'INJECTED') ; [backup]");
  restrictPrivateDirectory(f.directory, f.root);
  equal(readFileSync(f.file, 'utf8'), 'synthetic-private-bytes');
  if (process.platform === 'win32') privateAcl([f.directory, f.file]);
});
if (process.platform === 'win32') h.test('a foreign owner on the scope root is rejected before repairing any child', () => {
  const f = fixture(); acl([f.root, f.directory, f.file], true);
  execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32/icacls.exe'), [f.root, '/setowner', '*S-1-5-18'], { windowsHide: true, timeout: 10_000, stdio: 'pipe' });
  const before = acl([f.root, f.directory, f.file]); equal(before[0]!.owner, 'S-1-5-18');
  throws(() => restrictPrivateDirectory(f.directory, f.root), /FOREIGN_OWNER/);
  deepEqual(acl([f.root, f.directory, f.file]), before);
});
h.test('credential backups are repaired even when a completed owner marker returns early', () => {
  const f = fixture(), appData = join(f.root, 'roaming'), statePath = join(f.directory, 'electron', 'Local State');
  mkdirSync(join(f.directory, 'electron')); mkdirSync(join(appData, 'Klaus'), { recursive: true });
  const key = Buffer.from('DPAPI-synthetic-key').toString('base64');
  writeFileSync(statePath, JSON.stringify({ os_crypt: { encrypted_key: key } }));
  writeFileSync(join(f.directory, '.credentials.enc'), 'synthetic-encrypted-old-login');
  const options = { configRoot: f.directory, appData }, initial = prepareWindowsProfile(options);
  const directory = initial.backupDirectory!; equal(typeof directory, 'string');
  const paths = [directory, ...readdirSync(directory).map(file => join(directory, file))];
  const before = paths.slice(1).map(file => readFileSync(file));
  if (process.platform === 'win32') acl(paths, true);
  else for (const path of paths) chmodSync(path, lstatSync(path).isDirectory() ? 0o755 : 0o644);
  equal(prepareWindowsProfile(options).status, 'current');
  paths.slice(1).forEach((file, index) => deepEqual(readFileSync(file), before[index]));
  if (process.platform === 'win32') privateAcl(paths);
  else for (const path of paths.slice(1)) equal(lstatSync(path).mode & 0o7777, 0o600);
});
h.test('an existing snapshot link is refused on the reuse path', async () => {
  const f = fixture(); rmSync(f.file);
  const original = await ensureSettingsBackup(f.directory), moved = join(f.root, 'other-snapshot');
  mkdirSync(moved); writeFileSync(join(moved, 'snapshot.json'), readFileSync(join(original.directory, 'snapshot.json')));
  rmSync(original.directory, { recursive: true }); symlinkSync(moved, original.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await rejects(ensureSettingsBackup(f.directory), /regular file or directory|REPARSE/);
  equal(existsSync(join(moved, 'snapshot.json')), true);
});

h.test('the constrained-language fallback stays inside cmdlets and external executables', () => {
  // Enterprise policy can lock PowerShell into Constrained Language Mode, where Add-Type,
  // type creation and .NET static members are forbidden. The fallback is the only repair
  // path left there, so it must never grow one of those constructs back.
  const forbidden = [
    /Add-Type/,
    /New-Object/,
    /\[Console\]::/,
    /\[[A-Za-z.]+\]::new\(/,
    /\[System\./,
    /\[Security\./,
    /\[IO\./,
    /\[Collections\./,
    /\[Text\./,
    /\[Convert\]::/,
    /\[Environment\]::/,
    /\[DateTime\]::/,
    /\[regex\]::/,
  ];
  for (const pattern of forbidden) equal(pattern.test(FALLBACK_SCRIPT), false, `fallback script must avoid ${pattern}`);
  equal(FALLBACK_SCRIPT.includes('icacls.exe'), true);
  equal(FALLBACK_SCRIPT.includes('whoami.exe'), true);
  equal(FALLBACK_SCRIPT.includes("LanguageMode -ne 'ConstrainedLanguage'"), true);
  // Scope roots and intermediate directories keep their ordinary inherited ACLs. The
  // strict single-ACE verification must therefore stay inside the branch that rewrites
  // an entry, not run over every inspected entry.
  const changeBranch = FALLBACK_SCRIPT.indexOf('if($entry.change){');
  const strictCheck = FALLBACK_SCRIPT.indexOf('AreAccessRulesProtected');
  equal((FALLBACK_SCRIPT.match(/AreAccessRulesProtected/g) ?? []).length, 1);
  equal(strictCheck > changeBranch, true);
  equal(FALLBACK_SCRIPT.indexOf('PRIVATE_DIRECTORY_REPARSE_OR_TYPE') < changeBranch, true);
  equal(FALLBACK_SCRIPT.indexOf('PRIVATE_DIRECTORY_FOREIGN_OWNER') < changeBranch, true);
});

void (async () => {
  try { process.exitCode = await h.finish(join(__dirname, 'private-directory-result.json'), 'private-directory'); }
  finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    equal(roots.every(root => !existsSync(root)), true); process.stdout.write('private-directory-fixture-cleanup: removed\n');
  }
})();
