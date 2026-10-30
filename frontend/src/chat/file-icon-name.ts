/** File categories share the same icon in main and worker renderers. */
export function fileIconName(name: string): string {
  const lower = (name || '').toLowerCase()
  if (/\.(md|markdown)$/.test(lower)) {
    return 'chat-file'
  }
  if (/\.(json|ya?ml|toml)$/.test(lower)) {
    return 'chat-file-2'
  }
  if (/\.(sh|bash|zsh|fish|bat|ps1)$/.test(lower)) {
    return 'chat-file-3'
  }
  if (/\.(py|js|ts|jsx|tsx|go|rs|java|c|cpp|h|hpp|cs|rb|php|swift|kt)$/.test(lower)) {
    return 'chat-file-code'
  }
  return 'chat-file-plain'
}
