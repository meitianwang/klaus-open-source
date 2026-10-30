// Install the bridge, then restore persisted UI state before UI modules evaluate.
import '../bridge/klaus-api'
import { bootstrapLegacyUiState } from './app/legacy-ui-state'
import { installTabFocusPolicy } from './app/tab-focus-policy'

installTabFocusPolicy()

void bootstrapLegacyUiState(
  window.klaus.settings.kv,
  () => window.localStorage,
  () => import('./app-entry'),
)
