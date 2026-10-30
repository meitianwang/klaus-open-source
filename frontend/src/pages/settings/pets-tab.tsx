import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PetCatalogEntry,
  PetSettings,
  PetState,
} from "../../../../contracts/desktop-pet";
import type { DesktopPetApi } from "../../../bridge/pet-api";
import { BUILT_IN_PETS } from "../../pets/catalog";
import { PetSprite } from "../../pets/Sprite";
import { petMessages } from "../../pets/messages";
import { captureShortcut, shortcutLabel } from "../../pets/settings-model";
import { SettingsPage } from "./kv";
import { useSettingsSnapshot } from "./settings-snapshot";
import { Icon } from "../../components/Icon";
import "./pets-tab.css";

const desktopPet = () =>
  (window as unknown as { klaus: { desktopPet: DesktopPetApi } }).klaus
    .desktopPet;
const keymapCapture = () =>
  (
    window as unknown as {
      klaus: {
        settings: {
          keymap: {
            captureBegin: () => Promise<void>;
            captureEnd: () => Promise<void>;
          };
        };
      };
    }
  ).klaus.settings.keymap;
export function PetsSettingsTab() {
  const [state, setState, beginStateRead] = useSettingsSnapshot<PetState | null>("pets:state", null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [customizing, setCustomizing] = useState(false),
    [capturing, setCapturing] = useState(false);
  const language =
    state?.settings.language ??
    (document.documentElement.lang.startsWith("zh") ? "zh" : "en");
  const m = petMessages(language),
    api = desktopPet();
  useEffect(
    () => () => {
      void keymapCapture()
        .captureEnd()
        .catch(() => {});
    },
    [],
  );
  const endCapture = () => {
    setCapturing(false);
    void keymapCapture().captureEnd().catch(fail);
  };
  const beginCapture = async () => {
    try {
      await keymapCapture().captureBegin();
      setCapturing(true);
    } catch (error) {
      fail(error);
    }
  };
  const dialog = useRef<HTMLDialogElement>(null);
  const fail = (value: unknown) =>
    setError(value instanceof Error ? value.message : String(value));
  const loadState = useCallback(() => {
    const publish = beginStateRead();
    setError("");
    void api.getState().then(next => {
      publish(current => !current || next.revision >= current.revision ? next : current);
    }).catch(value => { if (publish(current => current)) fail(value); });
  }, [api, beginStateRead]);
  useEffect(() => {
    let active = true;
    const receive = (next: PetState) => {
      if (active)
        setState((current) =>
          !current || next.revision >= current.revision ? next : current,
        );
    };
    const off = api.onState(receive);
    loadState();
    return () => {
      active = false;
      off();
    };
  }, [api, loadState, setState]);
  useEffect(() => {
    if (customizing) dialog.current?.showModal();
    else dialog.current?.close();
  }, [customizing]);
  const update = async (patch: Partial<PetSettings>) => {
    setError("");
    setState(current => current);
    try {
      setState(await api.updateSettings(patch));
    } catch (failure) {
      fail(failure);
    }
  };
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(false);
    }
  };
  if (!state)
    return (
      <SettingsPage title={m.title}>
        <div className="pet-settings-empty" role={error ? "alert" : "status"}>
          {error || m.loading}
          {error && (
            <button onClick={loadState}>
              {m.retry}
            </button>
          )}
        </div>
      </SettingsPage>
    );
  const settings = state.settings,
    selected =
      state.catalog.find((pet) => pet.id === settings.selectedPetId) ??
      BUILT_IN_PETS[0];
  const SizeSetting = (
    <div className="pet-settings-row">
      <div>
        <label htmlFor="pet-size">{m.size}</label>
        <p>{m.sizeDescription}</p>
      </div>
      <div className="pet-size-control">
        <input
          id="pet-size"
          type="range"
          min={80}
          max={224}
          value={settings.size}
          aria-valuetext={`${settings.size}px`}
          onInput={(event) =>
            void update({ size: Number(event.currentTarget.value) })
          }
        />
        <button
          disabled={settings.size === 112}
          onClick={() => void update({ size: 112 })}
        >
          {m.reset}
        </button>
      </div>
    </div>
  );
  const select = (pet: PetCatalogEntry) =>
    void update({ selectedPetId: pet.id, showPet: true });
  return (
    <SettingsPage
      title={m.title}
      subtitle={
        <span
          className="pet-settings-shortcut"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              endCapture();
          }}
        >
          <span>{settings.shortcut ? m.subtitle : m.shortcutHelp}</span>
          <button
            className={capturing ? "capturing" : ""}
            aria-label={m.shortcuts}
            onClick={() => void beginCapture()}
            onKeyDown={(event) => {
              if (!capturing) return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") {
                endCapture();
                return;
              }
              const shortcut = captureShortcut(event);
              if (shortcut !== null) {
                endCapture();
                void update({ shortcut });
              }
            }}
          >
            <kbd>
              {capturing
                ? m.shortcuts
                : settings.shortcut
                  ? shortcutLabel(
                      settings.shortcut,
                      navigator.platform.includes("Mac"),
                    )
                  : m.none}
            </kbd>
          </button>
          {capturing && (
            <>
              {settings.shortcut && (
                <button
                  className="pet-settings-icon"
                  aria-label={m.shortcutClear}
                  onClick={() => {
                    endCapture();
                    void update({ shortcut: "" });
                  }}
                >
                  <Icon name="close" size={14} />
                </button>
              )}
              <button className="pet-shortcut-cancel" onClick={endCapture}>
                {m.cancel}
              </button>
            </>
          )}
        </span>
      }
      actions={
        <button
          className="pet-settings-button"
          disabled={busy}
          onClick={() =>
            void perform(() => (state.visible ? api.hide() : api.show()))
          }
        >
          {state.visible ? m.hide : m.show}
        </button>
      }
    >
      <div className="pet-settings">
        {error && (
          <div className="pet-settings-error" role="alert">
            {error}
            <button aria-label={m.close} onClick={() => setError("")}>
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {settings.showPet && (
          <section className="pet-settings-preview">
            <div className="pet-preview-art" aria-hidden="true" inert>
              <PetSprite pet={selected} size={settings.size} />
              <div className="pet-preview-mini">
                <span>
                  <Icon name="edit" size={23} />
                </span>
                <i />{" "}
                <span>
                  <Icon name="voice-waveform" size={20} />
                </span>
                <i />
                <span>
                  <Icon name="chevron-down" size={18} />
                </span>
              </div>
            </div>
            <button
              className="pet-settings-button pet-preview-customize"
              onClick={() => setCustomizing(true)}
            >
              {m.customize}
            </button>
          </section>
        )}
        <section className="pet-settings-section">
          <div className="pet-settings-section-heading">
            <h2>{m.pets}</h2>
            <div>
              <button
                className="pet-settings-icon"
                aria-label={m.refresh}
                disabled={busy}
                onClick={() =>
                  void perform(async () => setState(await api.refreshCatalog()))
                }
              >
                <Icon name="refresh" size={16} />
              </button>
              <button
                className="pet-settings-button"
                disabled={busy}
                onClick={() => void perform(() => api.createPet())}
              >
                {m.create}
              </button>
            </div>
          </div>
          <div className="pet-settings-grid">
            <button
              className={`pet-settings-tile ${!settings.showPet ? "selected" : ""}`}
              aria-pressed={!settings.showPet}
              onClick={() => void update({ showPet: false })}
            >
              <div className="pet-none-art" aria-hidden="true">
                <span>
                  <Icon name="edit" size={23} />
                </span>
                <i />
                <span>
                  <Icon name="voice-waveform" size={20} />
                </span>
                <i />
                <span>
                  <Icon name="chevron-down" size={18} />
                </span>
              </div>
              <strong>{m.none}</strong>
              <p>{m.noneDescription}</p>
            </button>
            {state.catalog.map((pet) => (
              <div
                className={`pet-settings-tile-wrap ${settings.showPet && pet.id === selected.id ? "selected" : ""}`}
                key={pet.id}
              >
                <button
                  className="pet-settings-tile"
                  aria-pressed={settings.showPet && pet.id === selected.id}
                  onClick={() => select(pet)}
                >
                  <PetSprite pet={pet} size={88} respondToHover />
                  <strong>{pet.name}</strong>
                  <p>{pet.description}</p>
                </button>
                {!pet.builtIn && pet.spriteVersion === 1 && (
                  <button
                    className="pet-settings-button pet-tile-update"
                    disabled={busy}
                    onClick={() => void perform(() => api.upgradePet(pet.id))}
                  >
                    {m.update}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
        <dialog
          className="pet-settings-dialog"
          ref={dialog}
          onCancel={() => setCustomizing(false)}
          onClick={(event) => {
            if (event.target === event.currentTarget) setCustomizing(false);
          }}
        >
          <div className="pet-dialog-header">
            <h2>{m.customize}</h2>
            <button aria-label={m.close} onClick={() => setCustomizing(false)}>
              <Icon name="close" size={14} />
            </button>
          </div>
          {SizeSetting}
        </dialog>
      </div>
    </SettingsPage>
  );
}
