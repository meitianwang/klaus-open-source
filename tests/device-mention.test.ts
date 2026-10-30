import assert from 'node:assert/strict';
import { join } from 'node:path';
import { deviceAddressesIn, deviceContextBlock } from '../main/services/device-mention';
import { Harness } from './harness';

const h = new Harness();
const deadline = setTimeout(() => { process.stderr.write('device-mention deadline exceeded\n'); process.exit(1); }, 10_000);

void (async () => {
  await h.test('device addresses are extracted once each, in first-seen order', () => {
    assert.deepEqual(deviceAddressesIn('ping @device-mac then @device-win and again @device-mac'), ['mac', 'win']);
    assert.deepEqual(deviceAddressesIn('no devices here'), []);
    // A bare "@device-" with no id is prose, not an address.
    assert.deepEqual(deviceAddressesIn('@device-'), []);
    // The id grammar matches the account device id grammar, nothing longer.
    assert.deepEqual(deviceAddressesIn('@device-' + 'a'.repeat(129)), []);
    assert.deepEqual(deviceAddressesIn('@device-' + 'a'.repeat(128)), ['a'.repeat(128)]);
  });

  await h.test('the context block names each reachable device with its host id and drops unknown ones', () => {
    const discovered = {
      localHostId: 'this-mac',
      hosts: [
        { id: 'studio-mac', name: 'Studio Mac', status: 'online', platform: 'darwin' },
        { id: 'win-desk', name: 'Windows Desk', status: 'offline', platform: 'win32' },
      ],
    };
    const block = deviceContextBlock(['studio-mac', 'win-desk', 'this-mac', 'gone-mac'], discovered);
    assert.match(block, /Target devices named in this message:/);
    assert.match(block, /@device-studio-mac: "Studio Mac" \(darwin platform, currently online\)\. Pass hostId "studio-mac" to send_message_to_thread/);
    assert.match(block, /@device-win-desk: "Windows Desk" \(win32 platform, currently offline\)\. This computer is not reachable right now/);
    assert.match(block, /@device-this-mac: this computer/);
    assert(!block.includes('gone-mac'), 'a device that left the account is dropped, not named');
    assert.equal(deviceContextBlock(['gone-mac'], discovered), '', 'only unknown ids produce no block at all');
  });

})().then(
  () => h.finish(join(__dirname, 'device-mention-result.json'), 'device-mention'),
).then(code => { clearTimeout(deadline); process.exitCode = code; }, error => {
  clearTimeout(deadline);
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
