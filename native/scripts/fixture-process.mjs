export async function withDeadline(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Keep the original close promise: attaching a new close listener during cleanup
// can miss a child that already exited. Only this retained ChildProcess is killed.
export function observeFixtureProcess(child, { exitTimeoutMs = 10_000, cleanupTimeoutMs = 5_000 } = {}) {
  let exited = false, ended = false, spawnError, cleanupError;
  child.once('error', error => { spawnError = error; });
  child.once('exit', () => { exited = true; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    ended = true;
    resolve({ code, signal });
  }));
  const label = () => `fixture PID ${child.pid ?? 'not started'}`;

  async function stop() {
    if (!exited && child.pid !== undefined) child.kill('SIGKILL');
    try {
      return await withDeadline(closed, cleanupTimeoutMs, `Unconfirmed cleanup of ${label()}`);
    } catch (error) {
      cleanupError = error;
      // A descendant may have retained a stdio pipe after the direct child exited.
      // Release our pipe handles, but keep cleanup failed and preserve its files.
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      child.unref();
      throw error;
    }
  }

  return {
    child,
    get ended() { return ended; },
    get error() { return spawnError; },
    get cleanupError() { return cleanupError; },
    stop,
    async wait() {
      let status;
      try {
        status = await withDeadline(closed, exitTimeoutMs, `Timed out waiting for ${label()} to exit`);
      } catch (error) {
        try { await stop(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], `Exit and cleanup failed for ${label()}`); }
        throw error;
      }
      if (spawnError) throw spawnError;
      return status;
    },
  };
}
