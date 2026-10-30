/** The friend folder already identifies the sender. Hide only the prefix
 * recorded for that friendship; renamed and ordinary titles stay intact. */
export function friendGroupThreadTitle(title: string, friendshipId: string, hostMetadata: unknown): string {
  if (!hostMetadata || typeof hostMetadata !== 'object' || !('friend' in hostMetadata)) return title
  const friend = hostMetadata.friend
  if (!friend || typeof friend !== 'object'
    || !('friendshipId' in friend) || friend.friendshipId !== friendshipId
    || !('displayName' in friend) || typeof friend.displayName !== 'string'
    || !friend.displayName) return title
  const prefix = `${friend.displayName} · `
  if (!title.startsWith(prefix)) return title
  const content = title.slice(prefix.length)
  return content.trim() ? content : title
}
