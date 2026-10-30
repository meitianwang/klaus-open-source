// The "what changed in this release" card.
//
// One card per upgrade, listing the release-kind features inside the announced
// window. It is a summary and not a gate: dismissing it advances the baseline
// (ledger.dismissCard) so it never returns for the same family, but it does not
// acknowledge any feature — the card is a place to read, not a tour of the
// controls it describes.
//
// Features with no entry point to point at still belong on the list — a
// queue-behaviour change has no surface of its own, and hiding it because it
// cannot be highlighted would drop most of a release.

import { useCallback } from 'react'
import { ModalPortal } from '../../components/ModalPortal'
import { t } from '../../i18n'
import type { FeatureEntry } from './registry'
import styles from './feature-onboarding.module.css'

export function FeatureAnnouncementCard({ features, version, onDismiss }: {
  features: FeatureEntry[]
  version: string
  onDismiss: () => void
}) {
  const close = useCallback(() => { onDismiss() }, [onDismiss])

  return (
    <ModalPortal>
      <div
        className={styles['card-backdrop']}
        // Clicking the surround dismisses. The card is a notice, not a decision
        // the user must make, so an accidental click must not trap them.
        onClick={close}
      >
        <div
          className={styles.card}
          role="dialog"
          aria-modal="true"
          aria-labelledby="klaus-feature-card-title"
          onClick={event => event.stopPropagation()}
        >
          <div className={styles['card-header']}>
            <span className={styles['card-eyebrow']}>
              {version ? t('onb_card_eyebrow_version').replace('{version}', version) : t('onb_card_eyebrow')}
            </span>
            <h2 className={styles['card-title']} id="klaus-feature-card-title">{t('onb_card_title')}</h2>
          </div>
          <div className={styles['card-body']}>
            {features.map(entry => (
              <div className={styles['feature-row']} key={entry.id}>
                <span className={styles['feature-marker']} aria-hidden="true" />
                <div className={styles['feature-text']}>
                  <span className={styles['feature-name']}>{t(entry.titleKey)}</span>
                  <span className={styles['feature-desc']}>{t(entry.bodyKey)}</span>
                </div>
              </div>
            ))}
          </div>
          <div className={styles['card-footer']}>
            <div className={styles['card-actions']}>
              <button type="button" className="kls-btn kls-btn-primary" onClick={close}>
                {t('onb_card_dismiss')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
