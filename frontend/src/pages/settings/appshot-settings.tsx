import { useEffect, useRef, useState } from 'react';
import type { PetAppshotSettings, PetAppshotState } from '../../../../contracts/desktop-pet-appshot';
import type { DesktopPetApi } from '../../../bridge/pet-api';
import { petMessages } from '../../pets/messages';
import { captureShortcut, shortcutLabel } from '../../pets/settings-model';

export function AppshotSettings({ api, language }: { api: DesktopPetApi; language: 'en' | 'zh' }) {
  const [state, setState] = useState<PetAppshotState | null>(null), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const m = petMessages(language);
  const [capturing, setCapturing] = useState(false), captureActive = useRef(false), captureButton = useRef<HTMLButtonElement>(null);
  const endCapture = () => { if (captureActive.current) { captureActive.current = false; void window.klaus.settings.keymap.captureEnd().catch(() => {}); } setCapturing(false); };
  useEffect(() => () => { if (captureActive.current) void window.klaus.settings.keymap.captureEnd().catch(() => {}); }, []);
  useEffect(() => { let current = true; api.appshotSettings().then(value => { if (current) setState(value); }).catch(error => { if (current) setError(String(error)); }); return () => { current = false; }; }, [api]);
  const update = async (patch: Partial<PetAppshotSettings>) => {
    if (pending) return; setPending(true); setError('');
    try { setState(await api.updateAppshotSettings(patch)); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setPending(false); }
  };
  return <section className="pet-settings-section" aria-label={m.appshotTitle}>
    <div className="pet-settings-row"><div><strong>{m.appshotTitle}</strong><p>{m.appshotDescription}</p></div></div>
    {error && <p role="alert">{error}</p>}
    {!state ? <p role="status">{m.loading}</p> : <>
      {!state.supported && <p role="status">{state.unavailableReason || m.error}</p>}
      <fieldset disabled={pending || !state.supported} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="pet-settings-row"><label htmlFor="appshot-shortcut">{m.appshotShortcut}</label><select id="appshot-shortcut" value={state.settings.shortcut && !['DoubleCommand', 'DoubleAlt'].includes(state.settings.shortcut) ? 'custom' : state.settings.shortcut ?? ''} onChange={event => { if (event.target.value !== 'custom') void update({ shortcut: event.target.value || null }); }}>
          <option value="DoubleCommand">{m.appshotDoubleCommand}</option><option value="DoubleAlt">{m.appshotDoubleAlt}</option>{state.settings.shortcut && !['DoubleCommand', 'DoubleAlt'].includes(state.settings.shortcut) && <option value="custom">{shortcutLabel(state.settings.shortcut, navigator.platform.includes('Mac'))}</option>}<option value="">{m.appshotNoShortcut}</option>
        </select><button type="button" ref={captureButton} onClick={() => { void window.klaus.settings.keymap.captureBegin().then(() => { captureActive.current = true; setCapturing(true); captureButton.current?.focus(); }).catch((error: unknown) => setError(error instanceof Error ? error.message : String(error))); }} onBlur={endCapture} onKeyDown={event => {
          if (!capturing) return; event.preventDefault(); event.stopPropagation(); if (event.key === 'Escape') { endCapture(); return; } const shortcut = captureShortcut(event); if (shortcut !== null) { endCapture(); void update({ shortcut: shortcut || null }); }
        }}>{capturing ? m.appshotShortcutRecording : m.appshotCustomShortcut}</button></div>
        <div className="pet-settings-row"><label htmlFor="appshot-destination">{m.appshotDestination}</label><select id="appshot-destination" value={state.settings.destination} onChange={event => void update({ destination: event.target.value as PetAppshotSettings['destination'] })}>
          <option value="automatic">{m.appshotAutomatic}</option><option value="last-chat">{m.appshotLastChat}</option><option value="new-chat">{m.appshotNewChat}</option>
        </select></div>
        <label className="pet-settings-toggle"><input type="checkbox" checked={state.settings.alwaysSendToMini} onChange={event => void update({ alwaysSendToMini: event.target.checked })} />{m.appshotPreferMini}</label>
        <label className="pet-settings-toggle"><input type="checkbox" checked={state.settings.soundEnabled} onChange={event => void update({ soundEnabled: event.target.checked })} />{m.appshotSound}</label>
      </fieldset>
    </>}
  </section>;
}
