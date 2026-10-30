import { open, rm, rename, mkdtemp, chmod } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { artifactPath } from './paths';
import { escapeAppleScript as esc, pretty, string, type MacOsExecution, type Row } from './types';

export const SYSTEM_EXECUTABLES = ['/usr/bin/osascript', '/usr/bin/open', '/usr/bin/pbpaste', '/usr/bin/pbcopy', '/usr/bin/mdfind', '/usr/sbin/screencapture'];
function numeric(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(name + ' must be a finite number'); return value;
}
async function capture(args: Row, execution: MacOsExecution, workdir: string | undefined, configRoot: string): Promise<string> {
  const requested = string(args.path, 'path', true);
  if (requested && !isAbsolute(requested)) throw new Error('The screenshot path must be absolute');
  const region = string(args.region, 'region', true);
  if (region) {
    const values = region.split(',').map(Number);
    if (values.length !== 4 || values.some(value => !Number.isFinite(value)) || values[2]! <= 0 || values[3]! <= 0) throw new Error('region must be x,y,width,height with positive dimensions');
  }
  if (args.silent !== undefined && typeof args.silent !== 'boolean') throw new Error('silent must be a boolean');
  const destination = requested || await artifactPath(configRoot, workdir, 'screenshots', 'klaus-capture', 'png');
  execution.assertCurrent();
  // Only the private sibling is written until a valid image and current owner are confirmed.
  const pendingDirectory = await mkdtemp(join(dirname(destination), '.klaus-capture-'));
  const pending = join(pendingDirectory, 'capture.png');
  try {
    const argv = args.silent !== false ? ['-x'] : [];
    if (region) argv.push('-R', region); argv.push(pending);
    await execution.run('/usr/sbin/screencapture', argv, { timeoutMs: 10_000 });
    const file = await open(pending, 'r');
    try {
      const info = await file.stat(), header = Buffer.alloc(24); await file.read(header, 0, header.length, 0);
      if (!info.isFile() || info.size < 24 || info.size > 100 * 1024 * 1024 || !header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        || header.readUInt32BE(16) < 1 || header.readUInt32BE(20) < 1) throw new Error('The screenshot command did not produce a valid bounded PNG');
    } finally { await file.close(); }
    await chmod(pending, 0o600); execution.assertCurrent(); await rename(pending, destination); execution.assertCurrent();
    return 'Saved screenshot to ' + destination;
  } finally { await rm(pendingDirectory, { recursive: true, force: true }); }
}
export async function system(name: string, args: Row, execution: MacOsExecution, workdir: string | undefined, configRoot: string): Promise<string> {
  if (name === 'read_clipboard') return execution.run('/usr/bin/pbpaste', []);
  if (name === 'write_clipboard') {
    const value = string(args.text, 'text'); await execution.run('/usr/bin/pbcopy', [], { stdin: value });
    return `Wrote ${value.length} char(s) to clipboard`;
  }
  if (name === 'spotlight_search') {
    const query = string(args.query, 'query'), onlyin = string(args.onlyin, 'onlyin', true);
    const limit = Math.trunc(Math.max(1, Math.min(500, numeric(args.limit, 'limit', 50))));
    if (onlyin && !isAbsolute(onlyin)) throw new Error('onlyin must be an absolute directory');
    const argv = onlyin ? ['-0', '-onlyin', onlyin, query] : ['-0', query];
    const out = await execution.run('/usr/bin/mdfind', argv, { timeoutMs: 20_000 });
    const paths = out.split('\0').filter(Boolean).slice(0, limit);
    return pretty({ query, count: paths.length, paths });
  }
  if (name === 'capture_screen') return capture(args, execution, workdir, configRoot);
  if (name === 'show_notification') {
    const title = string(args.title, 'title'), message = string(args.message, 'message'), subtitle = string(args.subtitle, 'subtitle', true);
    await execution.osa(`display notification "${esc(message)}" with title "${esc(title)}"${subtitle ? ' subtitle "' + esc(subtitle) + '"' : ''}`);
    return 'Notification requested: ' + title;
  }
  if (name === 'list_running_apps') {
    const raw = await execution.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
      JSON.stringify(Application('System Events').applicationProcesses.whose({backgroundOnly:false}).name());`]);
    const apps: unknown = JSON.parse(raw);
    if (!Array.isArray(apps) || apps.length > 2000 || apps.some(name => typeof name !== 'string')) throw new Error('System Events returned an invalid application list');
    return pretty({ count: apps.length, apps });
  }
  if (name === 'open_app') {
    const name = string(args.name, 'name'); if (!name.trim()) throw new Error('name must not be empty');
    await execution.osa(`tell application "${esc(name)}" to activate`); return 'Activation requested: ' + name;
  }
  if (name === 'set_volume') {
    const level = Math.round(Math.max(0, Math.min(100, numeric(args.level, 'level'))));
    const actual = await execution.osa(`set volume output volume ${level}\nreturn output volume of (get volume settings)`);
    if (!/^\d{1,3}$/.test(actual) || Number(actual) !== level) throw new Error('The requested output volume was not confirmed'); return 'Volume set to ' + level;
  }
  if (name === 'show_dialog') {
    const message = string(args.message, 'message'), title = string(args.title, 'title', true), defaultButton = string(args.defaultButton, 'defaultButton', true);
    if (args.buttons !== undefined && (!Array.isArray(args.buttons) || args.buttons.length > 3)) throw new Error('buttons must contain at most three labels');
    const buttons = Array.isArray(args.buttons) && args.buttons.length ? args.buttons.map(value => string(value, 'button')) : ['OK'];
    if (defaultButton && !buttons.includes(defaultButton)) throw new Error('defaultButton must name an available button');
    const timeout = Math.ceil(Math.max(5, Math.min(600, numeric(args.timeoutSeconds, 'timeoutSeconds', 60))));
    const parts = [`display dialog "${esc(message)}"`, 'buttons {' + buttons.map(value => '"' + esc(value) + '"').join(', ') + '}'];
    if (title) parts.push('with title "' + esc(title) + '"'); if (defaultButton) parts.push('default button "' + esc(defaultButton) + '"');
    parts.push('giving up after ' + timeout);
    const raw = await execution.osa(`try
      set response to ${parts.join(' ')}
      if gave up of response then return "GAVE_UP"
      return "BUTTON:" & button returned of response
    on error errorMessage number errorNumber
      if errorNumber = -128 then return "CANCELED"
      error errorMessage
    end try`, (timeout + 5) * 1000);
    if (raw === 'CANCELED') throw new Error('User canceled the dialog');
    if (raw === 'GAVE_UP') throw new Error('Dialog timed out after ' + timeout + 's');
    const button = raw.startsWith('BUTTON:') ? raw.slice(7) : undefined;
    if (button === undefined || !buttons.includes(button)) throw new Error('The dialog did not return a configured button'); return pretty({ button });
  }
  if (name === 'lock_screen') {
    // Apple documents Control-Command-Q at https://support.apple.com/en-us/102650.
    // The shared interaction guard and this call's owner run before dispatch.
    await execution.osa('tell application "System Events" to keystroke "q" using {control down, command down}');
    return pretty({ requested: true, locked: null, message: 'Screen lock requested. The locked state has not been confirmed.' });
  }
  throw new Error('Unknown macOS System tool: ' + name);
}
