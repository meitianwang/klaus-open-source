import assert from 'node:assert/strict';
import { join } from 'node:path';
import { conversationContextBlock, conversationReferencesIn } from '../main/services/conversation-mention';
import { Harness } from './harness';

const h = new Harness();
const deadline = setTimeout(() => { process.stderr.write('conversation-mention deadline exceeded\n'); process.exit(1); }, 10_000);

void (async () => {
  await h.test('conversation links are extracted once each, in first-seen order', () => {
    const text = 'see [Alpha](klaus:conversation/sess-a) and [Beta](klaus:conversation/sess-b), again [Alpha](klaus:conversation/sess-a)';
    assert.deepEqual(conversationReferencesIn(text), [
      { title: 'Alpha', id: 'sess-a' },
      { title: 'Beta', id: 'sess-b' },
    ]);
    assert.deepEqual(conversationReferencesIn('no links here'), []);
    // A link without the klaus:conversation scheme is ordinary prose.
    assert.deepEqual(conversationReferencesIn('[Alpha](https://example.com/sess-a)'), []);
    // An over-long id-shaped run is not a conversation id.
    assert.deepEqual(conversationReferencesIn('[x](klaus:conversation/' + 'a'.repeat(129) + ')'), []);
  });

  await h.test('the context block names each conversation and marks the current one', () => {
    const block = conversationContextBlock([
      { title: 'Alpha', id: 'sess-a' },
      { title: 'This one', id: 'sess-current' },
    ], 'sess-current');
    assert.match(block, /Conversations named in this message:/);
    assert.match(block, /"Alpha" \(klaus:conversation\/sess-a\): another conversation on this computer\. Use read_thread with threadId "sess-a"/);
    assert.match(block, /"This one" \(klaus:conversation\/sess-current\): this conversation\./);
    assert.equal(conversationContextBlock([], 'sess-current'), '');
  });

})().then(
  () => h.finish(join(__dirname, 'conversation-mention-result.json'), 'conversation-mention'),
).then(code => { clearTimeout(deadline); process.exitCode = code; }, error => {
  clearTimeout(deadline);
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
