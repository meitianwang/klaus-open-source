"""Edit WordprocessingML packages without rebuilding unrelated parts."""
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import posixpath
import re
import secrets
import stat
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile, ZIP_DEFLATED

from defusedxml.ElementTree import fromstring
from lxml import etree as E

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
W14 = '{http://schemas.microsoft.com/office/word/2010/wordml}'
W15 = '{http://schemas.microsoft.com/office/word/2012/wordml}'
CT = '{http://schemas.openxmlformats.org/package/2006/content-types}'
REL = '{http://schemas.openxmlformats.org/package/2006/relationships}'
SPACE = '{http://www.w3.org/XML/1998/namespace}space'
MANIFEST = 'unpack-manifest.json'
REVISIONS = {W + 'ins', W + 'del'}
TEXT = {W + name for name in ('t', 'delText', 'instrText', 'delInstrText')}


def parse(data):
    fromstring(data, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    return E.fromstring(data, E.XMLParser(resolve_entities=False, no_network=True))


def safe_name(name):
    if any(part in ('', '.', '..') for part in name.split('/')) or any(c in name for c in '\\:\x00'):
        raise ValueError(f'Unsafe package path: {name!r}')
    return name


def parts(path):
    path = Path(path)
    if path.is_dir():
        result = {}
        for entry in path.rglob('*'):
            if entry.is_symlink():
                raise ValueError(f'Symlink in package: {entry}')
            if entry.is_file() and entry != path / MANIFEST:
                result[safe_name(entry.relative_to(path).as_posix())] = entry.read_bytes()
    else:
        with ZipFile(path) as archive:
            result = {}
            seen = set()
            entries = archive.infolist()
            if len(entries) > 20000 or sum(item.file_size for item in entries) > 500 * 1024**2:
                raise ValueError('Package exceeds archive limits')
            for item in entries:
                name = safe_name(item.filename.rstrip('/'))
                if name.casefold() in seen or stat.S_ISLNK(item.external_attr >> 16):
                    raise ValueError(f'Duplicate or symlink member: {name}')
                seen.add(name.casefold())
                if not item.is_dir():
                    result[name] = archive.read(item)
    if MANIFEST in result or 'word/document.xml' not in result:
        raise ValueError('Invalid document package')
    return result


def xml_parts(files):
    return {name: parse(data) for name, data in files.items() if name.lower().endswith(('.xml', '.rels'))}


def clean(root):
    for node in root.iter():
        if node.tag not in TEXT and len(node) and node.text and not node.text.strip():
            node.text = None
        if node.getparent() is not None and node.getparent().tag not in TEXT and node.tail and not node.tail.strip():
            node.tail = None


def serialize(root, pretty=False):
    clean(root)
    return E.tostring(root, encoding='UTF-8', xml_declaration=True, pretty_print=pretty)


def visible(node):
    if node.tag in {W + 'del', W + 'moveFrom'}:
        return ''
    if node.tag == W + 't':
        return node.text or ''
    if node.tag in {W + 'tab', W + 'br', W + 'cr'}:
        return '\t' if node.tag == W + 'tab' else '\n'
    return ''.join(map(visible, node))


def text_node(run, text, tag='t'):
    node = E.SubElement(run, W + tag)
    node.text = text
    if text != text.strip():
        node.set(SPACE, 'preserve')
    return node


def simple(run):
    return run.tag == W + 'r' and all(c.tag in {W + 'rPr', W + 't'} for c in run) and run.find(W + 't') is not None


def props(run):
    return run.find(W + 'rPr')


def formatting(run):
    node = props(run)
    if node is None:
        return None
    return (node.tag, sorted(node.attrib.items()), (node.text or '').strip(), tuple(formatting_node(child) for child in node))


def formatting_node(node):
    return (node.tag, sorted(node.attrib.items()), (node.text or '').strip(), tuple(map(formatting_node, node)))


def fresh(used):
    while True:
        value = secrets.token_hex(4).upper()
        if value not in used and value != '00000000':
            return value


def unpack_docx(docx_path, output_dir):
    files = parts(docx_path)
    roots = xml_parts(files)
    used = set(re.findall(rb'\b[A-Fa-f0-9]{8}\b', b' '.join(files[n] for n in roots)))
    rsid = fresh({value.decode().upper() for value in used})
    directory = Path(output_dir)
    if directory.is_symlink() or (directory.exists() and any(directory.iterdir())):
        raise ValueError('Unpack requires an empty output directory')
    for name, root in roots.items():
        for paragraph in root.iter(W + 'p'):
            previous = None
            for run in list(paragraph):
                if not simple(run):
                    previous = None
                    continue
                if previous is not None and previous.attrib == run.attrib and formatting(previous) == formatting(run):
                    for text in list(run.findall(W + 't')):
                        if (text.text or '') != (text.text or '').strip():
                            text.set(SPACE, 'preserve')
                        previous.append(text)
                    paragraph.remove(run)
                else:
                    previous = run
        files[name] = serialize(root, pretty=True)
    for name, data in files.items():
        target = directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(data)
    (directory / MANIFEST).write_text(json.dumps({'rsid': rsid}) + '\n', encoding='utf-8')
    return directory


def story(name):
    return bool(re.fullmatch(r'word/(document|header[^/]*|footer[^/]*)\.xml', name))


def mark(paragraph, tag):
    for node in paragraph.findall(f'{W}pPr/{W}rPr/{W}{tag}'):
        yield node


def resolve(root, accept, selected):
    removed, kept = ('del', 'ins') if accept else ('ins', 'del')
    for node in reversed(list(root.iter())):
        if node.tag not in REVISIONS or not selected(node):
            continue
        parent = node.getparent()
        if parent.tag == W + 'rPr' and parent.getparent().tag == W + 'pPr':
            continue
        index = parent.index(node)
        if node.tag == W + kept:
            if not accept:
                for child in node.iter():
                    if child.tag == W + 'delText':
                        child.tag = W + 't'
                    elif child.tag == W + 'delInstrText':
                        child.tag = W + 'instrText'
            for child in list(node):
                parent.insert(index, child)
                index += 1
        parent.remove(node)
    for paragraph in list(root.iter(W + 'p')):
        parent = paragraph.getparent()
        for tag in (kept, removed):
            for node in list(mark(paragraph, tag)):
                if not selected(node):
                    continue
                node.getparent().remove(node)
                if tag == removed:
                    following = paragraph.getnext()
                    children = [child for child in paragraph if child.tag != W + 'pPr']
                    if following is not None and following.tag == W + 'p':
                        insertion = int(following.find(W + 'pPr') is not None)
                        for child in children:
                            following.insert(insertion, child)
                            insertion += 1
                    elif children:
                        # Never discard surviving content when there is no paragraph to merge into.
                        continue
                    parent.remove(paragraph)


class DocxPackage:
    def __init__(self, unpacked_dir, author='Klaus', initials='K'):
        self.directory = Path(unpacked_dir)
        self.roots = xml_parts(parts(self.directory))
        self.document = self.roots['word/document.xml']
        self.author, self.initials = author, initials
        manifest = self.directory / MANIFEST
        used = {value.upper() for root in self.roots.values() for node in root.iter() for value in node.attrib.values()}
        self.rsid = json.loads(manifest.read_text())['rsid'] if manifest.exists() else fresh(used)
        if not re.fullmatch('[A-F0-9]{8}', self.rsid):
            raise ValueError('Invalid manifest RSID')
        self.dirty = set()
        self.next_id = max((int(value) for root in self.roots.values() for node in root.iter()
                            if (value := node.get(W + 'id')) and re.fullmatch(r'[0-9]+', value)), default=-1) + 1

    def find(self, kind, query=None, *, regex=None, index=None, xpath=None, part='word/document.xml'):
        root = self.roots[part]
        tag = W + {'paragraph': 'p', 'run': 'r', 'table': 'tbl'}[kind]
        nodes = root.xpath(xpath, namespaces={'w': W[1:-1]}) if xpath else root.iter(tag)
        if isinstance(query, int):
            index, query = query, None
        matches = [node for node in nodes if getattr(node, 'tag', None) == tag
                   and (query is None or query in visible(node)) and (regex is None or re.search(regex, visible(node)))]
        return matches if index is None else matches[index]

    def find_paragraphs(self, *args, **kwargs):
        return self.find('paragraph', *args, **kwargs)

    def find_runs(self, *args, **kwargs):
        return self.find('run', *args, **kwargs)

    def find_tables(self, *args, **kwargs):
        return self.find('table', *args, **kwargs)

    def _id(self):
        value = str(self.next_id)
        self.next_id += 1
        return value

    def _revision(self, tag):
        return E.Element(W + tag, {W + 'id': self._id(), W + 'author': self.author,
                                  W + 'date': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')})

    def _span(self, text, occurrence):
        if not text:
            raise ValueError('Anchor text must not be empty')
        matches = []
        for p in self.document.iter(W + 'p'):
            value = visible(p)
            for match in re.finditer(re.escape(text), value):
                matches.append((p, match.start(), match.end()))
        if occurrence is None and len(matches) != 1:
            raise ValueError(f'Expected one match; found {len(matches)}. Specify an occurrence for repeated text.')
        index = 0 if occurrence is None else occurrence
        if not 0 <= index < len(matches):
            raise ValueError('Occurrence is out of range')
        p, start, end = matches[index]
        selected = []
        offset = 0
        for child in p:
            value = visible(child)
            stop = offset + len(value)
            if start < stop and offset < end:
                if not simple(child):
                    raise ValueError('Match crosses a complex or already revised run')
                selected.append((child, max(0, start - offset), min(len(value), end - offset)))
            elif start < offset < end and child.tag != W + 'r':
                raise ValueError('Match crosses an inline boundary')
            offset = stop
        if not selected or sum(b - a for _, a, b in selected) != len(text):
            raise ValueError('Cannot isolate match')
        runs = []
        for run, start, end in selected:
            index = p.index(run)
            offset = 0
            segments = [deepcopy(run) for _ in range(3)]
            for segment in segments:
                for node in list(segment.findall(W + 't')):
                    segment.remove(node)
            for node in run.findall(W + 't'):
                value = node.text or ''
                for segment, left, right in zip(segments, (0, start, end), (start, end, float('inf'))):
                    piece = value[max(0, left - offset):min(len(value), right - offset)] if right > offset else ''
                    if piece and left < offset + len(value):
                        clone = deepcopy(node)
                        clone.text = piece
                        if piece != piece.strip():
                            clone.set(SPACE, 'preserve')
                        segment.append(clone)
                offset += len(value)
            for segment in segments:
                if segment.find(W + 't') is not None:
                    p.insert(index, segment)
                    index += 1
            runs.append(segments[1])
            p.remove(run)
        self.dirty.add('word/document.xml')
        return p, runs

    def _part(self, name, tag, content_type, relationship):
        if name not in self.roots:
            self.roots[name] = E.Element(tag, nsmap={'w': W[1:-1], 'w14': W14[1:-1], 'w15': W15[1:-1]})
        types = self.roots['[Content_Types].xml']
        if not any(node.get('PartName') == '/' + name for node in types):
            E.SubElement(types, CT + 'Override', PartName='/' + name, ContentType=content_type)
            self.dirty.add('[Content_Types].xml')
        path = 'word/_rels/document.xml.rels'
        if path not in self.roots:
            self.roots[path] = E.Element(REL + 'Relationships', nsmap={None: REL[1:-1]})
        links = self.roots[path]
        target = posixpath.basename(name)
        if not any(node.get('Type') == relationship for node in links):
            ids = {node.get('Id') for node in links}
            index = 1
            while f'rId{index}' in ids:
                index += 1
            E.SubElement(links, REL + 'Relationship', Id=f'rId{index}', Type=relationship, Target=target)
            self.dirty.add(path)
        self.dirty.add(name)
        return self.roots[name]

    def _settings(self, p):
        p.set(W + 'rsidR', self.rsid)
        setting = self._part('word/settings.xml', W + 'settings',
                             'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
                             'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings')
        rsids = setting.find(W + 'rsids')
        if rsids is None:
            rsids = E.Element(W + 'rsids')
            successors = {W + n for n in ('mathPr', 'uiCompat97To2003', 'attachedSchema', 'themeFontLang',
                                         'clrSchemeMapping', 'doNotIncludeSubdocsInStats', 'doNotAutoCompressPictures',
                                         'forceUpgrade', 'captions', 'readModeInkLockDown', 'smartTagType', 'decimalSymbol', 'listSeparator')}
            setting.insert(next((i for i, c in enumerate(setting) if c.tag in successors or not str(c.tag).startswith(W)), len(setting)), rsids)
        if not any(node.get(W + 'val') == self.rsid for node in rsids):
            E.SubElement(rsids, W + 'rsid', {W + 'val': self.rsid})
        self.dirty.add('word/document.xml')

    def propose_replace(self, target_text, replacement_text, occurrence=None):
        p, runs = self._span(target_text, occurrence)
        deleted = self._revision('del')
        p.insert(p.index(runs[0]), deleted)
        for run in runs:
            for node in run.findall(W + 't'):
                node.tag = W + 'delText'
            deleted.append(run)
        if replacement_text:
            inserted = self._revision('ins')
            run = E.SubElement(inserted, W + 'r')
            prop = props(runs[0])
            if prop is not None:
                run.append(deepcopy(prop))
            text_node(run, replacement_text)
            deleted.addnext(inserted)
        self._settings(p)
        return deleted.get(W + 'id')

    def _paragraph_mark(self, p, tag):
        pp = p.find(W + 'pPr')
        if pp is None:
            pp = E.Element(W + 'pPr')
            p.insert(0, pp)
        rp = pp.find(W + 'rPr')
        if rp is None:
            rp = E.Element(W + 'rPr')
            pp.insert(next((i for i, child in enumerate(pp) if child.tag in {W + 'sectPr', W + 'pPrChange'}), len(pp)), rp)
        if any(child.tag in REVISIONS for child in rp):
            raise ValueError('Paragraph mark already has a revision')
        rp.insert(0, self._revision(tag))

    def insert_paragraph_tracked(self, text, *, before=None, after=None):
        if before is not None and after is not None:
            raise ValueError('Specify before or after, not both')
        body = self.document.find(W + 'body')
        anchor = before if before is not None else after
        if isinstance(anchor, int):
            anchor = self.find_paragraphs(index=anchor)
        p = E.Element(W + 'p')
        self._paragraph_mark(p, 'ins')
        wrapper = self._revision('ins')
        p.append(wrapper)
        text_node(E.SubElement(wrapper, W + 'r'), text)
        if anchor is not None:
            (anchor.addprevious if before is not None else anchor.addnext)(p)
        else:
            section = body.find(W + 'sectPr')
            if section is None:
                body.append(p)
            else:
                section.addprevious(p)
        self._settings(p)
        return p

    def delete_paragraph_tracked(self, paragraph):
        p = self.find_paragraphs(index=paragraph) if isinstance(paragraph, int) else paragraph
        runs = [node for node in p if node.tag != W + 'pPr']
        if not all(simple(run) for run in runs) or p.find(f'{W}pPr/{W}sectPr') is not None:
            raise ValueError('Paragraph contains complex content or a section break')
        self._paragraph_mark(p, 'del')
        if runs:
            wrapper = self._revision('del')
            p.append(wrapper)
            for run in runs:
                for node in run.findall(W + 't'):
                    node.tag = W + 'delText'
                wrapper.append(run)
        self._settings(p)

    def _resolve(self, accept, author, ids):
        wanted = None if ids is None else set(map(str, ids))
        for name, root in self.roots.items():
            if story(name):
                resolve(root, accept, lambda n: (author is None or n.get(W + 'author') == author)
                        and (wanted is None or n.get(W + 'id') in wanted))
                self.dirty.add(name)

    def accept_revisions(self, *, author=None, ids=None):
        self._resolve(True, author, ids)

    def reject_revisions(self, *, author=None, ids=None):
        self._resolve(False, author, ids)

    def _comments(self):
        base = 'http://schemas.microsoft.com/office/2011/relationships/'
        return (
            self._part('word/comments.xml', W + 'comments', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
                       'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'),
            self._part('word/commentsExtended.xml', W15 + 'commentsEx', 'application/vnd.ms-word.commentsExtended+xml', base + 'commentsExtended'),
            self._part('word/people.xml', W15 + 'people', 'application/vnd.ms-word.people+xml', base + 'people'),
        )

    def _comment(self, text, parent_id=None):
        comments, extended, people = self._comments()
        parent_para = None
        used = {node.get(W14 + 'paraId') for node in comments.iter(W + 'p')}
        if parent_id is not None:
            parent = next((node for node in comments if node.get(W + 'id') == str(parent_id)), None)
            if parent is None:
                raise ValueError('Unknown parent comment')
            p = list(parent.iter(W + 'p'))[-1]
            parent_para = p.get(W14 + 'paraId')
            if parent_para is None:
                parent_para = fresh(used)
                p.set(W14 + 'paraId', parent_para)
                used.add(parent_para)
            if not any(node.get(W15 + 'paraId') == parent_para for node in extended):
                E.SubElement(extended, W15 + 'commentEx', {W15 + 'paraId': parent_para, W15 + 'done': '0'})
        para_id = fresh(used)
        attrib = dict(self._revision('ins').attrib)
        attrib[W + 'initials'] = self.initials
        comment = E.SubElement(comments, W + 'comment', attrib)
        p = E.SubElement(comment, W + 'p', {W14 + 'paraId': para_id})
        text_node(E.SubElement(p, W + 'r'), text)
        entry = E.SubElement(extended, W15 + 'commentEx', {W15 + 'paraId': para_id, W15 + 'done': '0'})
        if parent_para:
            entry.set(W15 + 'paraIdParent', parent_para)
        if not any(node.get(W15 + 'author') == self.author for node in people):
            E.SubElement(people, W15 + 'person', {W15 + 'author': self.author})
        return attrib[W + 'id']

    def add_comment(self, anchor_text, comment_text, occurrence=None):
        p, runs = self._span(anchor_text, occurrence)
        cid = self._comment(comment_text)
        p.insert(p.index(runs[0]), E.Element(W + 'commentRangeStart', {W + 'id': cid}))
        end = E.Element(W + 'commentRangeEnd', {W + 'id': cid})
        runs[-1].addnext(end)
        reference = E.Element(W + 'r')
        E.SubElement(reference, W + 'commentReference', {W + 'id': cid})
        end.addnext(reference)
        return cid

    def reply_comment(self, parent_comment_id, reply_text):
        return self._comment(reply_text, parent_comment_id)

    def save(self):
        for name in sorted(self.dirty):
            path = self.directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(serialize(self.roots[name], pretty=True))
        self.dirty.clear()


def paragraph_text(root):
    return [re.sub(r'\s+', ' ', visible(p)).strip() for p in root.iter(W + 'p')]


def validate_docx(target_path_or_dir, original_docx=None, author='Klaus'):
    errors = []
    counts = dict(sectionCount=0, paragraphCount=0, tableCount=0)
    try:
        files = parts(target_path_or_dir)
        roots = xml_parts(files)
        types = roots['[Content_Types].xml']
        if types.tag != CT + 'Types' or roots['word/document.xml'].tag != W + 'document':
            errors.append('Invalid content types or document root namespace')
        overrides = {unquote(n.get('PartName', '')).lstrip('/') for n in types.findall(CT + 'Override') if n.get('ContentType')}
        defaults = {n.get('Extension', '').lower() for n in types.findall(CT + 'Default') if n.get('ContentType')}
        for name in files.keys() - {'[Content_Types].xml'}:
            if name not in overrides and name.rsplit('.', 1)[-1].lower() not in defaults:
                errors.append(f'{name}: missing content type')
        comments = roots.get('word/comments.xml')
        comment_ids = {n.get(W + 'id') for n in comments.findall(W + 'comment')} if comments is not None else set()
        for name, root in roots.items():
            if name.endswith('.rels'):
                if root.tag != REL + 'Relationships':
                    errors.append(f'{name}: invalid relationships namespace')
                ids = set()
                for node in root:
                    if node.tag != REL + 'Relationship' or not node.get('Id') or node.get('Id') in ids:
                        errors.append(f'{name}: invalid or duplicate relationship ID')
                    ids.add(node.get('Id'))
                    if node.get('TargetMode') == 'External':
                        continue
                    raw = node.get('Target', '')
                    uri = urlsplit(raw)
                    target = unquote(uri.path)
                    base = posixpath.dirname(posixpath.dirname(name))
                    resolved = posixpath.normpath(posixpath.join(base, target)).lstrip('/')
                    if not target and uri.fragment and name != '_rels/.rels':
                        resolved = posixpath.join(base, posixpath.basename(name)[:-5])
                    if uri.scheme or uri.netloc or resolved not in files:
                        errors.append(f'{name}: unresolved internal target {raw!r}')
            identities = set()
            anchors = {tag: Counter() for tag in ('commentRangeStart', 'commentRangeEnd', 'commentReference')}
            active_ranges = set()
            for node in root.iter():
                if not isinstance(node.tag, str):
                    continue
                value = node.get(W + 'id')
                local = E.QName(node).localname
                scope = 'revision' if node.tag in REVISIONS else node.tag
                if value is not None or node.tag in REVISIONS | {W + 'comment', *(W + tag for tag in anchors)}:
                    if value is None or not re.fullmatch(r'[+-]?[0-9]+', value):
                        errors.append(f'{name}: invalid w:id on {local}')
                    elif (scope, int(value)) in identities:
                        errors.append(f'{name}: duplicate w:id {value} in {scope}')
                    else:
                        identities.add((scope, int(value)))
                if local in anchors and node.tag == W + local:
                    anchors[local][value] += 1
                    if value not in comment_ids:
                        errors.append(f'{name}: unknown comment {value}')
                    if local == 'commentRangeStart':
                        active_ranges.add(value)
                    elif local == 'commentRangeEnd':
                        if value not in active_ranges:
                            errors.append(f'{name}: comment range end before start: {value}')
                        active_ranges.discard(value)
                if node.tag in TEXT:
                    text = node.text or ''
                    if text != text.strip() and node.get(SPACE) != 'preserve':
                        errors.append(f'{name}: missing xml:space="preserve" on {local}')
                    deleted = any(a.tag in {W + 'del', W + 'moveFrom'} for a in node.iterancestors())
                    if deleted != (local in {'delText', 'delInstrText'}):
                        errors.append(f'{name}: invalid revision placement for {local}')
            starts, ends, refs = anchors.values()
            if starts != ends or starts - refs:
                errors.append(f'{name}: unbalanced comment ranges or references')
            for table in root.iter(W + 'tbl'):
                grid = table.find(W + 'tblGrid')
                columns = len(grid.findall(W + 'gridCol')) if grid is not None else 0
                for row in table.findall(W + 'tr'):
                    cells = row.findall(W + 'tc')
                    spans = [cell.find(f'{W}tcPr/{W}gridSpan') for cell in cells]
                    widths = [int(span.get(W + 'val')) if span is not None else 1 for span in spans]
                    for tag in ('gridBefore', 'gridAfter'):
                        padding = row.find(f'{W}trPr/{W}{tag}')
                        if padding is not None:
                            widths.append(int(padding.get(W + 'val')))
                    if not columns or sum(widths) != columns or any(width < 0 for width in widths) or any(width == 0 for width in widths[:len(cells)]):
                        errors.append(f'{name}: row width does not match table grid')
        document = roots['word/document.xml']
        counts = {key: sum(1 for _ in document.iter(W + tag)) for key, tag in
                  (('sectionCount', 'sectPr'), ('paragraphCount', 'p'), ('tableCount', 'tbl'))}
        if original_docx is not None:
            originals = xml_parts(parts(original_docx))
            for name in sorted(n for n in originals.keys() | roots.keys() if story(n)):
                if name not in originals or name not in roots:
                    errors.append(f'{name}: story parts differ from original')
                    continue
                old, new = originals[name], deepcopy(roots[name])
                existing = {(n.tag, n.get(W + 'id')) for n in old.iter() if n.tag in REVISIONS}
                resolve(new, False, lambda n: n.get(W + 'author') == author and (n.tag, n.get(W + 'id')) not in existing)
                if paragraph_text(new) != paragraph_text(old):
                    errors.append(f'{name}: untracked text edits differ from original')
    except Exception as exc:
        errors.append(str(exc))
    return dict(valid=not errors, errors=errors, warnings=[], **counts)


def pack_docx(unpacked_dir, output_docx, validate=True, original_docx=None, author='Klaus'):
    import tempfile

    output = Path(output_docx)
    if output.resolve().is_relative_to(Path(unpacked_dir).resolve()):
        raise ValueError('Output archive must be outside the unpacked directory')
    files = parts(unpacked_dir)
    for name, root in xml_parts(files).items():
        files[name] = serialize(root)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix='.docx', delete=False) as stream:
        temporary = Path(stream.name)
    try:
        with ZipFile(temporary, 'w', ZIP_DEFLATED) as archive:
            for name, data in sorted(files.items()):
                archive.writestr(name, data)
        if validate:
            result = validate_docx(temporary, original_docx, author)
            if not result['valid']:
                raise ValueError('; '.join(result['errors']))
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return output
