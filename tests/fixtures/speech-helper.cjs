// A test-only subprocess. Production SpeechHelper cannot select it through IPC.
const crypto = require('node:crypto');
const fs = require('node:fs');
const mode = process.env.SPEECH_FIXTURE_MODE || 'normal';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (process.env.SPEECH_FIXTURE_PID) fs.writeFileSync(process.env.SPEECH_FIXTURE_PID, String(process.pid));
if (mode === 'early-exit') process.exit(3);
if (mode === 'ready-hang') { setInterval(() => {}, 1000); return; }
if (mode === 'protocol-error') { process.stdout.write('{bad-json}\n'); setInterval(() => {}, 1000); return; }
if (mode === 'stubborn') process.on('SIGTERM', () => {});
emit({ type: 'ready' });
process.stderr.write(Buffer.alloc(256 * 1024, 120));
if (mode === 'no-read' || mode === 'stubborn') { setInterval(() => {}, 1000); return; }
let size = 0, partial = false;
const hash = crypto.createHash('sha256');
process.stdin.on('data', data => {
  size += data.length; hash.update(data);
  if (!partial) { partial = true; emit({ type: 'partial', text: 'fixture partial' }); }
});
process.stdin.on('end', () => {
  const text = `pcm:${size}:${hash.digest('hex')}`;
  if (mode === 'final-hang') return;
  setTimeout(() => { emit({ type: 'final', text }); }, 20);
});
