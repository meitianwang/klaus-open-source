import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vectors from '../../../../contracts/vectors/feature-onboarding-vectors.json'
import {
  FEATURE_BASELINE_KEY,
  FEATURE_ONBOARDING_MIRROR_KEY,
  FEATURE_ONBOARDING_UI_STATE_KEYS,
  FEATURE_SEEN_LEDGER_KEY,
  TOUR_DONE_PREFIX,
  compareReleaseFamilies,
  decideOnboarding,
  isTourDone,
  parseMirror,
  parseSeenLedger,
  releaseFamily,
  serializeMirror,
  startsTourOnArrival,
  tourDoneId,
  tourMayStart,
  unionLedger,
  withFeatureSeen,
  type FeatureHintKind,
} from '../../../../contracts/feature-onboarding'
import { FEATURE_REGISTRY } from './registry'
import { declaredSubjects } from './arrival'
import { featureOnboardingEn, featureOnboardingZh } from '../../i18n/feature-onboarding-messages'

const readRepo = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), 'utf8')

interface AnnouncementCase {
  _why?: string
  baseline: string | null
  currentFamily: string | null
  kind: 'baseline' | 'idle' | 'announce'
  features: string[]
  newBaseline: string | null
  mustNotContain?: string[]
}

const announcement = vectors.announcement as unknown as {
  registry: Array<{ id: string; kind: FeatureHintKind; since: string | null }>
  cases: AnnouncementCase[]
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
    expect(FEATURE_SEEN_LEDGER_KEY).toBe(vectors.storage.ledgerKey)
    expect(FEATURE_BASELINE_KEY).toBe(vectors.storage.baselineKey)
    expect(FEATURE_ONBOARDING_MIRROR_KEY).toBe(vectors.storage.mirrorKey)
    expect([...FEATURE_ONBOARDING_UI_STATE_KEYS]).toEqual([...vectors.storage.uiOnlyKeys])
  })

  test('both rows stay out of SessionConfiguration staleness', () => {
    // The exemption list lives in the host; asserting the literal keeps a rename
    // here from silently rebuilding live sessions.
    const configuration = readRepo('main/sessions/configuration.ts')
    expect(configuration).toContain('FEATURE_ONBOARDING_UI_STATE_KEYS')
    expect(configuration).toContain('...FEATURE_ONBOARDING_UI_STATE_KEYS,')
  })

  test('the mirror is ledger-only, so the announcement window comes from the baseline row', () => {
    const source = readRepo('frontend/src/app/feature-onboarding/ledger.ts')
    expect(source).toContain('serializeMirror({ ledger: state.ledger })')
    expect(source).not.toContain('announced: state.announced })')
  })
})

describe('release family', () => {
  for (const { version, family } of vectors.releaseFamily.cases) {
    test(`releaseFamily(${JSON.stringify(version)}) → ${family}`, () => {
      expect(releaseFamily(version as string | null)).toBe(family)
    })
  }

  for (const { a, b, positive } of vectors.compareReleaseFamilies.cases) {
    test(`compareReleaseFamilies(${a}, ${b}) sign is ${positive}`, () => {
      expect(compareReleaseFamilies(a, b) > 0).toBe(positive)
    })
  }
})

describe('seen ledger', () => {
  for (const { _why, raw, parsed } of vectors.ledger.parse) {
    test(`parse: ${_why ?? JSON.stringify(raw)}`, () => {
      expect(parseSeenLedger(raw)).toEqual(parsed)
    })
  }

  for (const { _why, ledger, id, result } of vectors.ledger.append) {
    test(`append: ${_why ?? `${ledger} + ${id}`}`, () => {
      const before = [...ledger]
      expect(withFeatureSeen(ledger, id)).toEqual(result)
      expect(ledger).toEqual(before)
    })
  }

  // The merge-on-write rule. Without it, two windows acknowledging different
  // features inside one round trip let the later write clobber the earlier one,
  // and an acknowledgement the user already made is lost on the next launch.
  for (const { _why, base, other, result, baseAfter, otherAfter } of vectors.ledger.union) {
    test(`union: ${_why ?? `${base} ∪ ${other}`}`, () => {
      expect(unionLedger(base, other)).toEqual(result)
      // Neither input may be mutated: the caller keeps its own ledger as the
      // rollback target, and a mutated `base` would silently alias live state.
      expect(base).toEqual(baseAfter ?? base)
      expect(other).toEqual(otherAfter ?? other)
    })
  }

  test('union is the durable-write merge rule the renderer actually uses', () => {
    // Pinning the call site is what keeps the contract honest: a write path that
    // stops merging still passes every vector above while shipping the clobber.
    const source = readRepo('frontend/src/app/feature-onboarding/ledger.ts')
    expect(source).toContain('unionLedger(parseSeenLedger(durable), local)')
    expect(source).not.toContain('kvSet(FEATURE_SEEN_LEDGER_KEY, JSON.stringify(ledger))')
  })
})

describe('announcement decision', () => {
  for (const vector of announcement.cases) {
    test(vector._why ?? `baseline ${vector.baseline} → ${vector.currentFamily}`, () => {
      const decision = decideOnboarding({
        baseline: vector.baseline,
        currentFamily: vector.currentFamily,
        registry: announcement.registry,
      })
      expect(decision.kind).toBe(vector.kind)
      expect(decision.features).toEqual(vector.features)
      expect(decision.baseline).toBe(vector.newBaseline)
      for (const excluded of vector.mustNotContain ?? []) {
        expect(decision.features).not.toContain(excluded)
      }
    })
  }
})

describe('tour markers and gates', () => {
  test('the completion marker is namespaced inside the same row', () => {
    expect(TOUR_DONE_PREFIX).toBe(tourVectors.doneIdPrefix)
    expect(tourDoneId(tourVectors.doneId.featureId)).toBe(tourVectors.doneId.id)
  })

  for (const { _why, ledger, featureId, done } of tourVectors.isDone) {
    test(`isTourDone: ${_why ?? `${ledger} / ${featureId}`}`, () => {
      expect(isTourDone(ledger, featureId)).toBe(done)
    })
  }

  for (const vector of tourVectors.mayStart.cases) {
    const input = { ...tourVectors.mayStart._base, ...vector } as never
    test(`mayStart: ${vector._why}`, () => {
      expect(tourMayStart(input)).toBe(vector.start)
    })
  }

  for (const vector of tourVectors.startsOnArrival.cases) {
    const merged = { ...tourVectors.startsOnArrival._base, ...vector }
    // The vector spells "never evaluated" as JSON null; the contract takes
    // undefined, and `previous === false` must not match either of them.
    const input = {
      previous: merged.previous === null ? undefined : merged.previous,
      now: merged.now,
      initialSweep: merged.initialSweep,
    } as never
    test(`startsOnArrival: ${vector._why}`, () => {
      expect(startsTourOnArrival(input)).toBe(vector.start)
    })
  }
})

describe('first-paint mirror', () => {
  test('a written mirror reads back as the same ledger', () => {
    const parsed = parseMirror(serializeMirror(mirrorVectors.roundTrip))
    expect(parsed?.ledger).toEqual(mirrorVectors.roundTrip.ledger)
  })

  for (const { _why, raw, parsed } of mirrorVectors.parse) {
    test(`parse: ${_why ?? JSON.stringify(raw)}`, () => {
      const result = parseMirror(raw)
      if (parsed === null) expect(result).toBeNull()
      else expect(result?.ledger).toEqual(parsed)
    })
  }
})

// --- registry guards ---
//
// The registry is hand-written and ships inside the client, so its two failure
// modes are silent: a key missing from one language renders the raw key, and an
// anchor id that does not exist renders a spotlight over nothing. Both are
// checked here against the real sources.

const INDEX_HTML = readRepo('frontend/index.html')

/** Only the anchors a walkthrough step points at, because a step that cannot be
 *  measured is skipped and the tour silently loses it. */
function tourAnchorsInUse(): string[] {
  const ids = new Set<string>()
  for (const entry of FEATURE_REGISTRY) {
    for (const step of entry.tour ?? []) ids.add(step.anchor)
  }
  return [...ids]
}

function i18nKeysInUse(): string[] {
  const keys = new Set<string>()
  for (const entry of FEATURE_REGISTRY) {
    keys.add(entry.titleKey)
    keys.add(entry.bodyKey)
    for (const step of entry.tour ?? []) {
      keys.add(step.titleKey)
      keys.add(step.bodyKey)
    }
  }
  return [...keys]
}

describe('registry guards', () => {
  test('every i18n key exists in both languages', () => {
    const missing: string[] = []
    for (const key of i18nKeysInUse()) {
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
    // This exists because of a measured failure: a step anchored inside a page's
    // own React island has no size until that island renders, and an unmeasurable
    // step is SKIPPED — so the tour silently loses steps. Anchoring only markup
    // that exists before any island runs makes every step resolvable on the first
    // frames after its reveal. Adding a step on island-built content means giving
    // that content a static anchor first.
    const missing = tourAnchorsInUse().filter(id => !INDEX_HTML.includes(`id="${id}"`))
    expect(missing).toEqual([])
  })

  test('no walkthrough step anchors the entry its own reveal hides', () => {
    // Opening the files panel or a full-page view hides the whole side rail
    // (`body.artifacts-open .side-rail { display: none }` and friends), so a
    // step pointing at a rail button is unmeasurable exactly after its own
    // reveal runs. A tour starts on arrival, which means the user has already
    // clicked that entry, so a step there would explain nothing.
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
    // The observer subscribes to the elements the rules name, resolved once at
    // boot. A subject built later by a page's own React island would resolve to
    // nothing, so that hint would never clear and no test would notice. Every
    // declared subject must therefore exist in the shipped skeleton.
    const { ids, selectors } = declaredSubjects(FEATURE_REGISTRY.map(entry => entry.arrival))
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.filter(id => !INDEX_HTML.includes(`id="${id}"`))).toEqual([])
    // A selector subject has to be locatable too; assert the shape rather than
    // evaluating it, since this test has no DOM.
    expect(selectors.every(selector => /^[.#][\w-]+$/.test(selector))).toBe(true)
    expect(selectors.filter(selector => selector.startsWith('.')).length)
      .toBe(selectors.filter(selector => selector === '.settings-main').length)
  })
})
