import { describe, expect, test } from 'bun:test'
import {
  ENCODED_RUSTFLAGS_SEPARATOR,
  encodedReleaseRustflags,
  pathRemapFlags,
  releaseRustflags,
} from './rust-release-path-remap.mjs'

const fixture = {
  home: '/Users/builder',
  repoRoot: '/Users/builder/workspace/klaus',
}

describe('release path remapping', () => {
  test('rewrites the home, toolchain, registry and checkout prefixes', () => {
    expect(pathRemapFlags({ env: {}, ...fixture })).toEqual([
      '--remap-path-prefix=/Users/builder=/home',
      '--remap-path-prefix=/Users/builder/.rustup=/rustup',
      '--remap-path-prefix=/Users/builder/.cargo=/cargo',
      '--remap-path-prefix=/Users/builder/workspace/klaus=/klaus',
    ])
  })

  test('follows a relocated CARGO_HOME and RUSTUP_HOME', () => {
    const env = { CARGO_HOME: '/Volumes/Build/cargo', RUSTUP_HOME: '/Volumes/Build/rustup' }
    expect(pathRemapFlags({ env, ...fixture })).toContain('--remap-path-prefix=/Volumes/Build/cargo=/cargo')
    expect(pathRemapFlags({ env, ...fixture })).toContain('--remap-path-prefix=/Volumes/Build/rustup=/rustup')
  })

  // CARGO_ENCODED_RUSTFLAGS makes Cargo ignore RUSTFLAGS, so dropping what the
  // caller set would silently change how the shipped artifact is compiled. The
  // whitespace split matches how Cargo itself reads RUSTFLAGS.
  test('carries over flags the caller already set', () => {
    const flags = releaseRustflags({ env: { RUSTFLAGS: '-C target-cpu=apple-m1  -C lto' }, ...fixture })
    expect(flags.slice(0, 4)).toEqual(['-C', 'target-cpu=apple-m1', '-C', 'lto'])
  })

  test('prefers an already encoded flag list over RUSTFLAGS, as Cargo does', () => {
    const env = {
      RUSTFLAGS: '-C ignored',
      CARGO_ENCODED_RUSTFLAGS: ['-C', 'target-cpu=apple-m1'].join(ENCODED_RUSTFLAGS_SEPARATOR),
    }
    expect(releaseRustflags({ env, ...fixture }).slice(0, 2)).toEqual(['-C', 'target-cpu=apple-m1'])
  })

  test('encodes the flag list the way Cargo reads it back', () => {
    const encoded = encodedReleaseRustflags({}, fixture)
    expect(encoded.split(ENCODED_RUSTFLAGS_SEPARATOR)).toEqual(pathRemapFlags({ env: {}, ...fixture }))
  })
})
