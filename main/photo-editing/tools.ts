import type { Data } from '../visuals/data';

const string = { type: 'string' };
const id = {
  type: 'string',
  description: 'Photo-editing workspace id. Omit to use the latest workspace in this chat.',
};

function spec(name: string, description: string, properties: Data, required: string[] = []): Data {
  return {
    name,
    description,
    inputSchema: { type: 'object', additionalProperties: false, properties, required },
  };
}

export const PHOTO_EDITING_TOOL_FIELDS: Record<string, readonly string[]> = {
  photo_open: ['id', 'title', 'source_path', 'width', 'height', 'resolution', 'background', 'mode', 'depth'],
  photo_inspect: ['id', 'tab_index', 'detail'],
  photo_commands: ['id', 'query', 'enabled_only', 'limit'],
  photo_execute: ['id', 'expected_version', 'commands'],
  photo_place: ['id', 'expected_version', 'path', 'layer_name', 'smart_object', 'fit', 'scale', 'x', 'y', 'angle'],
  photo_preview: ['id', 'max_side', 'output_path'],
  photo_export: ['id', 'format', 'output_path', 'quality'],
};

export function photoEditingTools(): Data[] {
  return [
    spec(
      'photo_open',
      'Create or reopen a layered photo-editing workspace and show it in the work panel. Pass source_path to open an existing PSD, PSB, .pcraft, PNG, JPG, WebP, TIFF, SVG, or RAW image with its layers intact, or pass width/height/background to create a blank document.',
      {
        id,
        title: { type: 'string', description: 'Human-readable workspace or document title.' },
        source_path: {
          type: 'string',
          description: 'Optional absolute path inside the chat workspace to import as an editable document.',
        },
        width: { type: 'integer', minimum: 1, maximum: 16384, description: 'New document width in pixels (default 1920).' },
        height: { type: 'integer', minimum: 1, maximum: 16384, description: 'New document height in pixels (default 1080).' },
        resolution: { type: 'number', minimum: 1, maximum: 2400, description: 'Resolution in pixels per inch (default 72).' },
        background: {
          type: 'string',
          description: 'Canvas background for a new document: "white", "black", "transparent", or "#RRGGBB".',
        },
        mode: { type: 'string', enum: ['rgb', 'grayscale', 'cmyk', 'lab'] },
        depth: { type: 'integer', enum: [8, 16, 32] },
      },
    ),
    spec(
      'photo_inspect',
      'Inspect the live photo-editing workspace, persisted version, open document tabs, active selection, and layer tree (including manual edits made in the panel). Read version immediately before photo_execute or photo_place.',
      {
        id,
        tab_index: { type: 'integer', minimum: 0, description: 'Optional 0-based tab index to inspect without switching tabs.' },
        detail: { type: 'boolean', description: 'Include extended per-layer adjustment, style, and text details.' },
      },
    ),
    spec(
      'photo_commands',
      'Search the photo-editing engine command catalog and parameter documentation by id, label, or keyword before running unfamiliar edits.',
      {
        id,
        query: { type: 'string', description: 'Case-insensitive substring filter over command id, label, or keywords.' },
        enabled_only: { type: 'boolean', description: 'When true, list only commands currently enabled on the active document.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum commands to return (default 60).' },
      },
    ),
    spec(
      'photo_execute',
      'Execute one or more photo-editing engine commands on the shared live workspace. Pass expected_version from the latest photo_inspect, photo_open, photo_place, or photo_execute response; stale versions are refused so manual edits in the panel are never overwritten.',
      {
        id,
        expected_version: { type: 'integer', minimum: 0 },
        commands: {
          type: 'array',
          minItems: 1,
          maxItems: 128,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['command'],
            properties: {
              command: string,
              params: { type: 'object' },
            },
          },
        },
      },
      ['expected_version', 'commands'],
    ),
    spec(
      'photo_place',
      'Place a local image, PSD, or SVG file from the workspace onto the active document as a layer (embedded Smart Object by default so subsequent scaling and transforms stay non-destructive).',
      {
        id,
        expected_version: { type: 'integer', minimum: 0 },
        path: { type: 'string', description: 'Absolute path to the image file inside the chat workspace.' },
        layer_name: { type: 'string', description: 'Optional display name for the placed layer.' },
        smart_object: { type: 'boolean', description: 'Place as an embedded Smart Object (default true).' },
        fit: { type: 'boolean', description: 'Scale oversized assets down to fit inside the canvas (default true).' },
        scale: { type: 'number', minimum: 1, maximum: 1000, description: 'Optional initial scale percentage.' },
        x: { type: 'number', description: 'Optional center X position in document pixels.' },
        y: { type: 'number', description: 'Optional center Y position in document pixels.' },
        angle: { type: 'number', minimum: -360, maximum: 360, description: 'Optional rotation angle in degrees.' },
      },
      ['expected_version', 'path'],
    ),
    spec(
      'photo_preview',
      'Render a flattened PNG preview of the active document and return its saved local path so you can visually verify composition, color grading, masks, and typography with read.',
      {
        id,
        max_side: { type: 'integer', minimum: 64, maximum: 2048, description: 'Maximum longest edge in pixels (default 1024).' },
        output_path: { type: 'string', description: 'Optional absolute destination path inside the chat workspace.' },
      },
    ),
    spec(
      'photo_export',
      'Export the active document to PSD, PSB, native .pcraft, PNG, JPG, WebP, TIFF, or PDF. Use psd or pcraft to preserve editable layers, masks, adjustment layers, and text.',
      {
        id,
        format: { type: 'string', enum: ['psd', 'psb', 'pcraft', 'png', 'jpg', 'webp', 'tiff', 'pdf'] },
        output_path: { type: 'string', description: 'Optional absolute output path inside the chat workspace.' },
        quality: { type: 'integer', minimum: 1, maximum: 100, description: 'Compression quality (1-100) for jpg or webp.' },
      },
      ['format'],
    ),
  ];
}
