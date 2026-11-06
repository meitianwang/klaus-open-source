export interface BrowserExtensionInfo {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  loaded: boolean;
  path: string;
  permissions: string[];
  error?: string;
}

export interface BrowserExtensionPackage {
  path: string;
  id?: string;
  name?: string;
  version?: string;
}

export interface BrowserExtensionsSnapshot {
  items: BrowserExtensionInfo[];
}
