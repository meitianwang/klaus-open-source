#!/usr/bin/env node
// TS-side reference for misc::locale_compare / locale_compare_numeric.
//
// The host orders every user-visible list with String.prototype.localeCompare,
// so the reference is the platform collator itself: sort the fixture with it and
// let the Rust test sort the same fixture and compare, element by element. Both
// sorts are stable, so equal keys keep the fixture's order on both sides.
//
// Usage: node scripts/locale-compare-reference.mjs [--fixtures path]
// Exit 2 + "SKIP: ..." when the fixture is unreadable.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const fixturesPath = args.includes("--fixtures")
  ? args[args.indexOf("--fixtures") + 1]
  : join(here, "locale-compare-fixtures.json");

let fixtures;
try {
  fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));
} catch (err) {
  process.stdout.write(`SKIP: cannot read fixtures (${err.message})\n`);
  process.exit(2);
}

process.stdout.write(`${JSON.stringify({
  plain: [...fixtures.plain].sort((a, b) => a.localeCompare(b)),
  numeric: [...fixtures.numeric].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
}, null, 2)}\n`);
