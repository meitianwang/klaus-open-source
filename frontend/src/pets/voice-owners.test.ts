import { expect, test } from 'bun:test';
import { PetVoiceOwners } from '../../../main/pets/voice-owners';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
test('hidden capability refresh does not cache an attachment that blocks the next show', async () => {
  let visible = false, attached = 0;
  const owners = new PetVoiceOwners({ visible: () => visible, attach: async () => { attached++; }, detach: async () => ({ complete: true }), stop: async () => {} });
  await owners.attach(7); expect(attached).toBe(0);
  visible = true; await owners.attach(7); expect(attached).toBe(1); await owners.release(7);
});
test('hide show hide invalidates attachment waiting behind an earlier release', async () => {
  const stop = deferred(); let visible = true, attaches = 0;
  const owners = new PetVoiceOwners({ visible: () => visible, attach: async () => { attaches++; }, detach: async () => ({ complete: true }), stop: () => stop.promise });
  await owners.attach(7); visible = false; const releasing = owners.release(7);
  visible = true; const pending = owners.attach(7);
  visible = false; const again = owners.release(7);
  stop.resolve(); await Promise.all([releasing, pending, again]);
  expect(attaches).toBe(1); expect(owners.releases.size).toBe(0);
  visible = true; await owners.attach(7); expect(attaches).toBe(2); await owners.release(7);
});
test('hiding during asynchronous attachment revokes the late audio owner', async () => {
  const gate = deferred(); let visible = true, attached = false;
  const owners = new PetVoiceOwners({ visible: () => visible, attach: async () => { await gate.promise; attached = true; }, detach: async () => { attached = false; return { complete: true }; }, stop: async () => {} });
  const pending = owners.attach(7); await Promise.resolve();
  visible = false; const release = owners.release(7); gate.resolve(); await Promise.all([pending, release]);
  expect(attached).toBe(false);
});
