/** File categories share the same icon in main and worker renderers. */
export function fileIconName(name: string): string {
  const lower = (name || '').toLowerCase()
  if (/\.pdf$/.test(lower)) return 'resource-file-pdf'
  if (/\.(csv|tsv)$/.test(lower)) return 'resource-file-spreadsheet'
  if (/\.(xlsx?|xlsm|xltx|xltm|xlt|ods|et|ett)$/.test(lower)) return 'resource-file-excel'
  if (/\.(docx?|docm|dotx|dotm|dot|odt|rtf|wps|wpt)$/.test(lower)) return 'resource-file-word'
  if (/\.(pptx?|pptm|ppsx?|ppsm|potx|potm|pot|odp|dps|dpt)$/.test(lower)) return 'resource-file-powerpoint'
  if (/\.xmind$/.test(lower)) return 'resource-file-document'
  if (/\.(html?|xhtml)$/.test(lower)) return 'resource-file-html'
  if (/\.(md|markdown|mdown|mkd)$/.test(lower)) {
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
