import type { PetPlacement, PetRect } from '../../contracts/desktop-pet';
export interface PetPoint { x: number; y: number }
export interface PetDisplay { id: number; bounds: PetRect; workArea: PetRect }
export function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(value, Math.max(minimum, maximum))); }
export function clampPet(point: PetPoint, size: { width: number; height: number }, area: PetRect): PetPoint {
  return { x: Math.round(clamp(point.x, area.x, area.x + area.width - size.width)), y: Math.round(clamp(point.y, area.y, area.y + area.height - size.height)) };
}
export function petPlacement(point: PetPoint, area: PetRect): PetPlacement {
  return `${point.y < area.y + area.height / 2 ? 'top' : 'bottom'}-${point.x < area.x + area.width / 2 ? 'start' : 'end'}`;
}
export function snapPet(point: PetPoint, size: { width: number; height: number }, area: PetRect): PetPoint {
  const horizontal = (point.x + size.width / 2 - area.x) / area.width;
  const top = point.y + size.height / 2 < area.y + area.height / 2;
  return { x: horizontal < 1 / 3 ? area.x + 16 : horizontal >= 2 / 3 ? area.x + area.width - size.width - 16 : area.x + (area.width - size.width) / 2, y: top ? area.y + 16 : area.y + area.height - size.height - 16 };
}
export function resolutionKey(area: PetRect): string { return `${area.width}x${area.height}`; }
export function containsPoint(rect: PetRect, point: PetPoint): boolean { return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height; }

/** Keep every visible accessory inside the work area while retaining an edge restore target. */
export function layoutPetWindow(anchor: PetPoint, pet: PetRect, viewport: { width: number; height: number }, area: PetRect, stashedEdge: 'left' | 'right' | null = null, movingAcrossEdge = false, accessories?: PetRect): { bounds: PetRect; anchor: PetPoint; pet?: PetRect; contentOffset?: PetPoint; accessoryOffset?: PetPoint } {
  if (accessories) return layoutPetDrawWindow(anchor, pet, viewport, area, stashedEdge, movingAcrossEdge, accessories);
  const width = Math.max(1, Math.min(Math.ceil(viewport.width), area.width));
  const height = Math.max(1, Math.min(Math.ceil(viewport.height), area.height));
  const exposed = Math.min(24, pet.width);
  const x = movingAcrossEdge ? anchor.x - pet.x : stashedEdge === 'left' ? area.x - pet.x - pet.width + exposed
    : stashedEdge === 'right' ? area.x + area.width - pet.x - exposed
    : clamp(anchor.x - pet.x, area.x, area.x + area.width - width);
  const y = clamp(anchor.y - pet.y, area.y, area.y + area.height - height);
  const bounds = { x: Math.round(x), y: Math.round(y), width, height };
  return { bounds, anchor: { x: bounds.x + pet.x, y: bounds.y + pet.y } };
}

/** Restore the same logical point when a display moves within the desktop arrangement. */
export function restorePetPosition(position: PetPoint & { displayBounds: PetRect }, displayBounds: PetRect): PetPoint {
  return { x: position.x + displayBounds.x - position.displayBounds.x, y: position.y + displayBounds.y - position.displayBounds.y };
}
export function canStashPet(edge: 'left' | 'right', bounds: PetRect, workArea: PetRect): boolean {
  return edge === 'left' ? workArea.x === bounds.x : workArea.x + workArea.width === bounds.x + bounds.width;
}
export const PET_MOTION = Object.freeze({ intervalMs: 16, maximumStepMs: 32, decay: 0.88, bounce: 0.7, minimumSpeed: 65, maximumDurationMs: 900, spring: 220, damping: 26 });

/** Reserve transparent drawing space independently from visible content constraints. */
export function layoutPetDrawWindow(anchor: PetPoint, pet: PetRect, viewport: { width: number; height: number }, area: PetRect, stashedEdge: 'left' | 'right' | null, movingAcrossEdge: boolean, accessories: PetRect) {
  const padding = 28, marginX = Math.min(16, Math.max(0, (area.width - accessories.width) / 2)), marginY = Math.min(16, Math.max(0, (area.height - accessories.height) / 2));
  const minimum = { x: area.x, y: area.y }, maximum = { x: area.x + Math.max(0, area.width - pet.width), y: area.y + Math.max(0, area.height - pet.height) };
  const visible = clampPet(anchor, pet, area);
  if (movingAcrossEdge) visible.x = anchor.x;
  else if (stashedEdge) visible.x = stashedEdge === 'left' ? area.x - pet.width + Math.min(24, pet.width) : area.x + area.width - Math.min(24, pet.width);
  const origin = { x: visible.x - pet.x, y: visible.y - pet.y };
  const accessoryOffset = {
    x: Math.round(clamp(origin.x + accessories.x, area.x + marginX, area.x + area.width - marginX - accessories.width) - origin.x - accessories.x),
    y: Math.round(clamp(origin.y + accessories.y, area.y + marginY, area.y + area.height - marginY - accessories.height) - origin.y - accessories.y),
  };
  const minimumShift = { x: Math.min(0, area.x + area.width - marginX - accessories.width - (maximum.x - pet.x + accessories.x)), y: Math.min(0, area.y + area.height - marginY - accessories.height - (maximum.y - pet.y + accessories.y)) };
  const maximumShift = { x: Math.max(0, area.x + marginX - (minimum.x - pet.x + accessories.x)), y: Math.max(0, area.y + marginY - (minimum.y - pet.y + accessories.y)) };
  const horizontalReach = Math.ceil(Math.max(viewport.width + padding, pet.x - accessories.x - minimumShift.x + padding, accessories.x + accessories.width + maximumShift.x - pet.x - pet.width + padding));
  const verticalReach = Math.ceil(Math.max(area.height + padding, viewport.height + padding, pet.y - accessories.y - minimumShift.y + padding, accessories.y + accessories.height + maximumShift.y - pet.y - pet.height + padding));
  // Reserve both accessory orientations so crossing an edge never moves the mascot in its draw surface.
  const contentOffset = { x: horizontalReach - pet.x, y: verticalReach - pet.y };
  return { bounds: { x: Math.round(visible.x - horizontalReach), y: Math.round(visible.y - verticalReach), width: horizontalReach * 2 + pet.width, height: verticalReach * 2 + pet.height }, anchor: visible, pet: { ...pet, x: horizontalReach, y: verticalReach }, contentOffset, accessoryOffset };
}
export function petWindowOriginBounds(pet: PetRect, area: PetRect): PetRect {
  return { x: area.x - pet.x, y: area.y - pet.y, width: Math.max(0, area.width - pet.width), height: Math.max(0, area.height - pet.height) };
}
