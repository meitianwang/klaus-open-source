/**
 * File associations declared in macOS Info.plist (CFBundleDocumentTypes) and
 * Windows installer / per-user OpenWith registrations.
 *
 * Every entry uses Viewer role and Alternate handler rank so the operating
 * system lists the desktop app under "Open With" without taking over the
 * user's default double-click handler.
 */

export const FILE_ASSOCIATION_GROUPS = Object.freeze([
  {
    id: 'word',
    name: 'Document',
    description: 'Word & Rich Text Document',
    extensions: ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'wps', 'wpt', 'odt', 'rtf'],
  },
  {
    id: 'spreadsheet',
    name: 'Spreadsheet',
    description: 'Spreadsheet & Delimited Table',
    extensions: ['xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'xltm', 'et', 'ett', 'ods', 'csv', 'tsv'],
  },
  {
    id: 'presentation',
    name: 'Presentation',
    description: 'Presentation Deck',
    extensions: ['ppt', 'pptx', 'pptm', 'pot', 'potx', 'potm', 'pps', 'ppsx', 'ppsm', 'dps', 'dpt', 'odp'],
  },
  {
    id: 'mindmap',
    name: 'Mind Map',
    description: 'XMind Mind Map',
    extensions: ['xmind'],
  },
  {
    id: 'pdf',
    name: 'PDF Document',
    description: 'PDF Document',
    extensions: ['pdf'],
  },
  {
    id: 'markdown-text',
    name: 'Text & Config',
    description: 'Markdown, Text & Structured Data',
    extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt', 'log', 'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'conf'],
  },
  {
    id: 'web-code',
    name: 'Web & Source',
    description: 'HTML, SVG & Source File',
    extensions: ['html', 'htm', 'xhtml', 'svg', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'sh', 'sql'],
  },
  {
    id: 'image',
    name: 'Image',
    description: 'Image File',
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'],
  },
  {
    id: 'media',
    name: 'Audio & Video',
    description: 'Audio & Video File',
    extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'mp4', 'webm', 'mov', 'm4v', 'ogv', '3gp', 'mkv', 'avi', 'wmv', 'flv'],
  },
  {
    id: 'archive',
    name: 'Archive',
    description: 'ZIP Archive',
    extensions: ['zip'],
  },
]);

export const ALL_ASSOCIATED_EXTENSIONS = Object.freeze([
  ...new Set(FILE_ASSOCIATION_GROUPS.flatMap(group => group.extensions)),
]);

export const REQUIRED_CORE_ASSOCIATED_EXTENSIONS = Object.freeze([
  'doc', 'docx', 'dot', 'wps', 'wpt',
  'xls', 'xlsx', 'xlt', 'et', 'ett', 'csv', 'tsv',
  'ppt', 'pptx', 'pot', 'ppsm', 'dps', 'dpt',
  'xmind', 'pdf', 'md', 'mdown', 'mkd', 'html', 'svg', 'png', 'mp3', 'mp4', '3gp', 'zip',
]);

export function electronBuilderFileAssociations(edition) {
  return FILE_ASSOCIATION_GROUPS.map(group => ({
    ext: [...group.extensions],
    name: `${edition.productName} ${group.name}`,
    description: group.description,
    role: 'Viewer',
  }));
}

export function macDocumentTypes(edition) {
  return [
    ...FILE_ASSOCIATION_GROUPS.map(group => ({
      CFBundleTypeName: `${edition.productName} ${group.name}`,
      CFBundleTypeRole: 'Viewer',
      LSHandlerRank: 'Alternate',
      CFBundleTypeExtensions: [...group.extensions],
    })),
    {
      CFBundleTypeName: `${edition.productName} Folder`,
      CFBundleTypeRole: 'Viewer',
      LSHandlerRank: 'Alternate',
      LSItemContentTypes: ['public.folder'],
    },
  ];
}
