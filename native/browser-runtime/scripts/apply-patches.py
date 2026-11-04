#!/usr/bin/env python3
"""Preflight an ordered patch series against private, temporary Git indexes."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def git(root, *arguments, env=None, capture=False):
    return subprocess.run(
        ["git", "-C", str(root), *map(str, arguments)],
        env=env, check=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    ).stdout


def patch_paths(root, patch):
    fields = git(root, "apply", "--numstat", "-z", patch, capture=True).split(b"\0")
    paths = set()
    index = 0
    while index < len(fields) and fields[index]:
        record = fields[index].split(b"\t", 2)
        if len(record) != 3:
            raise ValueError("Invalid patch path inventory")
        name = record[2]
        index += 1
        if not name:
            paths.update(os.fsdecode(value) for value in fields[index:index + 2])
            index += 2
        else:
            paths.add(os.fsdecode(name))
    for name in paths:
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise ValueError("Patch path escapes the source root")
    return sorted(paths)


def load_series(manifest, roots):
    base = manifest.parent.resolve()
    entries = json.loads(manifest.read_text())["patch_order"]
    if not isinstance(entries, list) or not entries:
        raise ValueError("The manifest has no patch series")
    series = []
    for entry in entries:
        repo = entry["repo"]
        if repo not in roots:
            raise ValueError("Unknown patch repository")
        patch = (base / entry["file"]).resolve()
        if not patch.is_relative_to(base):
            raise ValueError("Patch file escapes the manifest directory")
        if hashlib.sha256(patch.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError("Patch SHA-256 does not match the manifest: " + patch.name)
        series.append((roots[repo], patch))
    return series


def preflight(series):
    # An empty private index stages only touched files from the current source,
    # including prerequisite patches, without copying the large source checkout.
    with tempfile.TemporaryDirectory(prefix="native-profile-patches-") as scratch:
        for number, root in enumerate(dict.fromkeys(root for root, _ in series)):
            patches = [patch for patch_root, patch in series if patch_root == root]
            paths = sorted({path for patch in patches for path in patch_paths(root, patch)})
            env = {**os.environ, "GIT_INDEX_FILE": str(Path(scratch) / str(number))}
            git(root, "read-tree", "--empty", env=env)
            existing = [path for path in paths if (root / path).exists() or (root / path).is_symlink()]
            if existing:
                git(root, "add", "--force", "--", *existing, env=env)
            for patch in patches:
                print("Preflight:", patch.name, flush=True)
                git(root, "apply", "--cached", patch, env=env)


def apply_series(series):
    applied = []
    try:
        for root, patch in series:
            print("Apply:", patch.name, flush=True)
            git(root, "apply", patch)
            applied.append((root, patch))
    except BaseException:
        for root, patch in reversed(applied):
            try:
                git(root, "apply", "--reverse", patch)
            except subprocess.CalledProcessError:
                print("Rollback failed; inspect the source before retrying:", patch.name, file=sys.stderr)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("chromium_root", type=Path)
    parser.add_argument("electron_root", type=Path)
    parser.add_argument("--manifest", type=Path, default=Path(__file__).resolve().parents[1] / "manifest.json")
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    roots = {"chromium": args.chromium_root.resolve(), "electron": args.electron_root.resolve()}
    for root in roots.values():
        actual = Path(os.fsdecode(git(root, "rev-parse", "--show-toplevel", capture=True)).strip()).resolve()
        if actual != root:
            raise ValueError("Each source root must be a Git repository root")
    series = load_series(args.manifest.resolve(), roots)
    preflight(series)
    if not args.check_only:
        apply_series(series)
    print("Patch series preflight passed." if args.check_only else "Applied the complete native profile patch series.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print("error:", error, file=sys.stderr)
        sys.exit(1)
