// CLI wrapper executed under ELECTRON_RUN_AS_NODE=1 via the runtime-bin
// `klaus-headless-browser` shim. Spawns an isolated hidden Electron instance,
// suppresses the unbridged inner DevTools stderr banner, and exposes either
// `--remote-debugging-port` (stderr WebSocket URL) or `--remote-debugging-pipe`
// (fd 3 / fd 4 NUL-framed CDP) to standard automation libraries.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { join } from 'node:path';
import WebSocket from 'ws';
import { appRoot } from '../paths';
import { HEADLESS_BROWSER_FLAG, HEADLESS_DEVTOOLS_PREFIX, normalizeHeadlessBrowserArgs } from './headless-browser-protocol';

function isPackagedRoot(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { klausDesktopLayoutVersion?: number };
    return pkg.klausDesktopLayoutVersion === 1;
  } catch {
    return false;
  }
}

function main(): void {
  const root = appRoot();
  const packaged = isPackagedRoot(root);
  const { pipeMode, electronArgs } = normalizeHeadlessBrowserArgs(process.argv.slice(2));
  const childArgs = packaged
    ? [HEADLESS_BROWSER_FLAG, ...electronArgs]
    : [root, HEADLESS_BROWSER_FLAG, ...electronArgs];

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  // Explicitly ignore fd 3 and fd 4 in the child so Playwright's debugging
  // pipes are never inherited by Electron or its Crashpad/GPU helpers.
  const child = spawn(process.execPath, childArgs, {
    env: childEnv,
    stdio: ['pipe', 'ignore', 'pipe', 'ignore', 'ignore'],
    windowsHide: true,
  });

  let bridged = false;
  let stderrRemainder = '';

  const bridgePipeTransport = (wsUrl: string): void => {
    const ws = new WebSocket(wsUrl);
    const pipeIn = new Socket({ fd: 3, readable: true, writable: false });
    const pipeOut = new Socket({ fd: 4, readable: false, writable: true });
    let pipeBuffer = '';
    const pendingFrames: string[] = [];
    let wsOpen = false;
    let closed = false;

    const shutdown = (code = 0): void => {
      if (closed) return;
      closed = true;
      pipeIn.destroy();
      pipeOut.destroy();
      try { ws.close(); } catch { /* Socket may already be closing. */ }
      child.kill('SIGKILL');
      process.exit(code);
    };

    ws.on('open', () => {
      wsOpen = true;
      for (const frame of pendingFrames.splice(0)) ws.send(frame);
    });
    ws.on('message', data => {
      if (!pipeOut.destroyed) pipeOut.write(data.toString('utf8') + '\0');
    });
    ws.on('close', () => shutdown(0));
    ws.on('error', () => shutdown(1));

    pipeIn.setEncoding('utf8');
    pipeIn.on('data', chunk => {
      pipeBuffer += chunk;
      let nulIndex = pipeBuffer.indexOf('\0');
      while (nulIndex >= 0) {
        const frame = pipeBuffer.slice(0, nulIndex);
        pipeBuffer = pipeBuffer.slice(nulIndex + 1);
        if (frame.length > 0) {
          if (wsOpen) ws.send(frame);
          else pendingFrames.push(frame);
        }
        nulIndex = pipeBuffer.indexOf('\0');
      }
    });
    pipeIn.on('end', () => shutdown(0));
    pipeIn.on('error', () => shutdown(0));
    pipeOut.on('error', () => shutdown(0));
  };

  const handleStderrLine = (line: string): void => {
    if (!line) return;
    if (line.startsWith(HEADLESS_DEVTOOLS_PREFIX)) {
      const devtoolsLine = line.slice(HEADLESS_DEVTOOLS_PREFIX.length);
      if (pipeMode && !bridged) {
        const match = devtoolsLine.match(/ws:\/\/[^\s]+/);
        if (match) {
          bridged = true;
          bridgePipeTransport(match[0]);
        }
      } else if (!pipeMode) {
        process.stderr.write(devtoolsLine + '\n');
      }
      return;
    }
    if (!line.includes('DevTools listening on ws://')) {
      process.stderr.write(line + '\n');
    }
  };

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrRemainder += chunk.toString('utf8');
    let newlineIndex = stderrRemainder.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stderrRemainder.slice(0, newlineIndex).replace(/\r$/, '');
      stderrRemainder = stderrRemainder.slice(newlineIndex + 1);
      handleStderrLine(line);
      newlineIndex = stderrRemainder.indexOf('\n');
    }
  });

  child.stderr?.on('end', () => {
    if (stderrRemainder.length > 0) {
      handleStderrLine(stderrRemainder.replace(/\r$/, ''));
      stderrRemainder = '';
    }
  });

  const forwardKill = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  process.on('SIGTERM', () => forwardKill('SIGTERM'));
  process.on('SIGINT', () => forwardKill('SIGINT'));
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => forwardKill('SIGHUP'));
  }

  child.on('error', error => {
    process.stderr.write(`headless browser launch error: ${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', code => {
    process.exit(code ?? 0);
  });
}

if (require.main === module) {
  main();
}
