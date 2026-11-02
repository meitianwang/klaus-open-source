import type { Data } from '../visuals/data';

export function pptTools(): Data[] {
  const id = { type: 'string', description: 'Presentation id. Omit to use the most recently opened presentation in this chat.' };
  const object = (properties: Data, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
  return [
    { name: 'ppt_open', description: 'Create or reopen an editable presentation in the PPT work panel. Returns the presentation id and current file version. Read its files before editing.', inputSchema: object({ id, title: { type: 'string' } }) },
    { name: 'ppt_inspect', description: 'List the presentation files and their current version, or read one file. Set diagnostics to include per-file validation state, the last content hash, per-slide issues and uploaded asset status. The editable document uses project/deck.json (v4) and project/slides/<id>.html.', inputSchema: object({ id, path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 }, diagnostics: { type: 'boolean' } }) },
    { name: 'ppt_publish', description: 'Validate the complete candidate document with the PPT plugin authoring parser, then publish presentation files atomically against the version returned by inspect. Invalid content leaves the saved version unchanged. File paths are existing absolute local files inside the chat workspace; as is the presentation-relative destination. The receipt reports saved and validated separately.', inputSchema: object({ id, base_version: { type: 'string' }, files: { type: 'array', items: object({ path: { type: 'string' }, as: { type: 'string' } }, ['path', 'as']) }, remove: { type: 'array', items: { type: 'string' } } }, ['base_version', 'files']) },
    { name: 'ppt_import_asset', description: 'Import one local image, animated GIF, video or font into the presentation asset store. The local path must be inside the chat workspace. Returns the real /_blob/<id> URL, content type, byte size and sha256 for use as a slide media reference.', inputSchema: object({ id, path: { type: 'string' } }, ['path']) },
    { name: 'ppt_export', description: 'Export the presentation through its editor. PDF, editable PPTX, picture PPTX, PNG and HTML use the same rendering and export engine as the work panel.', inputSchema: object({ id, format: { type: 'string', enum: ['pdf', 'pptx', 'png', 'html'] }, variant: { type: 'string', enum: ['current', 'basic', 'pictures'] } }, ['format']) },
  ];
}
