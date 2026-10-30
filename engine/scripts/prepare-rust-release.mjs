#!/usr/bin/env node

import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  assertCargoReleaseBinary,
  cargoReleaseBinaryPath,
  createCargoInvocationContext,
  queryCargoTargetDirectory,
} from './cargo-target-directory.mjs'
import { encodedReleaseRustflags, releaseFlagsProvenance, releaseFlagsMatch, validReleaseFlagsProvenance } from './rust-release-path-remap.mjs'
import { engineBuildInputs, engineBuildInputsMatch, validEngineBuildInputs } from './build-inputs.mjs'
import { stagePolicyNotices, validatePolicyNotices } from './policy-notices.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '../..')
const ENGINE_PATH = 'engine/klaus-agent-rust'
const MANIFEST_FILENAME = 'manifest.json'

const RELEASE_TARGETS = new Map([
  ['darwin-arm64', {
    platform: 'darwin',
    arch: 'arm64',
    targetTriple: 'aarch64-apple-darwin',
    binary: 'klaus-agent-stdio',
  }],
  ['darwin-x64', {
    platform: 'darwin',
    arch: 'x64',
    targetTriple: 'x86_64-apple-darwin',
    binary: 'klaus-agent-stdio',
  }],
  ['win32-x64', {
    platform: 'win32',
    arch: 'x64',
    targetTriple: 'x86_64-pc-windows-msvc',
    binary: 'klaus-agent-stdio.exe',
    // Sandbox setup and command execution use native helpers beside the engine.
    // The browser broker also requires its own Node addon.
    artifacts: [
      { role: 'engine', file: 'klaus-agent-stdio.exe' },
      { role: 'browserPipeAddon', file: 'klaus_browser_pipe.node', builtAs: 'klaus_browser_pipe.dll' },
      { role: 'sandboxSetup', file: 'klaus-windows-sandbox-setup.exe' },
      { role: 'sandboxRunner', file: 'klaus-command-runner.exe' },
      { role: 'sandboxManagedDenyProbe', file: 'klaus-windows-managed-deny-probe.exe' },
    ],
  }],
])

export function resolveReleaseTarget(platform, arch) {
  const target = RELEASE_TARGETS.get(`${platform}-${arch}`)
  if (!target) {
    throw new Error(`Unsupported Rust release target: ${platform}-${arch}`)
  }
  return { ...target }
}

export function cargoBuildPlan(targetTriple) {
  const plan = [[
    'build',
    '--locked',
    '--release',
    '-p',
    'klaus-agent-server',
    '--bin',
    'klaus-agent-stdio',
    '--target',
    targetTriple,
  ]]
  if (targetTriple.includes('windows')) {
    // The browser broker's Node addon is a cdylib in its own crate, and nothing else in the
    // build graph depends on it, so it has to be asked for by name. It also needs its own
    // invocation: `--bin` is a target filter applied across every selected package, so a
    // `-p klaus-browser-pipe-napi` riding along in the engine's command builds nothing at
    // all — cargo still exits 0 and the missing .dll only surfaces when staging resolves it.
    plan.push([
      'build',
      '--locked',
      '--release',
      '-p',
      'klaus-browser-pipe-napi',
      '--lib',
      '--target',
      targetTriple,
    ])
    plan.push([
      'build', '--locked', '--release', '-p', 'klaus-sandbox-win',
      '--bin', 'klaus-windows-sandbox-setup',
      '--bin', 'klaus-command-runner',
      '--bin', 'klaus-windows-managed-deny-probe',
      '--target', targetTriple,
    ])
  }
  return plan
}

export function assertHostPlatform(target, hostPlatform = process.platform, hostArch = process.arch) {
  if (target.platform !== hostPlatform || target.arch !== hostArch) {
    throw new Error(
      `Rust release host ${hostPlatform}-${hostArch} cannot build ${target.platform}-${target.arch}; run this target on a matching host instead. Cross-target packaging is not treated as success.`,
    )
  }
}

export function parseIndexedGitlink(output) {
  const match = output.match(/^160000 ([0-9a-f]{40}) [0-3]\t/m)
  if (!match) throw new Error(`Cannot resolve indexed Rust gitlink at ${ENGINE_PATH}`)
  return match[1]
}

export function buildReleaseManifest({ engineCommit, treeDirty = false, sourceFingerprint, releaseFlags, flagsProvenance, buildInputs, target, binaryContents, artifactContents, policyNotices }) {
  if (buildInputs !== undefined && !validEngineBuildInputs(buildInputs)) throw new Error('Invalid engine build inputs record')
  if (flagsProvenance !== undefined && !validReleaseFlagsProvenance(flagsProvenance, releaseFlags)) throw new Error('Invalid release flags provenance')
  if (sourceFingerprint !== undefined && !validEngineSourceFingerprint(sourceFingerprint)) throw new Error('Invalid engine source fingerprint')
  const provenance = {
    ...(flagsProvenance === undefined ? {} : { releaseFlagsProvenance: flagsProvenance }),
    ...(sourceFingerprint === undefined ? {} : { engineSourceFingerprint: sourceFingerprint }),
    ...(buildInputs === undefined ? {} : { engineBuildInputs: buildInputs }),
  }
  const notices = policyNotices === undefined ? {} : { policyNotices }
  if (target.platform === 'win32') {
    return {
      schemaVersion: 2,
      engineCommit,
      engineTreeDirty: treeDirty,
      releaseFlagsSha256: releaseFlags,
      ...provenance,
      ...notices,
      targetTriple: target.targetTriple,
      platform: target.platform,
      arch: target.arch,
      artifacts: target.artifacts.map(({ role, file }) => ({
        role,
        file,
        sha256: createHash('sha256').update(artifactContents.get(role)).digest('hex'),
      })),
    }
  }
  return {
    engineCommit,
    engineTreeDirty: treeDirty,
    releaseFlagsSha256: releaseFlags,
    ...provenance,
    ...notices,
    targetTriple: target.targetTriple,
    sha256: createHash('sha256').update(binaryContents).digest('hex'),
    platform: target.platform,
    arch: target.arch,
    binary: target.binary,
  }
}

function parseArgs(argv) {
  let platform
  let arch
  let mode = 'package'
  let verifyOnly = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--dev') {
      mode = 'dev'
      continue
    }
    if (arg === '--verify-only') {
      verifyOnly = true
      continue
    }
    if (arg === '--platform' || arg === '--arch') {
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`)
      if (arg === '--platform') platform = value
      else arch = value
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return {
    help: false,
    mode,
    verifyOnly,
    target: resolveReleaseTarget(platform ?? process.platform, arch ?? process.arch),
  }
}

function commandOutput(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to run ${command} ${args.join(' ')}: ${detail}`)
  }
}

function indexedEngineCommit(repoRoot) {
  const output = commandOutput(
    'git',
    ['-C', repoRoot, 'ls-files', '--stage', '--', ENGINE_PATH],
    repoRoot,
  )
  return parseIndexedGitlink(output)
}

// What the engine submodule actually has checked out right now. This is the
// source cargo will compile, and it is NOT interchangeable with the parent
// repo's gitlink: committing inside the submodule moves this and leaves the
// gitlink behind until someone stages the pointer.
function engineCheckoutState(repoRoot, includeSourceFingerprint = false) {
  const engineRoot = join(repoRoot, ENGINE_PATH)
  return {
    commit: commandOutput('git', ['-C', engineRoot, 'rev-parse', 'HEAD'], repoRoot),
    dirty: commandOutput('git', ['-C', engineRoot, 'status', '--short'], repoRoot) !== '',
    ...(includeSourceFingerprint ? { sourceFingerprint: fingerprintEngineSource(engineRoot) } : {}),
  }
}

function validEngineSourceFingerprint(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3 && value.version === 1
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.fileCount) && value.fileCount >= 0
}

function sourceFingerprintsMatch(first, second) {
  return validEngineSourceFingerprint(first) && validEngineSourceFingerprint(second)
    && first.sha256 === second.sha256 && first.fileCount === second.fileCount
}

function engineSourcePaths(engineRoot) {
  const output = execFileSync('git', ['-C', engineRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBuffer: 32 * 1024 * 1024 })
  const paths = output.toString('utf8').split('\0').filter(Boolean)
  if (!Buffer.from(output.toString('utf8')).equals(output)) throw new Error('Engine source paths must use valid UTF-8')
  for (const path of paths) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('Invalid engine source path')
  }
  return [...new Set(paths)].sort((first, second) => Buffer.compare(Buffer.from(first), Buffer.from(second)))
}

function sameSourceStat(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.mode === second.mode
    && first.size === second.size && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs
}

function hashSourceFile(path, expected) {
  const handle = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(handle)
    if (!before.isFile() || !sameSourceStat(expected, before)) throw new Error('Engine source changed while being fingerprinted')
    const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
    let bytes = 0, read
    while ((read = readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      bytes += read
      if (bytes > before.size) throw new Error('Engine source changed while being fingerprinted')
      digest.update(buffer.subarray(0, read))
    }
    if (bytes !== before.size || !sameSourceStat(before, fstatSync(handle)) || !sameSourceStat(before, lstatSync(path))) throw new Error('Engine source changed while being fingerprinted')
    return digest.digest('hex')
  } finally { closeSync(handle) }
}

/** Bind development artifacts to all tracked and nonignored untracked source bytes. */
export function fingerprintEngineSource(engineRoot) {
  const root = realpathSync(engineRoot), paths = engineSourcePaths(root), digest = createHash('sha256')
  digest.update('klaus-engine-source-v1\0')
  const field = value => {
    const bytes = Buffer.from(String(value))
    digest.update(`${bytes.length}:`).update(bytes)
  }
  for (const path of paths) {
    field(path)
    const absolute = join(root, path)
    let info
    try { info = lstatSync(absolute) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      field('missing')
      continue
    }
    field(info.mode & 0o777)
    if (info.isFile()) {
      const destination = relative(root, realpathSync(absolute))
      if (isAbsolute(destination) || destination === '..' || destination.startsWith('../') || destination.startsWith('..\\')) throw new Error('Engine source path escapes its source root')
      field('file'); field(hashSourceFile(absolute, info))
    } else if (info.isSymbolicLink()) {
      field('symlink'); field(readlinkSync(absolute))
      let target
      try { target = realpathSync(absolute) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        const destination = relative(root, resolve(dirname(absolute), readlinkSync(absolute)))
        if (isAbsolute(destination) || destination === '..' || destination.startsWith('../') || destination.startsWith('..\\')) throw new Error('Engine source symlink escapes its source root')
        field('missing-target')
      }
      if (target !== undefined) {
        const destination = relative(root, target)
        if (isAbsolute(destination) || destination === '..' || destination.startsWith('../') || destination.startsWith('..\\')) throw new Error('Engine source symlink escapes its source root')
        const targetInfo = lstatSync(target)
        if (!targetInfo.isFile()) throw new Error('Engine source symlink must target a regular file')
        field(destination); field(targetInfo.mode & 0o777); field(hashSourceFile(target, targetInfo))
      }
      if (!sameSourceStat(info, lstatSync(absolute))) throw new Error('Engine source changed while being fingerprinted')
    } else throw new Error('Engine source inventory contains an unsupported file type or nested repository')
  }
  if (JSON.stringify(paths) !== JSON.stringify(engineSourcePaths(root))) throw new Error('Engine source inventory changed while being fingerprinted')
  return { version: 1, sha256: digest.digest('hex'), fileCount: paths.length }
}

export function assertEngineSourceUnchanged(before, after) {
  if (before.commit !== after.commit || before.dirty !== after.dirty || !sourceFingerprintsMatch(before.sourceFingerprint, after.sourceFingerprint)) {
    throw new Error('Engine source changed during the development build; refusing to stage mixed or stale source')
  }
}

function assertEngineCheckout(indexedCommit, checkout) {
  if (checkout.commit !== indexedCommit) {
    throw new Error(
      `Rust checkout ${checkout.commit} does not match parent gitlink ${indexedCommit}; update the submodule before building.`,
    )
  }
  if (checkout.dirty) {
    throw new Error('Rust engine submodule has tracked or untracked source changes; refusing to label a dirty build with the indexed gitlink.')
  }
}

function assertRustToolchain(repoRoot) {
  const version = commandOutput('rustc', ['--version'], repoRoot)
  if (!/^rustc 1\.93\./.test(version)) {
    throw new Error(`Rust 1.93 is required by rust-toolchain.toml, but ${version} is active.`)
  }
}

function assertTargetInstalled(repoRoot, target) {
  const installed = commandOutput('rustup', ['target', 'list', '--installed'], repoRoot)
    .split(/\r?\n/)
    .filter(Boolean)
  if (!installed.includes(target.targetTriple)) {
    throw new Error(
      `Rust target ${target.targetTriple} is not installed; run rustup target add ${target.targetTriple} and retry.`,
    )
  }
}

// Release flags are a build input the artifact cannot be inspected for: the
// path remapping they carry only shows up as an absence of strings. Recording
// their digest — never the flags themselves, since this manifest ships inside
// the app bundle and the flags spell out the build machine's paths — is what
// makes a flag change force a rebuild instead of reusing a binary compiled
// under the previous set. New manifests additionally carry a producer-derived
// recipe digest: only the generated physical remap prefixes vary across build
// machines. Legacy raw digests still require an exact match or explicit proof.
function releaseFlagsDigest(encodedRustflags) {
  return createHash('sha256').update(encodedRustflags).digest('hex')
}

function runCargoBuild(cargoContext, target, encodedRustflags, engineCommit) {
  for (const args of cargoBuildPlan(target.targetTriple)) {
    const result = spawnSync('cargo', args, {
      cwd: cargoContext.cwd,
      // The shipped binary must not carry this machine's absolute source paths:
      // every panic site embeds a std::file!() string, so `strings` on it printed
      // the build user's home directory. Only the build gets these flags; the
      // metadata query above stays on the plain environment.
      // The engine's build script embeds this commit into the binary so a
      // shipped artifact can name its own source; stageRelease cross-checks it
      // against the manifest claim right after the build.
      env: { ...cargoContext.env, CARGO_ENCODED_RUSTFLAGS: encodedRustflags, KLAUS_ENGINE_BUILD_COMMIT: engineCommit },
      stdio: 'inherit',
    })
    if (result.error) throw new Error(`Failed to start cargo: ${result.error.message}`)
    if (result.status !== 0) {
      throw new Error(`cargo ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`)
    }
  }
}

/**
 * Prove the freshly built binary carries the commit the manifest is about to
 * claim. The build script embeds `KLAUS_ENGINE_BUILD_COMMIT` into the binary
 * (the `--version` identity line quotes it), so reading that string back is a
 * direct check that cargo compiled the source the release labeled — the one
 * gap a manifest-only check cannot close, because a manifest can name any
 * commit for any binary.
 */
export function assertEmbeddedEngineCommit(staged, engineCommit) {
  const identity = commandOutput(staged.destinationBinary, ['--version'], undefined)
  if (!identity.includes(`engine build ${engineCommit}`)) {
    throw new Error(
      `staged engine binary does not carry the labeled commit ${engineCommit}; refusing to ship an unidentified build`,
    )
  }
}

export function stageRelease({ repoRoot, target, engineCommit, treeDirty, sourceFingerprint, releaseFlags, flagsProvenance, buildInputs, sourceBinary, sourceArtifacts }) {
  assertCargoReleaseBinary(sourceBinary)
  // Shell-agnostic staging dir: the engine is consumed by the desktop client's
  // bundle config and by its dev fallback, so its build output does not belong
  // under any one client's tree.
  const destinationDir = stagingDirectory(repoRoot, target)
  const destinationBinary = join(destinationDir, target.binary)

  mkdirSync(destinationDir, { recursive: true })
  const artifactContents = new Map()
  if (target.platform === 'win32') {
    for (const artifact of target.artifacts) {
      const source = sourceArtifacts.get(artifact.role)
      assertCargoReleaseBinary(source)
      const destination = join(destinationDir, artifact.file)
      replaceFileAtomically(source, destination)
      artifactContents.set(artifact.role, readFileSync(destination))
    }
  } else {
    replaceFileAtomically(sourceBinary, destinationBinary, 0o755)
  }
  const binaryContents = readFileSync(destinationBinary)
  const policyNotices = stagePolicyNotices({ repoRoot, destinationDir, engineCommit })
  const manifest = buildReleaseManifest({ engineCommit, treeDirty, sourceFingerprint, releaseFlags, flagsProvenance, buildInputs, target, binaryContents, artifactContents, policyNotices })
  writeFileSync(join(destinationDir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`)
  return { destinationBinary, manifest }
}

// Stage a file by writing a sibling temp copy and renaming it over the
// destination, NEVER by copying onto the destination in place.
//
// A plain copy opens the existing destination and rewrites the SAME inode.
// When any process still maps that inode (an orphaned engine, a leftover
// probe), macOS invalidates the per-inode code-signature cache it validates
// executables against, and every later exec from that path is SIGKILLed by
// taskgated with `CODESIGNING / Taskgated Invalid Signature` — the desktop
// client then has no engine at all while the file itself still verifies fine
// with `codesign -vv`. Measured: a probe left running for three hours kept the
// staged copy mapped, the next staging run poisoned it, and every engine spawn
// died 30ms after exec.
//
// rename gives the new contents a NEW inode: whoever holds the old one keeps
// running against it undisturbed, and no signature cache is ever contradicted.
function replaceFileAtomically(source, destination, mode) {
  const staging = `${destination}.staging-${process.pid}`
  try {
    copyFileSync(source, staging)
    if (mode !== undefined) chmodSync(staging, mode)
    renameSync(staging, destination)
  } catch (error) {
    rmSync(staging, { force: true })
    throw error
  }
}

function printHelp() {
  process.stdout.write([
    'Prepare a verified Klaus Rust stdio release binary.',
    '',
    'Usage:',
    '  node engine/scripts/prepare-rust-release.mjs [--platform darwin|win32] [--arch arm64|x64]',
    '                                               [--dev] [--verify-only]',
    '',
    'Supported targets: darwin-arm64, darwin-x64, win32-x64',
    '',
    'Freshness is judged against the engine commit the artifact must carry:',
    '  default  the parent gitlink (packaging: the artifact must be a clean build',
    '           of the commit this repo records for the submodule)',
    '  --dev    the engine submodule checkout (dev launchers: the artifact must be',
    '           a build of the current commit and exact tracked/untracked source,',
    '           with the same source dirty state recorded in its manifest)',
    '  --verify-only  report a needed rebuild as a failure instead of building',
    '',
  ].join('\n'))
}

function stagingDirectory(repoRoot, target) {
  return join(repoRoot, 'resources', 'bin', `${target.platform}-${target.arch}`)
}

// Every artifact the target declares must still hash to what the manifest
// recorded. Checking only the top-level `sha256` left the Windows target
// (schemaVersion 2, per-artifact hashes, no top-level `sha256`) unverifiable.
export function stagedContentsMatchManifest(manifest, target, readArtifact) {
  if (target.platform === 'win32') {
    if (!Array.isArray(manifest.artifacts)) return false
    return target.artifacts.every(({ role, file }) => {
      const entry = manifest.artifacts.find(candidate => candidate.role === role)
      if (!entry || entry.file !== file) return false
      const contents = readArtifact(file)
      return contents !== undefined
        && createHash('sha256').update(contents).digest('hex') === entry.sha256
    })
  }
  const contents = readArtifact(target.binary)
  return contents !== undefined
    && createHash('sha256').update(contents).digest('hex') === manifest.sha256
}

export function readStagedRelease(repoRoot, target) {
  const directory = stagingDirectory(repoRoot, target)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(directory, MANIFEST_FILENAME), 'utf8'))
  } catch {
    return null
  }
  const readArtifact = file => {
    try {
      return readFileSync(join(directory, file))
    } catch {
      return undefined
    }
  }
  let noticesMatchManifest = false
  try {
    validatePolicyNotices(directory, manifest)
    noticesMatchManifest = true
  } catch {
    // A stale or incomplete notice payload must be regenerated with the release.
  }
  return {
    engineCommit: manifest.engineCommit,
    treeDirty: manifest.engineTreeDirty,
    sourceFingerprint: manifest.engineSourceFingerprint,
    releaseFlags: manifest.releaseFlagsSha256,
    flagsProvenance: manifest.releaseFlagsProvenance,
    buildInputs: manifest.engineBuildInputs,
    contentsMatchManifest: stagedContentsMatchManifest(manifest, target, readArtifact) && noticesMatchManifest,
  }
}

/**
 * Decide whether the staged artifact can be reused, and which engine commit a
 * rebuild must be labeled with.
 *
 * Two callers ask two different questions, so the anchor is a mode and not a
 * constant:
 *
 *   `package` — is this artifact a clean build of the commit the parent repo
 *     records for the submodule? A dirty submodule tree is fine as long as the
 *     artifact already on disk carries that commit: packaging reuses it instead
 *     of labeling uncommitted engine code with a commit it is not.
 *   `dev` — was this artifact built from the engine source checked out right
 *     now? That is the only question a dev launcher can ask. The gitlink is
 *     parent-repo bookkeeping that a submodule checkout routinely runs ahead of
 *     (commit inside the submodule, pointer not staged yet), so answering with
 *     it reports "ready" while the client runs an engine from another commit.
 *     Measured: the submodule sat 7 commits ahead with the pointer unstaged,
 *     the staged binary predated a protocol field the shell had already started
 *     sending, and every session resume died with
 *     `invalid protocol op: runtime codec UnknownField at /op/init/...` — a
 *     failure that reads like a protocol bug rather than a stale artifact.
 */
export function planEngineStaging({ mode, indexedCommit, checkoutCommit, treeDirty, sourceFingerprint, releaseFlags, flagsProvenance, buildInputs = [], staged }) {
  const short = commit => (typeof commit === 'string' ? commit.slice(0, 7) : '<none>')
  const dev = mode === 'dev'
  const engineCommit = dev ? checkoutCommit : indexedCommit
  const anchor = dev
    ? `engine checkout ${short(engineCommit)}`
    : `indexed gitlink ${short(engineCommit)}`
  const notes = []
  // A packaging run whose checkout has moved on is legitimate, but it must not
  // look like it built what the developer is editing.
  if (!dev && checkoutCommit !== indexedCommit) {
    notes.push(`engine submodule checkout ${short(checkoutCommit)} is not the indexed gitlink ${short(indexedCommit)}; this run is about the gitlink, so the checkout's commits are NOT in the result.`)
  }
  const build = reason => ({ action: 'build', engineCommit, treeDirty: dev && treeDirty, reason, notes })
  if (!staged) return build('no staged engine artifacts with a readable manifest')
  if (staged.engineCommit !== engineCommit) {
    return build(`staged engine binary was built from ${short(staged.engineCommit)}, not the ${anchor}`)
  }
  if (!dev && staged.treeDirty) return build('staged engine binary was built from an uncommitted engine tree')
  // A flag change leaves the commit and the hashes intact, so nothing else here
  // can notice it. Without this the path-remapped flags would land in the repo
  // and packaging would keep shipping the binary built before them.
  if (!releaseFlagsMatch({ expectedRaw: releaseFlags, expectedProvenance: flagsProvenance,
    actualRaw: staged.releaseFlags, actualProvenance: staged.flagsProvenance })) {
    return build('staged engine binary was built with a different set of release flags')
  }
  // Compile-time inputs change the binary without touching the commit, the
  // source or the flags, so they are compared on their own.
  if (!engineBuildInputsMatch(buildInputs, staged.buildInputs)) {
    return build('staged engine binary was built with a different set of build-time inputs')
  }
  // A commit alone cannot identify local edits. Development reuse also proves
  // the complete source inventory and retains the build's actual dirty state.
  if (dev && staged.treeDirty !== Boolean(treeDirty)) return build('staged engine source dirty state differs from the checkout')
  if (dev && !sourceFingerprintsMatch(sourceFingerprint, staged.sourceFingerprint)) return build('staged engine source fingerprint is missing, invalid, or different from the checkout')
  if (!staged.contentsMatchManifest) return build('staged engine artifacts do not hash to their manifest')
  return { action: 'reuse', engineCommit, treeDirty: dev && Boolean(treeDirty), message: `staged engine binary matches the ${anchor}${dev ? ' and exact source fingerprint' : ''}`, notes }
}

function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    printHelp()
    return
  }

  const target = parsed.target
  assertHostPlatform(target)
  const indexedCommit = indexedEngineCommit(REPO_ROOT)
  const checkout = engineCheckoutState(REPO_ROOT, parsed.mode === 'dev')
  const encodedRustflags = encodedReleaseRustflags()
  const flagsProvenance = releaseFlagsProvenance(encodedRustflags)
  const plan = planEngineStaging({
    mode: parsed.mode,
    indexedCommit,
    checkoutCommit: checkout.commit,
    treeDirty: checkout.dirty,
    sourceFingerprint: checkout.sourceFingerprint,
    releaseFlags: releaseFlagsDigest(encodedRustflags),
    flagsProvenance,
    buildInputs: engineBuildInputs(),
    staged: readStagedRelease(REPO_ROOT, target),
  })
  for (const note of plan.notes) process.stdout.write(`[rust-release] ${note}\n`)
  if (plan.action === 'reuse') {
    process.stdout.write(`[rust-release] ${plan.message}; reusing without rebuild.\n`)
    return
  }
  if (parsed.verifyOnly) {
    throw new Error(`engine artifacts need a rebuild: ${plan.reason}`)
  }
  process.stdout.write(`[rust-release] rebuilding the engine: ${plan.reason}.\n`)
  // Packaging is the only path that may claim the parent's recorded commit, so
  // it is the only path that has to prove the checkout is that commit, clean.
  if (parsed.mode !== 'dev') assertEngineCheckout(indexedCommit, checkout)
  assertRustToolchain(REPO_ROOT)
  assertTargetInstalled(REPO_ROOT, target)
  const cargoContext = createCargoInvocationContext(join(REPO_ROOT, ENGINE_PATH))
  const targetDirectory = queryCargoTargetDirectory(cargoContext)
  const sourceBinary = cargoReleaseBinaryPath({
    targetDirectory,
    targetTriple: target.targetTriple,
    binaryName: target.binary,
  })
  const sourceArtifacts = new Map((target.artifacts ?? [{ role: 'engine', file: target.binary }]).map(artifact => [
    artifact.role,
    cargoReleaseBinaryPath({
      targetDirectory,
      targetTriple: target.targetTriple,
      // `builtAs` is for the artifacts cargo names differently from the file we ship: the
      // broker addon is built as a `.dll` and loaded as a `.node`.
      binaryName: artifact.builtAs ?? artifact.file,
    }),
  ]))
  process.stdout.write('[rust-release] this is a release build, not debug: ~15s when only leaf crates changed, one to two minutes when core did. cargo output follows, and a long silence is not a hang.\n')
  runCargoBuild(cargoContext, target, encodedRustflags, plan.engineCommit)
  if (parsed.mode === 'dev') assertEngineSourceUnchanged(checkout, engineCheckoutState(REPO_ROOT, true))
  const staged = stageRelease({
    repoRoot: REPO_ROOT,
    target,
    engineCommit: plan.engineCommit,
    treeDirty: plan.treeDirty,
    sourceFingerprint: checkout.sourceFingerprint,
    releaseFlags: releaseFlagsDigest(encodedRustflags),
    flagsProvenance,
    buildInputs: engineBuildInputs(),
    sourceBinary,
    sourceArtifacts,
  })
  assertEmbeddedEngineCommit(staged, plan.engineCommit)
  process.stdout.write(`${JSON.stringify({
    binary: staged.destinationBinary,
    ...staged.manifest,
  }, null, 2)}\n`)
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedUrl === import.meta.url) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[rust-release] ${message}\n`)
    process.exitCode = 1
  }
}
