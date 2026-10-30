import { describe, expect, test } from 'bun:test'
import { projectLayoutGraph } from './diagram-layout-graph'

describe('layout graph worker projection', () => {
  test('retains opaque renderer identities while applying layout in place', () => {
    const callback = () => 42
    const renderer = { callback, native: new WeakMap(), symbol: Symbol('renderer') }
    const child = { id: 'a', width: 40, height: 30, renderer }
    const children = [child]
    const graph = { id: 'root', children, renderer, cycle: {} as any }
    graph.cycle = graph
    const projected = projectLayoutGraph(graph)
    expect(projected.graph).not.toHaveProperty('renderer')
    expect(projected.graph.children![0]).not.toHaveProperty('renderer')
    const result = structuredClone(projected.graph)
    Object.assign(result.children![0], { x: 12, y: 15 })
    expect(child).not.toHaveProperty('x')
    const applied = projected.apply(result)
    expect(applied).toBe(graph)
    expect(applied.children).toBe(children)
    expect(applied.children![0]).toBe(child)
    expect((applied as any).renderer).toBe(renderer)
    expect((applied as any).cycle).toBe(graph)
    expect((applied.children![0] as any).renderer.callback).toBe(callback)
    expect((child as any).x).toBe(12)
  })

  test('matches reordered graph elements by ID without detaching renderer fields', () => {
    const a = { id: 'a', token: {} }, b = { id: 'b', token: {} }
    const graph = { id: 'root', children: [a, b] }
    const projected = projectLayoutGraph(graph)
    projected.apply({ id: 'root', children: [{ id: 'b', x: 30 }, { id: 'a', x: 10 }] })
    expect(graph.children).toEqual([b, a])
    expect(graph.children[0]).toBe(b)
    expect((graph.children[0] as any).x).toBe(30)
  })

  test('new output IDs do not consume metadata from existing graph elements', () => {
    const a = { id: 'a', renderer: {} }, b = { id: 'b', renderer: {} }
    const graph = { id: 'root', children: [a, b] }
    projectLayoutGraph(graph).apply({ id: 'root', children: [{ id: 'new', x: 0 }, { id: 'a', x: 10 }, { id: 'b', x: 20 }] })
    expect(graph.children[0]).not.toBe(a)
    expect(graph.children[0]).not.toBe(b)
    expect(graph.children[1]).toBe(a)
    expect(graph.children[2]).toBe(b)
    expect((graph.children[1] as any).x).toBe(10)
  })

  test('preserves nested ports, labels, options, and generated edge routes', () => {
    const label = { text: 'label', renderer: {} }, port = { id: 'port', labels: [label], renderer: {} }
    const options = { 'elk.algorithm': 'layered' }
    const graph = { id: 'root', layoutOptions: options, children: [{ id: 'a', ports: [port] }], edges: [{ id: 'edge', sources: ['port'], targets: ['a'], renderer: {} }] }
    const projected = projectLayoutGraph(graph)
    const result = structuredClone(projected.graph)
    Object.assign(result.children![0].ports![0], { x: 8, y: 9 })
    result.children![0].ports![0].labels![0].x = 4
    result.edges![0].sections = [{ id: 'section', startPoint: { x: 1, y: 2 }, endPoint: { x: 3, y: 4 } }]
    projected.apply(result)
    expect(graph.layoutOptions).toBe(options)
    expect(graph.children[0].ports[0]).toBe(port)
    expect(port.labels[0]).toBe(label)
    expect((label as any).x).toBe(4)
    expect((graph.edges[0] as any).sections[0].endPoint).toEqual({ x: 3, y: 4 })
  })

  test('projects primitive edges and legacy layout properties', () => {
    const graph = { id: 'root', properties: { algorithm: 'layered' }, edges: [{ id: 'edge', source: 'a', sourcePort: 'p', target: 'b', sourcePoint: { x: 1, y: 2 } }] } as any
    const projected = projectLayoutGraph(graph)
    expect(projected.graph).toEqual(graph)
    const point = graph.edges[0].sourcePoint
    projected.apply({ ...projected.graph, edges: [{ ...projected.graph.edges![0], sourcePoint: { x: 8, y: 9 } }] } as any)
    expect(graph.edges[0].sourcePoint).toBe(point)
    expect(point).toEqual({ x: 8, y: 9 })
  })

  test('projects point coordinates while keeping opaque route metadata in place', () => {
    const renderer = { callback: () => 42, native: new WeakMap() }
    const startPoint = { x: 0, y: 0, renderer }, endPoint = { x: 20, y: 20, renderer }
    const bend = { x: 10, y: 0, renderer }, bends = [bend]
    const section = { id: 'section', startPoint, endPoint, bendPoints: bends }
    const graph = { id: 'root', edges: [{ id: 'edge', sources: ['a'], targets: ['b'], sections: [section], junctionPoints: [{ x: 5, y: 6, renderer }] }] }
    const projected = projectLayoutGraph(graph)
    const result = structuredClone(projected.graph)
    result.edges![0].sections![0].startPoint.x = 8
    result.edges![0].sections![0].bendPoints![0].y = 9
    projected.apply(result)
    expect(section.startPoint).toBe(startPoint)
    expect(section.bendPoints).toBe(bends)
    expect(section.bendPoints[0]).toBe(bend)
    expect(startPoint.renderer).toBe(renderer)
    expect(startPoint.x).toBe(8)
    expect(bend.y).toBe(9)
  })

  test('accepts generated output without changing object prototypes', () => {
    const graph = { id: 'root' }
    const result = JSON.parse('{"id":"root","generated":{"value":3},"__proto__":{"polluted":true}}')
    projectLayoutGraph(graph).apply(result)
    expect(Object.getPrototypeOf(graph)).toBe(Object.prototype)
    expect((graph as any).generated.value).toBe(3)
    expect(Object.hasOwn(graph, '__proto__')).toBe(true)
    expect(({} as any).polluted).toBeUndefined()
  })
})
