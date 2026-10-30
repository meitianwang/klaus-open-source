import { cp, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A real multi-file report; every path and byte belongs to this test checkout. */
export async function createHtmlPreviewFixture(): Promise<{ root: string; workspace: string; entry: string }> {
  const root = await realpath(await mkdtemp(join(__dirname, 'html-preview-fixture-'))), workspace = join(root, 'workspace');
  await cp(join(__dirname, '../../tests/fixtures/html-preview'), workspace, { recursive: true });
  const entry = join(workspace, 'pages', 'report.html');
  await writeFile(join(root, 'outside.json'), '{"secret":"outside"}\n');
  return { root, workspace, entry };
}
