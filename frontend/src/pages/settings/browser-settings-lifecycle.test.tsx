import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('browser settings lifecycle runs with an isolated DOM runtime', () => {
  // React DOM caches input-event support at import time. Other suites may have
  // loaded it without a document, so a later window shim cannot repair that cache.
  const result = spawnSync(process.execPath, [
    'test', fileURLToPath(new URL('./browser-settings-lifecycle.fixture.tsx', import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Browser settings lifecycle failed:\n${result.stdout}\n${result.stderr}`)
  expect(result.status).toBe(0)
})
