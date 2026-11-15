import type { Data } from '../visuals/data';

export function designTools(): Data[] {
  const id = { type: 'string', description: 'Design canvas id. Omit to use the most recently opened design canvas in this chat.' };
  const object = (properties: Data, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
  return [
    {
      name: 'design_open',
      description: 'Create or reopen an editable multi-artboard design canvas in the Design Canvas work panel. Returns the canvas id and current file version. Read its files before editing.',
      inputSchema: object({ id, title: { type: 'string' } }),
    },
    {
      name: 'design_inspect',
      description: 'List the design canvas files and their current version, or read one file. Set diagnostics to include per-file validation state, per-artboard issues, uploaded asset status, and live viewer selection context when the panel is open. The editable document uses project/canvas.json (v3) and project/<Name>.dc.html.',
      inputSchema: object({ id, path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 }, diagnostics: { type: 'boolean' } }),
    },
    {
      name: 'design_publish',
      description: 'Validate the complete candidate document with the Design plugin authoring validator, then publish design canvas files atomically against the version returned by open or inspect. Invalid content leaves the saved version unchanged. File paths are existing absolute local files inside the chat workspace; as is the canvas-relative destination under project/.',
      inputSchema: object(
        {
          id,
          base_version: { type: 'string' },
          files: { type: 'array', items: object({ path: { type: 'string' }, as: { type: 'string' } }, ['path', 'as']) },
          remove: { type: 'array', items: { type: 'string' } },
        },
        ['base_version', 'files'],
      ),
    },
    {
      name: 'design_import_asset',
      description: 'Import one local image, SVG, animated GIF, video, font or support file (.css, .js, .json) into the design canvas asset store. The local path must be inside the chat workspace. Returns the real /_blob/<id> URL, content type, byte size and sha256 for use in artboards.',
      inputSchema: object({ id, path: { type: 'string' } }, ['path']),
    },
    {
      name: 'design_export',
      description: 'Export the design canvas through its live editor. PDF, PNG and HTML use the same rendering and pagination engine as the work panel.',
      inputSchema: object({ id, format: { type: 'string', enum: ['pdf', 'png', 'html'] } }, ['format']),
    },
  ];
}
