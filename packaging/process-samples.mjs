import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function cpuTimeSeconds(value) {
  const parts = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  return parts ? Number(parts[1] ?? 0) * 86400 + Number(parts[2] ?? 0) * 3600 + Number(parts[3]) * 60 + Number(parts[4]) : null;
}
export function unixProcessRows(raw) {
  return raw.split('\n').flatMap(line => {
    const parts = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.\-]+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    return parts ? [{ pid: Number(parts[1]), parentPid: Number(parts[2]), rssKiB: Number(parts[3]), cpuSeconds: cpuTimeSeconds(parts[4]),
      startedAt: parts[5], executable: parts[6] }] : [];
  });
}
export function windowsProcessRows(raw) {
  const value = JSON.parse(raw);
  return (Array.isArray(value) ? value : value ? [value] : []).map(row => ({ pid: Number(row.ProcessId), parentPid: Number(row.ParentProcessId),
    rssKiB: Math.round(Number(row.WorkingSetSize) / 1024),
    cpuSeconds: row.KernelModeTime == null || row.UserModeTime == null ? null : (Number(row.KernelModeTime) + Number(row.UserModeTime)) / 10_000_000,
    startedAt: row.StartedAt ?? null, executable: row.ExecutablePath ?? '' }));
}
export function processTable() {
  if (process.platform === 'win32') {
    // No output-encoding statement: creating an encoding object is forbidden when policy
    // locks PowerShell into Constrained Language Mode, and every emitted field is ASCII.
    const command = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,ExecutablePath,KernelModeTime,UserModeTime,@{Name='StartedAt';Expression={if($null -ne $_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null}}} | ConvertTo-Json -Compress";
    return windowsProcessRows(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
  }
  return unixProcessRows(execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,lstart=,comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 10000 }));
}
export function processIdentity(row) { return `${row.pid}:${row.startedAt ?? ''}:${row.executable}`; }
export function descendantRows(rows, pid) {
  const pids = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (pids.has(row.parentPid) && !pids.has(row.pid)) { pids.add(row.pid); changed = true; }
  }
  return rows.filter(row => pids.has(row.pid));
}
export function remainingOwned(observed, current) {
  const identities = new Set(observed.map(processIdentity));
  return current.filter(row => identities.has(processIdentity(row)));
}

/** Failure cleanup only: recheck each observed identity before signalling it, including reparented children. */
export async function terminateObserved(observed) {
  const errors = [];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const row of remainingOwned(observed, processTable()).reverse()) {
      if (row.pid === process.pid || !row.startedAt || !row.executable) { errors.push(`Refused unidentifiable PID ${row.pid}`); continue; }
      if (!remainingOwned([row], processTable()).length) continue;
      try { process.kill(row.pid, signal); } catch (error) { if (error.code !== 'ESRCH') errors.push(`PID ${row.pid}: ${String(error)}`); }
    }
    const end = Date.now() + 1500;
    while (Date.now() < end && remainingOwned(observed, processTable()).length) await delay(50);
    if (!remainingOwned(observed, processTable()).length) break;
  }
  return { remainingProcesses: remainingOwned(observed, processTable()), errors };
}
