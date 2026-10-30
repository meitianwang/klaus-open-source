// Build-time inputs the engine compiles in with `option_env!`.
//
// Some integrations need an application credential that a source distribution
// must not carry (an installed-app OAuth client, for instance). The engine reads
// them at compile time and refuses the feature explicitly when they are absent.
// Cargo already rebuilds when such a variable changes, but the staging script can
// skip Cargo entirely when a staged binary looks current, so the set of inputs a
// binary was built with is recorded beside it and compared before reuse.
//
// Values never leave the build environment: the record holds each present
// variable's name and a domain-separated SHA-256 of its value.

import { createHash } from 'node:crypto'

export const ENGINE_BUILD_INPUTS = Object.freeze([
  'KLAUS_ANTIGRAVITY_OAUTH_CLIENT_ID',
  'KLAUS_ANTIGRAVITY_OAUTH_CLIENT_SECRET',
])

const DOMAIN = 'klaus-engine-build-input-v1'

function digest(name, value) {
  return createHash('sha256').update(`${DOMAIN}\0${name}\0${value}`).digest('hex')
}

/** The record for a build environment: present, non-empty inputs only, sorted by name. */
export function engineBuildInputs(env = process.env) {
  return ENGINE_BUILD_INPUTS
    .filter(name => typeof env[name] === 'string' && env[name].trim() !== '')
    .sort()
    .map(name => ({ name, sha256: digest(name, env[name]) }))
}

export function validEngineBuildInputs(value) {
  if (!Array.isArray(value)) return false
  let previous = ''
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'name,sha256') return false
    if (!ENGINE_BUILD_INPUTS.includes(entry.name) || entry.name <= previous || !/^[a-f0-9]{64}$/.test(entry.sha256)) return false
    previous = entry.name
  }
  return true
}

/** A staged binary without a record predates this check and is treated as built with none. */
export function engineBuildInputsMatch(expected, staged) {
  const actual = staged === undefined ? [] : staged
  if (!validEngineBuildInputs(expected) || !validEngineBuildInputs(actual)) return false
  return JSON.stringify(expected) === JSON.stringify(actual)
}
