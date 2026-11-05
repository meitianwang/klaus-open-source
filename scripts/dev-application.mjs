import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readSync, statSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnElectronGui } from './electron-test-preflight.cjs';
import { createDevelopmentControlServer } from './dev-control-server.mjs';
import { launchMacDevelopmentApp } from './dev-macos-launcher.mjs';

/** Keep dev lifecycle control while macOS owns the application's launch identity. */
export async function launchDevelopmentApplication({ executable, appDirectory, env, stdio = ['ignore', 'pipe', 'pipe', 'ipc'], platform = process.platform }) {
  if (platform !== 'darwin') return spawnElectronGui(executable, [appDirectory], { cwd: appDirectory, env, stdio });
  const logsRoot = join(appDirectory, 'dist', 'dev-launch-logs');
  mkdirSync(logsRoot, { recursive: true });
  const logDirectory = mkdtempSync(join(logsRoot, 'run-')); chmodSync(logDirectory, 0o700);
  for (const name of ['stdout.log', 'stderr.log']) writeFileSync(join(logDirectory, name), '', { mode: 0o600 });
  const control = await createDevelopmentControlServer();
  const application = new EventEmitter();
  application.stdout = new PassThrough(); application.stderr = new PassThrough();
  application.logDirectory = logDirectory;
  application.send = (message, callback = () => {}) => {
    if (control.connected) return control.send(message, callback);
    if (finishing || queue.length >= 8) { callback(Error('The development app is unavailable.')); return false; }
    queue.push({ message, callback }); return true;
  };
  application.disconnect = () => { requestedDisconnect = true; control.disconnect(); };
  application.kill = (signal = 'SIGTERM') => {
    if (!application.pid || terminating) return false;
    try { process.kill(application.pid, signal); return true; } catch { return false; }
  };
  Object.defineProperty(application, 'connected', { get: () => control.connected });
  let closed = false, ready = false, connected = false, channelEnded = false;
  let terminating = false, finishing = false, requestedDisconnect = false, receiptExitCode = 0;
  let helperExit, helperTerminated = false, failure;
  const queue = [], files = [];
  for (const name of ['stdout', 'stderr']) {
    const descriptor = openSync(join(logDirectory, name + '.log'), 'r');
    const entry = { name, descriptor, offset: 0 };
    entry.flush = () => {
      if (finishing) return;
      const size = statSync(join(logDirectory, name + '.log')).size;
      const amount = Math.min(size - entry.offset, 64 * 1024);
      if (amount <= 0) return;
      const bytes = Buffer.allocUnsafe(amount);
      const read = readSync(descriptor, bytes, 0, amount, entry.offset);
      entry.offset += read;
      if (!application[name].write(bytes.subarray(0, read))) application[name].once('drain', entry.flush);
      else if (entry.offset < size) setImmediate(entry.flush);
    };
    files.push(entry);
  }
  const observer = watch(logDirectory, (_event, filename) => {
    for (const entry of files) if (String(filename) === entry.name + '.log') entry.flush();
  });
  const finalize = async () => {
    if (finishing || helperExit === undefined || (connected && !channelEnded)) return;
    for (const entry of files) entry.flush();
    finishing = true; clearTimeout(authenticationDeadline); observer.close();
    await control.dispose();
    for (const entry of files) closeSync(entry.descriptor);
    for (const entry of queue.splice(0)) entry.callback(Error('The development app exited before connecting.'));
    application.stdout.end(); application.stderr.end();
    const code = failure || helperExit.code !== 0 || !helperTerminated || receiptExitCode !== 0
      || (ready && !closed && !requestedDisconnect) ? 1 : 0;
    application.emit('exit', code, helperExit.signal);
  };
  control.events.on('connected', pid => {
    connected = true; application.pid = pid; clearTimeout(authenticationDeadline);
    for (const entry of queue.splice(0)) control.send(entry.message, entry.callback);
  });
  control.events.on('message', message => {
    if (message.type === 'klaus:dev:ready') ready = true;
    if (message.type === 'klaus:dev:closed') {
      closed = true;
      receiptExitCode = message.exitCode === 0 ? 0 : 1;
    }
    application.emit('message', message);
  });
  control.events.on('disconnect', () => { channelEnded = true; void finalize(); });
  const authenticationDeadline = setTimeout(() => {
    failure = Error('The development application did not connect to its launcher.');
    application.stderr.write(failure.message + '\n');
    application.kill('SIGTERM');
  }, 30_000);
  let helper;
  try {
    helper = await launchMacDevelopmentApp({ executable, appDirectory, logDirectory,
      env: { ...env, ...control.environment, KLAUS_DEV_WORKING_DIRECTORY: appDirectory, KLAUS_DEV_LOG_DIRECTORY: logDirectory } });
  } catch (error) {
    clearTimeout(authenticationDeadline); observer.close();
    for (const entry of files) closeSync(entry.descriptor);
    await control.dispose(); throw error;
  }
  let buffer = '';
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 32 * 1024) { failure = Error('The macOS launcher returned an oversized event.'); control.disconnect(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const frame = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const event = JSON.parse(frame);
        if (event.type === 'launched') { control.expectPid(event.pid); application.pid = event.pid; }
        else if (event.type === 'terminated' && event.pid === application.pid) { helperTerminated = true; terminating = true; }
        else if (event.type === 'error') { failure = Error(String(event.message)); application.stderr.write(failure.message + '\n'); }
        else throw Error('Unknown macOS launcher event.');
      } catch (error) { failure = error; control.disconnect(); }
    }
  });
  helper.stderr.on('data', chunk => application.stderr.write(chunk));
  helper.once('error', error => {
    failure = error; helperExit = { code: 1, signal: null }; control.disconnect(); void finalize();
  });
  helper.once('close', (code, signal) => {
    helperExit = { code, signal };
    if (!helperTerminated) { failure ??= Error('The macOS launcher exited unexpectedly.'); control.disconnect(); }
    void finalize();
  });
  return application;
}
