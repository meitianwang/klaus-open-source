#!/usr/bin/env node
// Builds scripts/locale-compare-fixtures.json, the shared input for
// locale-compare-reference.mjs and misc::tests::locale_compare_*.
//
// The Latin half is derived, not hand-listed, so the fixture cannot drift from
// what the accent table claims to cover: every Latin letter that ICU treats as
// "ASCII base + diacritic" (base-sensitivity equal to a base letter or to one of
// the digraph expansions) goes in, in isolation and with a following/leading
// letter so a same-primary neighbour forces the secondary level to decide.
//
// Deliberately OUT of scope: the Extended-B stroke/hook letters (Ⱥ ƀ ɫ ɽ …).
// Root collation gives those their own primary weights slotted between the base
// letters, not an accent on an ASCII base, so `primary_weight`'s flat table
// cannot place them — and no Klaus surface (app names, model ids, agent names,
// file names) carries them. Pinyin tone letters (ǎ ǖ …) DO decompose and stay in.
//
// Usage: node scripts/gen-locale-compare-fixtures.mjs [--write]

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = new Intl.Collator(undefined, { sensitivity: "base" });
const BASES = "abcdefghijklmnopqrstuvwxyz".split("");
const EXPANSIONS = ["ss", "ae", "oe", "th", "dz", "ij", "lj", "nj"];
const RANGES = [
  [0x00c0, 0x00ff], // Latin-1 Supplement
  [0x0100, 0x017f], // Latin Extended-A
  [0x0180, 0x024f], // Latin Extended-B
];

const plain = [
  // Real rows: agent names, app names, chrome profiles, artifact file names.
  "Explore",
  "Plan",
  "general-purpose",
  "researcher",
  "Safari",
  "iTerm2",
  "Finder",
  "Google Chrome",
  "Default",
  "Profile 2",
  "Profile 10",
  "profile 2",
  "a-b",
  "a b",
  "a_b",
  "a.b",
  "a01",
  "a10",
  "_under",
  "1one",
  "apple",
  "Apple",
  "Zebra",
  "zebra",
  // Accent/expansion pairs whose ordering a byte compare gets wrong.
  "café",
  "Café",
  "cafe",
  "éclair",
  "Éclair",
  "eclair",
  "naïve",
  "naive",
  "Straße",
  "Strasse",
  "Ærø",
  "aero",
  "œuvre",
  "oeuvre",
  "ñandú",
  "nandu",
  // Outside the Latin table: Greek and CJK fall back to code-point order, while
  // a compatibility ligature folds onto its letters with a tertiary difference.
  "Ωmega",
  "omega",
  "日本語",
  "ﬁle",
  "file",
];

for (const [from, to] of RANGES) {
  for (let cp = from; cp <= to; cp += 1) {
    const ch = String.fromCodePoint(cp);
    if (!/\p{Script=Latin}/u.test(ch)) continue;
    if (![...BASES, ...EXPANSIONS].some(candidate => base.compare(ch, candidate) === 0)) continue;
    plain.push(ch, `${ch}x`, `x${ch}`);
  }
}

const numeric = [
  "Default",
  "Profile 1",
  "Profile 2",
  "Profile 10",
  "Profile 02",
  "profile 10",
  "Profile 1 (2)",
  "p1",
  "p01",
  "p10",
  "p2",
  "ä1",
  "a1",
  "á2",
  "a10",
  "ß1",
  "ss1",
  "ø9",
  "o9",
  "日1",
  "日10",
];

const json = `${JSON.stringify({ plain, numeric }, null, 2)}\n`;
if (process.argv.includes("--write")) {
  const out = join(dirname(fileURLToPath(import.meta.url)), "locale-compare-fixtures.json");
  writeFileSync(out, json);
  process.stdout.write(`wrote ${out} (${plain.length} plain, ${numeric.length} numeric)\n`);
} else {
  process.stdout.write(json);
}
