export function blocksWidgetFrameNavigation(initiatorUrl: string | null | undefined, frameUrl: string | null | undefined): boolean {
  const source = initiatorUrl ?? frameUrl ?? ''
  return source.startsWith('klaus-media://widget/')
}
