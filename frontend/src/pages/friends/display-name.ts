import { t } from '../../i18n'

export function friendDisplayName(row: { remark?: string; displayName?: string; email?: string }): string {
  const name = row.remark?.trim() || row.displayName?.trim() || row.email?.split('@')[0]?.trim() || t('friends_no_nickname')
  return name
}
