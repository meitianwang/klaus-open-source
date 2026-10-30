"""Run with the managed Python runtime: python -m unittest discover -s apps/desktop/tests -p pdf_skill_test.py -v."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen.canvas import Canvas

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / "resources/workspace-skills/pdf/scripts/pdf.py"


class PdfSkillTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="klaus-pdf-skill-")
        self.root = Path(self.temporary.name)
        self.pdf = self.root / "mixed source.pdf"
        scan = self.root / "scan.png"
        Image.new("RGB", (60, 60), (30, 80, 180)).save(scan)
        canvas = Canvas(str(self.pdf), pagesize=(300, 400))
        canvas.drawString(20, 350, "First page: selectable text for the document.")
        canvas.showPage()
        canvas.drawImage(str(scan), 20, 50, width=240, height=300)
        canvas.showPage()
        canvas.drawString(20, 350, "Third page: additional selectable text.")
        canvas.save()
        self.original_hash = hashlib.sha256(self.pdf.read_bytes()).hexdigest()

    def tearDown(self) -> None:
        self.assertEqual(hashlib.sha256(self.pdf.read_bytes()).hexdigest(), self.original_hash)
        self.temporary.cleanup()

    def run_helper(self, *args: str, success: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [sys.executable, str(HELPER), *map(str, args)], capture_output=True,
            text=True, timeout=20, env=env,
        )
        self.assertEqual(result.returncode, 0 if success else 2, result.stdout + result.stderr)
        return result

    def test_text_preserves_page_numbers_and_flags_scan(self) -> None:
        data = json.loads(self.run_helper("text", self.pdf).stdout)
        self.assertEqual(data["total_pages"], 3)
        self.assertEqual([row["page"] for row in data["pages"]], [1, 2, 3])
        self.assertIn("First page", data["pages"][0]["text"])
        self.assertEqual(data["pages"][1]["text"], "")
        self.assertEqual(data["sparse_text_pages"], [2])
        self.assertFalse(data["truncated"])
        self.assertTrue(any("No OCR" in warning for warning in data["warnings"]))

    def test_inspection_reports_sizes_and_image_only_pages(self) -> None:
        data = json.loads(self.run_helper("inspect", self.pdf, "--pages", "2").stdout)
        self.assertEqual(data["selected_pages"], [2])
        self.assertEqual(data["omitted_page_count"], 2)
        self.assertEqual(data["pages"][0]["width_points"], 300)
        self.assertEqual(data["pages"][0]["height_points"], 400)
        self.assertEqual(data["pages"][0]["direct_image_count"], 1)
        self.assertEqual(data["sparse_text_pages"], [2])

    def test_selection_is_bounded_and_rejects_invalid_ranges(self) -> None:
        data = json.loads(self.run_helper("text", self.pdf, "--pages", "3,1-1").stdout)
        self.assertEqual(data["selected_pages"], [1, 3])
        for pages in ("0", "4", "2-1", "1,,2", "-1", "1-9999999999999"):
            result = self.run_helper("text", self.pdf, "--pages", pages, success=False)
            self.assertIn("PDF error:", result.stderr)
        large = self.root / "many.pdf"
        writer = PdfWriter()
        for _ in range(55):
            writer.add_blank_page(width=72, height=72)
        writer.write(large)
        result = self.run_helper("text", large, "--pages", "1-51", success=False)
        self.assertIn("at most 50 pages", result.stderr)
        result = self.run_helper("render", large, "--pages", "1-11", "--output-dir", self.root / "too-many", success=False)
        self.assertIn("at most 10 pages", result.stderr)

    def test_default_sample_and_character_limit_are_explicit(self) -> None:
        large = self.root / "sample.pdf"
        writer = PdfWriter()
        for _ in range(24):
            writer.add_blank_page(width=72, height=72)
        writer.write(large)
        data = json.loads(self.run_helper("text", large).stdout)
        self.assertEqual(data["selected_pages"], list(range(1, 21)))
        self.assertEqual(data["omitted_page_count"], 4)
        data = json.loads(self.run_helper("text", self.pdf, "--max-chars", "12").stdout)
        self.assertEqual(sum(len(row["text"]) for row in data["pages"]), 12)
        self.assertTrue(data["truncated"])
        self.assertEqual(data["unprocessed_selected_pages"], [2, 3])
        self.run_helper("text", self.pdf, "--max-chars", "200001", success=False)

    def test_render_returns_real_selected_png_without_external_commands(self) -> None:
        output = self.root / "rendered pages"
        environment = {**os.environ, "PATH": ""}
        data = json.loads(self.run_helper("render", self.pdf, "--pages", "2", "--output-dir", output, "--dpi", "72", env=environment).stdout)
        self.assertEqual([row["page"] for row in data["images"]], [2])
        image_path = Path(data["images"][0]["path"])
        self.assertEqual(image_path, (output / "page-0002.png").resolve())
        self.assertEqual(image_path.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
        with Image.open(image_path) as image:
            self.assertEqual(image.size, (300, 400))
            self.assertEqual(image.getpixel((100, 200)), (30, 80, 180))
        self.assertFalse((output / "page-0001.png").exists())

    def test_output_collision_and_source_overwrite_are_refused(self) -> None:
        self.run_helper("text", self.pdf, "--output", self.pdf, "--overwrite", success=False)
        output = self.root / "existing.json"
        output.write_text("keep", encoding="utf-8")
        self.run_helper("text", self.pdf, "--output", output, success=False)
        self.assertEqual(output.read_text(), "keep")
        self.run_helper("text", self.pdf, "--output", output, "--overwrite")
        self.assertEqual(json.loads(output.read_text())["total_pages"], 3)
        render_dir = self.root / "existing-render"
        render_dir.mkdir()
        (render_dir / "page-0002.png").write_bytes(b"keep")
        self.run_helper("render", self.pdf, "--pages", "1-2", "--output-dir", render_dir, success=False)
        self.assertFalse((render_dir / "page-0001.png").exists())
        self.assertEqual((render_dir / "page-0002.png").read_bytes(), b"keep")

    def test_invalid_empty_and_oversize_documents_are_actionable(self) -> None:
        invalid = self.root / "invalid.pdf"
        invalid.write_text("not a pdf")
        self.assertIn("PDF header", self.run_helper("inspect", invalid, success=False).stderr)
        invalid.write_text("%PDF-1.4\ntruncated")
        self.assertIn("PDF could not be parsed", self.run_helper("inspect", invalid, success=False).stderr)
        empty = self.root / "empty.pdf"
        PdfWriter().write(empty)
        self.assertIn("no pages", self.run_helper("inspect", empty, success=False).stderr)
        huge = self.root / "oversize.pdf"
        with huge.open("wb") as stream:
            stream.write(b"%PDF-1.4\n")
            stream.truncate(100 * 1024 * 1024 + 1)
        self.assertIn("100 MiB", self.run_helper("inspect", huge, success=False).stderr)

    def test_encrypted_documents_need_password_without_exposing_it(self) -> None:
        encrypted = self.root / "encrypted.pdf"
        writer = PdfWriter()
        writer.append(self.pdf)
        writer.encrypt("test-secret")
        writer.write(encrypted)
        failed = self.run_helper("text", encrypted, success=False)
        self.assertIn("encrypted", failed.stderr)
        self.assertNotIn("test-secret", failed.stderr)
        self.run_helper("text", encrypted, "--password-env", "ABSENT_PDF_TEST_PASSWORD", success=False, env={})
        environment = {**os.environ, "PDF_TEST_PASSWORD": "test-secret"}
        data = json.loads(self.run_helper("text", encrypted, "--password-env", "PDF_TEST_PASSWORD", env=environment).stdout)
        self.assertIn("First page", data["pages"][0]["text"])
        self.assertNotIn("test-secret", json.dumps(data))
        images = json.loads(self.run_helper("render", encrypted, "--pages", "1", "--password-env", "PDF_TEST_PASSWORD", "--output-dir", self.root / "decrypted-images", env=environment).stdout)
        self.assertEqual(len(images["images"]), 1)

    def test_render_caps_reject_oversize_images_before_writing(self) -> None:
        self.run_helper("render", self.pdf, "--pages", "1", "--output-dir", self.root / "high-dpi", "--dpi", "201", success=False)
        huge_page = self.root / "huge-page.pdf"
        writer = PdfWriter()
        writer.add_blank_page(width=20_000, height=20_000)
        writer.write(huge_page)
        output_dir = self.root / "huge-image"
        result = self.run_helper("render", huge_page, "--output-dir", output_dir, "--dpi", "72", success=False)
        self.assertIn("megapixel", result.stderr)
        self.assertFalse(output_dir.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
