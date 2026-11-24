import { describe, expect, test } from 'bun:test'
import { aggregateModelUsage, buildStackedTimeline, normalizeModelIdentity } from './model-usage'
import type { ProfileActivity } from '../../../../contracts/profile'

describe('normalizeModelIdentity', () => {
  test('collapses provider prefixes, effort suffixes, runtime brackets and snapshot dates into clean model families', () => {
    expect(normalizeModelIdentity('subscription:opus')).toMatchObject({
      key: 'claude-opus',
      label: 'Claude Opus',
      brand: 'claude',
      source: 'subscription',
    })
    expect(normalizeModelIdentity('claude-opus-5-5-high', 'antigravity')).toMatchObject({
      key: 'claude-opus-5.5',
      label: 'Claude Opus 5.5',
      brand: 'claude',
      source: 'antigravity',
    })
    expect(normalizeModelIdentity('aicodemirror-opus-5-5', 'custom')).toMatchObject({
      key: 'claude-opus-5.5',
      label: 'Claude Opus 5.5',
      brand: 'claude',
      source: 'custom',
    })
    expect(normalizeModelIdentity('antigravity:gemini-4-carbon-high')).toMatchObject({
      key: 'gemini-4-carbon',
      label: 'Gemini 4 Carbon',
      brand: 'gemini',
      source: 'antigravity',
    })
    expect(normalizeModelIdentity('codex:gpt-6.1-sol')).toMatchObject({
      key: 'gpt-6.1-sol',
      label: 'GPT-6.1 Sol',
      brand: 'openai',
      source: 'codex',
    })
    expect(normalizeModelIdentity('qwen3.8-max', 'custom')).toMatchObject({
      key: 'qwen-3.8-max',
      label: 'Qwen 3.8 Max',
      brand: 'qwen',
      source: 'custom',
    })
    expect(normalizeModelIdentity('bailian:deepseek-v4.1-flash-1017')).toMatchObject({
      key: 'deepseek-v4.1-flash',
      label: 'DeepSeek V4.1 Flash',
      brand: 'deepseek',
      source: 'bailian',
    })
    expect(normalizeModelIdentity('k3.1-pro', 'kimi')).toMatchObject({
      key: 'kimi-k3.1-pro',
      label: 'Kimi K3.1 Pro',
      brand: 'kimi',
      source: 'kimi',
    })
    expect(normalizeModelIdentity('trae:kimi-k3.1-pro')).toMatchObject({
      key: 'kimi-k3.1-pro',
      label: 'Kimi K3.1 Pro',
      brand: 'kimi',
      source: 'trae',
    })
    expect(normalizeModelIdentity('cursor:grok-4.7[context=500k,fast=true,reasoning_effort=high]@max')).toMatchObject({
      key: 'grok-4.7',
      label: 'Grok 4.7',
      brand: 'xai',
      source: 'cursor',
    })
    expect(normalizeModelIdentity('custom:f51ffcb9-fca4-4b5f-a978-943fa0c5a72f')).toMatchObject({
      key: 'custom-model',
      isCustomPlaceholder: true,
      source: 'custom',
    })
  })
})

describe('aggregateModelUsage and buildStackedTimeline', () => {
  const now = new Date('2026-10-18T12:00:00Z')
  const fixture: ProfileActivity = {
    days: [
      { date: '2026-09-01', tokens: 100 },
      { date: '2026-10-15', tokens: 500 },
      { date: '2026-10-18', tokens: 900 },
    ],
    models: [
      {
        model: 'claude-opus-5-5',
        source: 'subscription',
        tokens: 800,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 600,
        cacheWriteTokens: 50,
        requests: 4,
        days: [
          { date: '2026-09-01', tokens: 100 },
          { date: '2026-10-18', tokens: 700 },
        ],
      },
      {
        model: 'claude-opus-5-5-high',
        source: 'antigravity',
        tokens: 300,
        inputTokens: 60,
        outputTokens: 40,
        cacheReadTokens: 200,
        cacheWriteTokens: 0,
        requests: 2,
        days: [{ date: '2026-10-15', tokens: 300 }],
      },
      {
        model: 'claude-sonnet-5-5',
        source: 'subscription',
        tokens: 200,
        inputTokens: 50,
        outputTokens: 30,
        cacheReadTokens: 120,
        cacheWriteTokens: 0,
        requests: 3,
        days: [{ date: '2026-10-15', tokens: 200 }],
      },
      {
        model: 'gpt-6.1-sol',
        source: 'codex',
        tokens: 200,
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        requests: 1,
        days: [{ date: '2026-10-18', tokens: 200 }],
      },
    ],
    totalTokens: 1500,
    peakDailyTokens: 900,
    longestTaskMs: 12_000,
    longestStreakDays: 1,
    currentStreakDays: 1,
  }

  test('merges cross-source variants of the same model family and assigns distinct colors within a brand', () => {
    const all = aggregateModelUsage(fixture, now, { window: 'all', groupBy: 'model' })
    expect(all.totalTokens).toBe(1500)
    expect(all.rows.map(row => [row.key, row.tokens, row.sources])).toEqual([
      ['claude-opus-5.5', 1100, ['subscription', 'antigravity']],
      ['claude-sonnet-5.5', 200, ['subscription']],
      ['gpt-6.1-sol', 200, ['codex']],
    ])
    expect(all.rows[0].color).not.toBe(all.rows[1].color)
    expect(all.composition.totalRequests).toBe(10)
    expect(all.composition.cacheReadTokens).toBe(1020)
  })

  test('slices exact daily windows and supports grouping by provider source', () => {
    const recent7d = aggregateModelUsage(fixture, now, { window: '7d', groupBy: 'model' })
    expect(recent7d.totalTokens).toBe(1400)
    expect(recent7d.rows[0]).toMatchObject({ key: 'claude-opus-5.5', tokens: 1000, activeDays: 2 })

    const bySource = aggregateModelUsage(fixture, now, {
      window: 'all',
      groupBy: 'source',
      sourceLabel: src => `src:${src}`,
    })
    expect(bySource.rows.map(row => [row.label, row.tokens, row.modelCount])).toEqual([
      ['src:subscription', 1000, 2],
      ['src:antigravity', 300, 1],
      ['src:codex', 200, 1],
    ])
  })

  test('builds daily, weekly and monthly stacked timelines aligned to UTC dates', () => {
    const all = aggregateModelUsage(fixture, now, { window: 'all', groupBy: 'model' })
    const daily = buildStackedTimeline(fixture, all.rows, now, 'daily')
    expect(daily).toHaveLength(30)
    const todayBucket = daily[29]
    expect(todayBucket.startDate).toBe('2026-10-18')
    expect(todayBucket.totalTokens).toBe(900)
    expect(todayBucket.segments.map(seg => [seg.key, seg.tokens])).toEqual([
      ['claude-opus-5.5', 700],
      ['gpt-6.1-sol', 200],
    ])

    const weekly = buildStackedTimeline(fixture, all.rows, now, 'weekly')
    expect(weekly).toHaveLength(16)
    const monthly = buildStackedTimeline(fixture, all.rows, now, 'monthly')
    expect(monthly).toHaveLength(12)
    expect(monthly[11].totalTokens).toBe(1400)
    expect(monthly[10].totalTokens).toBe(100)
  })
})
