// A process/pipe fixture. Native capture is covered separately by the macOS probe.
const readline = require('node:readline');
const fs = require('node:fs');
const mode = process.env.KLAUS_RECORDING_FIXTURE_MODE || 'normal';
if (process.argv.includes('--capabilities')) {
  console.log(JSON.stringify({ version: 1, supported: true, permissions: { accessibility: mode !== 'permission-denied', inputMonitoring: true } }));
  process.exit(0);
}
let identity, sequence = 0, inFlight, ending = false;
const queue = [];
function send(value) { queue.push(value); next(); }
function next() {
  if (inFlight || !queue.length) return;
  inFlight = { ...queue.shift(), ...identity, seq: ++sequence };
  if (mode === 'bad-sequence' && sequence === 2) inFlight.seq++;
  process.stdout.write(JSON.stringify(inFlight) + '\n');
}
function end(value = 'stop') {
  if (ending) return; ending = true;
  send({ type: 'event', event: { type: 'session.ended', ts: 2, discarded: value === 'discard' } });
  send({ type: 'ended', mode: value, reason: 'fixture-stop', suppressedEventCount: 0 });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  if (process.env.KLAUS_RECORDING_FIXTURE_TRACE) fs.appendFileSync(process.env.KLAUS_RECORDING_FIXTURE_TRACE, JSON.stringify(command) + '\n');
  if (command.type === 'start') {
    identity = { recordingId: command.recordingId, generation: command.generation };
    if (mode === 'native-denied') { send({ type: 'ended', mode: 'error', reason: 'macos-event-tap-refused', suppressedEventCount: 0 }); return; }
    if (mode === 'early-exit') { process.stderr.write('fixture-early-exit'); process.exit(2); }
    if (mode === 'stderr') process.stderr.write('x'.repeat(512 * 1024));
    send({ type: 'ready' });
  } else if (command.type === 'ack') {
    if (command.seq !== inFlight?.seq) process.exit(3);
    const previous = inFlight; inFlight = undefined;
    if (previous.type === 'ended') {
      if (mode === 'hang-exit') return;
      process.exit(mode === 'bad-exit' ? 2 : 0);
    }
    if (previous.type === 'ready') {
      send({ type: 'event', event: { type: 'session.started', ts: 0 } });
      send({ type: 'event', event: { type: 'keyboard.text_input', ts: 1, text: 'fixture demonstration' } });
      if (mode === 'auto-stop') end();
    }
    next();
  } else if (command.type === 'stop') end(command.mode);
  else if (command.type === 'policy') send({ type: 'policy', operationId: command.operationId });
}).on('close', () => process.exit(2));
