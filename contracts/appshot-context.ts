import type { PetAppshotContext } from './desktop-pet-composer';

/** Captured application text is user-supplied context, separate from the user's request. */
export function appshotContextText(context: PetAppshotContext): string {
  const lines = ['Application snapshot (captured user interface content):', `Captured at: ${new Date(context.capturedAt).toISOString()}`];
  for (const [label, value] of [['Application', context.appName], ['Bundle identifier', context.bundleId], ['Window', context.windowTitle], ['URL', context.url]] as const) if (value) lines.push(`${label}: ${value}`);
  if (context.selectedText) lines.push(`Selected text:\n${context.selectedText}`);
  if (context.accessibilityText) lines.push(`Visible application text:\n${context.accessibilityText}`);
  if (context.accessibilityUnavailableReason) lines.push(`Accessibility context unavailable: ${context.accessibilityUnavailableReason}`);
  if (context.treeTruncated) lines.push('The visible application text was truncated.');
  if (context.observationChanged) lines.push('The application changed while its screenshot was captured.');
  return lines.join('\n');
}
