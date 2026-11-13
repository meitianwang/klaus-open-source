import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('retained React islands pause effects and transient portals in an isolated DOM runtime', () => {
  const result = spawnSync(process.execPath, ['test', fileURLToPath(new URL('./retained-island.fixture.tsx', import.meta.url))], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)), encoding: 'utf8', timeout: 15_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`${result.stdout}\n${result.stderr}`)
  expect(result.status).toBe(0)
})
