import type { Data } from '../visuals/data';

const string = { type: 'string' };
const id = { type: 'string', description: 'Design workspace id. Omit to use the latest workspace in this chat.' };
const nodeId: Data = { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }] };
function spec(name: string, description: string, properties: Data, required: string[] = []): Data {
  return { name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required } };
}

export function prototypeTools(): Data[] {
  return [
    spec('prototype_open', 'Create or reopen an interface design workspace. The full editor shares its live document with these tools. The returned artifact opens in the work panel.', {
      id, title: string,
      legacy_canvas: { type: 'string', description: 'Optional absolute .canvas.tsx path. Imports supported static screens and navigation into a new design, retaining originals and a source backup. Unsupported controls or components are refused.' },
    }),
    spec('prototype_inspect', 'Read the current live design and revision before editing. Includes manual changes and workspace.files for open document tabs. Switch documents with doc.switch before inspecting or editing another tab. Use node_id to inspect a subtree. Defaults to depth 2; pass depth 0 or 1 when only the revision or the page list is needed, to keep the payload small.', {
      id, node_id: nodeId, depth: { type: 'integer', minimum: 0, maximum: 12 }, all_pages: { type: 'boolean' },
    }),
    spec('prototype_commands', 'Discover the design engine commands and their exact parameter documentation. Search by command id, label, or purpose before executing an unfamiliar operation.', {
      id, query: string, limit: { type: 'integer', minimum: 1, maximum: 100 },
    }),
    spec('prototype_execute', 'Apply design commands to the same live document as the editor. Pass the revision from prototype_inspect; a stale revision is refused. The editor advances the revision through its own activity, so read the revision immediately before editing, and when a batch is refused as stale resend it with the current revision the refusal reports. Multiple commands must be undoable document edits: they form one undo step and roll back on failure. Read commands such as node.get run on their own, never inside a batch. Run other commands individually. Earlier results can be referenced using {"$step":0} in parameters.', {
      id, expected_revision: { type: 'integer', minimum: 0 }, label: string,
      commands: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', additionalProperties: false, required: ['command'], properties: { command: string, params: { type: 'object' } } } },
    }, ['expected_revision', 'commands']),
    spec('prototype_export', 'Export the editable native design or render the current design with the same engine. Export only when the user wants a file. The fig format is experimental and may report conversion warnings.', {
      id, format: { type: 'string', enum: ['figcraft', 'png', 'jpg', 'webp', 'svg', 'pdf', 'fig'] },
      ids: { type: 'array', items: nodeId }, scale: { type: 'number', minimum: 0.1, maximum: 4 },
    }, ['format']),
  ];
}
