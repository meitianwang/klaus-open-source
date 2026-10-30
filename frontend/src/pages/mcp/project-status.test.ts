import { describe, expect, test } from 'bun:test'
import { normalizeProjectMcpData } from './project-status'

describe('project MCP status boundary', () => {
  test('accepts the current bare-array host contract', () => {
    expect(normalizeProjectMcpData([
      { name: 'shared', scope: 'project', status: 'declared', transport: 'stdio' },
      { name: 'private', scope: 'local', enabled: false, transport: 'http' },
    ], '/repo')).toEqual({
      cwd: '/repo',
      isDefaultWorkdir: false,
      servers: [
        { name: 'shared', scope: 'project', status: 'declared', transport: 'stdio' },
        { name: 'private', scope: 'local', enabled: false, transport: 'http' },
      ],
    })
  })

  test('keeps compatibility with the legacy wrapped fixture shape', () => {
    expect(normalizeProjectMcpData({
      cwd: '/legacy',
      isDefaultWorkdir: false,
      servers: [{ name: 'fixture', scope: 'project', tools: [{ name: 'read', description: 'Read data' }] }],
    }, '/ignored')).toEqual({
      cwd: '/legacy',
      isDefaultWorkdir: false,
      servers: [{ name: 'fixture', scope: 'project', tools: [{ name: 'read', description: 'Read data' }] }],
    })
  })

  test('rejects non-list payloads and drops malformed rows', () => {
    expect(normalizeProjectMcpData({ error: 'failed' }, '/repo')).toBeNull()
    expect(normalizeProjectMcpData([null, {}, { name: '', scope: 'project' }, { name: 'ok', scope: 'user' }], '/repo')?.servers)
      .toEqual([{ name: 'ok', scope: 'user' }])
  })
})
