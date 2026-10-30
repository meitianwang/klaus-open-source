import type { EditCommandKeystroke } from './composer-edit-commands';

export type ImageZoomCommand = 'in' | 'out' | 'fit';
export function readImageZoomCommand(input: EditCommandKeystroke & { code?: string }, platform: NodeJS.Platform): ImageZoomCommand | null {
  if (input.type !== 'keyDown' || input.isComposing || input.alt) return null;
  const primary = platform === 'darwin' ? input.meta : input.control;
  const other = platform === 'darwin' ? input.control : input.meta;
  if (!primary || other) return null;
  if (input.code === 'NumpadAdd' || input.code === 'Equal' || input.key === '+' || input.key === '=') return 'in';
  if (input.code === 'NumpadSubtract' || input.code === 'Minus' || input.key === '-' || input.key === '_') return 'out';
  return !input.shift && (input.code === 'Digit0' || input.code === 'Numpad0' || input.key === '0') ? 'fit' : null;
}
export interface ImageZoomTarget {
  evaluate(script: string): Promise<unknown>;
  nativeZoom(command: ImageZoomCommand): void;
}
export interface ImageZoomHost extends ImageZoomTarget {
  onBeforeInput(listener: (event: { preventDefault(): void }, input: EditCommandKeystroke) => void): () => void;
}
/** Standard window zoom commands belong to the active image while it is open. */
export class ImageZoomCommands {
  private detach?: () => void;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly host: ImageZoomHost, private readonly platform: NodeJS.Platform = process.platform, private readonly log?: (message: string) => void) {}
  start(): void {
    if (this.detach) return;
    this.closed = false;
    this.detach = this.host.onBeforeInput((event, input) => {
      const command = readImageZoomCommand(input, this.platform);
      if (!command) return;
      event.preventDefault();
      void this.dispatch(command);
    });
  }
  dispatch(command: ImageZoomCommand, origin: ImageZoomTarget = this.host): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (this.closed) return;
      const owned = await origin.evaluate(`window.klausImageZoomCommand ? window.klausImageZoomCommand(${JSON.stringify(command)}) : null`);
      if (!this.closed && owned !== true && owned !== false) origin.nativeZoom(command);
    }).catch(error => this.log?.(String(error)));
    return this.pending;
  }
  close(): void { this.closed = true; this.detach?.(); this.detach = undefined; }
}
