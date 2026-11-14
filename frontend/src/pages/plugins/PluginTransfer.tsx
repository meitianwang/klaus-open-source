import {
  ExtensionDetailTransferPanel,
  ExtensionInlineProgressBar,
  ExtensionTransferBanner,
} from '../../components/ExtensionTransfer'
import type { PluginItem, PluginOperation } from './plugin-store'

export function PluginInlineProgressBar({ operation, label }: { operation?: PluginOperation; label: string }) {
  return <ExtensionInlineProgressBar operation={operation} label={label} dataAttr="plugin-inline-bar" />
}

export function PluginTransferBanner({
  plugin,
  name,
  iconHtml,
  operation,
  queuedCount,
  onOpen,
  onCancel,
}: {
  plugin: PluginItem
  name: string
  iconHtml: string
  operation: PluginOperation
  queuedCount: number
  onOpen: () => void
  onCancel: () => void
}) {
  return (
    <ExtensionTransferBanner
      itemId={plugin.id}
      name={name}
      iconHtml={iconHtml}
      operation={operation}
      queuedCount={queuedCount}
      openLabelKey="plugins_transfer_open_detail"
      onOpen={onOpen}
      onCancel={onCancel}
      bannerAttr="plugin-transfer-banner"
      detailAttr="transfer-detail"
      cancelAttr="plugin-cancel"
    />
  )
}

// Preserves data-plugin-detail-transfer contract attribute via panelAttr.
export function PluginDetailTransferPanel({
  pluginId,
  name,
  operation,
}: {
  pluginId: string
  name: string
  operation?: PluginOperation
}) {
  return (
    <ExtensionDetailTransferPanel
      itemId={pluginId}
      name={name}
      operation={operation}
      panelAttr="plugin-detail-transfer"
    />
  )
}
