import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const POLICY_NOTICE_CATALOG = 'third-party-notices.json'
export const POLICY_NOTICE_DIRECTORY = 'licenses'

const COMPONENTS = [
  { name: 'instruction-policy', source: 'context/prompts' },
  { name: 'goal-policy', source: 'goal/templates' },
  { name: 'planning-policy', source: 'planning/prompts' },
  { name: 'automatic-review-policy', source: 'engine/approval_context/assets' },
  { name: 'sandbox-runtime', engineSource: 'crates/core/src/sandbox/linux', notices: { LICENSE: 'LICENSE-APACHE', NOTICE: 'NOTICE' } },
  { name: 'linux-sandbox-helper', engineSource: 'crates/sandbox-linux-bwrap', notices: { LICENSE: 'vendor/bubblewrap/LICENSE', COPYING: 'vendor/bubblewrap/COPYING', NOTICE: 'NOTICE', 'LICENSE-MIT': 'LICENSE-MIT', 'LICENSE-APACHE': 'LICENSE-APACHE' } },
  { name: 'windows-sandbox-runtime', engineSource: 'crates/sandbox-win', notices: { LICENSE: 'LICENSE-APACHE', NOTICE: 'NOTICE', 'LICENSE-MIT': 'LICENSE-MIT' } },
  { name: 'windows-terminal-runtime', engineSource: 'crates/sandbox-win/src/elevated/pty_native', notices: { LICENSE: 'LICENSE', NOTICE: 'NOTICE' } },
  { name: 'windows-container-sdk', engineSource: 'crates/sandbox-win/src/mxc', notices: { LICENSE: 'LICENSE-MIT' } },
]
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const validCommit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const noticeName = name => ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE', 'COPYING'].includes(name) || /^[a-zA-Z0-9_.-]+\.license$/.test(name)
const requiredNotices = component => component.notices ? Object.keys(component.notices) : ['LICENSE', 'NOTICE']

function requireDirectory(path) {
  if (!lstatSync(path).isDirectory()) throw new Error(`Policy notice path must be a regular directory: ${path}`)
}

function readNotice(path) {
  if (!lstatSync(path).isFile()) throw new Error(`Policy notice must be a regular file: ${path}`)
  const bytes = readFileSync(path)
  if (bytes.length === 0) throw new Error(`Policy notice must not be empty: ${path}`)
  return bytes
}

function sourceNotices(repoRoot) {
  return COMPONENTS.flatMap(component => {
    const directory = join(repoRoot, 'engine/klaus-agent-rust', component.engineSource ?? `crates/core/src/${component.source}`)
    requireDirectory(directory)
    if (component.notices) {
      return Object.entries(component.notices).map(([name, source]) => ({
        path: `${POLICY_NOTICE_DIRECTORY}/${component.name}/${name}`,
        bytes: readNotice(join(directory, source)),
      }))
    }
    const names = readdirSync(directory).filter(noticeName).sort()
    for (const required of requiredNotices(component)) {
      if (!names.includes(required)) throw new Error(`Missing ${component.name} ${required}`)
    }
    return names.map(name => ({
      path: `${POLICY_NOTICE_DIRECTORY}/${component.name}/${name}`,
      bytes: readNotice(join(directory, name)),
    }))
  })
}

/** Preserve attribution independently of the compiled binary's identity fields. */
export function stagePolicyNotices({ repoRoot, destinationDir, engineCommit }) {
  if (!validCommit(engineCommit)) throw new Error('Policy notices require an identified engine commit')
  const notices = sourceNotices(repoRoot)
  const catalog = {
    schemaVersion: 1,
    engineCommit,
    files: notices.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: sha256(bytes) })),
  }
  const contents = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`)
  mkdirSync(destinationDir, { recursive: true })
  const staging = mkdtempSync(join(destinationDir, `${POLICY_NOTICE_DIRECTORY}.staging-`))
  try {
    for (const notice of notices) {
      const destination = join(staging, notice.path.slice(POLICY_NOTICE_DIRECTORY.length + 1))
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, notice.bytes)
    }
    rmSync(join(destinationDir, POLICY_NOTICE_DIRECTORY), { recursive: true, force: true })
    renameSync(staging, join(destinationDir, POLICY_NOTICE_DIRECTORY))
    writeFileSync(join(destinationDir, POLICY_NOTICE_CATALOG), contents)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return { file: POLICY_NOTICE_CATALOG, sha256: sha256(contents) }
}

/** Reject missing attribution, altered bytes and payloads outside the exact catalog. */
export function validatePolicyNotices(directory, manifest) {
  const identity = manifest.policyNotices
  if (!identity || identity.file !== POLICY_NOTICE_CATALOG || !validDigest(identity.sha256)) {
    throw new Error('Engine policy notice identity is missing or invalid')
  }
  const contents = readNotice(join(directory, POLICY_NOTICE_CATALOG))
  if (sha256(contents) !== identity.sha256) throw new Error('Engine policy notice catalog SHA-256 mismatch')
  const catalog = JSON.parse(contents.toString('utf8'))
  if (catalog.schemaVersion !== 1 || !validCommit(catalog.engineCommit) || catalog.engineCommit !== manifest.engineCommit || !Array.isArray(catalog.files)) {
    throw new Error('Engine policy notice catalog identity mismatch')
  }
  const expected = new Map()
  for (const file of catalog.files) {
    if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || file.size <= 0 || !validDigest(file.sha256)) {
      throw new Error('Invalid engine policy notice record')
    }
    const parts = file.path.split('/')
    if (parts.length !== 3 || parts[0] !== POLICY_NOTICE_DIRECTORY || !COMPONENTS.some(component => component.name === parts[1]) || !noticeName(parts[2]) || expected.has(file.path)) {
      throw new Error('Invalid or duplicate engine policy notice path')
    }
    expected.set(file.path, file)
  }
  requireDirectory(join(directory, POLICY_NOTICE_DIRECTORY))
  const componentNames = COMPONENTS.map(component => component.name).sort()
  if (readdirSync(join(directory, POLICY_NOTICE_DIRECTORY)).sort().join(',') !== componentNames.join(',')) throw new Error('Unexpected engine policy notice component')
  let count = 0
  for (const component of COMPONENTS) {
    const root = join(directory, POLICY_NOTICE_DIRECTORY, component.name)
    requireDirectory(root)
    for (const required of requiredNotices(component)) {
      if (!expected.has(`${POLICY_NOTICE_DIRECTORY}/${component.name}/${required}`)) throw new Error(`Missing ${component.name} ${required}`)
    }
    for (const name of readdirSync(root)) {
      const path = `${POLICY_NOTICE_DIRECTORY}/${component.name}/${name}`
      const record = expected.get(path)
      if (!record) throw new Error(`Unexpected engine policy notice file: ${path}`)
      const bytes = readNotice(join(root, name))
      if (bytes.length !== record.size || sha256(bytes) !== record.sha256) throw new Error(`Engine policy notice SHA-256 mismatch: ${path}`)
      count += 1
    }
  }
  if (count !== expected.size) throw new Error('Engine policy notice files are missing')
  return catalog.files
}

export function copyPolicyNotices(sourceDirectory, destinationDirectory, manifest) {
  const records = validatePolicyNotices(sourceDirectory, manifest)
  for (const file of [POLICY_NOTICE_CATALOG, ...records.map(record => record.path)]) {
    const destination = join(destinationDirectory, file)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(sourceDirectory, file), destination)
  }
}

function main(args) {
  if (args[0] === 'stage' && args.length === 4) {
    const [, repoRoot, destinationDir, receipt] = args
    const engineCommit = execFileSync('git', ['-C', join(repoRoot, 'engine/klaus-agent-rust'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const policyNotices = stagePolicyNotices({ repoRoot, destinationDir, engineCommit })
    writeFileSync(receipt, `${JSON.stringify({ engineCommit, policyNotices }, null, 2)}\n`)
    return
  }
  if (args[0] === 'verify' && args.length === 3) {
    const [, directory, receipt] = args
    validatePolicyNotices(directory, JSON.parse(readFileSync(receipt, 'utf8')))
    return
  }
  throw new Error('Usage: policy-notices.mjs stage <repo> <directory> <receipt> | verify <directory> <receipt>')
}

let invokedUrl
try {
  invokedUrl = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined
} catch {
  // An importing test runner may use a non-file command name.
}
if (invokedUrl === import.meta.url) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`[policy-notices] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
