import { app } from 'electron';
import { Console } from 'node:console';
import { constants, lstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Writable } from 'node:stream';

// LaunchServices supplies an application identity without a terminal cwd or
// inherited stdio. Restore only the explicit development launch configuration
// before loading modules that capture process.cwd() or console.
if (!app.isPackaged && process.env.KLAUS_DEV_WORKING_DIRECTORY) {
  const directory = process.env.KLAUS_DEV_WORKING_DIRECTORY;
  const logs = process.env.KLAUS_DEV_LOG_DIRECTORY;
  delete process.env.KLAUS_DEV_WORKING_DIRECTORY;
  delete process.env.KLAUS_DEV_LOG_DIRECTORY;
  if (!isAbsolute(directory) || realpathSync(directory) !== realpathSync(app.getAppPath())) {
    throw new Error('The development working directory must match the application project.');
  }
  process.chdir(directory);
  if (logs) {
    const info = lstatSync(logs);
    if (!isAbsolute(logs) || !info.isDirectory() || info.isSymbolicLink()
      || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
      throw new Error('The development log directory must be privately owned.');
    }
    const output = (name: string): { descriptor: number; stream: Writable } => {
      const descriptor = openSync(join(logs, name), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      return { descriptor, stream: new Writable({ write(chunk: Buffer, _encoding, callback) {
        try {
          let offset = 0;
          while (offset < chunk.length) offset += writeSync(descriptor, chunk, offset, chunk.length - offset);
          callback();
        } catch (error) { callback(error as Error); }
      } }) };
    };
    const stdout = output('stdout.log'), stderr = output('stderr.log');
    global.console = new Console({ stdout: stdout.stream, stderr: stderr.stream, colorMode: false });
    process.on('uncaughtExceptionMonitor', error => {
      try { writeSync(stderr.descriptor, String(error.stack ?? error) + '\n'); } catch { /* Preserve the original fatal exception. */ }
    });
  }
}
