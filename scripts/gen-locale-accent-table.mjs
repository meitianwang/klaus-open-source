#!/usr/bin/env node
// Derives the ICU root-collation weights for Latin letters that carry
// diacritics, straight out of the platform's own collator, and prints the Rust
// table used by misc::locale_compare.
//
// Why a table: `é` has the same PRIMARY weight as `e` (so `éclair` sorts before
// `Zebra`, not after every ASCII string) and differs only at the SECONDARY
// (accent) level, which outranks the case tertiary. Without this, every
// localeCompare-ordered list in the shell puts accented names in the wrong place.
//
// Usage: node scripts/gen-locale-accent-table.mjs

const base = new Intl.Collator(undefined, { sensitivity: "base" });
const accent = new Intl.Collator(undefined, { sensitivity: "accent" });

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
// Expansions ICU uses for the digraph/ligature letters in these blocks.
const EXPANSIONS = ["ss", "ae", "oe", "th", "dz", "ij", "lj", "nj", "d", "h", "l", "t", "b", "n"];
const CANDIDATES = [...LETTERS, ...EXPANSIONS];

/** Every Latin block whose letters decompose onto an ASCII base. */
const RANGES = [
  [0x00c0, 0x00ff], // Latin-1 Supplement
  [0x0100, 0x017f], // Latin Extended-A
  [0x0180, 0x024f], // Latin Extended-B
  [0x1e00, 0x1eff], // Latin Extended Additional
  // The lowercase half of a few Extended-B capitals lives out here (Ⱥ → ⱥ),
  // and Rust looks the table up by the LOWERCASE char, so it has to be scanned.
  [0x2c60, 0x2c7f], // Latin Extended-C
  [0xa720, 0xa7ff], // Latin Extended-D
];

const rows = [];
for (const [from, to] of RANGES) {
  for (let cp = from; cp <= to; cp += 1) {
    const ch = String.fromCodePoint(cp);
    if (!/\p{Script=Latin}/u.test(ch)) continue;
    const hit = CANDIDATES.find(candidate => base.compare(ch, candidate) === 0);
    if (!hit) continue;
    if (base.compare(ch, hit) !== 0) continue;
    rows.push({ cp, ch, primary: hit });
  }
}

// Secondary rank: within one base, sort by the accent-sensitive collator (case
// insensitive), so `e < é < è < ê < ë` gets 0,1,2,3,4.
const byPrimary = new Map();
for (const row of rows) {
  if (!byPrimary.has(row.primary)) byPrimary.set(row.primary, []);
  byPrimary.get(row.primary).push(row);
}
const ranks = new Map();
for (const [primary, group] of byPrimary) {
  const forms = [...new Set([primary, ...group.map(row => row.ch.toLowerCase())])].sort((a, b) =>
    accent.compare(a, b),
  );
  forms.forEach((form, index) => ranks.set(`${primary}\u0000${form}`, index));
}

const table = rows
  .map(row => {
    const rank = ranks.get(`${row.primary}\u0000${row.ch.toLowerCase()}`) ?? 0;
    return { cp: row.cp, ch: row.ch, primary: row.primary, rank };
  })
  // Only the lowercase form carries the mapping; the uppercase one reaches the
  // same weight through Rust's to_lowercase. `İ` is the exception: it lowercases
  // to TWO chars (i + combining dot), so nothing folds onto it and it needs a row.
  .filter(row => row.ch === row.ch.toLowerCase() || [...row.ch.toLowerCase()].length !== 1)
  .sort((a, b) => a.cp - b.cp);

const lines = table.map(row => `    ('\\u{${row.cp.toString(16)}}', "${row.primary}", ${row.rank}), // ${row.ch}`);
process.stdout.write(`const LATIN_ACCENTS: [(char, &str, u8); ${table.length}] = [\n${lines.join("\n")}\n];\n`);
