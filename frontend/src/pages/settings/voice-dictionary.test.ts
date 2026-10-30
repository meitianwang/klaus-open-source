import { expect, test } from 'bun:test'
import { dictionaryWords, parseDictionaryCsv } from './voice-dictionary'

test('dictionary filters are sources and search never changes the stored terms', () => {
  const words = [{ id: 'a', text: 'Klaus', source: 'manual' }, { id: 'b', text: '项目名称', source: 'learned' }, { id: 'c', text: 'Retired', enabled: false }]
  expect(dictionaryWords(words, 'all', '').map(word => word.id)).toEqual(['a', 'b'])
  expect(dictionaryWords(words, 'learned', '').map(word => word.id)).toEqual(['b'])
  expect(dictionaryWords(words, 'manual', ' klAUs ').map(word => word.text)).toEqual(['Klaus'])
  expect(words[0].text).toBe('Klaus')
})

test('single-column CSV keeps the first row, quoted fields and exact-case terms', () => {
  expect(parseDictionaryCsv('\uFEFFterm\r\nKlaus\r\n"Smith, Jane"\r\nKlaus\r\nklaus\r\n,,项目名称,\r\n')).toEqual(['term', 'Klaus', 'Smith, Jane', 'klaus', '项目名称'])
  expect(parseDictionaryCsv('"A ""quoted"" name"\n\n')).toEqual(['A "quoted" name'])
})

test('CSV rejects multiple populated columns, embedded NUL and incomplete quotes before import', () => {
  for (const input of ['valid\nfirst,second', 'word\0', '"unfinished']) expect(() => parseDictionaryCsv(input)).toThrow('voice_dictionary_csv_invalid')
})

test('CSV bounds count distinct terms and use UTF-16 term lengths', () => {
  expect(parseDictionaryCsv('x'.repeat(100) + '\n' + 'y'.repeat(101))).toEqual(['x'.repeat(100)])
  expect(parseDictionaryCsv('😀'.repeat(50) + '\n' + '😀'.repeat(51))).toEqual(['😀'.repeat(50)])
  const terms = Array.from({ length: 3000 }, (_, index) => `word-${index}`).join('\n')
  expect(parseDictionaryCsv(terms + '\nword-1')).toHaveLength(3000)
  expect(() => parseDictionaryCsv(terms + '\nanother')).toThrow('voice_dictionary_csv_limit')
})
