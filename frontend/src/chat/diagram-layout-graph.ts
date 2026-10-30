import type { ElkNode } from 'elkjs/lib/elk-api.js'

type Kind = 'node' | 'port' | 'label' | 'edge' | 'section'
type RecordValue = Record<string, any>
type Entry = { source: RecordValue; payload: RecordValue; collections: Map<string, Entry[]> }
const common = ['id', 'layoutOptions', 'properties']
const shape = [...common, 'x', 'y', 'width', 'height']
const fields: Record<Kind, string[]> = {
  node: shape,
  port: shape,
  label: [...shape, 'text'],
  edge: [...common, 'sources', 'targets', 'source', 'target', 'sourcePort', 'targetPort', 'sourcePoint', 'targetPoint', 'bendPoints', 'junctionPoints'],
  section: [...common, 'startPoint', 'endPoint', 'bendPoints', 'incomingShape', 'outgoingShape', 'incomingSections', 'outgoingSections'],
}
const collections: Record<Kind, Record<string, Kind>> = {
  node: { children: 'node', ports: 'port', edges: 'edge', labels: 'label' },
  port: { labels: 'label' },
  label: { labels: 'label' },
  edge: { labels: 'label', sections: 'section' },
  section: { labels: 'label' },
}

const pointFields = new Set(['sourcePoint', 'targetPoint', 'startPoint', 'endPoint'])
const pointArrays = new Set(['bendPoints', 'junctionPoints'])
const idArrays = new Set(['sources', 'targets', 'incomingSections', 'outgoingSections'])
const projectPoint = (point: RecordValue) => ({ x: point.x, y: point.y })

function setValue(target: RecordValue, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
}

function mergeValue(source: any, result: any): any {
  if (source && result && typeof source === 'object' && typeof result === 'object' && Array.isArray(source) === Array.isArray(result)) {
    for (const key of Object.keys(result)) setValue(source, key, mergeValue(Object.hasOwn(source, key) ? source[key] : undefined, result[key]))
    if (Array.isArray(source)) source.length = result.length
    return source
  }
  return result
}

/**
 * Only documented layout fields cross the worker boundary. Renderer callbacks,
 * DOM references, and arbitrary application metadata remain attached to their
 * original objects while the returned layout updates those objects in place.
 */
export function projectLayoutGraph(graph: ElkNode) {
  const seen = new WeakMap<object, Entry>()
  const project = (source: RecordValue, kind: Kind): Entry => {
    const known = seen.get(source)
    if (known) return known
    const entry: Entry = { source, payload: {}, collections: new Map() }
    seen.set(source, entry)
    for (const key of fields[kind]) {
      if (!Object.hasOwn(source, key)) continue
      const value = source[key]
      setValue(entry.payload, key,
        pointFields.has(key) && value ? projectPoint(value)
          : pointArrays.has(key) && Array.isArray(value) ? value.map(projectPoint)
            : idArrays.has(key) && Array.isArray(value) ? value.map(id => id) : value)
    }
    for (const [key, childKind] of Object.entries(collections[kind])) {
      if (!Array.isArray(source[key])) continue
      const members = source[key].map((child: RecordValue) => project(child, childKind))
      entry.collections.set(key, members)
      setValue(entry.payload, key, members.map((member: Entry) => member.payload))
    }
    return entry
  }
  const root = project(graph, 'node')
  const merge = (entry: Entry, result: RecordValue): RecordValue => {
    for (const [key, value] of Object.entries(result)) {
      const members = entry.collections.get(key)
      if (members && Array.isArray(value)) {
        const used = new Set<Entry>()
        const byId = new Map<unknown, Entry[]>()
        for (const member of members) {
          if (member.payload.id === undefined) continue
          const bucket = byId.get(member.payload.id) ?? []
          bucket.push(member)
          byId.set(member.payload.id, bucket)
        }
        const merged = value.map((child, index) => {
          const bucket = byId.get(child.id)
          while (bucket?.length && used.has(bucket[0])) bucket.shift()
          const candidate = members[index]
          const anonymousMatch = candidate && !used.has(candidate) && (child.id === undefined || candidate.payload.id === undefined)
          const member = bucket?.shift() ?? (anonymousMatch ? candidate : undefined)
          if (!member) return child
          used.add(member)
          return merge(member, child)
        })
        const original = entry.source[key]
        if (Array.isArray(original)) { original.splice(0, original.length, ...merged); continue }
        setValue(entry.source, key, merged)
      } else {
        setValue(entry.source, key, mergeValue(Object.hasOwn(entry.source, key) ? entry.source[key] : undefined, value))
      }
    }
    return entry.source
  }
  return { graph: root.payload as ElkNode, apply: (result: ElkNode) => merge(root, result) as ElkNode }
}
