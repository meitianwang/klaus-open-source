const PLUGIN_LOGOS = new Map<string, string>([
  ['model3d@klaus-official', 'extension-logos/plugins/model3d.png'],
  ['prototype-studio@klaus-official', 'extension-logos/plugins/prototype-studio.png'],
  ['browser@builtin', 'extension-logos/plugins/browser.png'],
  ['digram@klaus-official', 'extension-logos/plugins/digram.png'],
  ['iphoneuse@klaus-official', 'extension-logos/plugins/iphoneuse.png'],
])

const AGENT_LOGOS = new Map<string, string>([
  ['explore', 'extension-logos/agents/explore.png'],
  ['general-purpose', 'extension-logos/agents/general-purpose.png'],
  ['plan', 'extension-logos/agents/plan.png'],
  ['researcher', 'extension-logos/agents/researcher.png'],
])

const CONNECTOR_LOGOS = new Map<string, string>([
  ['computeruse', 'skill-logos/computer-use.png'],
  ['computer-use', 'skill-logos/computer-use.png'],
  ['github', 'extension-logos/connectors/github.png'],
  ['group:macos', 'extension-logos/connectors/macos.png'],
  ['connectors:macos', 'extension-logos/connectors/macos.png'],
])

const key = (value: unknown): string => String(value ?? '').trim().toLowerCase()

/** Package artwork updates with its marketplace; older packages keep shipped fallbacks. */
export function getPluginLogoSrc(plugin: { id?: unknown; iconDataUrl?: unknown } | null | undefined): string {
  const icon = plugin?.iconDataUrl;
  if (typeof icon === 'string' && icon.length <= 4 * Math.ceil(64 * 1024 / 3) + 32
    && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(icon)) {
    try {
      const [header, encoded] = icon.split(','), bytes = atob(encoded!);
      const mime = bytes.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png'
        : bytes.startsWith('\xff\xd8\xff') ? 'image/jpeg'
        : bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP' ? 'image/webp'
        : bytes.startsWith('GIF87a') || bytes.startsWith('GIF89a') ? 'image/gif' : '';
      if (bytes.length <= 64 * 1024 && btoa(bytes) === encoded && header === `data:${mime};base64`) return icon;
    } catch { /* Malformed artwork uses the ordinary plugin fallback. */ }
  }
  return PLUGIN_LOGOS.get(key(plugin?.id)) || ''
}

export function getAgentLogoSrc(agentType: unknown): string {
  return AGENT_LOGOS.get(key(agentType)) || ''
}

/** Group artwork never replaces the individual native application icons. */
export function getConnectorLogoSrc(connectorId: unknown): string {
  return CONNECTOR_LOGOS.get(key(connectorId)) || ''
}
