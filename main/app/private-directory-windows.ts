import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// The command is constant. Paths cross stdin as JSON, never as PowerShell source.
// Handles deny delete sharing until validation, repair and verification finish.
// Enterprise policy can force PowerShell into Constrained Language Mode, which forbids
// Add-Type and every .NET type creation this script needs. The script then reports a
// marker and protectWindowsBackup retries with FALLBACK_SCRIPT, which stays inside
// cmdlets plus external executables (icacls/whoami) and re-verifies the same ACL shape.
const CONSTRAINED_MARKER = 'private-backup-acl: constrained-language';
const VERIFIED = 'private-backup-acl: verified';
const SCRIPT = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){
  Write-Error '${CONSTRAINED_MARKER}'
}
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public sealed class PrivateBackupHandle : IDisposable {
  [StructLayout(LayoutKind.Sequential, Pack=4)] struct FileInfo {
    public uint Attributes; public long Creation; public long Access; public long Write;
    public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links;
    public uint IndexHigh; public uint IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle handle, uint type, uint flags, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetKernelObjectSecurity(SafeFileHandle handle, uint flags, byte[] descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  readonly SafeFileHandle handle;
  readonly bool directory;
  public uint Volume { get; private set; }
  public PrivateBackupHandle(string path, bool isDirectory, bool change, string expectedIndex) {
    directory=isDirectory;
    handle=CreateFile(path, 0x20080U | (change ? 0xC0000U : 0U), 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if(handle.IsInvalid) { int code=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(code, "Cannot open private backup entry"); }
    try {
      FileInfo info;
      if(!GetFileInformationByHandle(handle,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if((info.Attributes & 0x400)!=0 || ((info.Attributes & 0x10)!=0)!=directory) throw new InvalidOperationException("PRIVATE_DIRECTORY_REPARSE_OR_TYPE");
      if(!directory && info.Links!=1) throw new InvalidOperationException("PRIVATE_DIRECTORY_HARDLINK");
      ulong index=((ulong)info.IndexHigh << 32) | info.IndexLow;
      if(index.ToString()!=expectedIndex) throw new InvalidOperationException("PRIVATE_DIRECTORY_CHANGED");
      Volume=info.Volume;
    } catch { handle.Dispose(); throw; }
  }
  RawSecurityDescriptor Read() {
    IntPtr owner,group,dacl,sacl,descriptor;
    uint error=GetSecurityInfo(handle,1,5,out owner,out group,out dacl,out sacl,out descriptor);
    if(error!=0) throw new Win32Exception((int)error);
    try { byte[] bytes=new byte[GetSecurityDescriptorLength(descriptor)]; Marshal.Copy(descriptor,bytes,0,bytes.Length); return new RawSecurityDescriptor(bytes,0); }
    finally { LocalFree(descriptor); }
  }
  public void ValidateOwner(string user, string tokenOwner) {
    string owner=Read().Owner.Value;
    if(owner!=user && owner!=tokenOwner) throw new InvalidOperationException("PRIVATE_DIRECTORY_FOREIGN_OWNER");
  }
  public void Protect(string user) {
    RawSecurityDescriptor descriptor=new RawSecurityDescriptor("O:"+user+"D:P(A;"+(directory ? "OICI" : "")+";FA;;;"+user+")");
    byte[] bytes=new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes,0);
    if(!SetKernelObjectSecurity(handle,0x80000005U,bytes)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot protect private backup entry");
    RawSecurityDescriptor actual=Read();
    if(actual.Owner.Value!=user || (actual.ControlFlags & ControlFlags.DiscretionaryAclProtected)==0 || actual.DiscretionaryAcl==null || actual.DiscretionaryAcl.Count!=1) throw new InvalidOperationException("PRIVATE_DIRECTORY_ACL_VERIFICATION");
    CommonAce ace=actual.DiscretionaryAcl[0] as CommonAce;
    AceFlags flags=directory ? AceFlags.ObjectInherit | AceFlags.ContainerInherit : AceFlags.None;
    if(ace==null || ace.SecurityIdentifier.Value!=user || ace.AceQualifier!=AceQualifier.AccessAllowed || ace.AccessMask!=0x1F01FF || ace.AceFlags!=flags) throw new InvalidOperationException("PRIVATE_DIRECTORY_ACL_VERIFICATION");
  }
  public void Dispose() { handle.Dispose(); }
}
'@
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$opened=[Collections.Generic.List[PrivateBackupHandle]]::new()
$changed=[Collections.Generic.List[PrivateBackupHandle]]::new()
try {
  $volume=$null
  foreach($entry in $request.entries) {
    $handle=[PrivateBackupHandle]::new([string]$entry.path,[bool]$entry.directory,[bool]$entry.change,[string]$entry.ino)
    $opened.Add($handle)
    $handle.ValidateOwner($identity.User.Value,$identity.Owner.Value)
    if($null -eq $volume){$volume=$handle.Volume} elseif($volume -ne $handle.Volume){throw 'PRIVATE_DIRECTORY_FOREIGN_VOLUME'}
    if($entry.change){$changed.Add($handle)}
  }
  foreach($handle in $changed){$handle.Protect($identity.User.Value)}
  [Console]::Out.Write('${VERIFIED}')
} finally {
  for($i=$opened.Count-1;$i -ge 0;$i--){$opened[$i].Dispose()}
  $identity.Dispose()
}
`;

// Constrained Language Mode forbids Add-Type, type creation and .NET static members, so
// this script uses only cmdlets, operators and external executables. icacls replaces the
// DACL piece by piece (disable inheritance, drop foreign explicit ACEs, grant one full
// control ACE, set the owner) and Get-Acl then proves every rewritten entry matches the
// strict shape: protected DACL, exactly one non-inherited Allow FullControl ACE for the
// current user. Entries the script does not rewrite keep their ordinary inherited ACLs
// and are only checked for owner, reparse points and type. Hardlink counts are checked
// by the caller before invoking this helper; constrained mode exposes no cmdlet that
// reports them, so the in-script recheck is intentionally absent.
export const FALLBACK_SCRIPT = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
if($ExecutionContext.SessionState.LanguageMode -ne 'ConstrainedLanguage'){exit 3}
$request=$env:KLAUS_PRIVATE_BACKUP_REQUEST | ConvertFrom-Json
$whoami=((whoami.exe /user /fo csv /nh | Select-Object -First 1) -split ',')
$user=$whoami[1].Trim('"'); $userName=$whoami[0].Trim('"')
foreach($entry in $request.entries){
  $path=[string]$entry.path
  $item=Get-Item -LiteralPath $path -Force
  if(($item.Attributes -band 1024) -ne 0){throw 'PRIVATE_DIRECTORY_REPARSE_OR_TYPE'}
  if($item.PSIsContainer -ne [bool]$entry.directory){throw 'PRIVATE_DIRECTORY_REPARSE_OR_TYPE'}
  $acl=Get-Acl -LiteralPath $path
  if($acl.Owner -ne $userName -and $acl.Owner -ne $user){throw 'PRIVATE_DIRECTORY_FOREIGN_OWNER'}
  if($entry.change){
    icacls.exe $path /inheritance:d | Out-Null
    if($LASTEXITCODE -ne 0){throw 'PRIVATE_DIRECTORY_ACL_VERIFICATION'}
    foreach($rule in @(Get-Acl -LiteralPath $path).Access){
      if(-not $rule.IsInherited){
        $sid="$($rule.IdentityReference.Value)"
        if($sid -ne $user){
          icacls.exe $path /remove:d "*$sid" | Out-Null
          if($LASTEXITCODE -ne 0){throw 'PRIVATE_DIRECTORY_ACL_VERIFICATION'}
        }
      }
    }
    $scope=''
    if($item.PSIsContainer){$scope='(OI)(CI)'}
    icacls.exe $path /grant:r ($user+':'+$scope+'F') | Out-Null
    if($LASTEXITCODE -ne 0){throw 'PRIVATE_DIRECTORY_ACL_VERIFICATION'}
    icacls.exe $path /setowner $userName | Out-Null
    if($LASTEXITCODE -ne 0){throw 'PRIVATE_DIRECTORY_ACL_VERIFICATION'}
    // Only entries this script just rewrote must end in the strict single-ACE shape.
    // Scope roots and intermediate directories keep their ordinary inherited ACLs,
    // exactly as the unrestricted repair path leaves them.
    $acl=Get-Acl -LiteralPath $path
    if(-not $acl.AreAccessRulesProtected){throw 'PRIVATE_DIRECTORY_ACL_VERIFICATION'}
    $rules=@($acl.Access | Where-Object { -not $_.IsInherited })
    if($rules.Count -ne 1){throw 'PRIVATE_DIRECTORY_ACL_VERIFICATION'}
    $rule=$rules[0]
    if("$($rule.IdentityReference.Value)" -ne $user){throw 'PRIVATE_DIRECTORY_ACL_VERIFICATION'}
    if("$($rule.AccessControlType)" -ne 'Allow'){throw 'PRIVATE_DIRECTORY_ACL_VERIFICATION'}
    if("$($rule.FileSystemRights)" -ne 'FullControl'){throw 'PRIVATE_DIRECTORY_ACL_VERIFICATION'}
    $expected=if($item.PSIsContainer){'ContainerInherit, ObjectInherit'}else{'None'}
    if("$($rule.InheritanceFlags)" -ne $expected){throw 'PRIVATE_DIRECTORY_ACL_VERIFICATION'}
    if($acl.Owner -ne $userName -and $acl.Owner -ne $user){throw 'PRIVATE_DIRECTORY_FOREIGN_OWNER'}
  }
}
'${VERIFIED}'
`;

export interface PrivateEntry { path: string; directory: boolean; change: boolean; ino: string }

interface RunOutcome { stdout: string; stderr: string }

/** PowerShell 5.1 writes redirected streams in the OEM code page (GBK on Chinese systems), so decode UTF-8 first and fall back to the local code page. */
function decodeStream(value: string | Buffer | undefined): string {
  if (value === undefined || value === null) return '';
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try { return new TextDecoder('gbk').decode(bytes); } catch { return utf8; }
}

function runScript(script: string, payload: string): RunOutcome {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  if (encoded.length > 28_000) throw new Error('The private backup command exceeded its size limit');
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const stdout = execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      input: `${payload}\n`, env: { ...process.env, KLAUS_PRIVATE_BACKUP_REQUEST: payload }, windowsHide: true, timeout: 30_000,
      maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: decodeStream(stdout), stderr: '' };
  } catch (error) {
    const failure = error as { stderr?: string | Buffer; stdout?: string | Buffer };
    return { stdout: decodeStream(failure.stdout), stderr: decodeStream(failure.stderr) };
  }
}

function failureMessage(stderr: string): string {
  return stderr.match(/PRIVATE_DIRECTORY_[A-Z_]+/)?.[0] ?? `Windows backup ACL failed: ${stderr.slice(-1500).trim() || 'helper did not complete'}`;
}

export function protectWindowsBackup(entries: PrivateEntry[]): void {
  const payload = JSON.stringify({ entries });
  const primary = runScript(SCRIPT, payload);
  const primaryText = `${primary.stdout}\n${primary.stderr}`;
  const constrained = primaryText.includes(CONSTRAINED_MARKER)
    || /CannotCreateTypeConstrainedLanguage|CannotInvokeMethodConstrainedLanguage|ConstrainedLanguage/.test(primary.stderr);
  if (!constrained) {
    if (primary.stderr || primary.stdout.trim() !== VERIFIED) throw new Error(failureMessage(primary.stderr));
    return;
  }
  // Enterprise policy locked PowerShell into Constrained Language Mode; repair the same
  // ACL shape through cmdlets and icacls instead of failing startup.
  console.warn('Windows backup ACL protection is using the constrained-language fallback because policy restricts PowerShell');
  const fallback = runScript(FALLBACK_SCRIPT, payload);
  if (fallback.stdout.trim() !== VERIFIED || fallback.stderr) throw new Error(failureMessage(fallback.stderr));
}
