// The always-visible target line of an approval card.
//
// `primaryToolTarget` decides what a user can read WITHOUT expanding the collapsed
// JSON. For a cross-conversation write that line is the whole approval decision: the
// delegation rate ledger is gone, so this card is the only gate between one
// conversation and another. A card that shows just "Allow send_message_to_thread?"
// makes the approval a reflex rather than a choice — the user cannot see who is
// about to be messaged, or what they are about to be told.
import { describe, expect, test } from 'bun:test'

;(globalThis as any).window = { addEventListener: () => {}, currentLang: 'en', klaus: { media: { url: (p: string) => p } } }

const { primaryToolTarget, toolValueText } = await import('./factories')

describe('the approval target of a cross-conversation write', () => {
  test('names the destination and the opening of the message', () => {
    const target = primaryToolTarget('send_message_to_thread', {
      threadId: 'thread-b', prompt: 'Stop and report what you found.', hostId: 'local',
    })
    expect(target).toContain('thread-b')
    expect(target).toContain('Stop and report what you found.')
    // `local` is the caller's own computer, so naming it adds nothing but noise.
    expect(target).not.toContain('local')
  })

  test('names a remote computer, because there the id is the only clue', () => {
    const target = primaryToolTarget('send_message_to_thread', {
      threadId: 'thread-b', prompt: 'Continue.', hostId: 'device-42',
    })
    expect(target).toContain('device-42')
    expect(target).toContain('thread-b')
    expect(target).toContain('Continue.')
  })

  test('truncates a long message instead of pushing the decision off the card', () => {
    const target = primaryToolTarget('send_message_to_thread', { threadId: 'thread-b', prompt: 'x'.repeat(4000) })
    expect(target.length).toBeLessThan(200)
    expect(target).toContain('…')
    expect(target.startsWith('thread-b')).toBe(true)
  })

  test('a message with no usable text still names the destination', () => {
    expect(primaryToolTarget('send_message_to_thread', { threadId: 'thread-b', prompt: '   ' })).toBe('thread-b')
    expect(primaryToolTarget('send_message_to_thread', { threadId: 'thread-b' })).toBe('thread-b')
  })

  test('malformed arguments yield no target rather than throwing', () => {
    // The approval card renders during a permission request; throwing here would
    // blank a card the user has to answer.
    expect(primaryToolTarget('send_message_to_thread', null)).toBe('')
    expect(primaryToolTarget('send_message_to_thread', 'not-an-object')).toBe('')
    expect(primaryToolTarget('send_message_to_thread', {})).toBe('')
    expect(primaryToolTarget('send_message_to_thread', { threadId: '' })).toBe('')
  })

  test('a hostile prompt stays plain text, which is what makes the card safe', () => {
    // This is a PURE function: it must return the text unescaped, because its one
    // consumer renders it as a React child (`{target}` in approval-cards.tsx), and
    // React escapes that. Pre-escaping here would double-escape on screen — the user
    // would read "&lt;img" instead of "<img". What matters is that it returns a
    // string and never markup or an element, so React's escaping always applies.
    const target = primaryToolTarget('send_message_to_thread', {
      threadId: 'thread-b', prompt: '<img src=x onerror=alert(1)>',
    })
    expect(typeof target).toBe('string')
    expect(target).toBe('thread-b — <img src=x onerror=alert(1)>')
    // And it must not have built any HTML structure of its own around the payload.
    expect(target).not.toContain('onerror="')
    expect(target.startsWith('thread-b — ')).toBe(true)
  })

  test('the activity row is unaffected, so only the approval card changed', () => {
    // `toolValueText` returns '' for any tool the activity renderer owns, and
    // send_message_to_thread is one of them. Without that early return this change
    // would have leaked a long prompt into the collapsed activity row too.
    expect(toolValueText('send_message_to_thread', { threadId: 'thread-b', prompt: 'x'.repeat(4000) })).toBe('')
  })

  test('unrelated tools keep their existing targets', () => {
    expect(primaryToolTarget('bash', { command: 'git status' })).toBe('$ git status')
    expect(primaryToolTarget('read', { file_path: '/tmp/a.ts' })).toBe('/tmp/a.ts')
    expect(primaryToolTarget('read', { path: '/tmp/a.ts' })).toBe('/tmp/a.ts')
    expect(primaryToolTarget('advisor', { model: 'gpt-5' })).toBe('gpt-5')
    expect(primaryToolTarget('unknown_tool', { something: 'else' })).toBe('')
  })

  test('create_thread and fork_thread are not mistaken for a message send', () => {
    // They have their own activity cards; giving them a destination line would imply
    // a recipient that does not exist yet (create) or is the caller itself (fork).
    expect(primaryToolTarget('create_thread', { prompt: 'Do the work.' })).toBe('')
    expect(primaryToolTarget('fork_thread', { threadId: 'thread-b' })).toBe('')
  })
})
