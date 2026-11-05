// Wire shapes of the turn-end resource "Open in" menu.

/** One installed application that can open a file or a local website. */
export interface EndResourceApp {
  /** Stable id for this menu row (`app:<bundle path>`). */
  id: string
  /** Application bundle path, the only thing an open request carries. */
  appPath: string
  bundleId: string
  label: string
  /** Official application artwork as a data URL, when it could be read. */
  iconDataUrl?: string
  /** The application the operating system opens this resource with. */
  isDefault?: boolean
}

export interface EndResourceTargets {
  apps: EndResourceApp[]
  /** System file manager artwork for the reveal row, when it could be read. */
  fileManagerIconDataUrl?: string
  /** Downloads folder artwork for the copy row, when it could be read. */
  downloadsIconDataUrl?: string
  /** Platform naming of the reveal row. */
  platform: 'darwin' | 'win32' | 'linux'
}

export type EndResourceTargetsRequest =
  | { sessionId: string; filePath: string }
  | { sessionId: string; url: string }

export type EndResourceOpenRequest =
  | { sessionId: string; filePath: string; appPath?: string }
  | { sessionId: string; url: string; appPath: string }

export interface EndResourcePageMeta {
  title: string | null
  /** The page's own icon as a data image, when it declared a readable one. */
  iconUrl: string | null
}

/** At most this many applications are listed for one resource. */
export const END_RESOURCE_APP_LIMIT = 5
