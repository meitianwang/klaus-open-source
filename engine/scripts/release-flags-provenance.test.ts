import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodedReleaseRustflags, ENCODED_RUSTFLAGS_SEPARATOR as separator, releaseFlagsProvenance, releaseFlagsMatch } from './rust-release-path-remap.mjs'
import { buildReleaseManifest, planEngineStaging, resolveReleaseTarget } from './prepare-rust-release.mjs'
import { attestStagedReleaseFlags } from './attest-rust-release-flags.mjs'

const a = { env: {}, home: '/Users/builder-a', repoRoot: '/Users/builder-a/first checkout' }
const b = { env: { CARGO_HOME: '/Volumes/Build/cargo', RUSTUP_HOME: '/Volumes/Build/rustup' }, home: '/Users/builder-b', repoRoot: '/Volumes/Build/other checkout' }
const flags = (context = a, inherited = '') => {
  const { env, ...prefixes } = context
  return encodedReleaseRustflags({ ...env, RUSTFLAGS: inherited }, prefixes)
}
const digest = value => createHash('sha256').update(value).digest('hex')
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('portable release flags provenance', () => {
  test('only physical generated prefixes vary while actual raw digests remain different', () => {
    const first = releaseFlagsProvenance(flags(a), a), second = releaseFlagsProvenance(flags(b), b)
    expect(first.encodedSha256).not.toBe(second.encodedSha256)
    expect(first.recipeSha256).toBe(second.recipeSha256)
    expect(JSON.stringify(first)).not.toContain('/Users/')
    expect(releaseFlagsMatch({ expectedRaw: second.encodedSha256, expectedProvenance: second, actualRaw: first.encodedSha256, actualProvenance: first })).toBe(true)
  })

  test('inherited flags, their order, extra flags and user remaps are never normalized away', () => {
    const expected = releaseFlagsProvenance(flags(a, '-C overflow-checks=on -C opt-level=3'), a)
    for (const inherited of ['-C overflow-checks=off -C opt-level=3', '-C opt-level=3 -C overflow-checks=on', '-C overflow-checks=on -C opt-level=3 --cfg extra', '-C overflow-checks=on -C opt-level=3 --remap-path-prefix=/private=/klaus']) {
      expect(releaseFlagsProvenance(flags(a, inherited), a).recipeSha256).not.toBe(expected.recipeSha256)
    }
  })

  test('missing, reordered, changed and non-suffix remap rules refuse provenance', () => {
    const original = flags(a).split(separator)
    const cases = [original.slice(1), [original[1], original[0], ...original.slice(2)], [...original.slice(0, 3), original[3].replace('=/klaus', '=/other')], [...original, '--cfg=after']]
    for (const invalid of cases) expect(() => releaseFlagsProvenance(invalid.join(separator), a)).toThrow('exact four generated remap rules')
    expect(() => releaseFlagsProvenance(flags(a), b)).toThrow('exact four generated remap rules')
  })

  test('a relative or separator-bearing physical prefix cannot claim a recipe', () => {
    const relative = { ...a, repoRoot: 'relative-root' }
    expect(() => releaseFlagsProvenance(flags(relative), relative)).toThrow('Invalid physical')
    const injected = { ...a, repoRoot: `/source${separator}--cfg=injected` }
    expect(() => releaseFlagsProvenance(flags(injected), injected)).toThrow('Invalid physical')
  })

  test('legacy artifacts remain raw-strict and malformed new metadata never falls back', () => {
    const first = releaseFlagsProvenance(flags(a), a), second = releaseFlagsProvenance(flags(b), b)
    expect(releaseFlagsMatch({ expectedRaw: first.encodedSha256, expectedProvenance: first, actualRaw: first.encodedSha256 })).toBe(true)
    expect(releaseFlagsMatch({ expectedRaw: second.encodedSha256, expectedProvenance: second, actualRaw: first.encodedSha256 })).toBe(false)
    for (const invalid of [{ ...first, version: 2 }, { ...first, encodedSha256: '0'.repeat(64) }, { ...first, recipeSha256: 'bad' }, { ...first, ignored: true }]) {
      expect(releaseFlagsMatch({ expectedRaw: first.encodedSha256, expectedProvenance: first, actualRaw: first.encodedSha256, actualProvenance: invalid })).toBe(false)
    }
  })

  test('the staging planner reuses a relocated proof but still rejects changed compile options and bytes', () => {
    const first = releaseFlagsProvenance(flags(a), a), expected = releaseFlagsProvenance(flags(b), b), commit = 'a'.repeat(40)
    const options = { mode: 'package', indexedCommit: commit, checkoutCommit: commit, treeDirty: false,
      releaseFlags: expected.encodedSha256, flagsProvenance: expected,
      staged: { engineCommit: commit, treeDirty: false, releaseFlags: first.encodedSha256, flagsProvenance: first, contentsMatchManifest: true } }
    expect(planEngineStaging(options).action).toBe('reuse')
    expect(planEngineStaging({ ...options, staged: { ...options.staged, contentsMatchManifest: false } }).action).toBe('build')
    const changed = releaseFlagsProvenance(flags(b, '-C overflow-checks=off'), b)
    expect(planEngineStaging({ ...options, releaseFlags: changed.encodedSha256, flagsProvenance: changed }).reason).toContain('different set of release flags')
  })

  test('new macOS and Windows manifests bind the generated recipe to the actual raw flags', () => {
    const proof = releaseFlagsProvenance(flags(a), a)
    for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64']]) {
      const target = resolveReleaseTarget(platform, arch)
      const input = { engineCommit: 'd'.repeat(40), releaseFlags: proof.encodedSha256, flagsProvenance: proof,
        target, binaryContents: Buffer.from('engine'),
        artifactContents: new Map((target.artifacts ?? []).map(({ role }) => [role, Buffer.from(role)])) }
      expect(buildReleaseManifest(input).releaseFlagsProvenance).toEqual(proof)
      expect(() => buildReleaseManifest({ ...input, releaseFlags: '0'.repeat(64) })).toThrow('Invalid release flags provenance')
    }
  })
})

function staged() {
  const directory = mkdtempSync(join(tmpdir(), 'klaus-flags-attest-')); directories.push(directory)
  const bytes = Buffer.from('A fixture artifact; no Rust compilation is performed.')
  const target = resolveReleaseTarget('darwin', 'arm64'), expectedCommit = 'c'.repeat(40), originalFlags = flags(a)
  const manifest = buildReleaseManifest({ engineCommit: expectedCommit, releaseFlags: digest(originalFlags), target, binaryContents: bytes })
  writeFileSync(join(directory, target.binary), bytes)
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
  return { manifest, bytes, target, args: { directory, buildContext: { encodedRustflags: originalFlags, remapContext: a },
    expectedCommit, expectedBinarySha256: digest(bytes), expectedRawFlagsSha256: digest(originalFlags) } }
}

describe('explicit legacy artifact attestation', () => {
  test('attests only the original flags and bytes, changes only the proof, and is idempotent', () => {
    const item = staged(), result = attestStagedReleaseFlags(item.args)
    expect(result.changed).toBe(true)
    const proof = JSON.parse(readFileSync(join(item.args.directory, 'manifest.json'), 'utf8'))
    const { releaseFlagsProvenance: provenance, ...unchanged } = proof
    expect(unchanged).toEqual(item.manifest)
    expect(provenance.encodedSha256).toBe(item.args.expectedRawFlagsSha256)
    expect(readFileSync(join(item.args.directory, item.target.binary))).toEqual(item.bytes)
    expect(attestStagedReleaseFlags(item.args).changed).toBe(false)
  })

  test('wrong build context, original anchors or changed artifact bytes leave the manifest untouched', () => {
    const item = staged(), path = join(item.args.directory, 'manifest.json'), original = readFileSync(path)
    const bad = [
      { ...item.args, buildContext: { encodedRustflags: flags(b), remapContext: b } },
      { ...item.args, buildContext: { encodedRustflags: flags(a), remapContext: b } },
      { ...item.args, expectedRawFlagsSha256: '0'.repeat(64) },
      { ...item.args, expectedBinarySha256: '0'.repeat(64) },
      { ...item.args, expectedCommit: '0'.repeat(40) },
    ]
    for (const invalid of bad) { expect(() => attestStagedReleaseFlags(invalid)).toThrow(); expect(readFileSync(path)).toEqual(original) }
    writeFileSync(join(item.args.directory, item.target.binary), 'changed bytes')
    expect(() => attestStagedReleaseFlags(item.args)).toThrow('recorded SHA-256')
    expect(readFileSync(path)).toEqual(original)
  })

  test('dirty original builds and conflicting existing proof are refused', () => {
    const item = staged(), path = join(item.args.directory, 'manifest.json')
    writeFileSync(path, JSON.stringify({ ...item.manifest, engineTreeDirty: true }))
    expect(() => attestStagedReleaseFlags(item.args)).toThrow('source/target provenance')
    writeFileSync(path, JSON.stringify({ ...item.manifest, releaseFlagsProvenance: { version: 2 } }))
    expect(() => attestStagedReleaseFlags(item.args)).toThrow('Existing release flags provenance conflicts')
  })
})
