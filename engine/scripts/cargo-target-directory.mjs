import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export const CARGO_METADATA_ARGS = Object.freeze([
  'metadata',
  '--locked',
  '--no-deps',
  '--format-version',
  '1',
])

export function createCargoInvocationContext(engineCwd, environment = process.env) {
  // Use the system Git transport for pinned dependencies so downloads honor Git's
  // network settings instead of the embedded HTTP parser. Keep explicit overrides.
  const env = Object.freeze({
    ...environment,
    CARGO_NET_GIT_FETCH_WITH_CLI: environment.CARGO_NET_GIT_FETCH_WITH_CLI ?? 'true',
  })
  return Object.freeze({ cwd: resolve(engineCwd), env })
}

export function parseCargoTargetDirectory(metadataOutput) {
  let metadata
  try {
    metadata = JSON.parse(metadataOutput)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Cargo metadata returned invalid JSON: ${detail}`)
  }

  if (
    metadata === null
    || Array.isArray(metadata)
    || typeof metadata !== 'object'
    || !Object.hasOwn(metadata, 'target_directory')
    || typeof metadata.target_directory !== 'string'
    || metadata.target_directory.length === 0
  ) {
    throw new Error('Cargo metadata is missing a top-level target_directory')
  }
  if (!isAbsolute(metadata.target_directory)) {
    throw new Error(`Cargo metadata target_directory must be absolute: ${metadata.target_directory}`)
  }
  return metadata.target_directory
}

export function queryCargoTargetDirectory(
  cargoContext,
  { execFileSyncImpl = execFileSync } = {},
) {
  let output
  try {
    output = execFileSyncImpl('cargo', CARGO_METADATA_ARGS, {
      cwd: cargoContext.cwd,
      env: cargoContext.env,
      encoding: 'utf8',
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to run cargo ${CARGO_METADATA_ARGS.join(' ')}: ${detail}`)
  }
  return parseCargoTargetDirectory(output)
}

export function cargoReleaseBinaryPath({ targetDirectory, targetTriple, binaryName }) {
  if (!isAbsolute(targetDirectory)) {
    throw new Error(`Cargo target directory must be absolute: ${targetDirectory}`)
  }
  if (!targetTriple || targetTriple.includes('/') || targetTriple.includes('\\')) {
    throw new Error(`Invalid Cargo target triple: ${targetTriple}`)
  }
  if (!binaryName || binaryName.includes('/') || binaryName.includes('\\')) {
    throw new Error(`Invalid Cargo release binary name: ${binaryName}`)
  }
  return join(targetDirectory, targetTriple, 'release', binaryName)
}

export function assertCargoReleaseBinary(binaryPath, { statSyncImpl = statSync } = {}) {
  let isFile = false
  try {
    isFile = statSyncImpl(binaryPath).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) {
    throw new Error(`Cargo release binary not found at resolved path: ${binaryPath}`)
  }
  return binaryPath
}
