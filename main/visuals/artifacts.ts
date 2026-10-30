import type { Json } from '../ipc/contract';
import { object } from '../services/service-types';

/**
 * The clickable "open this surface" card a visual tool can publish into the
 * transcript.
 *
 * Every in-app visual surface (the diagram panel, the 3D panel, and anything
 * added later) reaches the user through ONE shape: a tool result carries an
 * `artifact`, the host projects it onto the `tool_end` event and the persisted
 * history, and the renderer turns it into a card that opens the owning panel.
 * Keeping the projector here — rather than one per surface — is what stops the
 * failure mode this replaced: a surface whose tool dutifully produced an
 * artifact that no projection layer was taught to recognise, so the card never
 * appeared and the panel could only be opened by a route the user could not see.
 */
export type VisualArtifactKind = 'diagram' | 'model3d' | 'prototype' | 'video-editing' | 'ppt';

export interface VisualArtifact {
  kind: VisualArtifactKind;
  id: string;
  title: string;
  /**
   * Whether the surface already held content when the tool published the card.
   * Only surfaces that can be opened empty publish it: an interface design is
   * created before anything is drawn into it, and a card that claims a finished
   * deliverable at creation time tells the user the opposite of what the panel
   * will show them. Absent means "unknown", which renders the ready copy so
   * saved history from before this field keeps its card.
   */
  ready?: boolean;
}

interface Surface {
  kind: VisualArtifactKind;
  /** The `mcp__<server>__` prefix the engine gives this host-managed server. */
  server: string;
  /** The tool-name prefix when the engine reaches the server bare. */
  bare: string;
  /** Title used when the tool published none. */
  defaultTitle: string;
}

/**
 * The built-in visual surfaces, and the tool namespace each one owns.
 *
 * Matching is on the SURFACE, not on a list of verb names. Two reasons. The
 * provenance boundary stays exactly as strong — a card can only come from the
 * built-in server's own namespace, so a foreign MCP server returning the same
 * JSON shape is refused. And a card is no longer lost because some verb was
 * never added to a whitelist: the 3D service creates its document implicitly
 * when a task opens with a modelling verb instead of `model3d_scene`, and that
 * call still has to be able to hand the user a way in.
 */
const SURFACES: readonly Surface[] = [
  { kind: 'diagram', server: 'mcp__klaus-digram__', bare: 'digram_', defaultTitle: 'Diagram' },
  { kind: 'model3d', server: 'mcp__klaus-model3d__', bare: 'model3d_', defaultTitle: '3D scene' },
  { kind: 'prototype', server: 'mcp__klaus-prototype__', bare: 'prototype_', defaultTitle: 'Prototype' },
  { kind: 'video-editing', server: 'mcp__klaus-video-editing__', bare: 'video_editing_', defaultTitle: 'Video' },
  { kind: 'ppt', server: 'mcp__klaus-ppt__', bare: 'ppt_', defaultTitle: 'Presentation' },
];

const MAX_ID_LENGTH = 160;
const MAX_TEXT_BYTES = 20 * 1024 * 1024;

function surfaceOf(toolName: string): Surface | undefined {
  return SURFACES.find(surface => toolName.startsWith(surface.server) || toolName.startsWith(surface.bare));
}

/**
 * Every place a tool result can carry the artifact envelope: the structured
 * content, and each JSON text block in `content`. A failed call publishes
 * nothing — a card that opens a surface must never claim a success that errored.
 */
function* candidates(result: unknown): Iterable<Record<string, Json>> {
  let raw = result;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return; } }
  const value = object(raw);
  if (value.isError === true || value.is_error === true) return;
  yield object(value.structuredContent ?? value.structured_content);
  for (const entry of Array.isArray(value.content) ? value.content : []) {
    const text = object(entry).text;
    if (typeof text !== 'string' || text.length > MAX_TEXT_BYTES) continue;
    try { yield object(JSON.parse(text)); } catch { /* Ordinary tool text has no artifact. */ }
  }
}

function normalize(value: Record<string, Json>, surface: Surface): VisualArtifact | undefined {
  // The payload's own kind must match the surface that published it, so a 3D
  // tool cannot mint a diagram card or vice versa.
  if (value.kind !== surface.kind) return undefined;
  if (typeof value.id !== 'string' || !value.id || value.id.length > MAX_ID_LENGTH) return undefined;
  const title = typeof value.title === 'string' && value.title.trim() ? value.title : surface.defaultTitle;
  return { kind: surface.kind, id: value.id, title, ...(typeof value.ready === 'boolean' ? { ready: value.ready } : {}) };
}

/** The card a completed visual tool call publishes, or undefined when it publishes none. */
export function visualArtifact(toolName: string, result: unknown): VisualArtifact | undefined {
  const surface = surfaceOf(toolName);
  if (!surface) return undefined;
  for (const value of candidates(result)) {
    const artifact = normalize(object(value.artifact), surface);
    if (artifact) return artifact;
  }
  return undefined;
}

/**
 * Older saved diagram results predate the explicit artifact field but still hold
 * the document inline. Repair them into a card only where verified history
 * ownership allows (the caller confirms the store accepts the claim). Two limits
 * keep this narrow: only `digram_open` ever wrote that shape, and 3D documents
 * always carry a session owner, so they need no legacy path at all.
 */
export function legacyDiagramArtifact(toolName: string, result: unknown): VisualArtifact | undefined {
  const surface = surfaceOf(toolName);
  if (surface?.kind !== 'diagram' || !toolName.endsWith('digram_open')) return undefined;
  for (const value of candidates(result)) {
    if (value.artifact != null || !value.document || typeof value.document !== 'object' || Array.isArray(value.document)) continue;
    const artifact = normalize({ kind: 'diagram', id: value.id ?? null, title: object(value.document).title ?? null }, surface);
    if (artifact) return artifact;
  }
  return undefined;
}
