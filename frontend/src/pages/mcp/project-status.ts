export interface ProjectMcpServer {
  name: string
  scope: string
  status?: string
  transport?: string
  enabled?: boolean
  tools?: Array<{ name: string; description?: string }>
}

export interface ProjectMcpData {
  cwd?: string
  isDefaultWorkdir?: boolean
  servers: ProjectMcpServer[]
}

const record = (value: unknown): Record<string, unknown> | null => (
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
)

/**
 * The current host returns the project declaration list as a bare array. Older
 * renderer fixtures wrapped the same list in `{ servers }`, which hid the
 * contract mismatch during the Electron migration. Accept both shapes at the
 * renderer boundary and expose one stable UI model.
 */
export function normalizeProjectMcpData(value: unknown, requestedCwd = ''): ProjectMcpData | null {
  const container = record(value)
  const source = Array.isArray(value)
    ? value
    : Array.isArray(container?.servers)
      ? container.servers
      : null
  if (!source) return null

  const servers = source.flatMap(item => {
    const row = record(item)
    if (!row || typeof row.name !== 'string' || !row.name.trim() || typeof row.scope !== 'string') return []
    const server: ProjectMcpServer = { name: row.name, scope: row.scope }
    if (typeof row.status === 'string') server.status = row.status
    if (typeof row.transport === 'string') server.transport = row.transport
    if (typeof row.enabled === 'boolean') server.enabled = row.enabled
    if (Array.isArray(row.tools)) {
      server.tools = row.tools.flatMap(tool => {
        const value = record(tool)
        if (!value || typeof value.name !== 'string' || !value.name.trim()) return []
        return [{ name: value.name, ...(typeof value.description === 'string' ? { description: value.description } : {}) }]
      })
    }
    return [server]
  })

  const cwd = typeof container?.cwd === 'string' ? container.cwd : requestedCwd
  const isDefaultWorkdir = typeof container?.isDefaultWorkdir === 'boolean'
    ? container.isDefaultWorkdir
    : !cwd
  return { cwd, isDefaultWorkdir, servers }
}
