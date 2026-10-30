export type StorageChatsChanged = {
  kind: 'deleted' | 'archived'
  sessionIds: string[]
}
