#!/usr/bin/env python3
"""Bounded local PDF inspection, text extraction, and page rendering."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sys
from typing import Any

INPUT_BYTES_LIMIT = 100 * 1024 * 1024
TEXT_CHAR_LIMIT = 200_000
PAGE_PIXEL_LIMIT = 20_000_000
BATCH_PIXEL_LIMIT = 60_000_000


class PdfError(Exception):
    """An actionable failure suitable for command output."""


def positive_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def page_numbers(selection: str | None, count: int, default: int, cap: int, command: str) -> list[int]:
    if not count:
        raise PdfError("PDF has no pages.")
    if selection is None:
        return list(range(1, min(count, default) + 1))
    selected: set[int] = set()
    for token in selection.split(","):
        bounds = token.strip().split("-")
        if len(bounds) not in (1, 2) or not all(item.strip().isdigit() for item in bounds):
            raise PdfError("Use one-based page numbers or ranges, for example --pages 1-3,7.")
        first, last = int(bounds[0]), int(bounds[-1])
        if first < 1 or last < first or last > count:
            raise PdfError(f"Page range {token!r} is outside 1-{count} or reversed.")
        if last - first + 1 > cap:
            raise PdfError(f"Select at most {cap} pages per {command} batch.")
        selected.update(range(first, last + 1))
        if len(selected) > cap:
            raise PdfError(f"Select at most {cap} pages per {command} batch.")
    return sorted(selected)


def source_path(raw: str) -> Path:
    path = Path(raw).expanduser().resolve()
    if not path.is_file():
        raise PdfError(f"Input is not a readable file: {path}")
    if path.stat().st_size > INPUT_BYTES_LIMIT:
        raise PdfError("Input exceeds the 100 MiB limit. Split the PDF into smaller files first.")
    with path.open("rb") as stream:
        if b"%PDF-" not in stream.read(1024):
            raise PdfError("Input does not have a PDF header. Supply a valid PDF file.")
    return path


def load_reader(path: Path, password: str | None) -> Any:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(path)
        if reader.is_encrypted and not reader.decrypt(password or ""):
            raise PdfError(
                "PDF is encrypted or the password is incorrect. Supply a decrypted copy "
                "or use --password-env NAME with the password in that environment variable."
            )
        len(reader.pages)
        return reader
    except PdfReadError as error:
        raise PdfError(f"PDF could not be parsed: {error}. Supply a valid, decrypted PDF.") from error


def image_count(page: Any) -> int:
    resources = page.get("/Resources", {})
    if hasattr(resources, "get_object"):
        resources = resources.get_object()
    objects = resources.get("/XObject", {})
    if hasattr(objects, "get_object"):
        objects = objects.get_object()
    return sum(1 for item in objects.values() if item.get_object().get("/Subtype") == "/Image")


def extract(page: Any, number: int) -> str:
    try:
        return page.extract_text() or ""
    except Exception as error:
        raise PdfError(f"Text extraction failed on page {number}: {error}. Try rendering that page.") from error


def common_result(path: Path, count: int, numbers: list[int]) -> dict[str, Any]:
    warnings = []
    if len(numbers) < count:
        warnings.append(f"Selected {len(numbers)} of {count} pages; unselected pages were not processed.")
    return {
        "path": str(path), "total_pages": count, "selected_pages": numbers,
        "omitted_page_count": count - len(numbers), "warnings": warnings,
    }


def inspect_pdf(reader: Any, result: dict[str, Any]) -> None:
    pages = []
    sparse = []
    for number in result["selected_pages"]:
        page = reader.pages[number - 1]
        text = extract(page, number)
        chars = len(text.strip())
        pages.append({
            "page": number, "width_points": float(page.mediabox.width),
            "height_points": float(page.mediabox.height), "text_characters": chars,
            "direct_image_count": image_count(page),
        })
        if chars < 20:
            sparse.append(number)
    result["pages"] = pages
    result["sparse_text_pages"] = sparse
    if sparse:
        result["warnings"].append(
            "Pages with little extractable text may be scans, illustrations, or blank pages; "
            "render them for visual assessment. No OCR was performed."
        )


def text_pdf(reader: Any, result: dict[str, Any], limit: int) -> None:
    if limit > TEXT_CHAR_LIMIT:
        raise PdfError(f"--max-chars must not exceed {TEXT_CHAR_LIMIT}; use smaller page batches.")
    pages = []
    sparse = []
    remaining = limit
    truncated = False
    for number in result["selected_pages"]:
        text = extract(reader.pages[number - 1], number)
        if len(text.strip()) < 20:
            sparse.append(number)
        included = text[:remaining]
        page_truncated = len(included) != len(text)
        pages.append({"page": number, "text": included, "truncated": page_truncated})
        remaining -= len(included)
        truncated = truncated or page_truncated
        if remaining == 0:
            break
    result["pages"] = pages
    result["unprocessed_selected_pages"] = result["selected_pages"][len(pages):]
    result["truncated"] = truncated or bool(result["unprocessed_selected_pages"])
    result["sparse_text_pages"] = sparse
    result["warnings"].append(
        "Text extraction does not include image content and may not preserve visual reading order or tables."
    )
    if sparse:
        result["warnings"].append(
            "Some pages have little extractable text. Render them before claiming complete coverage. No OCR was performed."
        )
    if result["truncated"]:
        result["warnings"].append("Character limit reached; continue with smaller page batches or a larger --max-chars.")


def check_output(path: Path, source: Path, overwrite: bool) -> None:
    if path.resolve() == source:
        raise PdfError("Output would replace the source PDF. Choose another output path.")
    if path.exists() and not overwrite:
        raise PdfError(f"Output already exists: {path}. Choose another path or pass --overwrite.")


def render_pdf(path: Path, password: str | None, result: dict[str, Any], args: argparse.Namespace) -> None:
    import pypdfium2 as pdfium

    if args.dpi > 200:
        raise PdfError("--dpi must not exceed 200; render selected pages at a lower resolution.")
    output_dir = Path(args.output_dir).expanduser().resolve()
    if output_dir == path:
        raise PdfError("The output directory cannot be the source PDF.")
    scale = args.dpi / 72
    document = pdfium.PdfDocument(str(path), password=password)
    try:
        plan = []
        total_pixels = 0
        for number in result["selected_pages"]:
            page = document[number - 1]
            try:
                width, height = page.get_size()
                pixels = math.ceil(width * scale) * math.ceil(height * scale)
            finally:
                page.close()
            if not math.isfinite(pixels) or pixels > PAGE_PIXEL_LIMIT:
                raise PdfError(f"Page {number} exceeds the 20 megapixel limit. Reduce --dpi.")
            total_pixels += pixels
            if total_pixels > BATCH_PIXEL_LIMIT:
                raise PdfError("Rendering exceeds the 60 megapixel batch limit. Select fewer pages or reduce --dpi.")
            output = output_dir / f"page-{number:04d}.png"
            check_output(output, path, args.overwrite)
            plan.append((number, output))
        output_dir.mkdir(parents=True, exist_ok=True)
        images = []
        for number, output in plan:
            page = document[number - 1]
            try:
                bitmap = page.render(scale=scale)
                try:
                    image = bitmap.to_pil()
                    try:
                        with output.open("wb" if args.overwrite else "xb") as stream:
                            image.save(stream, format="PNG")
                        images.append({"page": number, "path": str(output), "width": image.width, "height": image.height})
                    finally:
                        image.close()
                finally:
                    bitmap.close()
            finally:
                page.close()
        result["images"] = images
        result["dpi"] = args.dpi
    finally:
        document.close()


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    for command in ("inspect", "text", "render"):
        item = commands.add_parser(command)
        item.add_argument("input", help="PDF file (at most 100 MiB)")
        item.add_argument("--pages", help="one-based pages, such as 1-3,7 (text/inspect cap: 50, render cap: 10)")
        item.add_argument("--password-env", help="name of an environment variable containing the PDF password")
        item.add_argument("--output", help="write JSON to a new file instead of standard output")
        item.add_argument("--overwrite", action="store_true", help="allow replacing existing derivative files")
        if command == "text":
            item.add_argument("--max-chars", type=positive_int, default=30_000, help="total extracted characters, at most 200000 (default: 30000)")
        if command == "render":
            item.add_argument("--output-dir", required=True, help="directory for page-NNNN.png files")
            item.add_argument("--dpi", type=positive_int, default=110, help="render resolution, at most 200 (default: 110)")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        password = None
        if args.password_env:
            password = os.environ.get(args.password_env)
            if password is None:
                raise PdfError(f"Password environment variable {args.password_env!r} is not set.")
        path = source_path(args.input)
        reader = load_reader(path, password)
        try:
            count = len(reader.pages)
            defaults = {"inspect": 10, "text": 20, "render": 3}
            numbers = page_numbers(args.pages, count, defaults[args.command], 10 if args.command == "render" else 50, args.command)
            result = common_result(path, count, numbers)
            output = Path(args.output).expanduser().resolve() if args.output else None
            if output:
                check_output(output, path, args.overwrite)
            if args.command == "inspect":
                inspect_pdf(reader, result)
            elif args.command == "text":
                text_pdf(reader, result, args.max_chars)
            else:
                render_pdf(path, password, result, args)
        finally:
            reader.close()
        encoded = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
        if output:
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("w" if args.overwrite else "x", encoding="utf-8") as stream:
                stream.write(encoded)
            print(json.dumps({"output": str(output)}, ensure_ascii=False))
        else:
            print(encoded, end="")
        return 0
    except ImportError as error:
        print(
            "PDF error: Managed PDF dependencies are unavailable. Call load_workspace_dependencies "
            f"and use its returned pythonPath. Missing module: {error.name}", file=sys.stderr,
        )
    except PdfError as error:
        print(f"PDF error: {error}", file=sys.stderr)
    except Exception as error:
        print(f"PDF error: {type(error).__name__}: {error}. Check the input, password, and output permissions.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
