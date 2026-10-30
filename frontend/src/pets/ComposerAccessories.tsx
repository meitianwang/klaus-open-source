import { useState } from "react";
import type {
  PetComposerAttachment,
  PetScreenshotSource,
} from "../../../contracts/desktop-pet-composer";
import { petApi } from "../../bridge/pet-api";
import { Icon } from "../components/Icon";
import { petMessages } from "./messages";

export function ComposerAccessories({
  attachments,
  language,
  disabled,
  menuOpen,
  closeMenu,
  onAdded,
  onRemoved,
  onError,
}: {
  attachments: PetComposerAttachment[];
  language: "en" | "zh";
  disabled: boolean;
  menuOpen: boolean;
  closeMenu: () => void;
  onAdded: (attachments: PetComposerAttachment[]) => void;
  onRemoved: (id: string) => void;
  onError: (error: unknown) => void;
}) {
  const m = petMessages(language);
  const [sources, setSources] = useState<PetScreenshotSource[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const pickFiles = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      onAdded(await petApi.pickAttachments());
      closeMenu();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const screenshots = async () => {
    if (busy || disabled) return;
    setSourceLoading(true);
    setSources([]);
    closeMenu();
    try {
      setSources(await petApi.screenshotSources());
    } catch (error) {
      onError(error);
      setSources(null);
    } finally {
      setSourceLoading(false);
    }
  };
  const foreground = async () => {
    if (busy || disabled) return;
    setBusy(true); closeMenu();
    try { onAdded([await petApi.attachForeground()]); } catch (error) { onError(error); } finally { setBusy(false); }
  };
  const attach = async (source: PetScreenshotSource) => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      onAdded([await petApi.attachScreenshot(source.id)]);
      setSources(null);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      await petApi.removeAttachment(id);
      onRemoved(id);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  if (!attachments.length && !menuOpen && !sources && !busy)
    return null;
  return (
    <div className="pet-composer-accessories" data-pet-hit>
      {attachments.length > 0 && (
        <div
          className="pet-attachment-list"
          role="list"
          aria-label={m.attachments}
        >
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              role="listitem"
              className="pet-attachment-chip"
            >
              {attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt="" />
              ) : (
                <Icon name="file" size={18} />
              )}
              <span>
                <strong>{attachment.name}</strong>
                <small>
                  {attachment.size < 1024
                    ? `${attachment.size} B`
                    : attachment.size < 1024 * 1024
                      ? `${Math.ceil(attachment.size / 1024)} KB`
                      : `${(attachment.size / 1024 / 1024).toFixed(1)} MB`}
                </small>
                  {attachment.context && <small>{[attachment.context.appName, attachment.context.windowTitle].filter(Boolean).join(' · ')}</small>}
              </span>
              <button
                disabled={disabled || busy}
                aria-label={`${m.attachmentRemove}: ${attachment.name}`}
                onClick={() => void remove(attachment.id)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {menuOpen && (
        <div className="pet-attachment-menu" role="menu">
          <button
            role="menuitem"
            disabled={disabled || busy}
            onClick={() => void pickFiles()}
          >
            <Icon name="tc-attachment" size={16} />
            {m.attachFiles}
          </button>
          <button
            role="menuitem"
            disabled={disabled || busy}
            onClick={() => void foreground()}
          >
            <Icon name="browser-nav-screenshot" size={16} />
            {m.screenshot}
          </button>
          <button role="menuitem" disabled={disabled || busy} onClick={() => void screenshots()}><Icon name="browser-nav-screenshot" size={16} />{m.screenshotChoose}</button>
          <button role="menuitem" onClick={closeMenu}>
            <Icon name="close" size={16} />
            {m.close}
          </button>
        </div>
      )}
      {sources && (
        <section
          className="pet-screenshot-picker"
          aria-label={m.screenshotChoose}
        >
          <div>
            <strong>{m.screenshotChoose}</strong>
            <button
              disabled={busy}
              aria-label={m.close}
              onClick={() => setSources(null)}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
          {sourceLoading ? (
            <p role="status">{m.screenshotLoading}</p>
          ) : !sources.length ? (
            <p role="status">{m.screenshotEmpty}</p>
          ) : (
            <div className="pet-screenshot-gallery">
              {sources.map((source) => (
                <button
                  key={source.id}
                  disabled={disabled || busy}
                  onClick={() => void attach(source)}
                >
                  <img src={source.previewUrl} alt="" />
                  <span>{source.name}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      {busy && (
        <p className="pet-attachment-busy" role="status">
          <Icon name="chat-scroll-to-bottom-spin" size={12} />
          {m.attachmentAdding}
        </p>
      )}
    </div>
  );
}
