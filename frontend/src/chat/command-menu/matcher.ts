// Fuzzy matcher for the command menu. A query becomes a wildcard pattern
// (`*query`, with `/` and `\` treated as hard separators) that is matched
// case-insensitively against a candidate name; when the query itself contains a
// hard separator, the text after the last one is retried as a fallback so a
// path-like query still finds a name that only shares its tail.
//
// Scoring rewards matches at word starts — camel humps, and positions after a
// separator, underscore, hyphen, colon, plus or dot — over matches inside a
// word, and the same walk records which characters matched so the UI can
// highlight exactly those fragments. Ranking and highlighting therefore come
// from one traversal and cannot disagree.
//
// Every branch, constant and tie-breaker here is load-bearing: do not
// "simplify" this file.

export interface MatchFragment {
  startOffset: number
  endOffset: number
}

const MAX_PATTERN_LENGTH = 100
const NO_MATCH = -2147483648
const SEPARATOR_PLACEHOLDER = '\0'
const HARD_SEPARATORS = ['/', '\\']
const START_BONUS = 1e4

type MatchingMode = 'IGNORE_CASE' | 'MATCH_CASE' | 'FIRST_LETTER'

function isUpperCaseChar(ch: string): boolean {
  return ch.toUpperCase() === ch && ch.toLowerCase() !== ch
}

function isLowerCaseChar(ch: string): boolean {
  return ch.toLowerCase() === ch && ch.toUpperCase() !== ch
}

function isDigitChar(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isWordChar(ch: string): boolean {
  return /[a-z0-9]/i.test(ch)
}

function isWildcardChar(ch: string): boolean {
  return ch === ' ' || ch === '*'
}

function isWordSeparatorChar(ch: string): boolean {
  return ch.trim().length === 0 || ch === '_' || ch === '-' || ch === ':' || ch === '+' || ch === '.' || ch === '/' || ch === '\\'
}

/** A camel-hump / word start inside `name` at `index`. */
function isWordStart(name: string, index: number): boolean {
  if (index < 0 || index >= name.length) return false
  const ch = name[index]
  if (!isWordChar(ch)) return false
  if (index === 0) return true
  const prev = name[index - 1]
  return !!(!isWordChar(prev) || (isUpperCaseChar(ch) && isLowerCaseChar(prev)) || (isDigitChar(ch) && !isDigitChar(prev)))
}

function skipDigitsOrJumpToWordStart(name: string, index: number): number {
  return index < name.length && isDigitChar(name[index]) ? index + 1 : nextWordStartAfter(name, index)
}

function nextWordStartAfter(name: string, index: number): number {
  for (let i = index + 1; i <= name.length; i += 1) {
    if (i >= name.length) return name.length + 1
    if (isWordStart(name, i)) return i
  }
  return name.length + 1
}

function indexOfPatternChar(pattern: string[], ch: string, from: number, to: number, ignoreCase: boolean): number {
  if (!ignoreCase) {
    for (let i = from; i < to; i += 1) if (pattern[i] === ch) return i
    return -1
  }
  const lower = ch.toLowerCase()
  const upper = ch.toUpperCase()
  for (let i = from; i < to; i += 1) {
    const p = pattern[i]
    if (p === lower || p === upper) return i
  }
  return -1
}

function indexOfAnyChar(name: string, chars: string[], from: number, to: number): number {
  for (let i = from; i < to; i += 1) if (chars.includes(name[i])) return i
  return -1
}

function indexOfChar(name: string, ch: string, from: number, to: number): number {
  for (let i = from; i < to; i += 1) if (name[i] === ch) return i
  return -1
}

function indexOfIgnoreCase(name: string, needle: string, from: number, bound: number): number {
  const lowerName = name.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  const at = lowerName.indexOf(lowerNeedle, from)
  return at < 0 || at + needle.length > bound ? -1 : at
}

function equalsIgnoreCaseAt(name: string, from: number, length: number, needle: string): boolean {
  return from + length <= name.length && name.slice(from, from + length).toLowerCase() === needle.toLowerCase()
}

function stripWildcards(pattern: string[]): string {
  let out = ''
  for (const ch of pattern) if (ch !== '*') out += ch
  return out
}

function prependFragment(fragments: MatchFragment[], start: number, length: number): MatchFragment[] {
  if (fragments.length === 0) return [{ startOffset: start, endOffset: start + length }]
  const last = fragments[fragments.length - 1]
  if (last.startOffset === start + length) fragments[fragments.length - 1] = { startOffset: start, endOffset: last.endOffset }
  else fragments.push({ startOffset: start, endOffset: start + length })
  return fragments
}

function withStartBonus(degree: number, fragments: MatchFragment[]): number {
  return fragments.length === 0 ? degree : fragments[0].startOffset === 0 ? degree + START_BONUS : degree
}

class WildcardMatcher {
  private readonly myPattern: string[]
  private readonly isLowerCase: boolean[]
  private readonly isUpperCase: boolean[]
  private readonly isWordSeparator: boolean[]
  private readonly toUpperCase: string[]
  private readonly toLowerCase: string[]
  private readonly hardSeparators: string[]
  private readonly matchingMode: MatchingMode
  private mixedCase = false
  private hasSeparators = false
  private hasDots = false
  private meaningfulCharacters: string[] = []
  private minNameLength = 0
  private failedMatchStates: Set<number> | null = null

  constructor(pattern: string, mode: MatchingMode, hardSeparators: string[]) {
    const trimmed = pattern.endsWith('* ') ? pattern.slice(0, -2) : pattern
    this.myPattern = trimmed.split('')
    const n = this.myPattern.length
    this.isLowerCase = Array.from({ length: n }, () => false)
    this.isUpperCase = Array.from({ length: n }, () => false)
    this.isWordSeparator = Array.from({ length: n }, () => false)
    this.toUpperCase = Array.from({ length: n }, () => '')
    this.toLowerCase = Array.from({ length: n }, () => '')
    this.hardSeparators = Array.from(hardSeparators)
    this.matchingMode = mode
    const meaningful: string[] = []
    let seenWordChar = false
    let seenLower = false
    let seenLowerAfterWordChar = false
    let seenDot = false
    let seenSeparatorAfterWordChar = false
    for (let i = 0; i < this.myPattern.length; i += 1) {
      const ch = this.myPattern[i]
      const separator = isWordSeparatorChar(ch)
      const upper = isUpperCaseChar(ch)
      const lower = isLowerCaseChar(ch)
      const up = ch.toUpperCase()
      const low = ch.toLowerCase()
      if (lower) seenLower = true
      if (ch === '.') seenDot = true
      if (seenWordChar && upper) seenLowerAfterWordChar = true
      if (!isWildcardChar(ch)) {
        seenWordChar = true
        meaningful.push(low)
        meaningful.push(up)
      }
      if (seenWordChar && separator) seenSeparatorAfterWordChar = true
      this.isWordSeparator[i] = separator
      this.isUpperCase[i] = upper
      this.isLowerCase[i] = lower
      this.toUpperCase[i] = up
      this.toLowerCase[i] = low
    }
    this.hasDots = seenDot
    this.mixedCase = seenLower && seenLowerAfterWordChar
    this.hasSeparators = seenSeparatorAfterWordChar
    this.meaningfulCharacters = meaningful
    this.minNameLength = meaningful.length / 2
  }

  get pattern(): string {
    return this.myPattern.join('')
  }

  matchingDegree(name: string, preferStart: boolean = false, fragments: MatchFragment[] | null = this.match(name)): number {
    if (fragments == null) return NO_MATCH
    if (fragments.length === 0) return 0
    const first = fragments[0]
    const startsAtZero = first.startOffset === 0
    const anchored = startsAtZero && preferStart
    let degree = 0
    let patternPos = -1
    let skippedWords = 0
    let namePos = 0
    let fragmentStartsHere = false
    for (const fragment of fragments) {
      for (let i = fragment.startOffset; i < fragment.endOffset; i += 1) {
        const isFragmentFirstChar = i === fragment.startOffset && fragment !== first
        let atWordStart = false
        for (; namePos <= i;) {
          if (namePos === i) atWordStart = true
          else if (isFragmentFirstChar) skippedWords += 1
          namePos = skipDigitsOrJumpToWordStart(name, namePos)
        }
        const nameChar = name[i]
        patternPos = indexOfPatternChar(this.myPattern, nameChar, patternPos + 1, this.myPattern.length, true)
        if (patternPos < 0) break
        if (atWordStart) fragmentStartsHere = nameChar === this.myPattern[patternPos] && this.isUpperCase[patternPos]
        degree += this.evaluateCaseMatching(anchored, patternPos, fragmentStartsHere, i, isFragmentFirstChar, atWordStart, nameChar)
      }
    }
    const matchStart = first.startOffset
    const crossesHardSeparator = indexOfAnyChar(name, this.hardSeparators, 0, matchStart) >= 0
    const atNameWordStart = matchStart === 0 || (isWordStart(name, matchStart) && !isWordStart(name, matchStart - 1))
    const endsAtNameEnd = fragments[fragments.length - 1].endOffset === name.length
    return (atNameWordStart ? 1e3 : 0) + degree - fragments.length - skippedWords * 10 + (crossesHardSeparator ? 0 : 2) + +!!startsAtZero + +!!endsAtNameEnd
  }

  match(name: string): MatchFragment[] | null {
    if (name.length < this.minNameLength) return null
    if (this.myPattern.length > MAX_PATTERN_LENGTH) return this.matchBySubstring(name)
    let meaningfulPos = 0
    for (let i = 0; i < name.length && meaningfulPos < this.meaningfulCharacters.length; i += 1) {
      const ch = name[i]
      if (ch === this.meaningfulCharacters[meaningfulPos] || ch === this.meaningfulCharacters[meaningfulPos + 1]) {
        const lastPatternIndex = this.myPattern.length - 2
        if (
          meaningfulPos === this.meaningfulCharacters.length - 2
          && lastPatternIndex >= 0
          && isWordChar(this.myPattern[lastPatternIndex + 1])
          && !this.isWildcard(lastPatternIndex)
          && (i === 0 || !this.charEquals(this.myPattern[lastPatternIndex], lastPatternIndex, name[i - 1], this.matchingMode !== 'MATCH_CASE'))
          && !isWordStart(name, i)
        ) continue
        meaningfulPos += 2
      }
    }
    if (meaningfulPos < this.minNameLength * 2) return null
    this.failedMatchStates?.clear()
    const fragments = this.matchWildcards(name, 0, 0)
    return fragments == null ? null : fragments.reverse()
  }

  private evaluateCaseMatching(anchored: boolean, patternIndex: number, camelStart: boolean, nameIndex: number, fragmentFirst: boolean, atWordStart: boolean, nameChar: string): number {
    if (fragmentFirst && atWordStart && this.isLowerCase[patternIndex]) return -10
    if (nameChar === this.myPattern[patternIndex]) {
      return this.isUpperCase[patternIndex] ? 50 : nameIndex === 0 && anchored ? 150 : +!!atWordStart
    }
    return atWordStart || (this.isLowerCase[patternIndex] && camelStart) ? -1 : 0
  }

  private matchBySubstring(name: string): MatchFragment[] | null {
    const leadingWildcard = this.isPatternChar(0, '*')
    const needle = stripWildcards(this.myPattern)
    if (name.length < needle.length) return null
    if (leadingWildcard) {
      const at = indexOfIgnoreCase(name, needle, 0, name.length)
      return at >= 0 ? [{ startOffset: at, endOffset: at + needle.length }] : null
    }
    return equalsIgnoreCaseAt(name, 0, needle.length, needle) ? [{ startOffset: 0, endOffset: needle.length }] : null
  }

  private matchWildcards(name: string, patternIndex: number, nameIndex: number): MatchFragment[] | null {
    let p = patternIndex
    if (nameIndex < 0) return null
    if (!this.isWildcard(p)) return p === this.myPattern.length ? [] : this.matchFragment(name, p, nameIndex)
    do p += 1
    while (this.isWildcard(p))
    if (p === this.myPattern.length) {
      if (this.isTrailingSpacePattern() && nameIndex !== name.length && (p < 2 || !this.isUpperCaseOrDigit(p - 2))) {
        const space = name.indexOf(' ', nameIndex)
        return space >= 0 ? [{ startOffset: space, endOffset: space + 1 }] : null
      }
      return []
    }
    return this.matchSkippingWords(name, p, this.findNextPatternCharOccurrence(name, nameIndex, p), true)
  }

  private isTrailingSpacePattern(): boolean {
    return this.isPatternChar(this.myPattern.length - 1, ' ')
  }

  private isUpperCaseOrDigit(index: number): boolean {
    return this.isUpperCase[index] || isDigitChar(this.myPattern[index])
  }

  private matchSkippingWords(name: string, patternIndex: number, nameIndex: number, allowSkipping: boolean): MatchFragment[] | null {
    if (nameIndex < 0) return null
    const stateKey = (patternIndex * (name.length + 1) + nameIndex) * 2 + +!!allowSkipping
    if (this.failedMatchStates?.has(stateKey)) return null
    let at = nameIndex
    let bestFragmentLength = 0
    for (; at >= 0;) {
      const fragmentLength = this.seemsLikeFragmentStart(name, patternIndex, at) ? this.maxMatchingFragment(name, patternIndex, at) : 0
      if (fragmentLength > bestFragmentLength || (at + fragmentLength === name.length && this.isTrailingSpacePattern())) {
        if (!this.isMiddleMatch(name, patternIndex, at)) bestFragmentLength = fragmentLength
        const inside = this.matchInsideFragment(name, patternIndex, at, fragmentLength)
        if (inside != null) return inside
      }
      const nextOccurrence = this.findNextPatternCharOccurrence(name, at + 1, patternIndex)
      at = allowSkipping ? nextOccurrence : this.checkForSpecialChars(name, at + 1, nextOccurrence, patternIndex)
    }
    ;(this.failedMatchStates ??= new Set()).add(stateKey)
    return null
  }

  private findNextPatternCharOccurrence(name: string, from: number, patternIndex: number): number {
    return !this.isPatternChar(patternIndex - 1, '*') && !this.isWordSeparator[patternIndex]
      ? this.indexOfWordStart(name, patternIndex, from)
      : this.indexOfIgnoreCaseChar(name, from, patternIndex)
  }

  private checkForSpecialChars(name: string, from: number, to: number, patternIndex: number): number {
    if (to < 0) return -1
    if (!this.hasSeparators && !this.mixedCase && indexOfAnyChar(name, this.hardSeparators, from, to) !== -1) return -1
    if (this.hasDots && !this.isPatternChar(patternIndex - 1, '.') && indexOfChar(name, '.', from, to) !== -1) return -1
    return to
  }

  private seemsLikeFragmentStart(name: string, patternIndex: number, nameIndex: number): boolean {
    if (!this.isUpperCase[patternIndex] || isUpperCaseChar(name[nameIndex]) || isWordStart(name, nameIndex)) return true
    return !this.mixedCase && this.matchingMode !== 'MATCH_CASE'
  }

  private charEquals(patternChar: string, patternIndex: number, nameChar: string, ignoreCase: boolean): boolean {
    if (patternChar === nameChar) return true
    return ignoreCase ? this.toLowerCase[patternIndex] === nameChar || this.toUpperCase[patternIndex] === nameChar : false
  }

  private matchFragment(name: string, patternIndex: number, nameIndex: number): MatchFragment[] | null {
    const length = this.maxMatchingFragment(name, patternIndex, nameIndex)
    return length === 0 ? null : this.matchInsideFragment(name, patternIndex, nameIndex, length)
  }

  private maxMatchingFragment(name: string, patternIndex: number, nameIndex: number): number {
    if (!this.isFirstCharMatching(name, nameIndex, patternIndex)) return 0
    let length = 1
    const ignoreCase = this.matchingMode !== 'MATCH_CASE'
    while (nameIndex + length < name.length && patternIndex + length < this.myPattern.length) {
      const nameChar = name[nameIndex + length]
      if (!this.charEquals(this.myPattern[patternIndex + length], patternIndex + length, nameChar, ignoreCase)) {
        if (this.isSkippingDigitBetweenPatternDigits(patternIndex + length, nameChar)) return 0
        break
      }
      length += 1
    }
    return length
  }

  private isSkippingDigitBetweenPatternDigits(patternIndex: number, nameChar: string): boolean {
    return isDigitChar(this.myPattern[patternIndex]) && isDigitChar(this.myPattern[patternIndex - 1]) && isDigitChar(nameChar)
  }

  private matchInsideFragment(name: string, patternIndex: number, nameIndex: number, fragmentLength: number): MatchFragment[] | null {
    const minFragment = this.isMiddleMatch(name, patternIndex, nameIndex) ? 3 : 1
    return this.improveCamelHumps(name, patternIndex, nameIndex, fragmentLength, minFragment)
      ?? this.findLongestMatchingPrefix(name, patternIndex, nameIndex, fragmentLength, minFragment)
  }

  private isMiddleMatch(name: string, patternIndex: number, nameIndex: number): boolean {
    if (this.isPatternChar(patternIndex - 1, '*') && !this.isWildcard(patternIndex + 1) && isWordChar(name[nameIndex])) {
      return !isWordStart(name, nameIndex)
    }
    return false
  }

  private findLongestMatchingPrefix(name: string, patternIndex: number, nameIndex: number, fragmentLength: number, minFragment: number): MatchFragment[] | null {
    if (patternIndex + fragmentLength >= this.myPattern.length) {
      return [{ startOffset: nameIndex, endOffset: nameIndex + fragmentLength }]
    }
    let length = fragmentLength
    for (; length >= minFragment || (length > 0 && this.isWildcard(patternIndex + length));) {
      let rest: MatchFragment[] | null = null
      if (this.isWildcard(patternIndex + length)) rest = this.matchWildcards(name, patternIndex + length, nameIndex + length)
      else {
        let next = this.findNextPatternCharOccurrence(name, nameIndex + length + 1, patternIndex + length)
        next = this.checkForSpecialChars(name, nameIndex + length, next, patternIndex + length)
        if (next >= 0) rest = this.matchSkippingWords(name, patternIndex + length, next, false)
      }
      if (rest != null) return prependFragment(rest, nameIndex, length)
      --length
    }
    return null
  }

  private improveCamelHumps(name: string, patternIndex: number, nameIndex: number, fragmentLength: number, minFragment: number): MatchFragment[] | null {
    for (let length = minFragment; length < fragmentLength; length += 1) {
      if (this.isUppercasePatternVsLowercaseNameChar(name, patternIndex + length, nameIndex + length)) {
        const further = this.findUppercaseMatchFurther(name, patternIndex + length, nameIndex + length)
        if (further != null) return prependFragment(further, nameIndex, length)
      }
    }
    return null
  }

  private isUppercasePatternVsLowercaseNameChar(name: string, patternIndex: number, nameIndex: number): boolean {
    return this.isUpperCase[patternIndex] && this.myPattern[patternIndex] !== name[nameIndex]
  }

  private findUppercaseMatchFurther(name: string, patternIndex: number, nameIndex: number): MatchFragment[] | null {
    const wordStart = this.indexOfWordStart(name, patternIndex, nameIndex)
    return this.matchWildcards(name, patternIndex, wordStart)
  }

  private isFirstCharMatching(name: string, nameIndex: number, patternIndex: number): boolean {
    if (nameIndex >= name.length) return false
    const ignoreCase = this.matchingMode !== 'MATCH_CASE'
    const patternChar = this.myPattern[patternIndex]
    if (!this.charEquals(patternChar, patternIndex, name[nameIndex], ignoreCase)) return false
    if (this.matchingMode === 'FIRST_LETTER' && (patternIndex === 0 || (patternIndex === 1 && this.isWildcard(0))) && this.hasCase(patternIndex)) {
      return this.isUpperCase[patternIndex] === isUpperCaseChar(name[0])
    }
    return true
  }

  private hasCase(index: number): boolean {
    return this.isUpperCase[index] || this.isLowerCase[index]
  }

  private isWildcard(index: number): boolean {
    return index >= 0 && index < this.myPattern.length && isWildcardChar(this.myPattern[index])
  }

  private isPatternChar(index: number, ch: string): boolean {
    return index >= 0 && index < this.myPattern.length && this.myPattern[index] === ch
  }

  private indexOfWordStart(name: string, patternIndex: number, from: number): number {
    const patternChar = this.myPattern[patternIndex]
    if (from >= name.length || (this.mixedCase && this.isLowerCase[patternIndex] && !(patternIndex > 0 && this.isWordSeparator[patternIndex - 1]))) return -1
    let at = from
    const plainChar = !isWordChar(patternChar)
    for (;;) {
      at = this.indexOfIgnoreCaseChar(name, at, patternIndex)
      if (at < 0) return -1
      if (plainChar || isWordStart(name, at)) return at
      at += 1
    }
  }

  private indexOfIgnoreCaseChar(name: string, from: number, patternIndex: number): number {
    const upper = this.toUpperCase[patternIndex]
    const lower = this.toLowerCase[patternIndex]
    for (let i = from; i < name.length; i += 1) {
      const ch = name[i]
      if (ch === upper || ch === lower) return i
    }
    return -1
  }
}

/** Main + fallback matcher pair: the fallback re-tries the tail after the last hard separator. */
class CompositeMatcher {
  constructor(
    private readonly mainMatcher: WildcardMatcher,
    private readonly fallbackMatcher: WildcardMatcher | null,
  ) {}

  matchingDegree(name: string): number {
    const main = this.mainMatcher.match(name)
    if (main != null) return withStartBonus(this.mainMatcher.matchingDegree(name, false, main), main)
    if (this.fallbackMatcher == null) return NO_MATCH
    const fallback = this.fallbackMatcher.match(name)
    return fallback == null ? NO_MATCH : withStartBonus(this.fallbackMatcher.matchingDegree(name, false, fallback), fallback)
  }

  matchingFragments(name: string): MatchFragment[] | null {
    return this.mainMatcher.match(name) ?? this.fallbackMatcher?.match(name) ?? null
  }
}

function replaceSeparators(value: string, replacement: string): string {
  let out = value
  for (const sep of HARD_SEPARATORS) out = out.split(sep).join(replacement)
  return out
}

function hasHardSeparator(value: string): boolean {
  return HARD_SEPARATORS.some(sep => value.includes(sep))
}

/** Wildcard pattern: `*query` with hard separators turned into `*\0*`. */
function wildcardPatternFor(query: string): string {
  return replaceSeparators(`*${query}`, `*${SEPARATOR_PLACEHOLDER}*`)
}

function nameWithSeparatorPlaceholders(name: string): string {
  return replaceSeparators(name, SEPARATOR_PLACEHOLDER)
}

function tailAfterLastHardSeparator(value: string): string {
  let at = -1
  for (const sep of HARD_SEPARATORS) {
    const index = value.lastIndexOf(sep)
    if (index >= 0 && index < value.length - 1) at = Math.max(at, index)
  }
  return value.slice(at + 1)
}

function buildComposite(query: string): CompositeMatcher {
  const lowercased = Array.from(query, ch => {
    const low = ch.toLowerCase()
    return low.length === ch.length ? low : ch
  }).join('')
  const separated = hasHardSeparator(lowercased)
  const mainPattern = separated ? wildcardPatternFor(lowercased) : `*${lowercased}`
  const tail = separated ? tailAfterLastHardSeparator(lowercased) : ''
  const main = new WildcardMatcher(mainPattern, 'IGNORE_CASE', HARD_SEPARATORS)
  const fallback = separated && lowercased !== tail ? new WildcardMatcher(tail, 'IGNORE_CASE', HARD_SEPARATORS) : null
  return new CompositeMatcher(main, fallback)
}

function scoreWithName(name: string, composite: CompositeMatcher, separated: boolean): number {
  const candidate = separated ? nameWithSeparatorPlaceholders(name) : name
  const degree = composite.matchingDegree(candidate)
  if (degree === NO_MATCH) return 0
  const scaled = degree * 10 - name.length
  return scaled <= 0 ? 1 : scaled
}

/** Score `name` against a user query; 0 means "no match". */
export function matchScore(name: string, query: string): number {
  const trimmed = query.trim()
  if (trimmed.length === 0) return 0
  const composite = buildComposite(trimmed)
  return scoreWithName(name, composite, hasHardSeparator(trimmed))
}

/** Reusable scorer for one query. */
export function scorerFor(query: string): (name: string) => number {
  const trimmed = query.trim()
  if (trimmed.length === 0) return () => 0
  const composite = buildComposite(trimmed)
  const separated = hasHardSeparator(trimmed)
  return name => scoreWithName(name, composite, separated)
}

/** Matched fragments of `name` for highlight rendering. */
export function matchFragments(name: string, query: string): MatchFragment[] | null {
  const trimmed = query.trim()
  if (trimmed.length === 0) return null
  const composite = buildComposite(trimmed)
  const separated = hasHardSeparator(trimmed)
  return composite.matchingFragments(separated ? nameWithSeparatorPlaceholders(name) : name)
}
