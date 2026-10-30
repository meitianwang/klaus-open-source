#!/usr/bin/env node
// Explicitly add portable provenance to a legacy staging COPY. Never rebuild,
// relabel, or change the binary/raw-flags digest to make verification pass.
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { releaseFlagsProvenance, validReleaseFlagsProvenance } from './rust-release-path-remap.mjs'
import { resolveReleaseTarget, stagedContentsMatchManifest } from './prepare-rust-release.mjs'

export function attestStagedReleaseFlags({ directory, buildContext, expectedCommit, expectedBinarySha256, expectedRawFlagsSha256 }) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? '') || ![expectedBinarySha256, expectedRawFlagsSha256].every(value => /^[a-f0-9]{64}$/.test(value ?? ''))) throw new Error('Explicit original commit, engine hash and raw flags hash are required')
  const path = join(directory, 'manifest.json')
  const original = readFileSync(path)
  const manifest = JSON.parse(original)
  const target = resolveReleaseTarget(manifest.platform, manifest.arch)
  if (manifest.engineCommit !== expectedCommit || manifest.engineTreeDirty !== false || manifest.targetTriple !== target.targetTriple) throw new Error('Original engine source/target provenance mismatch')
  const engineHash = target.platform === 'win32' ? manifest.artifacts?.find(artifact => artifact.role === 'engine')?.sha256 : manifest.sha256
  if (engineHash !== expectedBinarySha256 || manifest.releaseFlagsSha256 !== expectedRawFlagsSha256) throw new Error('Original binary or raw flags digest differs from the supplied build record')
  if (target.platform === 'win32' && (manifest.schemaVersion !== 2 || manifest.artifacts?.length !== target.artifacts.length)) throw new Error('Invalid Windows artifact manifest')
  if (target.platform !== 'win32' && manifest.binary !== target.binary) throw new Error('Invalid engine filename')
  const readArtifact = name => { try { return readFileSync(join(directory, name)) } catch { return undefined } }
  if (!stagedContentsMatchManifest(manifest, target, readArtifact)) throw new Error('Original staged artifacts no longer match their recorded SHA-256')
  if (!buildContext || typeof buildContext.encodedRustflags !== 'string' || !buildContext.remapContext) throw new Error('An explicit original encoded flag string and remap context are required')
  const actualRaw = createHash('sha256').update(buildContext.encodedRustflags).digest('hex')
  if (actualRaw !== expectedRawFlagsSha256) throw new Error('Reconstructed original build flags do not hash to the original raw digest; refuse attestation')
  const provenance = releaseFlagsProvenance(buildContext.encodedRustflags, buildContext.remapContext)
  if (!validReleaseFlagsProvenance(provenance, manifest.releaseFlagsSha256)) throw new Error('Derived provenance does not bind the original flag digest')
  if (manifest.releaseFlagsProvenance !== undefined) {
    if (!validReleaseFlagsProvenance(manifest.releaseFlagsProvenance, expectedRawFlagsSha256) || manifest.releaseFlagsProvenance.recipeSha256 !== provenance.recipeSha256) throw new Error('Existing release flags provenance conflicts with the original build context')
    return { changed: false, engineCommit: expectedCommit, sha256: expectedBinarySha256, releaseFlagsSha256: expectedRawFlagsSha256, releaseFlagsProvenance: provenance }
  }
  // Recheck the manifest bytes before replacing only this metadata file.
  if (!readFileSync(path).equals(original)) throw new Error('The original manifest changed during attestation')
  const temporary = `${path}.attesting-${process.pid}`
  try {
    writeFileSync(temporary, `${JSON.stringify({ ...manifest, releaseFlagsProvenance: provenance }, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
  return { changed: true, engineCommit: expectedCommit, sha256: expectedBinarySha256, releaseFlagsSha256: expectedRawFlagsSha256, releaseFlagsProvenance: provenance }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: {
      directory: { type: 'string' }, 'build-context': { type: 'string' }, 'engine-commit': { type: 'string' },
      'engine-sha256': { type: 'string' }, 'raw-flags-sha256': { type: 'string' },
    } })
    if (!values.directory || !values['build-context']) throw new Error('Usage: node engine/scripts/attest-rust-release-flags.mjs --directory <staged copy> --build-context <private JSON> --engine-commit <original commit> --engine-sha256 <original hash> --raw-flags-sha256 <original digest>')
    const result = attestStagedReleaseFlags({ directory: resolve(values.directory), buildContext: JSON.parse(readFileSync(values['build-context'], 'utf8')),
      expectedCommit: values['engine-commit'], expectedBinarySha256: values['engine-sha256'], expectedRawFlagsSha256: values['raw-flags-sha256'] })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) { console.error(`[rust-release-attest] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 }
}
