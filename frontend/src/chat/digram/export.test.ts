import { describe, expect, test } from 'bun:test'
import { exportScaleFromPercent, rasterDimensions, scaleSvgDimensions } from './export'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="10" height="10"/></svg>'

describe('diagram export sizing', () => {
  test('converts percentages within the supported range', () => {
    expect(exportScaleFromPercent(10)).toBe(0.1)
    expect(exportScaleFromPercent(100)).toBe(1)
    expect(exportScaleFromPercent(400)).toBe(4)
  })

  test('rejects percentages outside the supported range', () => {
    expect(() => exportScaleFromPercent(9)).toThrow()
    expect(() => exportScaleFromPercent(401)).toThrow()
    expect(() => exportScaleFromPercent(Number.NaN)).toThrow()
  })

  test('calculates raster dimensions from the intrinsic SVG size', () => {
    expect(rasterDimensions(svg, 1.5)).toEqual({ width: 480, height: 270 })
  })

  test('rejects raster dimensions that exceed the canvas budget', () => {
    const huge = '<svg width="20000" height="20000" viewBox="0 0 20000 20000"></svg>'
    expect(() => rasterDimensions(huge, 1)).toThrow('output is too large')
  })

  test('scales SVG width and height without changing its viewBox or children', () => {
    const scaled = scaleSvgDimensions(svg, 2)
    expect(scaled).toContain('width="640"')
    expect(scaled).toContain('height="360"')
    expect(scaled).toContain('viewBox="0 0 320 180"')
    expect(scaled).toContain('<rect width="10" height="10"/>')
  })

  test('leaves SVG text unchanged at 100%', () => {
    expect(scaleSvgDimensions(svg, 1)).toBe(svg)
  })
})
