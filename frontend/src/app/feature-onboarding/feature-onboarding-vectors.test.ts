import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vectors from '../../../../contracts/vectors/feature-onboarding-vectors.json'
import {
  FEATURE_ONBOARDING_MIRROR_KEY,
  FEATURE_ONBOARDING_UI_STATE_KEYS,
  FEATURE_SEEN_LEDGER_KEY,
  GUIDE_SEEN_KEY,
  READING_MODE_KEY,
  TOUR_DONE_PREFIX,
  defaultGuideId,
  guideDue,
  isTourDone,
  parseGuideConfig,
  parseGuideSeenMap,
  parseMirror,
  parseReadingMode,
  parseSeenLedger,
  releaseFamily,
  serializeMirror,
  startsTourOnArrival,
  tourDoneId,
  tourMayStart,
  unionLedger,
  withFeatureSeen,
  withGuideSeen,
  type FeatureHintKind,
} from '../../../../contracts/feature-onboarding'
import { FEATURE_REGISTRY } from './registry'
import { declaredSubjects } from './arrival'
import { featureOnboardingEn, featureOnboardingZh } from '../../i18n/feature-onboarding-messages'

const readRepo = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), 'utf8')

const storage = vectors.storage as unknown as {
  ledgerKey: string
  guideSeenKey: string
  readingModeKey: string
  mirrorKey: string
  uiOnlyKeys: string[]
}
const guideVectors = vectors.guide as unknown as {
  defaultId: Array<{ family: string | null; id: string | null }>
  due: Array<{ _why?: string; enable: boolean; guideId: string | null; seen: string[]; shownThisSession: boolean; due: boolean }>
  seenMapParse: Array<{ _why?: string; raw: unknown; parsed: string[] }>
  seenMapAppend: Array<{ _why?: string; map: string[]; id: string; result: string[] }>
  readingMode: Array<{ raw: unknown; parsed: string | null }>
  config: Array<{ _why?: string; payload: unknown; accepted: boolean; enable?: boolean; guideId?: string | null; pageCount?: number }>
}
const tourVectors = vectors.tour as unknown as {
  doneIdPrefix: string
  doneId: { featureId: string; id: string }
  isDone: Array<{ _why?: string; ledger: string[]; featureId: string; done: boolean }>
  mayStart: {
    _base: Record<string, unknown>
    cases: Array<Record<string, unknown> & { start: boolean }>
  }
  startsOnArrival: {
    _base: Record<string, unknown>
    cases: Array<Record<string, unknown> & { start: boolean }>
  }
}
const mirrorVectors = vectors.mirror as unknown as {
  roundTrip: { ledger: string[] }
  parse: Array<{ _why?: string; raw: string | null; parsed: string[] | null }>
}

describe('feature discovery storage contract', () => {
  test('row names match the vectors, so the host exemption cannot drift', () => {
    expect(FEATURE_SEEN_LEDGER_KEY).toBe(storage.ledgerKey)
    expect(GUIDE_SEEN_KEY).toBe(storage.guideSeenKey)
    expect(READING_MODE_KEY).toBe(storage.readingModeKey)
    expect(FEATURE_ONBOARDING_MIRROR_KEY).toBe(storage.mirrorKey)
    expect([...FEATURE_ONBOARDING_UI_STATE_KEYS]).toEqual([...storage.uiOnlyKeys])
  })

  test('the exempt rows stay out of SessionConfiguration staleness', () => {
    // The exemption list lives in the host; asserting the spread keeps a rename
    // here from silently rebuilding live sessions.
    const configuration = readRepo('main/sessions/configuration.ts')
    expect(configuration).toContain('FEATURE_ONBOARDING_UI_STATE_KEYS')
    expect(configuration).toContain('...FEATURE_ONBOARDING_UI_STATE_KEYS,')
  })

  test('the mirror is ledger-only, so the guide decision never guesses on first paint', () => {
    const source = readRepo('frontend/src/app/feature-onboarding/ledger.ts')
    expect(source).toContain('serializeMirror({ ledger: state.ledger })')
    expect(source).not.toContain('guideSeen: mirror')
  })

  test('the seen mark is written on dismissal, never on first paint', () => {
    // The whole announcement survives a launch that fails to render the guide:
    // the mark lands only when the user dismisses or finishes it.
    const source = readRepo('frontend/src/app/feature-onboarding/ledger.ts')
    const dismiss = source.slice(source.indexOf('export function dismissGuide'))
    expect(dismiss).toContain('withGuideSeen')
    const show = source.slice(source.indexOf('export function shouldShowGuide'), source.indexOf('export function dismissGuide'))
    expect(show).not.toContain('kvSet')
  })
})

describe('release family', () => {
  for (const { version, family } of (vectors.releaseFamily as unknown as { cases: Array<{ version: string | null; family: string | null }> }).cases) {
    test(`releaseFamily(${JSON.stringify(version)}) → ${family}`, () => {
      expect(releaseFamily(version)).toBe(family)
    })
  }
})

describe('seen ledger', () => {
  for (const { _why, raw, parsed } of vectors.ledger.parse as unknown as Array<{ _why?: string; raw: unknown; parsed: string[] }>) {
    test(`parse: ${_why ?? JSON.stringify(raw)}`, () => {
      expect(parseSeenLedger(raw)).toEqual(parsed)
    })
  }

  for (const { _why, ledger, id, result } of vectors.ledger.append as unknown as Array<{ _why?: string; ledger: string[]; id: string; result: string[] }>) {
    test(`append: ${_why ?? `${ledger} + ${id}`}`, () => {
      const before = [...ledger]
      expect(withFeatureSeen(ledger, id)).toEqual(result)
      expect(ledger).toEqual(before)
    })
  }

  test('merge-on-write unions rather than overwrites', () => {
    const base = ['a', 'b']
    expect(unionLedger(base, ['b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(base).toEqual(['a', 'b'])
  })
})

describe('guide identity and due-ness', () => {
  for (const { family, id } of guideVectors.defaultId) {
    test(`defaultGuideId(${JSON.stringify(family)}) → ${id}`, () => {
      expect(defaultGuideId(family)).toBe(id)
    })
  }

  for (const { _why, enable, guideId, seen, shownThisSession, due } of guideVectors.due) {
    test(`due: ${_why ?? JSON.stringify({ enable, guideId, seen })}`, () => {
      const map = Object.fromEntries(seen.map(id => [id, true as const]))
      expect(guideDue({ enable, guideId, seen: map, shownThisSession })).toBe(due)
    })
  }

  for (const { _why, raw, parsed } of guideVectors.seenMapParse) {
    test(`seen map parse: ${_why ?? JSON.stringify(raw)}`, () => {
      expect(Object.keys(parseGuideSeenMap(raw)).sort()).toEqual([...parsed].sort())
    })
  }

  for (const { _why, map, id, result } of guideVectors.seenMapAppend) {
    test(`seen map mark: ${_why ?? `${map} + ${id}`}`, () => {
      const before = { ...Object.fromEntries(map.map(key => [key, true as const])) }
      expect(Object.keys(withGuideSeen(before, id)).sort()).toEqual([...result].sort())
      expect(Object.keys(before).sort()).toEqual([...map].sort())
    })
  }

  for (const { raw, parsed } of guideVectors.readingMode) {
    test(`reading mode parse: ${JSON.stringify(raw)} → ${parsed}`, () => {
      expect(parseReadingMode(raw)).toBe(parsed)
    })
  }
})

describe('guide config validation', () => {
  for (const { _why, payload, accepted, enable, guideId, pageCount } of guideVectors.config) {
    test(`config: ${_why ?? JSON.stringify(payload).slice(0, 60)}`, () => {
      const parsed = parseGuideConfig(payload)
      if (!accepted) {
        expect(parsed).toBeNull()
        return
      }
      expect(parsed).not.toBeNull()
      if (enable !== undefined) expect(parsed!.enable).toBe(enable)
      if (guideId !== undefined) expect(parsed!.data?.guideId ?? null).toBe(guideId)
      if (pageCount !== undefined) expect(parsed!.data?.zh?.features?.length ?? 0).toBe(pageCount)
    })
  }
})

describe('tour completion', () => {
  test('prefix and id shape', () => {
    expect(TOUR_DONE_PREFIX).toBe(tourVectors.doneIdPrefix)
    expect(tourDoneId(tourVectors.doneId.featureId)).toBe(tourVectors.doneId.id)
  })

  for (const { _why, ledger, featureId, done } of tourVectors.isDone) {
    test(`isTourDone: ${_why ?? `${ledger} / ${featureId}`}`, () => {
      expect(isTourDone(ledger, featureId)).toBe(done)
    })
  }

  for (const entry of tourVectors.mayStart.cases) {
    const { start, ...input } = entry
    test(`mayStart: ${JSON.stringify(input)}`, () => {
      expect(tourMayStart({ ...tourVectors.mayStart._base, ...input } as never)).toBe(start)
    })
  }

  for (const entry of tourVectors.startsOnArrival.cases) {
    const { start, ...input } = entry
    test(`startsOnArrival: ${JSON.stringify(input)}`, () => {
      expect(startsTourOnArrival({ ...tourVectors.startsOnArrival._base, ...input } as never)).toBe(start)
    })
  }
})

describe('mirror', () => {
  test('round trip', () => {
    expect(parseMirror(serializeMirror(mirrorVectors.roundTrip))).toEqual(mirrorVectors.roundTrip)
  })

  for (const { _why, raw, parsed } of mirrorVectors.parse) {
    test(`parse: ${_why ?? JSON.stringify(raw)}`, () => {
      expect(parseMirror(raw)?.ledger ?? null).toEqual(parsed)
    })
  }
})

const INDEX_HTML = readRepo('frontend/index.html')

/** The guide's shipped copy keys, read from the content module so a key added
 *  there without a dictionary entry fails here rather than rendering raw. */
function guideKeysInUse(): string[] {
  const source = readRepo('frontend/src/app/feature-onboarding/guide-content.ts')
  return [...source.matchAll(/'((?:onb_g\d_|onb_guide_)[a-z0-9_]+)'/g)].map(match => match[1])
}

function tourKeysInUse(): string[] {
  const keys = new Set<string>()
  for (const entry of FEATURE_REGISTRY) {
    for (const step of entry.tour ?? []) {
      keys.add(step.titleKey)
      keys.add(step.bodyKey)
    }
  }
  return [...keys]
}

describe('registry guards', () => {
  test('every guide and walkthrough i18n key exists in both languages', () => {
    const missing: string[] = []
    for (const key of [...guideKeysInUse(), ...tourKeysInUse()]) {
      if (!featureOnboardingEn[key as keyof typeof featureOnboardingEn]) missing.push(`en.${key}`)
      if (!featureOnboardingZh[key as keyof typeof featureOnboardingZh]) missing.push(`zh.${key}`)
    }
    expect(missing).toEqual([])
  })

  test('every key is actually merged into the shipped dictionary', () => {
    // The dictionary spreads the module in; a dropped spread would leave every
    // label rendering as its raw key with no other failure signal.
    const messages = readRepo('frontend/src/i18n/messages.ts')
    expect(messages).toContain('...featureOnboardingEn,')
    expect(messages).toContain('...featureOnboardingZh,')
  })

  test('every walkthrough step anchors a static id from index.html', () => {
    const missing: string[] = []
    for (const entry of FEATURE_REGISTRY) {
      for (const step of entry.tour ?? []) {
        if (!INDEX_HTML.includes(`id="${step.anchor}"`)) missing.push(step.anchor)
      }
    }
    expect(missing).toEqual([])
  })

  test('no walkthrough step anchors the entry its own reveal hides', () => {
    const railIds = ['workspace-panel-toggle', 'monitor-panel-toggle', 'browser-panel-toggle', 'btn-diff', 'terminal-toggle']
    const offenders: string[] = []
    for (const entry of FEATURE_REGISTRY) {
      for (const step of entry.tour ?? []) {
        if (railIds.includes(step.anchor) && step.reveal) offenders.push(`${entry.id} -> ${step.anchor}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('registry ids are unique and release rows carry a family', () => {
    const ids = FEATURE_REGISTRY.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of FEATURE_REGISTRY) {
      if (entry.kind === 'release') {
        expect(releaseFamily(entry.since)).not.toBeNull()
      } else {
        expect(entry.since).toBeNull()
      }
    }
  })

  test('every arrival subject is static markup the observer can subscribe to', () => {
    const { ids, selectors } = declaredSubjects(FEATURE_REGISTRY.map(entry => entry.arrival))
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.filter(id => !INDEX_HTML.includes(`id="${id}"`))).toEqual([])
    expect(selectors.every(selector => /^[.#][\w-]+$/.test(selector))).toBe(true)
    expect(selectors.filter(selector => selector.startsWith('.')).length)
      .toBe(selectors.filter(selector => selector === '.settings-main').length)
  })

  test('registry kinds are the two the ledger understands', () => {
    const kinds = new Set(FEATURE_REGISTRY.map(entry => entry.kind))
    expect([...kinds].sort()).toEqual((['evergreen', 'release'] as FeatureHintKind[]).sort())
  })
})
