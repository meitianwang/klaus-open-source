import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { copyPolicyNotices, POLICY_NOTICE_CATALOG, stagePolicyNotices, validatePolicyNotices } from './policy-notices.mjs'

const temporaryDirectories: string[] = []
const engineCommit = 'a'.repeat(40)

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'klaus-policy-notices-'))
  temporaryDirectories.push(root)
  for (const component of ['context/prompts', 'goal/templates', 'planning/prompts', 'engine/approval_context/assets']) {
    const directory = join(root, 'engine/klaus-agent-rust/crates/core/src', component)
    mkdirSync(directory, { recursive: true })
    for (const file of component === 'engine/approval_context/assets' ? ['LICENSE', 'NOTICE', 'policy.md'] : ['LICENSE', 'NOTICE', 'full.md.license', 'full.md']) writeFileSync(join(directory, file), `${component}/${file}\n`)
  }
  for (const source of ['crates/core/src/sandbox/linux/LICENSE-APACHE', 'crates/core/src/sandbox/linux/NOTICE', 'crates/sandbox-linux-bwrap/NOTICE', 'crates/sandbox-linux-bwrap/LICENSE-MIT', 'crates/sandbox-linux-bwrap/LICENSE-APACHE', 'crates/sandbox-linux-bwrap/vendor/bubblewrap/LICENSE', 'crates/sandbox-linux-bwrap/vendor/bubblewrap/COPYING', 'crates/sandbox-win/LICENSE-APACHE', 'crates/sandbox-win/NOTICE', 'crates/sandbox-win/LICENSE-MIT', 'crates/sandbox-win/src/elevated/pty_native/LICENSE', 'crates/sandbox-win/src/elevated/pty_native/NOTICE', 'crates/sandbox-win/src/mxc/LICENSE-MIT']) {
    const destination = join(root, 'engine/klaus-agent-rust', source)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, `${source}\n`)
  }
  const destinationDir = join(root, 'release')
  const policyNotices = stagePolicyNotices({ repoRoot: root, destinationDir, engineCommit })
  return { root, destinationDir, manifest: { engineCommit, policyNotices } }
}

describe('policy notice distribution', () => {
  test('preserves all notice bytes and sidecars while excluding compiled policy bodies', () => {
    const { root, destinationDir, manifest } = fixture()
    const records = validatePolicyNotices(destinationDir, manifest)
    expect(records.map(record => record.path)).toEqual([
      'licenses/instruction-policy/LICENSE', 'licenses/instruction-policy/NOTICE', 'licenses/instruction-policy/full.md.license',
      'licenses/goal-policy/LICENSE', 'licenses/goal-policy/NOTICE', 'licenses/goal-policy/full.md.license',
      'licenses/planning-policy/LICENSE', 'licenses/planning-policy/NOTICE', 'licenses/planning-policy/full.md.license',
      'licenses/automatic-review-policy/LICENSE', 'licenses/automatic-review-policy/NOTICE',
      'licenses/sandbox-runtime/LICENSE', 'licenses/sandbox-runtime/NOTICE',
      'licenses/linux-sandbox-helper/LICENSE', 'licenses/linux-sandbox-helper/COPYING', 'licenses/linux-sandbox-helper/NOTICE', 'licenses/linux-sandbox-helper/LICENSE-MIT', 'licenses/linux-sandbox-helper/LICENSE-APACHE',
      'licenses/windows-sandbox-runtime/LICENSE', 'licenses/windows-sandbox-runtime/NOTICE', 'licenses/windows-sandbox-runtime/LICENSE-MIT',
      'licenses/windows-terminal-runtime/LICENSE', 'licenses/windows-terminal-runtime/NOTICE',
      'licenses/windows-container-sdk/LICENSE',
    ])
    expect(readFileSync(join(destinationDir, 'licenses/goal-policy/full.md.license'), 'utf8')).toBe('goal/templates/full.md.license\n')
    const copied = join(root, 'package')
    copyPolicyNotices(destinationDir, copied, manifest)
    expect(validatePolicyNotices(copied, manifest)).toEqual(records)
    expect(readFileSync(join(copied, POLICY_NOTICE_CATALOG))).toEqual(readFileSync(join(destinationDir, POLICY_NOTICE_CATALOG)))
    expect(readdirSync(join(copied, 'licenses/goal-policy'))).not.toContain('full.md')
    expect(readFileSync(join(copied, 'licenses/sandbox-runtime/LICENSE'), 'utf8')).toBe('crates/core/src/sandbox/linux/LICENSE-APACHE\n')
    expect(readFileSync(join(copied, 'licenses/linux-sandbox-helper/COPYING'), 'utf8')).toBe('crates/sandbox-linux-bwrap/vendor/bubblewrap/COPYING\n')
  })

  test('restaging removes notices no longer present in source', () => {
    const { root, destinationDir } = fixture()
    rmSync(join(root, 'engine/klaus-agent-rust/crates/core/src/goal/templates/full.md.license'))
    const policyNotices = stagePolicyNotices({ repoRoot: root, destinationDir, engineCommit })
    const records = validatePolicyNotices(destinationDir, { engineCommit, policyNotices })
    expect(records).toHaveLength(23)
    expect(readdirSync(join(destinationDir, 'licenses/goal-policy'))).toEqual(['LICENSE', 'NOTICE'])
  })

  test('rejects missing source attribution and linked sources', () => {
    const { root, destinationDir } = fixture()
    const source = join(root, 'engine/klaus-agent-rust/crates/core/src/goal/templates/NOTICE')
    rmSync(source)
    const stage = () => stagePolicyNotices({ repoRoot: root, destinationDir, engineCommit })
    expect(stage).toThrow('Missing goal-policy NOTICE')
    symlinkSync(join(root, 'release/licenses/goal-policy/NOTICE'), source)
    expect(stage).toThrow('must be a regular file')
    rmSync(source)
    writeFileSync(source, '')
    expect(stage).toThrow('must not be empty')
  })

  test('planning attribution is required and bound to its packaged bytes', () => {
    const { root, destinationDir, manifest } = fixture()
    const source = join(root, 'engine/klaus-agent-rust/crates/core/src/planning/prompts/NOTICE')
    rmSync(source)
    expect(() => stagePolicyNotices({ repoRoot: root, destinationDir, engineCommit })).toThrow('Missing planning-policy NOTICE')
    writeFileSync(join(destinationDir, 'licenses/planning-policy/NOTICE'), 'changed planning attribution')
    expect(() => validatePolicyNotices(destinationDir, manifest)).toThrow('SHA-256 mismatch: licenses/planning-policy/NOTICE')
  })

  test('requires bundled helper attribution and binds its complete copying terms', () => {
    const { root, destinationDir, manifest } = fixture()
    const source = join(root, 'engine/klaus-agent-rust/crates/sandbox-linux-bwrap/vendor/bubblewrap/COPYING')
    rmSync(source)
    expect(() => stagePolicyNotices({ repoRoot: root, destinationDir, engineCommit })).toThrow('ENOENT')
    writeFileSync(join(destinationDir, 'licenses/linux-sandbox-helper/COPYING'), 'changed copying terms')
    expect(() => validatePolicyNotices(destinationDir, manifest)).toThrow('SHA-256 mismatch: licenses/linux-sandbox-helper/COPYING')
  })

  test('rejects tampered notices, missing files, unexpected files and symlinks', () => {
    const { destinationDir, manifest } = fixture()
    const path = join(destinationDir, 'licenses/goal-policy/NOTICE')
    const contents = readFileSync(path)
    const validate = () => validatePolicyNotices(destinationDir, manifest)
    writeFileSync(path, 'changed attribution')
    expect(validate).toThrow('SHA-256 mismatch')
    rmSync(path)
    expect(validate).toThrow('files are missing')
    writeFileSync(path, contents)
    const extra = join(destinationDir, 'licenses/goal-policy/extra.license')
    writeFileSync(extra, 'unexpected')
    expect(validate).toThrow('Unexpected engine policy notice file')
    rmSync(extra)
    rmSync(path)
    symlinkSync(join(destinationDir, 'licenses/instruction-policy/NOTICE'), path)
    expect(validate).toThrow('must be a regular file')
  })

  test('binds the catalog to its manifest and the engine commit', () => {
    const { destinationDir, manifest } = fixture()
    expect(() => validatePolicyNotices(destinationDir, { engineCommit })).toThrow('identity is missing')
    expect(() => validatePolicyNotices(destinationDir, { ...manifest, engineCommit: 'b'.repeat(40) })).toThrow('catalog identity mismatch')
    writeFileSync(join(destinationDir, POLICY_NOTICE_CATALOG), '{}')
    expect(() => validatePolicyNotices(destinationDir, manifest)).toThrow('catalog SHA-256 mismatch')
  })

  test('rejects forged unsafe paths, duplicate records and incomplete required attribution', () => {
    const { root, destinationDir, manifest } = fixture()
    const path = join(destinationDir, POLICY_NOTICE_CATALOG)
    const original = JSON.parse(readFileSync(path, 'utf8'))
    function validateCatalog(catalog: unknown) {
      const contents = JSON.stringify(catalog)
      writeFileSync(path, contents)
      return () => validatePolicyNotices(destinationDir, { ...manifest, policyNotices: { file: POLICY_NOTICE_CATALOG, sha256: createHash('sha256').update(contents).digest('hex') } })
    }
    expect(validateCatalog({ ...original, files: [...original.files, original.files[0]] })).toThrow('duplicate')
    expect(validateCatalog({ ...original, files: [{ ...original.files[0], path: 'licenses/goal-policy/../../outside.license' }] })).toThrow('path')
    expect(validateCatalog({ ...original, files: original.files.filter(file => !file.path.endsWith('/NOTICE')) })).toThrow('Missing instruction-policy NOTICE')
    expect(validateCatalog({ ...original, files: original.files.filter(file => !file.path.endsWith('/COPYING')) })).toThrow('Missing linux-sandbox-helper COPYING')
    const linkedDirectory = join(root, 'linked')
    mkdirSync(linkedDirectory)
    rmSync(join(destinationDir, 'licenses/goal-policy'), { recursive: true })
    symlinkSync(linkedDirectory, join(destinationDir, 'licenses/goal-policy'))
    expect(validateCatalog(original)).toThrow('must be a regular directory')
  })
})
