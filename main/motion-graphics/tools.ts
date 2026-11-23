import type { Data } from '../visuals/data';

const string = { type: 'string' };
const id = {
  type: 'string',
  description: 'Motion-graphics workspace id. Omit to use the latest workspace in this chat.',
};

function spec(name: string, description: string, properties: Data, required: string[] = []): Data {
  return {
    name,
    description,
    inputSchema: { type: 'object', additionalProperties: false, properties, required },
  };
}

export const MOTION_GRAPHICS_TOOL_FIELDS: Record<string, readonly string[]> = {
  motion_open: ['id', 'title', 'source_path', 'width', 'height', 'fps', 'duration', 'background'],
  motion_inspect: ['id', 'comp', 'detail'],
  motion_commands: ['id', 'query', 'enabled_only', 'limit'],
  motion_execute: ['id', 'expected_version', 'commands'],
  motion_import_footage: ['id', 'expected_version', 'path', 'add_to_comp', 'new_comp'],
  motion_preview: ['id', 'comp', 'time', 'times', 'columns', 'labels', 'max_side', 'transparent', 'output_path'],
  motion_export: ['id', 'format', 'comp', 'time', 'transparent', 'output_path'],
};

export function motionGraphicsTools(): Data[] {
  return [
    spec(
      'motion_open',
      'Create or reopen a motion-graphics and visual-effects composition workspace and show it in the work panel. Pass source_path to open an existing .ecproj, .aep, .aepx, Lottie .json/.lottie, layered .psd, video, audio, or image asset, or pass width/height/fps/duration/background to create a fresh composition.',
      {
        id,
        title: { type: 'string', description: 'Human-readable workspace or main composition title.' },
        source_path: {
          type: 'string',
          description: 'Optional absolute path inside the chat workspace (.ecproj, .aep, .aepx, .lottie, .json, .psd, .mp4, .mov, .webm, .png, .jpg, .svg, .wav, .mp3).',
        },
        width: { type: 'integer', minimum: 16, maximum: 7680, description: 'Composition width in pixels (default 1920).' },
        height: { type: 'integer', minimum: 16, maximum: 7680, description: 'Composition height in pixels (default 1080).' },
        fps: { type: 'number', minimum: 1, maximum: 240, description: 'Frame rate in frames per second (default 30).' },
        duration: { type: 'number', minimum: 0.1, maximum: 3600, description: 'Composition duration in seconds (default 5).' },
        background: { type: 'string', description: 'Composition background hex color such as "#10121A".' },
      },
    ),
    spec(
      'motion_inspect',
      'Inspect the live motion-graphics workspace, persisted version, compositions, active timeline layers, keyframes, expressions, effects, and WebGPU compositor telemetry (including manual edits made in the panel). Read version immediately before motion_execute or motion_import_footage.',
      {
        id,
        comp: {
          anyOf: [{ type: 'integer' }, { type: 'string' }],
          description: 'Optional composition id or name to inspect.',
        },
        detail: {
          type: 'boolean',
          description: 'Include deep per-layer property trees, keyframes, masks, effects, and expressions.',
        },
      },
    ),
    spec(
      'motion_commands',
      'Search the motion-graphics command and GPU effect catalog with parameter schemas by id, label, or keyword before running unfamiliar timeline, shape, text, expression, 3D camera, or effect edits.',
      {
        id,
        query: { type: 'string', description: 'Case-insensitive substring filter over command or effect id, label, and category.' },
        enabled_only: { type: 'boolean', description: 'When true, list only commands currently enabled on the active composition.' },
        limit: { type: 'integer', minimum: 1, maximum: 400, description: 'Maximum commands to return (default 80).' },
      },
    ),
    spec(
      'motion_execute',
      'Execute one or more motion-graphics engine commands atomically on the shared live composition. Pass expected_version from the latest motion_inspect, motion_open, motion_import_footage, or motion_execute response; stale versions are refused so manual edits in the panel are never overwritten.',
      {
        id,
        expected_version: { type: 'integer', minimum: 0 },
        commands: {
          type: 'array',
          minItems: 1,
          maxItems: 256,
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
      'motion_import_footage',
      'Import a local media or project file (.mp4, .mov, .webm, .wav, .mp3, .png, .jpg, .webp, .svg, .psd, .aep, .aepx, .lottie, .json) from the chat workspace into the motion-graphics project media pool and optionally place it onto the active composition.',
      {
        id,
        expected_version: { type: 'integer', minimum: 0 },
        path: { type: 'string', description: 'Absolute path to the media or project file inside the chat workspace.' },
        add_to_comp: { type: 'boolean', description: 'Add the imported footage item as a layer in the active composition (default true).' },
        new_comp: { type: 'boolean', description: 'Create a new composition sized to the imported footage (default false).' },
      },
      ['expected_version', 'path'],
    ),
    spec(
      'motion_preview',
      'Render either a single frame (`time`) or a multi-timestamp contact sheet (`times: [0, 0.5, 1.0, ...]`) of the composition to a PNG file and return its saved local path so you can visually verify motion progression, easing, effects, and typography with read.',
      {
        id,
        comp: {
          anyOf: [{ type: 'integer' }, { type: 'string' }],
          description: 'Optional composition id or name (defaults to the active composition).',
        },
        time: { type: 'number', minimum: 0, description: 'Timestamp in seconds for a single-frame preview (defaults to playhead time).' },
        times: {
          type: 'array',
          minItems: 1,
          maxItems: 24,
          items: { type: 'number', minimum: 0 },
          description: 'Array of timestamps in seconds to render as a single tiled contact-sheet PNG.',
        },
        columns: { type: 'integer', minimum: 1, maximum: 8, description: 'Optional grid column count when rendering `times`.' },
        labels: { type: 'boolean', description: 'Draw timestamp badges on contact-sheet cells (default true).' },
        max_side: { type: 'integer', minimum: 64, maximum: 4096, description: 'Maximum longest edge per frame/cell in pixels (default 1280 single, 560 contact sheet).' },
        transparent: { type: 'boolean', description: 'Composite over transparent alpha instead of composition background color (default false).' },
        output_path: { type: 'string', description: 'Optional absolute PNG destination path inside the chat workspace.' },
      },
    ),
    spec(
      'motion_export',
      'Export the composition or project to MP4 (H.264), WebM (VP9), QuickTime MOV, animated GIF, WAV audio, PNG frame, layered PSD frame, Lottie JSON, dotLottie (.lottie), .aep project, or native .ecproj.',
      {
        id,
        format: {
          type: 'string',
          enum: ['mp4', 'webm', 'mov', 'gif', 'png', 'psd', 'wav', 'lottie', 'dotlottie', 'aep', 'ecproj'],
        },
        comp: {
          anyOf: [{ type: 'integer' }, { type: 'string' }],
          description: 'Optional composition id or name to render.',
        },
        time: { type: 'number', minimum: 0, description: 'Frame timestamp in seconds when format is "png" or "psd".' },
        transparent: { type: 'boolean', description: 'Preserve alpha transparency when supported by the target format.' },
        output_path: { type: 'string', description: 'Optional absolute output path inside the chat workspace.' },
      },
      ['format'],
    ),
  ];
}
