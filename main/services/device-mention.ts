// The model-facing half of a composer device chip.
//
// A chip renders as a placeholder run in the composer and reaches the model as
// a bare `@device-<id>` address block, so the model sees WHO was named without
// seeing a name it could act on. This module owns both ends of that contract:
// extracting the addresses from a request and turning them into the device
// context (host id, name, reachability) `send_message_to_thread` needs.

// The right boundary keeps a longer id-shaped run from matching as a truncated
// address: `@device-<129 chars>` is not a device id, it is prose.
const DEVICE_ADDRESS_RE = /@device-([A-Za-z0-9_-]{1,128})(?![A-Za-z0-9_-])/g

/** The distinct device ids a request text names, in first-seen order. */
export function deviceAddressesIn(text: string): string[] {
  const seen: string[] = []
  for (const match of String(text || '').matchAll(DEVICE_ADDRESS_RE)) {
    const id = match[1]!
    if (!seen.includes(id)) seen.push(id)
  }
  return seen
}

export interface DiscoveredDevice {
  id: string
  name: string
  status: string
  platform?: string | null
}

/**
 * The context block appended to a request that named devices. Unknown ids are
 * dropped: a chip for a device that left the account must not stall the turn,
 * and naming it would hand the model an address it cannot reach anyway.
 */
export function deviceContextBlock(
  addresses: string[],
  discovered: { localHostId: string | null; hosts: DiscoveredDevice[] },
): string {
  const lines: string[] = []
  for (const address of addresses) {
    if (address === discovered.localHostId) {
      lines.push(`- @device-${address}: this computer (the one running this conversation).`)
      continue
    }
    const host = discovered.hosts.find(row => row.id === address)
    if (!host) continue
    const reachable = host.status === 'online' || host.status === 'reconnecting'
    lines.push(`- @device-${host.id}: "${host.name}" (${host.platform ?? 'unknown'} platform, currently ${host.status}). `
      + (reachable
        ? `Pass hostId "${host.id}" to send_message_to_thread to reach a conversation on this computer.`
        : 'This computer is not reachable right now; say so instead of sending.'))
  }
  if (lines.length === 0) return ''
  return ['Target devices named in this message:', ...lines].join('\n')
}
