#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import sys
from pathlib import Path
from zipfile import ZipFile

from docx import Document

from ooxml_engine import DocxPackage, W, pack_docx, unpack_docx, validate_docx, xml_parts, parts

INPUT_BYTES_LIMIT = 100 * 1024 * 1024
DEFAULT_MAX_CHARS = 200_000


class DocxError(Exception):
    pass


def open_archive(path):
    if path.stat().st_size > INPUT_BYTES_LIMIT:
        raise DocxError('Input exceeds 100 MiB.')
    with path.open('rb') as stream:
        if stream.read(8) == bytes.fromhex('d0cf11e0a1b11ae1'):
            raise DocxError('Legacy binary .doc is not OOXML. Convert it to .docx first.')
    archive = ZipFile(path)
    if (sum(item.file_size for item in archive.infolist()) > 5 * INPUT_BYTES_LIMIT
            or 'word/document.xml' not in archive.namelist()):
        archive.close()
        raise DocxError('Expected a Word OOXML archive within the expanded size limit.')
    return archive


def text_of(node, revisions=False):
    tag = node.tag
    if tag in (W + 't', W + 'delText'):
        return node.text or ''
    if tag in (W + 'tab', W + 'br'):
        return '\t' if tag.endswith('tab') else '\n'
    if tag == W + 'del' and not revisions:
        return ''
    text = ''.join(text_of(child, revisions) for child in node)
    if revisions and tag in (W + 'ins', W + 'del'):
        marker = '+' if tag == W + 'ins' else '-'
        return '{' + marker + text + marker + '}'
    return text


def run(args, archive):
    path = args.input
    names = set(archive.namelist())
    roots = xml_parts(parts(path))
    root = roots['word/document.xml']
    comments_root = roots.get('word/comments.xml')
    comments = comments_root.findall(W + 'comment') if comments_root is not None else []
    doc = Document(path)
    if args.command == 'inspect':
        props = doc.core_properties
        return dict(file=str(path), bytes=path.stat().st_size,
                    coreProperties={key: getattr(props, key) for key in ('title', 'author', 'subject', 'created', 'modified')},
                    sectionCount=len(doc.sections), paragraphCount=len(doc.paragraphs),
                    headingOutline=[dict(index=i, style=p.style.name, text=p.text[:1000]) for i, p in enumerate(doc.paragraphs) if p.style.name.startswith('Heading')][:200],
                    tableCount=len(doc.tables), tables=[dict(index=i, rows=len(t.rows), cols=len(t.columns)) for i, t in enumerate(doc.tables) if i < 200],
                    commentCount=len(comments), trackedChanges=dict(insertions=len(list(root.iter(W + 'ins'))), deletions=len(list(root.iter(W + 'del')))),
                    mediaCount=sum(name.startswith('word/media/') and not name.endswith('/') for name in names))
    remaining = args.max_chars
    truncated = False
    omitted = 0

    def clip(value):
        nonlocal remaining, truncated
        result = value[:remaining]
        remaining -= len(result)
        truncated |= len(result) < len(value)
        return result

    paragraphs = []
    styles = {style.style_id: style.name for style in doc.styles}
    for p in root.findall(f'{W}body/{W}p'):
        if remaining <= 0 or len(paragraphs) >= DEFAULT_MAX_CHARS:
            omitted += 1
            truncated = True
            continue
        style = p.find(f'{W}pPr/{W}pStyle')
        key = style.get(W + 'val', '') if style is not None else 'Normal'
        paragraphs.append(dict(style=clip(styles.get(key, key)), text=clip(text_of(p, args.include_revisions))))
    tables = []
    for table in root.findall(f'{W}body/{W}tbl'):
        rows = []
        for row in table.findall(W + 'tr'):
            if not remaining:
                truncated = True
                break
            cells = []
            for cell in row.findall(W + 'tc'):
                if not remaining:
                    truncated = True
                    break
                remaining -= 1
                cells.append(clip(text_of(cell, args.include_revisions)))
            rows.append(cells)
        if not rows and not remaining:
            break
        tables.append(rows)
    selected = []
    if args.include_comments:
        for comment in comments:
            if not remaining:
                truncated = True
                break
            remaining -= 1
            selected.append({**{k: clip(comment.get(W + k, '')) for k in ('id', 'author', 'date')}, 'text': clip(text_of(comment))})
    return dict(paragraphs=paragraphs, tables=tables, comments=selected, truncated=truncated, omittedParagraphs=omitted)


def render(input_path, output, soffice=None, dpi=144):
    import pypdfium2

    candidates = (shutil.which('soffice'), shutil.which('libreoffice'),
                  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
                  str(Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'LibreOffice/program/soffice.exe'))
    binary = soffice or next((item for item in candidates if item and Path(item).is_file()), None)
    if not binary:
        raise DocxError('Cannot find soffice; pass --soffice with its absolute path.')
    if not 36 <= dpi <= 300:
        raise DocxError('--dpi must be between 36 and 300')
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp).resolve()
        source = directory / 'source.docx'
        shutil.copyfile(input_path, source)
        process = subprocess.run([binary, '-env:UserInstallation=' + (directory / 'profile').as_uri(),
                                  '--headless', '--convert-to', 'pdf', '--outdir', str(directory), str(source)],
                                 capture_output=True, text=True, timeout=120)
        pdf = directory / 'source.pdf'
        if process.returncode or not pdf.is_file():
            raise DocxError('PDF conversion failed: ' + (process.stderr or process.stdout).strip())
        pages = []
        with pypdfium2.PdfDocument(str(pdf)) as document:
            for index in range(len(document)):
                page = document[index]
                try:
                    bitmap = page.render(scale=dpi / 72)
                    try:
                        path = output / f'page-{index + 1:03}.png'
                        bitmap.to_pil().save(path)
                        pages.append(str(path))
                    finally:
                        bitmap.close()
                finally:
                    page.close()
    return {'pages': pages}


def main():
    parser = argparse.ArgumentParser(description='Inspect, edit, validate, and render Word OOXML files.')
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('inspect', 'text', 'unpack', 'redline', 'comment', 'validate', 'pack', 'render'):
        command = commands.add_parser(name)
        command.add_argument('input', type=Path)
        if name in ('unpack', 'pack', 'render'):
            command.add_argument('output', type=Path)
        if name == 'text':
            command.add_argument('--max-chars', type=int, default=DEFAULT_MAX_CHARS)
            command.add_argument('--include-tables', action='store_true', help='Include tables (the default).')
            command.add_argument('--include-comments', action='store_true')
            command.add_argument('--include-revisions', action='store_true')
        if name in ('redline', 'comment', 'validate', 'pack'):
            command.add_argument('--author', default='Klaus')
        if name in ('redline', 'comment'):
            command.add_argument('--initials', default='K')
            command.add_argument('--occurrence', type=int)
            command.add_argument('text')
        if name == 'redline':
            command.add_argument('replacement')
        if name == 'comment':
            anchor = command.add_mutually_exclusive_group(required=True)
            anchor.add_argument('--anchor')
            anchor.add_argument('--reply-to')
        if name in ('validate', 'pack'):
            command.add_argument('--original', type=Path)
        if name == 'pack':
            command.add_argument('--validate', action=argparse.BooleanOptionalAction, default=True)
        if name == 'render':
            command.add_argument('--soffice')
            command.add_argument('--dpi', type=int, default=144)
    args = parser.parse_args()
    if args.command == 'text' and not 1 <= args.max_chars <= DEFAULT_MAX_CHARS:
        parser.error(f'--max-chars must be between 1 and {DEFAULT_MAX_CHARS}')
    try:
        if args.command in ('inspect', 'text'):
            with open_archive(args.input) as archive:
                result = run(args, archive)
        elif args.command == 'validate':
            result = validate_docx(args.input, args.original, args.author)
        elif args.command == 'unpack':
            result = {'directory': str(unpack_docx(args.input, args.output))}
        elif args.command == 'pack':
            result = {'file': str(pack_docx(args.input, args.output, args.validate, args.original, args.author))}
        elif args.command == 'render':
            result = render(args.input, args.output, args.soffice, args.dpi)
        else:
            package = DocxPackage(args.input, args.author, args.initials)
            if args.command == 'redline':
                identifier = package.propose_replace(args.text, args.replacement, args.occurrence)
            elif args.reply_to is not None:
                identifier = package.reply_comment(args.reply_to, args.text)
            else:
                identifier = package.add_comment(args.anchor, args.text, args.occurrence)
            package.save()
            result = {'id': identifier}
    except Exception as exc:
        print(json.dumps({'error': str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps(result, default=str))
    return int(not result.get('valid', True))


if __name__ == '__main__':
    sys.exit(main())
