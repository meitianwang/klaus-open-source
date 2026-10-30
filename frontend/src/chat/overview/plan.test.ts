import { expect, test } from 'bun:test'
import { reconcilePlanSection, revealPlan } from './plan'

test('the progress shortcut reveals a folded plan and keeps it visible through task refreshes', () => {
  const savedGlobals = ['window', 'document', 'localStorage'].map(name =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  )
  const classes = new Set(['collapsed'])
  const attributes = new Map([['aria-expanded', 'false']])
  const tasks = { hidden: false }
  const empty = { hidden: false }
  let panelOpen = false
  let scrolls = 0
  const section = {
    classList: {
      remove: (name: string) => classes.delete(name),
    },
    querySelector: () => ({
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    }),
    scrollIntoView: (options: ScrollIntoViewOptions) => {
      expect(panelOpen).toBe(true)
      expect(classes.has('collapsed')).toBe(false)
      expect(options.block).toBe('nearest')
      scrolls += 1
    },
  }
  try {
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: { klausOpenMonitorPanel: () => { panelOpen = true } } },
      document: {
        configurable: true,
        value: {
          getElementById: (id: string) => {
            if (!panelOpen) return null
            if (id === 'monitor-section-plan') return section
            if (id === 'monitor-plan-group-tasks') return tasks
            if (id === 'monitor-plan-empty') return empty
            return null
          },
        },
      },
      localStorage: {
        configurable: true,
        value: {
          getItem: (key: string) => key === 'klaus_monitor_sections_collapsed'
            ? '["monitor-section-plan"]'
            : '[]',
        },
      },
    })

    revealPlan()
    reconcilePlanSection()
    expect(classes.has('collapsed')).toBe(false)
    expect(attributes.get('aria-expanded')).toBe('true')
    expect(tasks.hidden).toBe(false)
    expect(empty.hidden).toBe(true)

    // Clicking an already visible plan must reveal it again, never toggle it shut.
    revealPlan()
    expect(classes.has('collapsed')).toBe(false)
    expect(scrolls).toBe(2)
  } finally {
    for (const [name, descriptor] of savedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
