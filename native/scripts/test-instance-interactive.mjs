#!/usr/bin/env node
// Run isolated native instance fixtures in the signed-in Windows desktop session.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, electron: { type: 'string' }, addon: { type: 'string' } } });
if (process.platform !== 'win32' || positionals.length) throw new Error('Run on Windows: node native/scripts/test-instance-interactive.mjs [--electron executable] [--addon artifact.node] [--output report.json]');
const desktop = fileURLToPath(new URL('../..', import.meta.url));
const output = resolve(values.output ?? join(desktop, 'native/artifacts/instance-interactive-report.json'));
const electron = resolve(values.electron ?? join(desktop, 'node_modules/electron/dist/electron.exe'));
const addon = resolve(values.addon ?? join(desktop, 'native/artifacts/klaus-native-win32-x64.node'));
mkdirSync(dirname(output), { recursive: true });
const state = mkdtempSync(join(dirname(output), '.interactive-'));
const taskName = `Klaus-Instance-Fixture-${randomUUID()}`;
const launcher = join(state, 'run.cjs'), exitFile = join(state, 'exit.txt'), sessionFile = join(state, 'session.txt'), childFile = join(state, 'child.txt');
const log = `${output}.runner.log`, fixture = fileURLToPath(new URL('./test-instance.mjs', import.meta.url));
const fixtureArgs = [fixture];
writeFileSync(launcher, `const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const log = fs.openSync(${JSON.stringify(log)}, 'w');
const session = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id $PID).SessionId'], { encoding: 'utf8', timeout: 10000 });
fs.writeFileSync(${JSON.stringify(sessionFile)}, session.stdout || 'unknown');
if (!/^\\d+$/.test(session.stdout.trim()) || Number(session.stdout.trim()) === 0) throw new Error('The instance fixture requires an interactive Windows session');
const child = spawn(process.execPath, ${JSON.stringify(fixtureArgs)}, { env: { ...process.env, KLAUS_TEST_ELECTRON: ${JSON.stringify(electron)}, KLAUS_TEST_NATIVE_ADDON: ${JSON.stringify(addon)} }, stdio: ['ignore', log, log] });
if (child.pid) fs.writeFileSync(${JSON.stringify(childFile)}, String(child.pid));
const timer = setTimeout(() => { if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: ['ignore', log, log] }); }, 170000);
child.once('error', error => fs.writeSync(log, String(error)));
child.once('close', code => { clearTimeout(timer); fs.closeSync(log); fs.writeFileSync(${JSON.stringify(exitFile)}, String(code ?? 1)); process.exitCode = code ?? 1; });
`);
const ps = value => `'${value.replaceAll("'", "''")}'`;
const source = `& {
if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){
  Write-Output 'interactive_skip=constrained-language'
  exit 0
}
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$scheduler=New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $folder=$scheduler.GetFolder('\\')
$name=${ps(taskName)}; $launcher=${ps(launcher)}; $created=$false; $failed=$false
if (@($folder.GetTasks(0) | Where-Object { $_.Name -eq $name }).Count -ne 0) { throw 'The unique instance fixture task already exists' }
try {
  $definition=$scheduler.NewTask(0)
  $definition.RegistrationInfo.Description='Temporary Klaus instance fixture in the existing interactive user session'
  $definition.Principal.UserId=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $definition.Principal.LogonType=3; $definition.Principal.RunLevel=0
  $definition.Settings.Enabled=$true; $definition.Settings.AllowDemandStart=$true
  $definition.Settings.DisallowStartIfOnBatteries=$false; $definition.Settings.StopIfGoingOnBatteries=$false
  $definition.Settings.ExecutionTimeLimit='PT3M'
  $action=$definition.Actions.Create(0); $action.Path=${ps(process.execPath)}; $action.Arguments='"'+$launcher+'"'; $action.WorkingDirectory=${ps(state)}
  $task=$folder.RegisterTaskDefinition($name,$definition,2,$definition.Principal.UserId,$null,3); $created=$true
  Write-Output ('interactive_task='+$name+';logon=InteractiveToken;runLevel=LeastPrivilege;triggers='+$definition.Triggers.Count)
  $instance=$task.Run($null); $end=[DateTime]::UtcNow.AddSeconds(175)
  while (-not (Test-Path -LiteralPath ${ps(exitFile)})) { if ([DateTime]::UtcNow -ge $end) { throw 'Interactive instance fixture deadline exceeded' }; Start-Sleep -Milliseconds 500 }
  Write-Output ('interactiveSessionId='+(Get-Content -LiteralPath ${ps(sessionFile)} -Raw).Trim())
  Get-Content -LiteralPath ${ps(log)} -Encoding UTF8
  $code=(Get-Content -LiteralPath ${ps(exitFile)} -Raw).Trim(); Write-Output ('interactive_exit_code='+$code); $failed=$code -ne '0'
} finally {
  if ($created) {
    if (Test-Path -LiteralPath ${ps(childFile)}) {
      $childId=[int](Get-Content -LiteralPath ${ps(childFile)} -Raw); $child=Get-CimInstance Win32_Process -Filter ('ProcessId='+$childId)
      if ($child -and $child.CommandLine.Contains(${ps(fixture)})) { taskkill.exe /PID $childId /T /F | Out-Null }
    }
    try { $task.Stop(0) } catch {}
    $folder.DeleteTask($name,0)
    if (@($folder.GetTasks(0) | Where-Object { $_.Name -eq $name }).Count -ne 0) { throw 'Instance task cleanup failed' }
    Write-Output 'interactive_task_cleanup=removed'
  }
  Remove-Item -LiteralPath $launcher -Force
  Write-Output 'interactive_launcher_cleanup=removed'
}
if ($failed) { throw 'Interactive instance fixture failed' }
}

`;
let cleanupConfirmed = false;
try {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 195000, maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  cleanupConfirmed = result.stdout?.includes('interactive_task_cleanup=removed') && result.stdout?.includes('interactive_launcher_cleanup=removed');
  const skipped = result.stdout?.includes('interactive_skip=constrained-language') ?? false;
  if (skipped) cleanupConfirmed = true;
  if (result.error) throw result.error;
  if (!skipped && result.status !== 0) throw new Error(`Interactive Windows instance fixture failed (${result.status}); see ${log}`);
  const sessionId = skipped ? null : Number(readFileSync(sessionFile, 'utf8').trim());
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, sessionId, electron, addon, passed: !skipped, skipped: skipped ? 'constrained-language' : undefined, log }, null, 2) + '\n');
  if (skipped) console.warn('Skipped: policy locks PowerShell into Constrained Language Mode, and this fixture needs the Task Scheduler COM interface that mode forbids');
  else console.log(`Session report: ${sessionId}`);
} finally {
  if (!cleanupConfirmed) {
    // A terminated controller still needs an independent, narrowly owned cleanup.
    const cleanup = `$ErrorActionPreference='Stop'; $scheduler=New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $folder=$scheduler.GetFolder('\\'); $name=${ps(taskName)};
      if (Test-Path -LiteralPath ${ps(childFile)}) { $id=[int](Get-Content -LiteralPath ${ps(childFile)} -Raw); $child=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id); if ($child -and $child.CommandLine.Contains(${ps(fixture)})) { taskkill.exe /PID $id /T /F | Out-Null } }
      foreach ($task in @($folder.GetTasks(0) | Where-Object { $_.Name -eq $name })) { try { $task.Stop(0) } catch {}; $folder.DeleteTask($name,0) }
      if (@($folder.GetTasks(0) | Where-Object { $_.Name -eq $name }).Count -ne 0) { throw 'Instance task cleanup failed' }; Write-Output 'interactive_final_cleanup=complete'`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cleanup, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    if (result.error || result.status !== 0) throw new Error(`Interactive cleanup needs attention; preserve ${state}`, { cause: result.error });
  }
  rmSync(state, { recursive: true, force: true });
}
