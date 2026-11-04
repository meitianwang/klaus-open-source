#!/usr/bin/env python3
"""Exercise ordered preflight, source preservation and rollback with synthetic repos."""

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).with_name("apply-patches.py")
SPEC = importlib.util.spec_from_file_location("native_profile_patches", MODULE)
APPLIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(APPLIER)


def change(before, after):
    return ("diff --git a/input.txt b/input.txt\n--- a/input.txt\n+++ b/input.txt\n"
            "@@ -1 +1 @@\n-" + before + "\n+" + after + "\n")


class PatchSeriesTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="native-patch-test-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.roots = {name: self.root / name for name in ("chromium", "electron")}
        for root in self.roots.values():
            root.mkdir()
            APPLIER.git(root, "init", "--quiet")
            (root / "input.txt").write_text("before\n")
            APPLIER.git(root, "add", "input.txt")
        self.indexes = {name: (root / ".git/index").read_bytes() for name, root in self.roots.items()}
        self.manifest = self.root / "manifest.json"

    def series(self, values):
        entries = []
        for index, (repo, text) in enumerate(values):
            path = self.root / (str(index) + ".patch")
            path.write_text(text)
            entries.append({"repo": repo, "file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        self.manifest.write_text(json.dumps({"patch_order": entries}))
        return APPLIER.load_series(self.manifest, self.roots)

    def assertIndexesUnchanged(self):
        for name, root in self.roots.items():
            self.assertEqual((root / ".git/index").read_bytes(), self.indexes[name])

    def test_ordered_preflight_handles_dependent_patches_without_touching_source_or_index(self):
        series = self.series([("chromium", change("before", "native")),
                              ("electron", change("before", "renamed")),
                              ("electron", change("renamed", "profile"))])
        APPLIER.preflight(series)
        for root in self.roots.values():
            self.assertEqual((root / "input.txt").read_text(), "before\n")
        self.assertIndexesUnchanged()
        APPLIER.apply_series(series)
        self.assertEqual((self.roots["chromium"] / "input.txt").read_text(), "native\n")
        self.assertEqual((self.roots["electron"] / "input.txt").read_text(), "profile\n")
        self.assertIndexesUnchanged()

    def test_invalid_later_patch_leaves_every_source_and_real_index_unchanged(self):
        series = self.series([("chromium", change("before", "native")),
                              ("electron", change("before", "renamed")),
                              ("electron", change("missing", "profile"))])
        with self.assertRaises(subprocess.CalledProcessError):
            APPLIER.preflight(series)
        for root in self.roots.values():
            self.assertEqual((root / "input.txt").read_text(), "before\n")
        self.assertIndexesUnchanged()

    def test_current_unstaged_prerequisite_content_is_used(self):
        (self.roots["electron"] / "input.txt").write_text("prerequisite\n")
        series = self.series([("electron", change("prerequisite", "profile"))])
        APPLIER.preflight(series)
        APPLIER.apply_series(series)
        self.assertEqual((self.roots["electron"] / "input.txt").read_text(), "profile\n")
        self.assertIndexesUnchanged()

    def test_hash_mismatch_rejects_before_applying_anything(self):
        self.series([("electron", change("before", "profile"))])
        (self.root / "0.patch").write_text(change("before", "tampered"))
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            APPLIER.load_series(self.manifest, self.roots)
        self.assertEqual((self.roots["electron"] / "input.txt").read_text(), "before\n")
        self.assertIndexesUnchanged()

    def test_real_apply_failure_rolls_back_only_already_applied_changes(self):
        series = self.series([("chromium", change("before", "native")),
                              ("electron", change("before", "profile"))])
        APPLIER.preflight(series)
        original = APPLIER.git

        def fail_second(root, *arguments, **kwargs):
            if root == self.roots["electron"] and arguments[:1] == ("apply",):
                raise subprocess.CalledProcessError(1, ["git", "apply"])
            return original(root, *arguments, **kwargs)

        with patch.object(APPLIER, "git", side_effect=fail_second):
            with self.assertRaises(subprocess.CalledProcessError):
                APPLIER.apply_series(series)
        for root in self.roots.values():
            self.assertEqual((root / "input.txt").read_text(), "before\n")
        self.assertIndexesUnchanged()


class ProbeResultTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("verify_native_profile_probe", MODULE.with_name("verify-probe.py"))
        self.verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.verifier)
        self.result = {"probe": "native-profile", "electron_bridge": False,
                       "extension_system_state": "native_services_initialized_dispatch_incomplete",
                       **{key: True for key in self.verifier.REQUIRED}}

    def test_all_service_checks_must_pass_even_when_ok_is_true(self):
        self.verifier.verify(self.result)
        for key in self.verifier.REQUIRED:
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    self.verifier.verify({**self.result, key: False})

    def test_bridge_and_extension_state_are_checked(self):
        for override in ({"electron_bridge": True}, {"extension_system_state": "ready"}, {"probe": "other"}):
            with self.assertRaises(ValueError):
                self.verifier.verify({**self.result, **override})

    def test_network_context_checks_must_pass(self):
        self.verifier.verify(self.result)
        for key in ("profile_network_context", "electron_network_context"):
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    self.verifier.verify({**self.result, key: False})



if __name__ == "__main__":
    unittest.main(verbosity=2)
