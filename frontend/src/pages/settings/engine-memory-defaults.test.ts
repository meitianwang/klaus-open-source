import { describe, expect, test } from 'bun:test'
import { AUTO_MEMORY_DEFAULT } from './engine-memory-defaults'

describe('engine memory defaults', () => {
  test('automatic memory is opt-in when no preference has been stored', () => {
    expect(AUTO_MEMORY_DEFAULT).toBe(false)
  })
})
