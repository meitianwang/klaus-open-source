// Default content of the post-upgrade guide, and its merge with whatever the
// control plane published.
//
// The shipped copy lives in the i18n dictionary like every other string, so it
// moves with the build and both languages always exist. A control-plane
// payload may replace the pages or individual labels for a locale; the schema
// (contracts/feature-onboarding.ts) accepts a page list only whole, so a
// partial override can never leave two pages assuming a third that did not
// arrive.
//
// Page durations drive each page's artwork timeline only. Turning a page always
// takes user input — the timeline is decoration and progress, never autoplay.

import { t } from '../../i18n'
import {
  GUIDE_SCENES,
  type GuideLabels,
  type GuidePage,
} from '../../../../contracts/feature-onboarding'
import { guideContentFor } from './ledger'

/** Artwork timeline per scene, in page order. Later pages carry denser copy
 *  and get a longer look; the timeline drives illustration and progress only. */
const SCENE_DURATION_MS: Record<(typeof GUIDE_SCENES)[number], number> = {
  overview: 6000,
  collaboration: 9000,
  cocreation: 11000,
  automation: 12000,
}

interface DefaultPageSpec {
  eyebrowKey: string
  titleKeys: [string, string]
  emphasisKey: string
  descriptionKey: string
}

const DEFAULT_PAGES: DefaultPageSpec[] = [
  {
    eyebrowKey: 'onb_g1_eyebrow',
    titleKeys: ['onb_g1_title_1', 'onb_g1_title_2'],
    emphasisKey: 'onb_g1_emphasis',
    descriptionKey: 'onb_g1_desc',
  },
  {
    eyebrowKey: 'onb_g2_eyebrow',
    titleKeys: ['onb_g2_title_1', 'onb_g2_title_2'],
    emphasisKey: 'onb_g2_emphasis',
    descriptionKey: 'onb_g2_desc',
  },
  {
    eyebrowKey: 'onb_g3_eyebrow',
    titleKeys: ['onb_g3_title_1', 'onb_g3_title_2'],
    emphasisKey: 'onb_g3_emphasis',
    descriptionKey: 'onb_g3_desc',
  },
  {
    eyebrowKey: 'onb_g4_eyebrow',
    titleKeys: ['onb_g4_title_1', 'onb_g4_title_2'],
    emphasisKey: 'onb_g4_emphasis',
    descriptionKey: 'onb_g4_desc',
  },
]

const LABEL_KEYS: Record<keyof GuideLabels, string> = {
  next: 'onb_guide_next',
  previous: 'onb_guide_previous',
  skip: 'onb_guide_skip',
  chooseReading: 'onb_guide_choose_reading',
  start: 'onb_guide_start',
  comfortable: 'onb_guide_comfortable',
  efficient: 'onb_guide_efficient',
  comfortableHint: 'onb_guide_comfortable_hint',
  efficientHint: 'onb_guide_efficient_hint',
  startTitle: 'onb_guide_start_title',
  readingDescriptionComfortable: 'onb_guide_reading_desc_comfortable',
  readingDescriptionEfficient: 'onb_guide_reading_desc_efficient',
}

export interface ResolvedGuideContent {
  pages: GuidePage[]
  labels: GuideLabels
}

/** Pages and labels for one locale: the control plane's content where it
 *  published any, the shipped dictionary everywhere else. */
export function resolveGuideContent(locale: 'zh' | 'en'): ResolvedGuideContent {
  const remote = guideContentFor(locale)
  const pages: GuidePage[] = remote?.features ?? DEFAULT_PAGES.map((spec, index) => ({
    scene: GUIDE_SCENES[index],
    eyebrow: t(spec.eyebrowKey),
    title: [t(spec.titleKeys[0]), t(spec.titleKeys[1])],
    emphasis: t(spec.emphasisKey),
    description: t(spec.descriptionKey),
    durationMs: SCENE_DURATION_MS[GUIDE_SCENES[index]],
  }))
  const labels = {} as GuideLabels
  for (const key of Object.keys(LABEL_KEYS) as (keyof GuideLabels)[]) {
    labels[key] = remote?.labels?.[key] ?? t(LABEL_KEYS[key])
  }
  return { pages, labels }
}
