// Rust bakes the compiling machine's absolute source paths into every binary it
// produces: each panic site embeds a std::file!() string, so `strings` on a
// shipped artifact prints the build user's home directory and this checkout's
// location (987 hits in the engine binary, 3 in the desktop shell when this was
// measured). --remap-path-prefix rewrites those strings at compile time.
//
// Release drivers can share this prefix set. The engine release driver uses it
// when staging the binary. Every additional native producer must explicitly
// record its own compiler flags and artifact identity; signing cannot rewrite
// source paths that were already compiled into a binary.
//
// Debug builds — the desktop dev launch and every `cargo test` — deliberately
// keep the real paths, so compiler diagnostics and backtraces stay clickable in
// an editor. The engine's staged artifact is a release build even when dev.sh
// stages it, so it carries remapped paths during development too: that is the
// price of one artifact identity instead of flag thrash that recompiles the
// whole engine on every switch between launching and packaging. File and line
// survive; only the absolute prefix is replaced.
//
// This is wired into the release drivers rather than a Cargo profile because
// Cargo's own `trim-paths` profile option is still nightly-only as of 1.93, and
// rustflags in .cargo/config.toml would apply to every build including debug.

import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

// Cargo splits RUSTFLAGS on whitespace, which cannot express a path containing a
// space; CARGO_ENCODED_RUSTFLAGS uses this separator and has no such limit.
export const ENCODED_RUSTFLAGS_SEPARATOR = '\u001f'

export const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export function pathRemapFlags({ env = process.env, home = homedir(), repoRoot = REPO_ROOT } = {}) {
  // Ordered general to specific. The rules overlap — CARGO_HOME and the checkout
  // normally sit under the home directory — and the home catch-all is what makes
  // the build user's name disappear whichever of the overlapping rules rustc
  // ends up applying.
  return [
    [home, '/home'],
    [env.RUSTUP_HOME || join(home, '.rustup'), '/rustup'],
    [env.CARGO_HOME || join(home, '.cargo'), '/cargo'],
    [repoRoot, '/klaus'],
  ].map(([from, to]) => `--remap-path-prefix=${from}=${to}`)
}

export function releaseRustflags({ env = process.env, ...prefixes } = {}) {
  // Setting CARGO_ENCODED_RUSTFLAGS makes Cargo ignore RUSTFLAGS and
  // build.rustflags outright, so whatever the caller already asked for has to be
  // carried over rather than silently dropped.
  const inherited = env.CARGO_ENCODED_RUSTFLAGS
    ? env.CARGO_ENCODED_RUSTFLAGS.split(ENCODED_RUSTFLAGS_SEPARATOR)
    : (env.RUSTFLAGS ?? '').split(/\s+/)
  return [...inherited.filter(Boolean), ...pathRemapFlags({ env, ...prefixes })]
}

export function encodedReleaseRustflags(env = process.env, prefixes = {}) {
  return releaseRustflags({ env, ...prefixes }).join(ENCODED_RUSTFLAGS_SEPARATOR)
}

const sha256 = value => createHash('sha256').update(value).digest('hex')
const REMAP_ROLES = ['home', 'rustup-home', 'cargo-home', 'repo-root']

/**
 * Derive portable provenance from the EXACT string passed to Cargo. Only the
 * four generated suffix rules may vary by physical build-machine location.
 * Extra flags, inherited remaps, order, destinations and compilation options
 * remain byte-for-byte inputs. No physical path is stored in the manifest.
 */
export function releaseFlagsProvenance(encodedRustflags, context = {}) {
  if (typeof encodedRustflags !== 'string') throw new Error('Expected the actual encoded release flags')
  const suffix = pathRemapFlags(context)
  if (suffix.some(flag => {
    const source = flag.slice('--remap-path-prefix='.length, flag.lastIndexOf('='))
    return flag.includes(ENCODED_RUSTFLAGS_SEPARATOR) || flag.includes('\0') || (!posix.isAbsolute(source) && !win32.isAbsolute(source))
  })) throw new Error('Invalid physical release remap prefix')
  const flags = encodedRustflags.split(ENCODED_RUSTFLAGS_SEPARATOR)
  if (flags.length < suffix.length || suffix.some((flag, index) => flags[flags.length - suffix.length + index] !== flag)) {
    throw new Error('Release flags do not end with the exact four generated remap rules in order')
  }
  const normalized = [
    ...flags.slice(0, -suffix.length),
    ...suffix.map((flag, index) => `--remap-path-prefix=<${REMAP_ROLES[index]}>${flag.slice(flag.lastIndexOf('='))}`),
  ]
  return {
    version: 1,
    encodedSha256: sha256(encodedRustflags),
    recipeSha256: sha256(`klaus-release-rustflags-remap-v1\0${normalized.join(ENCODED_RUSTFLAGS_SEPARATOR)}`),
  }
}

export function validReleaseFlagsProvenance(value, rawDigest) {
  return value !== null && typeof value === 'object' && value.version === 1
    && /^[a-f0-9]{64}$/.test(rawDigest ?? '') && value.encodedSha256 === rawDigest
    && /^[a-f0-9]{64}$/.test(value.recipeSha256 ?? '')
    && Object.keys(value).sort().join(',') === 'encodedSha256,recipeSha256,version'
}

export function releaseFlagsMatch({ expectedRaw, expectedProvenance, actualRaw, actualProvenance }) {
  // Old artifacts carry no recipe witness. They keep their original exact-raw
  // comparison until a separate attestation proves their original build flags.
  if (actualProvenance === undefined) return actualRaw === expectedRaw
  return validReleaseFlagsProvenance(actualProvenance, actualRaw)
    && validReleaseFlagsProvenance(expectedProvenance, expectedRaw)
    && actualProvenance.recipeSha256 === expectedProvenance.recipeSha256
}

// Printed form is for the shell driver: `export
// CARGO_ENCODED_RUSTFLAGS="$(node scripts/rust-release-path-remap.mjs)"`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${encodedReleaseRustflags()}\n`)
}
