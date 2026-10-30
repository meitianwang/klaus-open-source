import { describe, expect, test } from 'bun:test'
import { ENGINE_BUILD_INPUTS, engineBuildInputs, engineBuildInputsMatch, validEngineBuildInputs } from './build-inputs.mjs'

const [first, second] = ENGINE_BUILD_INPUTS

describe('engine build-time inputs', () => {
  test('records present inputs by name and digest, never by value', () => {
    const record = engineBuildInputs({ [second]: 'second-value', [first]: 'first-value', UNRELATED: 'x' })
    expect(record.map(entry => entry.name)).toEqual([first, second].sort())
    expect(JSON.stringify(record)).not.toContain('first-value')
    expect(JSON.stringify(record)).not.toContain('second-value')
    expect(validEngineBuildInputs(record)).toBe(true)
  })

  test('absent and blank inputs are not recorded', () => {
    expect(engineBuildInputs({})).toEqual([])
    expect(engineBuildInputs({ [first]: '', [second]: '  ' })).toEqual([])
  })

  test('a changed value, an added input or a removed input does not match', () => {
    const built = engineBuildInputs({ [first]: 'a', [second]: 'b' })
    expect(engineBuildInputsMatch(engineBuildInputs({ [first]: 'a', [second]: 'b' }), built)).toBe(true)
    expect(engineBuildInputsMatch(engineBuildInputs({ [first]: 'a', [second]: 'changed' }), built)).toBe(false)
    expect(engineBuildInputsMatch(engineBuildInputs({ [first]: 'a' }), built)).toBe(false)
    expect(engineBuildInputsMatch(engineBuildInputs({}), built)).toBe(false)
  })

  test('a staged binary without a record counts as built with no inputs', () => {
    expect(engineBuildInputsMatch([], undefined)).toBe(true)
    expect(engineBuildInputsMatch(engineBuildInputs({ [first]: 'a', [second]: 'b' }), undefined)).toBe(false)
  })

  test('malformed records are refused', () => {
    for (const value of [null, {}, [{ name: 'OTHER', sha256: 'a'.repeat(64) }], [{ name: first, sha256: 'short' }],
      [{ name: first, sha256: 'a'.repeat(64), value: 'leak' }], [{ name: second, sha256: 'a'.repeat(64) }, { name: first, sha256: 'a'.repeat(64) }]]) {
      expect(validEngineBuildInputs(value)).toBe(false)
    }
  })

  test('the staging plan rebuilds when build-time inputs differ from the staged binary', async () => {
    const release = await import('./prepare-rust-release.mjs')
    const commit = 'a'.repeat(40)
    const sourceFingerprint = { version: 1, sha256: 'f'.repeat(64), fileCount: 3 }
    const staged = { engineCommit: commit, treeDirty: false, sourceFingerprint, contentsMatchManifest: true }
    const plan = (buildInputs: unknown, stagedInputs?: unknown) => release.planEngineStaging({
      mode: 'dev', indexedCommit: commit, checkoutCommit: commit, treeDirty: false, sourceFingerprint, buildInputs,
      staged: { ...staged, ...(stagedInputs === undefined ? {} : { buildInputs: stagedInputs }) },
    })
    const configured = engineBuildInputs({ [first]: 'a', [second]: 'b' })
    expect(plan([]).action).toBe('reuse')
    expect(plan(configured).action).toBe('build')
    expect(plan(configured).reason).toContain('build-time inputs')
    expect(plan(configured, configured).action).toBe('reuse')
    expect(plan([], configured).action).toBe('build')
  })
})
