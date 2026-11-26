import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { MediaFiles } from '../main/services/media-files';
import { createConversationMediaScope } from '../main/services/media-scope';
import { FileService, remotePreviewSessionDir } from '../main/services/files';
import { WorkspaceStore } from '../main/services/workspaces';
import type { SshFileService } from '../main/services/ssh-files';
import type { OfficePreviewPayload } from '../contracts/office-preview';
import { Harness } from './harness';

const h = new Harness();
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/office-preview-vectors.json'), 'utf8'));
function zip(entries: Record<string, string | Buffer>, encrypted = false) {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [path, value] of Object.entries(entries)) {
    const name = Buffer.from(path), data = typeof value === "string" ? Buffer.from(value) : value, checksum = crc32(data);
    const raw = encrypted ? Buffer.concat([Buffer.alloc(12), data]) : data;
    const l = Buffer.alloc(30), c = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4); l.writeUInt16LE(Number(encrypted), 6);
    l.writeUInt32LE(checksum, 14); l.writeUInt32LE(raw.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(Number(encrypted), 8);
    c.writeUInt32LE(checksum, 16); c.writeUInt32LE(raw.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    local.push(l, name, raw); central.push(c, name); offset += l.length + name.length + raw.length;
  }
  const end = Buffer.alloc(22), count = central.length / 2;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(central.reduce((n, part) => n + part.length, 0), 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
const xlsx = zip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="薪酬明细" r:id="one"/><sheet name="汇总说明" r:id="two"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="one" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/one.xml"/><Relationship Id="two" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/two.xml"/></Relationships>',
  'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;mm&quot;月&quot;dd&quot;日&quot;"/></numFmts><fonts><font><b/></font></fonts><fills><fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/></patternFill></fill></fills><cellXfs><xf fontId="0" fillId="0"/><xf numFmtId="3"/><xf numFmtId="7"/><xf numFmtId="164"/></cellXfs></styleSheet>',
  'xl/worksheets/one.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr" s="0"><is><t>薪酬</t><rPh><t>phonetic</t></rPh></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>410922199510104913</t></is></c><c r="B2" s="1"><f>54000*12+200000</f></c><c r="C2" s="2"><v>1234</v></c><c r="D2" s="3"><v>45292</v></c></row></sheetData><mergeCells><mergeCell ref="A1:D1"/></mergeCells></worksheet>',
  'xl/worksheets/two.xml': '<worksheet><sheetData/></worksheet>',
  'padding.bin': Buffer.alloc(1024 ** 2),
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2cAAAAASUVORK5CYII=', 'base64');
const docx = zip({
  'word/styles.xml': '<styles><style styleId="Title" type="paragraph"><name val="Title"/></style><style styleId="Heading1" type="paragraph"><name val="heading 1"/></style><style styleId="Heading2" type="paragraph"><name val="heading 2"/></style></styles>',
  'word/document.xml': '<document><body><p><pPr><pStyle val="Title"/></pPr><r><t>Title</t></r></p><p><pPr><pStyle val="Heading1"/></pPr><r><t>First</t></r></p><p><pPr><pStyle val="Heading2"/></pPr><hyperlink r:id="link"><r><rPr><b/><i/><color val="123456"/><highlight val="yellow"/></rPr><t>Second</t></r></hyperlink></p><p><pPr><numPr><ilvl val="0"/><numId val="1"/></numPr></pPr><r><t>Bullet</t></r></p><p><pPr><numPr><ilvl val="0"/><numId val="2"/></numPr></pPr><r><t>Ordered</t></r></p><tbl><tr><tc><tcPr><gridSpan val="2"/><vMerge val="restart"/></tcPr><p><r><t>Top</t></r></p></tc></tr><tr><tc><tcPr><gridSpan val="2"/><vMerge/></tcPr><p/></tc></tr></tbl><p><r><footnoteReference id="1"/><drawing><blip r:embed="image"/></drawing></r></p></body></document>',
  'word/_rels/document.xml.rels': '<Relationships><Relationship Id="link" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="https://example.com/"/><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/p.png"/></Relationships>',
  'word/numbering.xml': '<numbering><abstractNum abstractNumId="1"><lvl ilvl="0"><numFmt val="bullet"/><lvlText val="•"/></lvl></abstractNum><abstractNum abstractNumId="2"><lvl ilvl="0"><start val="1"/><numFmt val="decimal"/><lvlText val="%1."/></lvl></abstractNum><num numId="1"><abstractNumId val="1"/></num><num numId="2"><abstractNumId val="2"/></num></numbering>',
  'word/media/p.png': png,
  'word/footnotes.xml': '<footnotes><footnote id="1"><p><r><t>Footnote</t></r></p></footnote></footnotes>',
});
const pptx = zip({
  'ppt/presentation.xml': '<presentation><sldIdLst><sldId id="256" r:id="slide"/></sldIdLst><sldSz cx="12192000" cy="6858000"/></presentation>',
  'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="slide" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
  'ppt/slides/slide1.xml': '<sld><cSld><spTree><sp><nvSpPr><nvPr><ph idx="1"/></nvPr></nvSpPr><txBody><p><r><t>Slide body</t></r></p></txBody></sp><pic><spPr><xfrm><off x="0" y="0"/><ext cx="12700" cy="12700"/></xfrm></spPr><blipFill><blip r:embed="image"/></blipFill></pic><graphicFrame><xfrm><off x="0" y="0"/><ext cx="12700" cy="12700"/></xfrm><graphic><graphicData><tbl><tr><tc><txBody><p><r><t>Table</t></r></p></txBody></tc></tr></tbl></graphicData></graphic></graphicFrame></spTree></cSld></sld>',
  'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="layout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/layout.xml"/><Relationship Id="notes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notes.xml"/><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/p.png"/></Relationships>',
  'ppt/slideLayouts/layout.xml': '<sldLayout><cSld><spTree><sp><nvSpPr><nvPr><ph idx="1"/></nvPr></nvSpPr><spPr><xfrm><off x="1219200" y="1371600"/><ext cx="3657600" cy="2743200"/></xfrm></spPr></sp></spTree></cSld></sldLayout>',
  'ppt/notesSlides/notes.xml': '<notes><cSld><spTree><sp><nvSpPr><nvPr><ph type="body"/></nvPr></nvSpPr><txBody><p><r><t>Speaker notes</t></r></p></txBody></sp></spTree></cSld></notes>',
  'ppt/media/p.png': png,
});
const odp = zip({
  mimetype: 'application/vnd.oasis.opendocument.presentation',
  'styles.xml': '<office:document-styles><style:page-layout style:name="page"><style:page-layout-properties fo:page-width="960pt" fo:page-height="540pt"/></style:page-layout></office:document-styles>',
  'content.xml': '<office:document-content><office:body><office:presentation><draw:page><draw:frame svg:x="96pt" svg:y="108pt" svg:width="288pt" svg:height="216pt"><draw:text-box><text:p>Slide body</text:p></draw:text-box></draw:frame><draw:frame><draw:image xlink:href="Pictures/p.png"/></draw:frame><draw:frame><table:table><table:table-row><table:table-cell><text:p>Table</text:p></table:table-cell></table:table-row></table:table></draw:frame><presentation:notes><text:p>Speaker notes</text:p></presentation:notes></draw:page></office:presentation></office:body></office:document-content>',
  'Pictures/p.png': png,
});

h.test('Office previews are structured and read-only locally and over SSH', async () => {
  const tmp = await mkdtemp(join(process.cwd(), 'dist/office-preview-'));
  const root = join(tmp, 'workspace'), external = join(tmp, 'external.xlsx');
  const workspaces = new WorkspaceStore({ configRoot: tmp, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const grants = new Set<string>();
  const reads: [number, number][] = [];
  const sshFiles = {
    stat: async (_owner: unknown, _workdir: unknown, path: string) => ({ isFile: true, mtimeMs: 1, size: path.endsWith('large.xlsx') ? vector.remoteMaxBytes + 1 : xlsx.length }),
    read: async (_owner: unknown, _workdir: unknown, _path: unknown, offset: number, size: number) => {
      reads.push([offset, size]);
      return { content: xlsx.subarray(offset, offset + size), size: xlsx.length, complete: offset + size >= xlsx.length };
    },
  } as unknown as SshFileService;
  const service = new FileService({ workspaces, watch: false, push: () => {}, openPath: async () => {}, revealPath: () => {}, trashPath: async () => {}, openPreviewWindow: async () => {}, requestSession: async () => ({}), sshFiles, sshOwner: () => 7, producedBySession: p => grants.has(p), authorizePreviewPath: p => { grants.add(p); } });
  try {
    await mkdir(root);
    workspaces.bindSession('local', { workdir: root });
    workspaces.bindSession('remote', { workdir: 'ssh://fixture@example.test/workspace' });
    const read = async (filePath: string, sessionId = 'local') => await service.readArtifact({ sessionId, filePath }) as unknown as { office: OfficePreviewPayload; content: string; binary: boolean; readonly: boolean; encoding: string };
    for (const [ext, data] of Object.entries({ xlsx, docx, pptx, odp })) await writeFile(join(root, `sample.${ext}`), data);
    await writeFile(external, xlsx);
    assert.equal((await service.authorizeArtifactPreview({ sessionId: 'local', filePath: external }) as { ok: boolean }).ok, true);
    for (const result of [await read(join(root, 'sample.xlsx')), await read(external), await read('/workspace/sample.xlsx', 'remote')]) {
      const { office, encoding, readonly, binary } = result;
      assert.deepEqual({ encoding, readonly, binary }, { encoding: vector.encoding, readonly: vector.readonly, binary: vector.binary });
      assert.equal(office.kind, 'spreadsheet');
      assert.deepEqual(office.sheets.map(s => s.name), ['薪酬明细', '汇总说明']);
      const cells = office.sheets[0]!.cells;
      assert.deepEqual(cells.map(c => c.v), ['薪酬', '410922199510104913', '848,000', '$1,234.00', '2024年01月01日']);
      assert.equal(cells[0]!.cs, 4);
      assert.equal(cells[2]!.f, '54000*12+200000');
      assert.equal(office.styles[cells[0]!.s!]!.bold, true);
      assert.equal(office.styles[cells[0]!.s!]!.bg, '#ff0000');
    }
    assert.deepEqual(reads, [[0, vector.remoteChunkBytes], [vector.remoteChunkBytes, vector.remoteChunkBytes]]);
    const large = (await read('/workspace/large.xlsx', 'remote')).office;
    assert.equal(large.kind, 'error'); assert.equal(large.code, 'too_large');
    for (const ext of ['xlsx', 'docx', 'pptx']) for (const [sessionId, dir] of [['local', root], ['remote', '/workspace']] as const) {
      assert.deepEqual(await service.write({ sessionId, filePath: join(dir, `sample.${ext}`), content: 'replacement' }), { error: vector.writeRefusalError });
    }
    for (const ext of ['pptx', 'odp']) {
      const { office, content } = await read(join(root, `sample.${ext}`));
      assert.equal(office.kind, 'presentation');
      assert.deepEqual([office.widthPt, office.heightPt], [960, 540]);
      const slide = office.slides[0]!;
      assert.equal(slide.index, 1); assert.match(content, /^Slide 1\n/);
      assert.equal(slide.notes, 'Speaker notes');
      assert.deepEqual(slide.elements.map(e => e.kind), ['shape', 'image', 'table']);
      const { x, y, w, h } = slide.elements[0]!;
      assert.deepEqual([x, y, w, h], [10, 20, 30, 40]);
    }
    const doc = (await read(join(root, 'sample.docx'))).office;
    assert.equal(doc.kind, 'document');
    assert.equal(doc.title, 'Title');
    assert.deepEqual(doc.blocks.flatMap(block => block.kind === 'paragraph' && block.heading ? [block.heading] : []), [1, 2]);
    const paragraphs = doc.blocks.filter(block => block.kind === 'paragraph');
    const styled = paragraphs.find(block => block.heading === 2)?.runs[0];
    assert.equal(styled?.bold, true); assert.equal(styled?.italic, true);
    assert.equal(styled?.color, '#123456'); assert.ok(styled?.highlight);
    assert.equal(styled?.href, 'https://example.com/');
    assert.deepEqual(paragraphs.flatMap(p => p.list ? [p.list.ordered] : []), [false, true]);
    assert.match(JSON.stringify(doc), /data:image\/png;base64,/);
    assert.match(JSON.stringify(doc.footnotes), /Footnote/);
    const table = doc.blocks.find(block => block.kind === 'table');
    assert.equal(table?.rows[0]?.cells[0]?.rowSpan, 2);
    assert.equal(table?.rows[0]?.cells[0]?.colSpan, 2);
    for (const [name, data, expected] of [
      ['encrypted.xlsx', zip({ entry: 'encrypted' }, true), 'encrypted'],
      ['encrypted.docx', Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.from('EncryptedPackage', 'utf16le')]), 'encrypted'],
      ['empty.xlsx', Buffer.alloc(0), 'empty'], ['broken.pptx', Buffer.from('broken'), 'corrupted'],
    ] as const) {
      const path = join(root, name); await writeFile(path, data);
      const { office } = await read(path);
      assert.equal(office.kind, 'error'); assert.equal(office.code, expected);
    }
    for (const [name, text, kind] of [['legacy.rtf', '{\\rtf1\\ansi Office preview}', 'document'], ['legacy.xls', '<html><table><tr><td>Office preview</td></tr></table></html>', 'spreadsheet']]) {
      const path = join(root, name!); await writeFile(path, text!);
      const result = await read(path);
      assert.equal(result.office.kind, kind); assert.match(result.content, /Office preview/);
    }
  } finally {
    service.close(); await rm(tmp, { recursive: true, force: true });
  }
});

function twoPagePdf(): Buffer {
  const stream = (text: string) => {
    const body = `BT /F1 18 Tf 30 100 Td (${text}) Tj ET`;
    return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  };
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    ...[6, 7].map(n => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents ${n} 0 R >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', stream('First PDF page'), stream('Second PDF page'),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => { const offset = pdf.length; pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

h.test('PDF previews preserve local bytes and isolate remote cache grants', async () => {
  const tmp = await mkdtemp(join(process.cwd(), 'dist/pdf-preview-'));
  const root = join(tmp, 'workspace'), bytes = twoPagePdf();
  const remoteBytes = Buffer.concat([bytes, Buffer.alloc(1300000, 32)]);
  const workspaces = new WorkspaceStore({ configRoot: tmp, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const grants = new Map<string, Set<string>>();
  const producedBySession = (path: string, id: string) => grants.get(id)?.has(path) ?? false;
  const mediaScope = createConversationMediaScope({ configRoot: tmp, prepareSessionMedia: async id => id !== 'draft', resolveSessionDirectory: id => workspaces.resolveSessionDirectory(id), extraRoots: () => [], producedBySession });
  const media = new MediaFiles(mediaScope);
  const reads: [number, number][] = [];
  const sshFiles = {
    stat: async (_a: unknown, _b: unknown, path: string) => ({ isFile: true, mtimeMs: 1, size: path.endsWith('large.pdf') ? vector.remoteMaxBytes + 1 : remoteBytes.length }),
    read: async (_a: unknown, _b: unknown, _c: unknown, offset: number, size: number) => {
      reads.push([offset, size]);
      return { content: remoteBytes.subarray(offset, offset + size), size: remoteBytes.length, complete: offset + size >= remoteBytes.length };
    },
  } as unknown as SshFileService;
  const service = new FileService({ workspaces, watch: false, push: () => {}, openPath: async () => {}, revealPath: () => {}, trashPath: async () => {}, openPreviewWindow: async () => {}, requestSession: async () => ({}), sshFiles, sshOwner: () => 7, mediaScope, producedBySession, toFileUrl: (path, id, displayName) => media.grant(path, id, displayName), authorizePreviewPath: (path, id) => { if (!grants.has(id)) grants.set(id, new Set()); grants.get(id)!.add(path); } });
  try {
    await mkdir(root); await mkdir(join(tmp, 'uploads'));
    for (const id of ['local', 'draft']) workspaces.bindSession(id, { workdir: root });
    workspaces.bindSession('session:1', { workdir: 'ssh://fixture@example.test/workspace' });
    const filePath = join(root, '薪酬制度汇编.PDF'); await writeFile(filePath, bytes);
    const url = async (filePath: string, sessionId = 'local') => await service.artifactFileUrl({ filePath, sessionId }) as { url: string; officeError?: { code: string } };
    const fetchBytes = async (value: string, filename?: string) => {
      const response = await media.respond(new Request(value));
      if (filename) assert.equal(response.headers.get('content-disposition')?.split("filename*=UTF-8''")[1], encodeURIComponent(filename));
      return Buffer.from(await response.arrayBuffer());
    };
    assert.deepEqual(await fetchBytes((await url(filePath)).url, '薪酬制度汇编.PDF'), bytes);
    const checkRead = async (filePath: string, sessionId: string) => {
      const result = await service.readArtifact({ filePath, sessionId }) as unknown as { office: OfficePreviewPayload; encoding: string; content: string; binary: boolean; readonly: boolean };
      assert.equal(result.encoding, vector.pdfEncoding); assert.equal(result.binary, false); assert.equal(result.readonly, true);
      assert.equal(result.office.kind, 'pdf'); assert.equal(result.office.pageCount, 2);
      assert.match(result.content, /Page 1\s+First PDF page\s+Page 2\s+Second PDF page/);
    };
    await checkRead(filePath, 'local');
    assert.deepEqual(await service.write({ filePath, sessionId: 'local', content: 'replacement' }), { error: vector.writeRefusalError });
    for (const [code, content] of [['empty', ''], ['corrupted', 'not a PDF']] as const) {
      const path = join(root, `${code}.pdf`); await writeFile(path, content);
      assert.equal((await url(path)).officeError?.code, code);
    }
    assert.deepEqual(await fetchBytes((await url('/workspace/薪酬制度汇编.pdf', 'session:1')).url, '薪酬制度汇编.pdf'), remoteBytes);
    assert.deepEqual(reads, [[0, vector.remoteChunkBytes], [vector.remoteChunkBytes, vector.remoteChunkBytes]]);
    const cache = [...grants.get('session:1')!][0]!;
    assert.notEqual(remotePreviewSessionDir(tmp, 'session:1'), remotePreviewSessionDir(tmp, 'session_1'));
    await assert.rejects(media.grant(cache, 'session_1'), /outside this conversation/);
    assert.equal((await url('/workspace/large.pdf', 'session:1')).officeError?.code, 'too_large');
    await checkRead('/workspace/薪酬制度汇编.pdf', 'session:1');
    const upload = join(tmp, 'uploads', 'upload.bin'); await writeFile(upload, bytes);
    const opened = await service.openArtifactWindow({ sessionId: 'draft', filePath: upload, displayName: 'Doc.pdf' }) as { path: string };
    assert.match(opened.path, /\.klaus-upload-previews\/upload\.bin\/Doc\.pdf$/);
    assert.deepEqual(await fetchBytes((await url(opened.path, 'draft')).url), bytes);
  } finally { service.close(); media.close(); await rm(tmp, { recursive: true, force: true }); }
});

h.test('CSV/TSV, XMind (JSON + XML), WPS/template extensions, external Open-With scope, and lossless Office/XMind Save & Save As round-trips', async () => {
  const tmp = await mkdtemp(join(process.cwd(), 'dist/office-roundtrip-'));
  const root = join(tmp, 'workspace');
  const externalDir = join(tmp, 'external');
  const savedAsPaths: string[] = [];
  const openedDefaultPaths: string[] = [];
  const workspaces = new WorkspaceStore({ configRoot: tmp, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const externalGrants = new Map<string, Set<string>>();
  const producedBySession = (path: string, id: string) => externalGrants.get(id)?.has(path) ?? false;
  const mediaScope = createConversationMediaScope({
    configRoot: tmp,
    prepareSessionMedia: async () => true,
    resolveSessionDirectory: id => workspaces.resolveSessionDirectory(id),
    extraRoots: () => [],
    producedBySession,
  });
  const media = new MediaFiles(mediaScope);
  let nextDialogSavePath: string | undefined = undefined;
  const service = new FileService({
    workspaces,
    watch: false,
    push: () => {},
    openPath: async p => { openedDefaultPaths.push(p); },
    revealPath: () => {},
    trashPath: async () => {},
    openPreviewWindow: async () => {},
    requestSession: async () => ({}),
    mediaScope,
    producedBySession,
    toFileUrl: (path, id, displayName) => media.grant(path, id, displayName),
    saveOfficeDialog: async () => nextDialogSavePath,
  });
  try {
    await mkdir(root, { recursive: true });
    await mkdir(externalDir, { recursive: true });
    workspaces.bindSession('local', { workdir: root });

    // 1. CSV and TSV grid parsing + formula evaluation + writeOfficeArtifact round-trip
    const csvPath = join(root, 'metrics.csv');
    await writeFile(csvPath, 'Item,Amount\n"Hosting, EU",120\nStorage,80\nTotal,=SUM(B2:B3)\n', 'utf8');
    const csvRead = await service.readArtifact({ sessionId: 'local', filePath: csvPath }) as any;
    assert.equal(csvRead.encoding, 'utf8');
    assert.equal(csvRead.readonly, false);
    assert.equal(csvRead.officeWritable, true);
    assert.equal(csvRead.office.kind, 'spreadsheet');
    assert.equal(csvRead.office.sheets[0].cells.find((c: any) => c.r === 3 && c.c === 1)?.v, '200');
    csvRead.office.sheets[0].cells.find((c: any) => c.r === 1 && c.c === 1).v = '300';
    const csvWrite = await service.writeOfficeArtifact({ sessionId: 'local', filePath: csvPath, office: csvRead.office, expectedMtimeMs: csvRead.mtimeMs }) as any;
    assert.equal(csvWrite.ok, true);
    const csvReload = await service.readArtifact({ sessionId: 'local', filePath: csvPath }) as any;
    assert.equal(csvReload.office.sheets[0].cells.find((c: any) => c.r === 3 && c.c === 1)?.v, '380');

    const tsvPath = join(root, 'metrics.tsv');
    await writeFile(tsvPath, 'Key\tVal\nAlpha\t42\n', 'utf8');
    const tsvRead = await service.readArtifact({ sessionId: 'local', filePath: tsvPath }) as any;
    assert.equal(tsvRead.office.kind, 'spreadsheet');
    assert.equal(tsvRead.office.sheets[0].cells.find((c: any) => c.r === 1 && c.c === 1)?.v, '42');

    // 2. XMind modern content.json + legacy content.xml + lossless .xmind write round-trip
    const xmindJsonPath = join(root, 'roadmap.xmind');
    await writeFile(xmindJsonPath, zip({
      'content.json': JSON.stringify([{
        id: 'sheet-1',
        title: 'Q4 Plan',
        rootTopic: {
          id: 'root-1',
          title: 'Desktop File Support',
          labels: ['P0'],
          notes: { plain: { content: 'Core milestone' } },
          children: { attached: [{ id: 'sub-1', title: 'XMind Native', branch: 'folded' }] },
        },
      }]),
      'metadata.json': JSON.stringify({ creator: { name: 'fixture' } }),
    }));
    const xmindRead = await service.readArtifact({ sessionId: 'local', filePath: xmindJsonPath }) as any;
    assert.equal(xmindRead.office.kind, 'mindmap');
    assert.equal(xmindRead.officeWritable, true);
    assert.equal(xmindRead.office.sheets[0].rootTopic.title, 'Desktop File Support');
    assert.deepEqual(xmindRead.office.sheets[0].rootTopic.labels, ['P0']);
    assert.equal(xmindRead.office.sheets[0].rootTopic.children[0].folded, true);

    xmindRead.office.sheets[0].rootTopic.children.push({ id: 'sub-2', title: 'In-Place Save' });
    const xmindSaved = await service.writeOfficeArtifact({ sessionId: 'local', filePath: xmindJsonPath, office: xmindRead.office }) as any;
    assert.equal(xmindSaved.ok, true);
    const xmindReload = await service.readArtifact({ sessionId: 'local', filePath: xmindJsonPath }) as any;
    assert.equal(xmindReload.office.sheets[0].rootTopic.children.length, 2);
    assert.equal(xmindReload.office.sheets[0].rootTopic.children[1].title, 'In-Place Save');

    const xmindXmlPath = join(root, 'legacy-map.xmind');
    await writeFile(xmindXmlPath, zip({
      'content.xml': '<xmap-content><sheet id="s1"><title>Legacy Sheet</title><topic id="r1" branch="folded"><title>Legacy Root</title><children><topics type="attached"><topic id="c1"><title>Child XML</title></topic></topics></children></topic></sheet></xmap-content>',
    }));
    const xmindXmlRead = await service.readArtifact({ sessionId: 'local', filePath: xmindXmlPath }) as any;
    assert.equal(xmindXmlRead.office.kind, 'mindmap');
    assert.equal(xmindXmlRead.office.sheets[0].rootTopic.title, 'Legacy Root');
    assert.equal(xmindXmlRead.office.sheets[0].rootTopic.children[0].title, 'Child XML');

    // 3. OOXML lossless write round-trips (.xlsx, .docx, .pptx) + optimistic mtime conflict check
    const xlsxPath = join(root, 'edit.xlsx');
    await writeFile(xlsxPath, xlsx);
    const xlsxRead = await service.readArtifact({ sessionId: 'local', filePath: xlsxPath }) as any;
    assert.equal(xlsxRead.officeWritable, true);
    xlsxRead.office.sheets[0].cells.push({ r: 3, c: 0, v: 'Edited Row', t: 's' });
    const conflictRes = await service.writeOfficeArtifact({ sessionId: 'local', filePath: xlsxPath, office: xlsxRead.office, expectedMtimeMs: 1 }) as any;
    assert.equal(conflictRes.conflict, true);
    const okXlsx = await service.writeOfficeArtifact({ sessionId: 'local', filePath: xlsxPath, office: xlsxRead.office, expectedMtimeMs: xlsxRead.mtimeMs }) as any;
    assert.equal(okXlsx.ok, true);
    const xlsxReload = await service.readArtifact({ sessionId: 'local', filePath: xlsxPath }) as any;
    assert.ok(xlsxReload.office.sheets[0].cells.some((c: any) => c.v === 'Edited Row'));

    const docxPath = join(root, 'edit.docx');
    await writeFile(docxPath, docx);
    const docxRead = await service.readArtifact({ sessionId: 'local', filePath: docxPath }) as any;
    docxRead.office.blocks.push({ kind: 'paragraph', heading: 2, runs: [{ text: 'Appended Section', bold: true }] });
    assert.equal(((await service.writeOfficeArtifact({ sessionId: 'local', filePath: docxPath, office: docxRead.office })) as any).ok, true);
    const docxReload = await service.readArtifact({ sessionId: 'local', filePath: docxPath }) as any;
    assert.match(JSON.stringify(docxReload.office.blocks), /Appended Section/);

    // 4. WPS (.wps, .wpt, .et, .ett, .dps, .dpt) & legacy templates (.dot, .xlt, .pot, .ppsm) + Save As conversion
    const wpsSpreadsheet = join(root, 'sheet.et');
    await writeFile(wpsSpreadsheet, '<html><table><tr><td>WPS Cell</td><td>99</td></tr></table></html>', 'utf8');
    const etRead = await service.readArtifact({ sessionId: 'local', filePath: wpsSpreadsheet }) as any;
    assert.equal(etRead.office.kind, 'spreadsheet');
    assert.equal(etRead.officeWritable, false);
    assert.equal(etRead.saveAsExt, 'xlsx');
    nextDialogSavePath = join(root, 'converted-from-et.xlsx');
    const saveAsRes = await service.saveOfficeArtifactAs({ sessionId: 'local', filePath: wpsSpreadsheet, office: etRead.office }, 1) as any;
    assert.equal(saveAsRes.ok, true);
    savedAsPaths.push(saveAsRes.filePath);
    const convertedRead = await service.readArtifact({ sessionId: 'local', filePath: nextDialogSavePath }) as any;
    assert.equal(convertedRead.office.kind, 'spreadsheet');
    assert.ok(convertedRead.office.sheets[0].cells.some((c: any) => c.v === 'WPS Cell'));

    for (const [ext, payloadBytes, expectedKind, writable] of [
      ['wps', '{\\rtf1\\ansi WPS Writer}', 'document', false],
      ['wpt', docx, 'document', false],
      ['ett', xlsx, 'spreadsheet', false],
      ['dps', zip({ 'ppt/presentation.xml': '<presentation><sldSz cx="12192000" cy="6858000"/><sldIdLst><sldId r:id="s1"/></sldIdLst></presentation>', 'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="s1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>', 'ppt/slides/slide1.xml': '<sld><cSld><spTree><sp><spPr><xfrm><off x="0" y="0"/><ext cx="1000000" cy="1000000"/></xfrm></spPr><txBody><p><r><t>WPS Slide</t></r></p></txBody></sp></spTree></cSld></sld>' }), 'presentation', false],
      ['dpt', zip({ 'ppt/presentation.xml': '<presentation><sldIdLst/></presentation>' }), 'presentation', false],
      ['dot', '{\\rtf1\\ansi Word Template}', 'document', false],
      ['xlt', '<html><table><tr><td>Excel Template</td></tr></table></html>', 'spreadsheet', false],
      ['pot', zip({ 'ppt/presentation.xml': '<presentation><sldIdLst/></presentation>' }), 'presentation', false],
      ['ppsm', zip({ 'ppt/presentation.xml': '<presentation><sldIdLst/></presentation>' }), 'presentation', true],
    ] as const) {
      const p = join(root, `sample.${ext}`);
      await writeFile(p, payloadBytes);
      const r = await service.readArtifact({ sessionId: 'local', filePath: p }) as any;
      assert.equal(r.office.kind, expectedKind, `expected ${ext} -> ${expectedKind}`);
      assert.equal(r.officeWritable, writable, `expected ${ext} writable=${writable}`);
    }

    // 5. External Open-With (__external__) single-file grant & openArtifactDefaultApp + 3gp media MIME
    const extXlsx = join(externalDir, 'finder-opened.xlsx');
    await writeFile(extXlsx, xlsx);
    externalGrants.set('__external__', new Set([extXlsx]));
    const extRead = await service.readArtifact({ sessionId: '__external__', filePath: extXlsx }) as any;
    assert.equal(extRead.office.kind, 'spreadsheet');
    assert.equal(extRead.officeWritable, true);
    const openDef = await service.openArtifactDefaultApp({ sessionId: '__external__', filePath: extXlsx }) as any;
    assert.equal(openDef.ok, true);
    assert.equal(openedDefaultPaths.length, 1);

    const clip3gp = join(root, 'mobile.3gp');
    await writeFile(clip3gp, Buffer.from([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70]));
    const url3gp = (await service.artifactFileUrl({ sessionId: 'local', filePath: clip3gp }) as any).url;
    const res3gp = await media.respond(new Request(url3gp));
    assert.equal(res3gp.headers.get('content-type'), 'video/3gpp');
  } finally {
    service.close();
    media.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

void h.finish(join(__dirname, 'office-preview-result.json'), 'office-preview').then(code => { process.exitCode = code; });
