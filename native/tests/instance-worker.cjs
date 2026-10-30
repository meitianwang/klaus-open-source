const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { DesktopInstanceGuard } = require('../../dist/main/native/instance-guard.js');
const identity = process.env.KLAUS_INSTANCE_FIXTURE_ID;
const profile = process.env.KLAUS_INSTANCE_FIXTURE_PROFILE;
if (!/^ai\.klaus\.instance-fixture\.[a-zA-Z0-9.-]+$/.test(identity || '') || !profile || !path.isAbsolute(profile)) throw new Error('An isolated fixture identity/profile is required');
app.setPath('userData', profile);
if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
const emit = event => process.stdout.write(`INSTANCE ${JSON.stringify(event)}\n`);
let yielded = false;
queueMicrotask(() => { yielded = true; });
let guard;
try {
  const result = DesktopInstanceGuard.acquireSync({ identity, argv: ['Klaus', process.env.KLAUS_INSTANCE_FIXTURE_LINK || 'klaus://settings'], addon: process.env.KLAUS_INSTANCE_FIXTURE_ADDON, timeoutMs: 1500 });
  emit({ type: 'acquired', acquired: result.acquired, forwarded: result.forwarded, acknowledged: result.acknowledged, synchronous: !yielded && !app.isReady(), pid: process.pid, arch: process.arch });
  if (!result.acquired) app.exit(0);
  else {
    guard = result.guard;
    guard.listen({ onActivation: event => emit({ type: 'activation', ...event }), onLost: error => emit({ type: 'lost', code: error.message }) });
    app.whenReady().then(() => { app.dock?.hide(); emit({ type: 'ready' }); });
    // A Windows GUI executable may receive immediate EOF on stdin even when its
    // parent requested a pipe. Keep fixture control outside the protocol under test.
    const control = path.join(profile, 'control.txt');
    let consumed = 0;
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      clearInterval(poll);
      try { emit({ type: 'closed', ...(await guard.close()) }); app.exit(0); }
      catch (error) { emit({ type: 'error', code: error.message }); app.exit(1); }
    };
    const poll = setInterval(() => {
      const raw = fs.readFileSync(control, 'utf8');
      if (raw.length > 16384) throw new Error('Fixture command bound exceeded');
      const lines = raw.split('\n'); lines.pop();
      for (const line of lines.slice(consumed)) {
        if (line === 'close') void close();
        if (line === 'assert') {
          try { guard.assertHeld(); emit({ type: 'held', held: true }); }
          catch (error) { emit({ type: 'held', held: false, code: error.message }); }
        }
      }
      consumed = lines.length;
    }, 20);
    setTimeout(() => { void close(); }, 20000).unref();
  }
} catch (error) {
  guard?.closeSync();
  emit({ type: 'error', code: error.message, synchronous: !yielded && !app.isReady() });
  app.exit(2);
}
