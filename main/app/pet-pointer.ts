import type { Point } from 'electron';
import type { PetRect } from '../../contracts/desktop-pet';

/** Observe mouse presses without installing a keyboard hook or requesting screen access. */
export function observePetOutsideClicks(
  readButtons: () => number,
  cursor: () => Point,
  listener: (point: Point) => void,
  report: (message: string) => void,
): () => void {
  let previous = readButtons();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      const buttons = readButtons();
      if ((buttons & ~previous) !== 0) listener(cursor());
      previous = buttons;
    } catch (error) {
      stopped = true;
      clearInterval(timer);
      report(error instanceof Error ? error.message : String(error));
    }
  }, 16);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}

/** Native monitors retain short clicks and exclude sheets before dispatching to the host. */
export function observeNativePetOutsideClicks(
  binding: { observePetOutsideClicks(handle: Buffer, callback: (windowNumber: number) => void): number; stopPetOutsideClicks(token: number): void },
  handle: Buffer, cursor: () => Point, listener: (point: Point) => void, report: (message: string) => void, isHostWindow?: (windowNumber: number) => boolean,
): () => void {
  let stopped = false;
  const token = binding.observePetOutsideClicks(handle, windowNumber => {
    if (stopped || (windowNumber > 0 && isHostWindow && !isHostWindow(windowNumber))) return;
    try { listener(cursor()); } catch (error) { report(error instanceof Error ? error.message : String(error)); }
  });
  return () => { if (stopped) return; stopped = true; binding.stopPetOutsideClicks(token); };
}

export interface NativePetDragEvent { windowX: number; windowY: number; ended: boolean; altKey: boolean }
export function beginNativePetWindowDrag(
  binding: { beginPetWindowDrag(handle: Buffer, x: number, y: number, callback: (event: NativePetDragEvent) => void, originBounds?: PetRect): number; stopPetWindowDrag(token: number): void },
  handle: Buffer, point: Point, listener: (event: NativePetDragEvent) => void, report: (message: string) => void, originBounds?: PetRect,
): (() => void) | undefined {
  let stopped = false;
  const token = binding.beginPetWindowDrag(handle, point.x, point.y, event => { if (stopped) return; try { listener(event); } catch (error) { report(error instanceof Error ? error.message : String(error)); } }, originBounds);
  if (!token) return;
  return () => { if (stopped) return; stopped = true; binding.stopPetWindowDrag(token); };
}
