import { expect, test } from "bun:test";
import { needsPatchWorker, patchSummary } from "./patch-summary";

test("patch summary excludes diff headers and includes all changed files", () => {
  expect(
    patchSummary({
      kind: "approval",
      id: "patch",
      category: "patch",
      toolName: "Apply patch",
      patch: "--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-old\n+new\n+extra\n--- /dev/null\n+++ b/two.ts\n+created\n",
    }),
  ).toEqual({ firstPath: "one.ts", fileCount: 2, additions: 3, deletions: 1 });
});

test("whole-file changes count minimal line edits while preserving common lines", () => {
  expect(
    patchSummary({
      kind: "approval",
      id: "patch",
      category: "patch",
      toolName: "Apply patch",
      fileChanges: [
        {
          path: "one.ts",
          oldText: "first\nkeep\nlast\n",
          newText: "changed\nkeep\nlast\nextra\n",
        },
        { path: "two.ts", oldText: "removed\n", newText: "" },
      ],
    }),
  ).toEqual({ firstPath: "one.ts", fileCount: 2, additions: 2, deletions: 2 });
});

test("renamed and deleted files each occupy one patch summary entry", () => {
  expect(
    patchSummary({
      kind: "approval",
      id: "patch",
      category: "patch",
      toolName: "Apply patch",
      patch: "--- a/old.ts\n+++ b/new.ts\n-a\n+b\n--- a/deleted.ts\n+++ /dev/null\n-removed\n",
    }),
  ).toEqual({ firstPath: "new.ts", fileCount: 2, additions: 1, deletions: 2 });
});

test("large replacements and retained surroundings produce exact counts without quadratic work", () => {
  const oldText = Array.from({ length: 20000 }, (_, index) => `old-${index}`).join("\n");
  const newText = Array.from({ length: 20000 }, (_, index) => `new-${index}`).join("\n");
  const approval = {
    kind: "approval" as const,
    id: "large",
    category: "patch" as const,
    toolName: "Apply patch",
    fileChanges: [{ path: "large.ts", oldText, newText }],
  };
  const started = performance.now();
  expect(patchSummary(approval)).toEqual({
    firstPath: "large.ts", fileCount: 1, additions: 20000, deletions: 20000,
  });
  expect(patchSummary({
    ...approval,
    fileChanges: [{ path: "large.ts", oldText: `${oldText}\nold\n${newText}`, newText: `${oldText}\nnew\n${newText}` }],
  })).toEqual({ firstPath: "large.ts", fileCount: 1, additions: 1, deletions: 1 });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(needsPatchWorker(approval)).toBe(true);
});
