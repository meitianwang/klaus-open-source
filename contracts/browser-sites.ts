export type SiteOpenTargetId = 'in-app' | 'chrome' | 'system-default';

export interface SiteOpenTarget {
  id: SiteOpenTargetId;
  kind: 'in-app' | 'named' | 'system-default';
  name: string;
  iconDataUrl?: string;
  isDefault?: boolean;
}

export interface SiteOpenTargets {
  targets: SiteOpenTarget[];
  preferredTarget: SiteOpenTargetId;
  localPreferredTarget?: SiteOpenTargetId;
}

export interface SiteOpenRequest {
  sessionId: string;
  url: string;
  target?: SiteOpenTargetId;
}

export type SiteOpenResult = { ok: true; target: SiteOpenTargetId } | { ok: false; code: string; error: string };
