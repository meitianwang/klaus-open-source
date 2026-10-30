import { describe, expect, test } from 'bun:test'
import { replaceSiteReferences, retireSiteReferences, siteReferencesForSession, subscribeSiteReferences, websiteReferencesForItem, websiteReferencesFromText } from './site-references'
import vectors from '../../../contracts/vectors/site-reference-vectors.json'

describe('assistant website resource projection', () => {
  for (const vector of vectors.projection) test(vector.name, () => {
    expect(websiteReferencesFromText(vector.text, 'turn-a').map(reference => reference.url)).toEqual(vector.urls)
  })
  test('turn identity preserves repeated resources across turns and deduplicates live history handoff', () => {
    const a = websiteReferencesFromText('[Preview](http://localhost:3000)', 'a')
    const b = websiteReferencesFromText('[Preview](http://localhost:3000)', 'b')
    let changes = 0
    const stop = subscribeSiteReferences(() => changes++)
    replaceSiteReferences('resource-session', [...a, ...a, ...b])
    expect(siteReferencesForSession('resource-session')).toHaveLength(2)
    replaceSiteReferences('resource-session', [...a, ...b])
    expect(changes).toBe(1)
    expect(siteReferencesForSession('other-session')).toEqual([])
    replaceSiteReferences('resource-session', b)
    expect(siteReferencesForSession('resource-session').map(reference => reference.turnId)).toEqual(['b'])
    stop()
    retireSiteReferences('resource-session')
  })

  test('unchanged items reuse extraction while text and turn identity remain authoritative', () => {
    const item = { text: '[Preview](http://localhost:3000)' }
    const first = websiteReferencesForItem(item, item.text, 'turn-a')
    expect(websiteReferencesForItem(item, item.text, 'turn-a')).toBe(first)
    const rebound = websiteReferencesForItem(item, item.text, 'turn-b')
    expect(rebound.map(reference => reference.id)).toEqual(['turn-b:http://localhost:3000/'])
    expect(rebound).not.toBe(first)
    item.text = '[Updated](https://example.test/new)'
    const updated = websiteReferencesForItem(item, item.text, 'turn-b')
    expect(updated.map(reference => reference.title)).toEqual(['Updated'])
    expect(updated.map(reference => reference.url)).toEqual(['https://example.test/new'])
    expect(websiteReferencesForItem(item, item.text, 'turn-b')).toBe(updated)
    expect(websiteReferencesForItem({}, item.text, 'turn-b')).not.toBe(updated)
  })

  test('candidate filtering preserves escaped URLs, entities and automatic links', () => {
    for (const text of ['[Preview](https\\://example.test)', '[Preview](https://example.test?a=1&amp;b=2)', 'www.example.test']) {
      expect(websiteReferencesFromText(text, 'turn-a')).toHaveLength(1)
    }
    expect(websiteReferencesFromText('A plain paragraph with no websites.', 'turn-a')).toEqual([])
  })

  test('retirement releases one session and permits complete history reconstruction', () => {
    const source = websiteReferencesFromText('[Preview](https://example.test)', 'turn-a')
    replaceSiteReferences('resource-retired', source)
    replaceSiteReferences('resource-preserved', source)
    retireSiteReferences('resource-retired')
    expect(siteReferencesForSession('resource-retired')).toEqual([])
    expect(siteReferencesForSession('resource-preserved')).toEqual(source)
    replaceSiteReferences('resource-retired', source)
    expect(siteReferencesForSession('resource-retired')).toEqual(source)
    retireSiteReferences('resource-retired')
    retireSiteReferences('resource-preserved')
  })
})
