import { useEffect, useRef, useState, type RefObject } from 'react';

export const TOOLBAR_PRESENTATION = {
  enterDistance: 40,
  exitDistance: 56,
  dismissDelayMs: 300,
} as const;

export function distanceToRect(point: { x: number; y: number }, rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>): number {
  return Math.hypot(Math.max(rect.left - point.x, 0, point.x - rect.right), Math.max(rect.top - point.y, 0, point.y - rect.bottom));
}

export function useToolbarPresentation(
  frame: RefObject<HTMLElement | null>,
  visible: boolean,
  pinned: boolean,
): boolean {
  const [near, setNear] = useState(false);
  const nearRef = useRef(false);
  const [presented, setPresented] = useState(pinned);
  useEffect(() => {
    if (!visible) { nearRef.current = false; setNear(false); return; }
    const receive = (event: Event) => {
      const point = event instanceof CustomEvent ? event.detail as { x: number; y: number } : { x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY };
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
      const distance = Math.min(...Array.from(frame.current?.querySelectorAll<HTMLElement>('[data-pet-hit]') ?? [], element => distanceToRect(point, element.getBoundingClientRect())));
      const next = distance <= (nearRef.current ? TOOLBAR_PRESENTATION.exitDistance : TOOLBAR_PRESENTATION.enterDistance);
      if (next !== nearRef.current) { nearRef.current = next; setNear(next); }
    };
    window.addEventListener('pet-pointer', receive);
    window.addEventListener('pointermove', receive);
    return () => { window.removeEventListener('pet-pointer', receive); window.removeEventListener('pointermove', receive); };
  }, [frame, visible]);
  useEffect(() => {
    if (!visible) { setPresented(false); return; }
    if (near || pinned) { setPresented(true); return; }
    const timer = setTimeout(() => setPresented(false), TOOLBAR_PRESENTATION.dismissDelayMs);
    return () => clearTimeout(timer);
  }, [near, pinned, visible]);
  return visible && (presented || pinned || near);
}
