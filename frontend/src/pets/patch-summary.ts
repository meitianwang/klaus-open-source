import type { PetAttention } from "../../../contracts/desktop-pet-attention";

type Approval = Extract<PetAttention, { kind: "approval" }>;
export interface PatchSummary {
  firstPath: string | null;
  fileCount: number;
  additions: number;
  deletions: number;
}

function lines(text: string): string[] {
  if (!text) return [];
  const result = text.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

function textChanges(oldText: string, newText: string) {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  let start = 0;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start])
    start++;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  const before = oldLines.slice(start, oldEnd);
  const after = newLines.slice(start, newEnd);
  if (!before.length || !after.length)
    return { additions: after.length, deletions: before.length };
  const oldValues = new Set(before);
  if (!after.some((line) => oldValues.has(line)))
    return { additions: after.length, deletions: before.length };
  const frontier = new Map<number, number>([[1, 0]]);
  for (let distance = 0; distance <= before.length + after.length; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const left = frontier.get(diagonal - 1) ?? -1;
      const right = frontier.get(diagonal + 1) ?? -1;
      let x =
        diagonal === -distance || (diagonal !== distance && left < right)
          ? right
          : left + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x++;
        y++;
      }
      frontier.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        const additions = (distance + after.length - before.length) / 2;
        return { additions, deletions: distance - additions };
      }
    }
  }
  return { additions: after.length, deletions: before.length };
}

export function needsPatchWorker(approval: Approval): boolean {
  const bytes =
    (approval.patch?.length ?? 0) +
    (approval.fileChanges?.reduce(
      (sum, change) =>
        sum +
        (change.diff?.length ?? 0) +
        (change.oldText?.length ?? 0) +
        (change.newText?.length ?? 0),
      0,
    ) ?? 0);
  return bytes > 64 * 1024;
}

function unifiedChanges(patch: string) {
  const paths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let previousPath: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const value = line.slice(4).split("\t")[0]!.replace(/^[ab]\//, "");
      if (line.startsWith("--- ")) previousPath = value;
      else if (value && value !== "/dev/null") paths.add(value);
      else if (previousPath && previousPath !== "/dev/null")
        paths.add(previousPath);
    } else if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { paths, additions, deletions };
}

export function patchSummary(approval: Approval): PatchSummary | null {
  if (approval.fileChanges?.length) {
    let additions = 0;
    let deletions = 0;
    for (const change of approval.fileChanges) {
      const counts = change.diff
        ? unifiedChanges(change.diff)
        : textChanges(change.oldText ?? "", change.newText ?? "");
      additions += counts.additions;
      deletions += counts.deletions;
    }
    return {
      firstPath: approval.fileChanges[0]!.path,
      fileCount: approval.fileChanges.length,
      additions,
      deletions,
    };
  }
  if (!approval.patch) return null;
  const result = unifiedChanges(approval.patch);
  return {
    firstPath: result.paths.values().next().value ?? null,
    fileCount: result.paths.size || 1,
    additions: result.additions,
    deletions: result.deletions,
  };
}
