import { describe, expect, test } from 'bun:test'
import { computeUserSubmenuPosition, parseNativeOverlayInsetRight } from './user-submenu-layout'

const baseAnchor = { left: 37, right: 227, top: 700, bottom: 730 }
const baseMenu = { left: 32, right: 232, top: 660, bottom: 840 }

describe('computeUserSubmenuPosition', () => {
  test('opens to the right of the trigger when no native panel is open', () => {
    const result = computeUserSubmenuPosition({
      anchorRect: baseAnchor,
      menuRect: baseMenu,
      submenuSize: { width: 184, height: 460 },
      viewport: { width: 1440, height: 900 },
      nativeInsetRight: 0,
    })
    expect(result).toEqual({
      left: 235,
      top: 432,
      maxHeight: null,
      placement: 'right',
      suspendNative: false,
    })
  })

  test('opens to the right when a split-view native panel leaves room for the submenu', () => {
    const result = computeUserSubmenuPosition({
      anchorRect: baseAnchor,
      menuRect: baseMenu,
      submenuSize: { width: 184, height: 460 },
      viewport: { width: 1440, height: 900 },
      nativeInsetRight: 780, // uncovered region is [0, 660]
    })
    expect(result.placement).toBe('right')
    expect(result.left).toBe(235)
    expect(result.left + 184).toBeLessThanOrEqual(660 - 8)
    expect(result.suspendNative).toBe(false)
  })

  test('stacks above the user menu inside the sidebar when a native panel is maximized', () => {
    // Sidebar 240px, maximized Design Canvas covers [240, 1440] => insetRight = 1200.
    const result = computeUserSubmenuPosition({
      anchorRect: baseAnchor,
      menuRect: baseMenu,
      submenuSize: { width: 184, height: 460 },
      viewport: { width: 1440, height: 900 },
      nativeInsetRight: 1200,
    })
    expect(result.placement).toBe('above')
    expect(result.suspendNative).toBe(false)
    expect(result.left).toBe(32)
    expect(result.left + 184).toBeLessThanOrEqual(240 - 8)
    expect(result.top).toBe(192)
    expect(result.top + 460).toBe(baseMenu.top - 8)
    expect(result.maxHeight).toBeNull()
  })

  test('clamps left and keeps the wider font submenu inside a minimum-width sidebar', () => {
    const result = computeUserSubmenuPosition({
      anchorRect: baseAnchor,
      menuRect: baseMenu,
      submenuSize: { width: 208, height: 84 },
      viewport: { width: 1440, height: 900 },
      nativeInsetRight: 1200, // uncoveredRight = 240
    })
    expect(result.placement).toBe('above')
    expect(result.suspendNative).toBe(false)
    expect(result.left).toBe(24)
    expect(result.left + 208).toBe(232)
    expect(result.top).toBe(568)
    expect(result.maxHeight).toBeNull()
  })

  test('caps maxHeight when stacking a tall theme submenu in a shorter window', () => {
    const shortMenu = { left: 32, right: 232, top: 380, bottom: 560 }
    const result = computeUserSubmenuPosition({
      anchorRect: { left: 37, right: 227, top: 420, bottom: 450 },
      menuRect: shortMenu,
      submenuSize: { width: 184, height: 460 },
      viewport: { width: 1440, height: 620 },
      nativeInsetRight: 1200,
    })
    expect(result.placement).toBe('above')
    expect(result.suspendNative).toBe(false)
    expect(result.top).toBe(8)
    expect(result.maxHeight).toBe(364)
    expect(result.top + (result.maxHeight ?? 0)).toBe(shortMenu.top - 8)
  })

  test('avoids partial slicing when a non-maximized wide native panel overlaps right placement', () => {
    const result = computeUserSubmenuPosition({
      anchorRect: baseAnchor,
      menuRect: baseMenu,
      submenuSize: { width: 184, height: 460 },
      viewport: { width: 1440, height: 900 },
      nativeInsetRight: 1080, // uncoveredRight = 360; right placement would reach 419
    })
    expect(result.placement).toBe('above')
    expect(result.suspendNative).toBe(false)
    expect(result.left + 184).toBeLessThanOrEqual(360 - 8)
  })

  test('falls back to suspending native views when the uncovered area cannot fit the submenu', () => {
    const result = computeUserSubmenuPosition({
      anchorRect: { left: 37, right: 227, top: 120, bottom: 150 },
      menuRect: { left: 32, right: 232, top: 90, bottom: 270 },
      submenuSize: { width: 184, height: 460 },
      viewport: { width: 1440, height: 320 },
      nativeInsetRight: 1200,
    })
    expect(result.placement).toBe('right-suspended')
    expect(result.suspendNative).toBe(true)
    expect(result.left).toBe(235)
    expect(result.top).toBe(8)
  })
})

describe('parseNativeOverlayInsetRight', () => {
  test('parses pixel lengths and ignores empty or non-positive values', () => {
    expect(parseNativeOverlayInsetRight('1200px')).toBe(1200)
    expect(parseNativeOverlayInsetRight(' 740.5px ')).toBe(740.5)
    expect(parseNativeOverlayInsetRight('0px')).toBe(0)
    expect(parseNativeOverlayInsetRight('-20px')).toBe(0)
    expect(parseNativeOverlayInsetRight('')).toBe(0)
    expect(parseNativeOverlayInsetRight(null)).toBe(0)
  })
})
