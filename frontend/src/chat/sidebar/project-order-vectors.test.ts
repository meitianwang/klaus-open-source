// Contract vectors for the dragged Projects-section order.
//
// The pure order math lives in ./project-order; this file pins it against the
// committed vectors so a refactor cannot silently change what a drop means. The
// gesture itself (threshold, indicator geometry, overlay portal, keyboard path)
// is measured end to end by the DOM harness, and the storage/wiring rules are
// asserted against the sources they name, following the collapse-vectors pattern.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vectors from '../../../../contracts/vectors/sidebar-project-order-vectors.json'
import { SIDEBAR_PROJECT_ORDER_CHANGED_KEY, SIDEBAR_UI_STATE_KEYS } from '../../../../contracts/sidebar-collapse'
import {
  arrayMove,
  dropPlacement,
  dropTargetFrom,
  moveBefore,
  parseStoredOrder,
  reconcileOrder,
  sameKeys,
  type DropPlacement,
} from './project-order'

const readRepo = (relative: string) => readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), 'utf8')

interface PlacementVector {
  activeRect: { top: number; bottom: number }
  pointerY: number | null
  targetRect: { top: number; bottom: number }
  placement: DropPlacement
}
interface DropTargetVector {
  keys: string[]
  active: string
  over: string
  placement: DropPlacement
  result: { beforeKey: string | null } | null
}
interface MoveVector {
  keys: string[]
  active: string
  beforeKey: string | null
  result: string[]
}
interface ReconcileVector {
  stored: string[]
  current: string[]
  result: string[]
}

const placementVectors = vectors.placement as unknown as Record<string, PlacementVector | string>
const dropTargetVectors = vectors.dropTarget as unknown as Record<string, DropTargetVector | string>
const moveVectors = vectors.moveBefore as unknown as Record<string, MoveVector | string>
const reconcileVectors = vectors.reconcile as unknown as Record<string, ReconcileVector | { raw: unknown; parsed: string[] } | string>

describe('sidebar project order contract vectors', () => {
  test('storage keys match the shared contract and stay out of the session-stale exemption', () => {
    const storage = vectors.storage
    expect(SIDEBAR_PROJECT_ORDER_CHANGED_KEY).toBe(storage.broadcastKey)
    // The order is NOT a settings:kv row (it lives in the workspace store so the
    // host can reconcile it against the project registry in one transaction), so
    // it must not be listed among the KV keys exempted from staleness.
    expect(SIDEBAR_UI_STATE_KEYS).not.toContain(SIDEBAR_PROJECT_ORDER_CHANGED_KEY)

    const workspaces = readRepo('main/services/workspaces.ts')
    expect(workspaces).toContain(`'${storage.hostOrderKey}'`)
    expect(workspaces).toContain(`'${storage.registryOrderKey}'`)
    expect(readRepo('frontend/src/chat/chat.ts')).toContain(`= '${storage.mirrorKey}'`)

    // The WebKit→Electron migration writes KV→localStorage; this mirror flows the
    // other way, so staging it would resurrect a stale arrangement.
    const legacyContract = readRepo('contracts/legacy-ui-state.ts')
    for (const key of storage.legacyMigrationWhitelistMustNotContain) {
      expect(legacyContract).not.toContain(`'${key}'`)
    }
  })

  test('the pointer half of the hovered row decides before/after, with the dragged centre as fallback', () => {
    for (const [name, vector] of Object.entries(placementVectors)) {
      if (typeof vector === 'string') continue
      expect({ name, got: dropPlacement(vector.activeRect, vector.pointerY, vector.targetRect) })
        .toEqual({ name, got: vector.placement })
    }
  })

  test('a drop that changes nothing resolves to null, so the gesture commits nothing', () => {
    for (const [name, vector] of Object.entries(dropTargetVectors)) {
      if (typeof vector === 'string') continue
      expect({ name, got: dropTargetFrom(vector.keys, vector.active, vector.over, vector.placement) })
        .toEqual({ name, got: vector.result })
    }
  })

  test('a drop is applied by lifting the dragged key out first', () => {
    for (const [name, vector] of Object.entries(moveVectors)) {
      if (typeof vector === 'string') continue
      expect({ name, got: moveBefore(vector.keys, vector.active, vector.beforeKey) })
        .toEqual({ name, got: vector.result })
    }
  })

  test('a drop that reproduces the current order reads as equal, so it commits nothing', () => {
    // sameKeys is the equality check dropTargetFrom uses to turn "the drag lands
    // where the row already is" into a null target. Order matters; membership
    // alone is not enough, or a genuine reorder would read as a no-op.
    expect(sameKeys(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameKeys(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameKeys(['a', 'b'], ['a', 'b', 'c'])).toBe(false)
    expect(sameKeys([], [])).toBe(true)
    // And the move it guards: dropping 'a' before 'b' in [a,b,c] reproduces the
    // same order, which is exactly the neighbour no-op dropTargetFrom rejects.
    expect(sameKeys(['a', 'b', 'c'], moveBefore(['a', 'b', 'c'], 'a', 'b'))).toBe(true)
  })

  test('a stored order reconciles against the rows that exist now', () => {
    for (const [name, vector] of Object.entries(reconcileVectors)) {
      if (typeof vector === 'string') continue
      if ('stored' in vector) {
        const got = reconcileOrder(vector.stored, vector.current)
        expect({ name, got }).toEqual({ name, got: vector.result })
        // The result always covers exactly the current keys, once each: the
        // caller indexes rows by it with no fallback path.
        expect(got.slice().sort()).toEqual(vector.current.slice().sort())
      } else {
        expect({ name, got: parseStoredOrder(vector.raw) }).toEqual({ name, got: vector.parsed })
      }
    }
  })

  test('the commit path paints first, chains writes and guards its rollback', () => {
    const commit = vectors.commit
    const chat = readRepo('frontend/src/chat/chat.ts')
    // Paint before write: the live order and a re-render happen synchronously,
    // ahead of the reorder call.
    const body = chat.slice(chat.indexOf('function commitSidebarProjectOrder'), chat.indexOf('/** Adopt an order pushed from another window'))
    expect(body.indexOf('renderSessionList()')).toBeLessThan(body.indexOf('klausApi.projects?.reorder?.('))
    expect(body).toContain(commit.writesAreChained.slice(0, 'sidebarProjectOrderWrite = sidebarProjectOrderWrite.then'.length))
    expect(body).toContain('mayApplyAsyncState')
    expect(body).toContain('project_reorder_failed')
  })

  test('the host writes both order rows in one transaction and only registered roots reach the registry order', () => {
    const host = vectors.host
    const workspaces = readRepo('main/services/workspaces.ts')
    const reorder = workspaces.slice(workspaces.indexOf('projectsReorder(payload'), workspaces.indexOf('projectsRemove(payload'))
    expect(reorder).toContain('withSettingsTransaction')
    expect(reorder).toContain('saved.roots.includes(path)')
    expect(reorder).toContain('writeProjectState')
    expect(reorder).toContain("'workspace.sidebar_project_order'")
    // An order rejected for having no usable keys is an envelope, not a throw.
    expect(reorder).toContain(`return { error: 'invalid keys' }`)
    // Removal paths drop the key so a deleted row cannot keep a reserved slot.
    expect(workspaces).toContain("sidebarProjectOrder(db).filter(key => key !== path)")
    expect(workspaces).toContain('!removed.has(key)')
    // The list echoes the stored order so a hydrate needs no second read.
    expect(workspaces.slice(workspaces.indexOf('projectsList()'), workspaces.indexOf('projectsAdd(payload')))
      .toContain('sidebarOrder')
    expect(host.oneTransaction.length).toBeGreaterThan(0)
  })

  test('alt+arrow moves one slot and stops at both ends', () => {
    const keys = ['a', 'b', 'c']
    expect(arrayMove(keys, 0, 1)).toEqual(['b', 'a', 'c'])
    expect(arrayMove(keys, 2, 0)).toEqual(['c', 'a', 'b'])
    expect(arrayMove(keys, 1, 1)).toEqual(keys)
    // The gesture layer clamps before calling: an out-of-range target is a no-op
    // rather than a wrap-around, so the first and last rows cannot be jumped past.
    expect(arrayMove(keys, 0, -1)).toEqual(['b', 'c', 'a'])
  })

  test('the gesture contract is wired the way the vectors say', () => {
    const gesture = vectors.gesture
    const reorderSource = readRepo('frontend/src/chat/sidebar/project-reorder.tsx')
    const listSource = readRepo('frontend/src/chat/sidebar/session-list.tsx')

    expect(reorderSource).toContain(`export const PROJECT_REORDER_DISTANCE_PX = ${gesture.activationDistancePx}`)
    expect(reorderSource).toContain(`activationConstraint: { distance: PROJECT_REORDER_DISTANCE_PX }`)
    // Listeners on the row, not the group block.
    expect(reorderSource).toContain('onPointerDown: reorderable')
    expect(listSource).toContain('onPointerDown={drag.row.onPointerDown}')
    expect(reorderSource).toContain('inert: true')
    // Keyboard path keeps Enter/Space for the existing fold gesture.
    expect(reorderSource).toContain("event.altKey")
    expect(reorderSource).toContain("event.key !== 'ArrowUp' && event.key !== 'ArrowDown'")
    expect(listSource).toContain('drag.onReorderKeyDown(e)')
    // Vertical only, overlay portalled, and auto-scroll restricted to real
    // scroll containers: an overflow-hidden shell must never be a scroll target,
    // or the gesture can shift the whole interface (see the vector's
    // autoScrollOnlyRealScrollContainers / shellScrollResetOnGestureEnd).
    expect(reorderSource).toContain('restrictToVerticalAxis')
    expect(reorderSource).toContain('createPortal')
    expect(reorderSource).toContain('canScroll: (element) =>')
    expect(reorderSource).toContain("getComputedStyle(element).overflowY")
    expect(reorderSource).toContain("overflow !== 'auto' && overflow !== 'scroll'")
    expect(reorderSource).toContain('function resetShellScroll()')
    expect(reorderSource).toContain('resetShellScroll()')
    // Below two rows there is nothing to reorder against.
    expect(listSource).toContain('reorderable={snapshot.projects.rows.length > 1}')

    const css = readRepo('frontend/src/chat/sidebar/sidebar.module.css')
    // Zero-height indicator so painting it cannot shift a row.
    expect(css).toMatch(/\.project-reorder-indicator \{[^}]*height: 0;[^}]*margin-bottom: -1px;/)
    expect(css).toMatch(/\.project-reorder-group\.is-dragging \{[^}]*opacity: 0\.2;/)
    expect(css).toMatch(/\.project-reorder-live \{[^}]*clip: rect\(0, 0, 0, 0\);/)
  })
})
