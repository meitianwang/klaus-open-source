type Tone = 'pdf' | 'code' | 'sheet' | 'doc' | 'archive' | 'media' | 'generic'
const groups = {
  code: 'ts tsx js jsx mjs cjs py rs go swift kt java c cpp h sh sql html css json yaml yml toml',
  sheet: 'xlsx xls csv tsv', doc: 'docx doc md txt rtf pptx ppt',
  archive: 'zip tar gz tgz 7z rar dmg', media: 'mp4 mov webm mp3 wav m4a flac',
} as const
export function resolveFileCardBadge(fileName: string, mimeType?: string): { badge: string; tone: Tone; iconName: 'file-2' | 'code' | 'image-square' } {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1].toLowerCase() || ''
  if (ext === 'pdf' || mimeType?.split(';')[0].trim().toLowerCase() === 'application/pdf') return { badge: 'PDF', tone: 'pdf', iconName: 'file-2' }
  const match = Object.entries(groups).find(([, list]) => list.split(' ').includes(ext))
  const tone = (match?.[0] || 'generic') as Tone
  return { badge: (match ? ext.slice(0, 4) : /^[a-z0-9]{1,4}$/.test(ext) ? ext : 'file').toUpperCase(), tone, iconName: tone === 'code' ? 'code' : 'file-2' }
}
