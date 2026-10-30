import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('./TranscriptView.tsx', import.meta.url)), 'utf8')

describe('transcript external-store selector contract', () => {
  test('derives collection snapshots after selecting stable store references', () => {
    expect(source).not.toMatch(/useChatStream\(\s*state\s*=>\s*new\s+(?:Set|Map)\b/)
    expect(source).toContain('const liveReviewSignature = useChatStream(state => JSON.stringify(')
    expect(source).toContain('const livePlanReviewIds = useMemo(() => new Set<string>(JSON.parse(liveReviewSignature)), [liveReviewSignature])')
    expect(source).not.toContain('const liveUnitsForPlanReview = useChatStream(')
  })
})
