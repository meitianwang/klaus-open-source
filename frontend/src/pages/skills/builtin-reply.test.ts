import { describe, expect, test } from 'bun:test'
import { skillErrorText, unpackBuiltinSkillsReply } from './builtin-reply'

describe('unpackBuiltinSkillsReply', () => {
  test('accepts the host object shape with items and no error', () => {
    const reply = unpackBuiltinSkillsReply({ items: [{ name: 'push-code' }], error: null })
    expect(reply.items).toEqual([{ name: 'push-code' }])
    expect(reply.error).toBeNull()
  })

  test('keeps fallback items and surfaces a nested engine error', () => {
    const reply = unpackBuiltinSkillsReply({ items: [{ name: 'deploy' }], error: { message: 'engine offline' } })
    expect(reply.items).toHaveLength(1)
    expect(reply.error).toBe('engine offline')
  })

  test('accepts the legacy bare-array shape', () => {
    const reply = unpackBuiltinSkillsReply([{ name: 'legacy' }])
    expect(reply.items).toEqual([{ name: 'legacy' }])
    expect(reply.error).toBeNull()
  })

  test('rejects garbage shapes with an empty list and a message', () => {
    for (const garbage of [null, undefined, {}, 'nope', 42]) {
      const reply = unpackBuiltinSkillsReply(garbage)
      expect(reply.items).toEqual([])
      expect(reply.error).toBe('Built-in skills returned an invalid response')
    }
  })

  test('rejects an object whose items field is not an array', () => {
    const reply = unpackBuiltinSkillsReply({ items: 'nope', error: null })
    expect(reply.items).toEqual([])
    expect(reply.error).not.toBeNull()
  })
})

describe('skillErrorText', () => {
  test('reads Error, message objects and plain strings', () => {
    expect(skillErrorText(new Error('boom'))).toBe('boom')
    expect(skillErrorText({ message: 'nested' })).toBe('nested')
    expect(skillErrorText('plain')).toBe('plain')
    expect(skillErrorText(null)).toBe('Unknown error')
  })
})
