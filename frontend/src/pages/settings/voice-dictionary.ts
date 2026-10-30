import { VOICE_DICTIONARY_TERM_MAX_LENGTH } from '../../../../shared/voice-input'

export interface DictionaryWord { id: string; text: string; source?: string; enabled?: boolean }
export type DictionaryFilter = 'all' | 'learned' | 'manual'

export function dictionaryWords(words: DictionaryWord[], filter: DictionaryFilter, search: string): DictionaryWord[] {
  const query = search.trim().toLocaleLowerCase()
  return words.filter(word => word.enabled !== false
    && (filter === 'all' || (word.source === 'learned' ? 'learned' : 'manual') === filter)
    && (!query || word.text.toLocaleLowerCase().includes(query)))
}

/** Read quoted CSV fields without executing or interpreting their contents. */
export function parseDictionaryCsv(input: string): string[] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false, closed = false
  if (input.includes('\0')) throw new Error('voice_dictionary_csv_invalid')
  const source = input.replace(/^\uFEFF/, '')
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { field += '"'; i++ }
      else if (quoted) { quoted = false; closed = true }
      else if (!field && !closed) quoted = true
      else throw new Error('voice_dictionary_csv_invalid')
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(field); field = ''; closed = false
      if (char !== ',') {
        rows.push(row); row = []
        if (char === '\r' && source[i + 1] === '\n') i++
      }
    } else {
      if (closed) throw new Error('voice_dictionary_csv_invalid')
      field += char
    }
  }
  if (quoted) throw new Error('voice_dictionary_csv_invalid')
  if (field || row.length) { row.push(field); rows.push(row) }
  const words = new Set<string>()
  for (const cells of rows) {
    const values = cells.map(value => value.trim()).filter(Boolean)
    if (values.length > 1) throw new Error('voice_dictionary_csv_invalid')
    const word = values[0]
    if (!word || word.length > VOICE_DICTIONARY_TERM_MAX_LENGTH) continue
    words.add(word)
    if (words.size > 3000) throw new Error('voice_dictionary_csv_limit')
  }
  return [...words]
}
