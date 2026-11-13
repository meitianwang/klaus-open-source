import { clientMessageId } from '../../../../contracts/message-identity'

interface MessageIdentity { uuid?: string; clientMessageId?: string; timestamp?: unknown; text?: unknown; steered?: boolean; questionAnswer?: unknown; localRender?: unknown }

/** UI identities outlive server acknowledgements and changes of transcript ownership. */
export class TranscriptRenderIdentity {
  private aliases = new Map<string, string>()
  private turnRevision = 0

  get revision(): number { return this.turnRevision }

  private resolve(aliases: string[], turn = false): string {
    const key = aliases.map(alias => this.aliases.get(alias)).find(Boolean) || aliases[0]
    for (const alias of aliases) {
      if (this.aliases.get(alias) === key) continue
      this.aliases.set(alias, key)
      if (turn) this.turnRevision++
    }
    return key
  }

  turn(turnId: string | undefined, sourceKey: string, opener?: MessageIdentity, segment = false): string {
    const aliases = [`${segment ? 'segment' : 'turn'}-source:${sourceKey}`]
    const clientId = clientMessageId(opener)
    if (clientId && (segment || !opener?.steered && !opener?.questionAnswer)) {
      const identity = `${segment ? 'segment' : 'turn'}-client:${clientId}`
      const key = this.aliases.get(identity) || identity
      for (const alias of [...aliases, ...(!segment && turnId ? [`turn-id:${turnId}`] : []),
        `${segment ? 'segment' : 'turn'}-user:${opener?.uuid || clientId}`, identity]) {
        if (this.aliases.get(alias) !== key) { this.aliases.set(alias, key); this.turnRevision++ }
      }
      return key
    }
    if (turnId && !segment) aliases.push(`turn-id:${turnId}`)
    if (opener?.uuid) aliases.push(`${segment ? 'segment' : 'turn'}-user:${opener.uuid}`)
    return this.resolve(aliases, true)
  }

  message(turnKey: string, msg: MessageIdentity, sourceKey: string, opener: boolean): string {
    const aliases = [`message-source:${sourceKey}`]
    const clientId = clientMessageId(msg)
    if (clientId) {
      const identity = `message-client:${clientId}`
      const key = this.aliases.get(identity) || identity
      for (const alias of [identity, ...aliases, ...(msg.uuid ? [`message-id:${msg.uuid}`] : [])]) this.aliases.set(alias, key)
      return key
    }
    if (msg.uuid) aliases.push(`message-id:${msg.uuid}`)
    if (!clientId && opener && !msg.steered && !msg.questionAnswer) aliases.push(`message-opener:${turnKey}`)
    return this.resolve(aliases)
  }
}
