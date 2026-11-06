/**
 * Self-contained preload source for browser credential autofill.
 *
 * It is intended to run as a sandboxed preload with contextIsolation. It uses
 * only the preload-provided electron module, keeps every symbol inside an IIFE,
 * and never assigns a page-visible global or calls contextBridge.
 */
export const AUTOFILL_PRELOAD_SOURCE = String.raw`
(() => {
  'use strict';
  const { ipcRenderer } = require('electron');
  const CH = {
    fill: 'browser-autofill:fill',
    document: 'browser-autofill:document',
    documentRequest: 'browser-autofill:document-request',
    input: 'browser-autofill:input',
    submit: 'browser-autofill:submit',
    ack: 'browser-autofill:ack',
  };
  let documentId = '';
  let intentSequence = 0;
  let activeIntent = null;

  const newIntentId = () => {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    } catch {}
    intentSequence += 1;
    return 'intent-' + Date.now().toString(36) + '-' + intentSequence.toString(36);
  };

  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    if (element instanceof HTMLInputElement && (element.type === 'hidden' || element.disabled || element.readOnly)) return false;
    return element.getClientRects().length > 0;
  };

  const firstIn = (root, selectors) => {
    for (const selector of selectors) {
      const found = Array.from(root.querySelectorAll(selector)).filter(isVisible)[0];
      if (found) return found;
    }
    return null;
  };

  const autocomplete = (element) => String(element.getAttribute('autocomplete') || '').toLowerCase();
  const marks = (element) => (String(element.getAttribute('name') || '') + ' ' + String(element.getAttribute('id') || '')).toLowerCase();

  const fieldKind = (element) => {
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return null;
    if (element instanceof HTMLInputElement && element.type === 'password') return 'password';
    const token = autocomplete(element);
    if (token.includes('username') || element instanceof HTMLInputElement && element.type === 'email') return 'username';
    if (token.includes('email')) return 'email';
    if (token.includes('tel')) return 'contact';
    if (token.includes('street-address') || token.includes('address-line') || token.includes('postal-code') || token.includes('country')) return 'address';
    if (token.includes('name') || token.includes('organization')) return 'contact';
    if (marks(element).includes('user') || marks(element).includes('login')) return 'username';
    return null;
  };

  const formFor = (element) => {
    const form = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.form : null;
    return form instanceof HTMLFormElement ? form : null;
  };

  const setValue = (element, value) => {
    if (!element || typeof value !== 'string') return false;
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  };

  const usernameField = (form) => firstIn(form, [
    'input[autocomplete~="username"]',
    'input[autocomplete~="email"]',
    'input[type="email"]',
    'input[name*="user" i]',
    'input[id*="user" i]',
  ]);
  const passwordField = (form) => firstIn(form, ['input[type="password"]']);

  const addressSelectors = {
    fullName: ['input[autocomplete~="name"]', 'input[name*="name" i]'],
    company: ['input[autocomplete~="organization"]', 'input[name*="company" i]'],
    addressLine1: ['input[autocomplete~="address-line1"]', 'input[autocomplete~="street-address"]', 'input[name*="address" i]'],
    addressLine2: ['input[autocomplete~="address-line2"]'],
    city: ['input[autocomplete~="address-level2"]', 'input[name*="city" i]'],
    state: ['input[autocomplete~="address-level1"]', 'input[name*="state" i]'],
    postalCode: ['input[autocomplete~="postal-code"]', 'input[name*="zip" i]', 'input[name*="postal" i]'],
    country: ['input[autocomplete~="country-name"]', 'select[autocomplete~="country"]', 'select[name*="country" i]'],
    phone: ['input[autocomplete~="tel"]', 'input[type="tel"]'],
    email: ['input[autocomplete~="email"]', 'input[type="email"]'],
  };

  const setSelectValue = (element, value) => {
    if (!(element instanceof HTMLSelectElement)) return setValue(element, value);
    const option = Array.from(element.options).find(item => item.value === value || item.text === value);
    if (!option) return false;
    element.value = option.value;
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  };

  const fillPassword = (form, values) => {
    let wrote = false;
    if (typeof values.username === 'string') wrote = setValue(usernameField(form), values.username) || wrote;
    if (typeof values.password === 'string') wrote = setValue(passwordField(form), values.password) || wrote;
    return wrote;
  };

  const fillProfile = (form, fields) => {
    if (!fields || typeof fields !== 'object') return false;
    let wrote = false;
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value !== 'string') continue;
      const selectors = addressSelectors[key];
      if (!selectors) continue;
      const element = firstIn(form, selectors);
      if (element) wrote = setSelectValue(element, value) || wrote;
    }
    return wrote;
  };

  const sendAck = (intent, filled, reason) => {
    ipcRenderer.send(CH.ack, {
      documentId,
      intentId: intent.id,
      filled,
      ...(reason ? { reason } : {}),
    });
  };

  ipcRenderer.on(CH.document, (_event, payload) => {
    if (payload && typeof payload.documentId === 'string') documentId = payload.documentId;
  });

  ipcRenderer.on(CH.fill, (_event, message) => {
    if (!message || message.type !== CH.fill) return;
    if (!documentId || message.documentId !== documentId) return;
    const intent = activeIntent;
    if (!intent || intent.id !== message.intentId) return;
    if (!intent.form.isConnected) {
      activeIntent = null;
      sendAck(intent, false, 'navigation');
      return;
    }
    const values = message.values;
    if (!values || typeof values !== 'object') {
      sendAck(intent, false, 'no_target');
      return;
    }
    const wrote = message.kind === 'password'
      ? fillPassword(intent.form, values)
      : message.kind === 'address' || message.kind === 'contact'
        ? fillProfile(intent.form, values.fields)
        : false;
    activeIntent = null;
    sendAck(intent, wrote, wrote ? undefined : 'no_target');
  });

  const requestIntent = (event) => {
    if (!event.isTrusted) return;
    const element = event.target;
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return;
    if (event.type === 'keydown' && !['Enter', ' ', 'ArrowDown'].includes(event.key)) return;
    const kind = fieldKind(element);
    const form = formFor(element);
    if (!kind || !form || !documentId) return;
    const intent = { id: newIntentId(), documentId, kind, form, field: element };
    activeIntent = intent;
    ipcRenderer.send(CH.input, { documentId, intentId: intent.id, kind, trusted: true });
  };

  document.addEventListener('pointerdown', requestIntent, true);
  document.addEventListener('keydown', requestIntent, true);

  document.addEventListener('submit', (event) => {
    if (!event.isTrusted) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const password = passwordField(form);
    const username = usernameField(form);
    if (!password || !username) return;
    if (typeof password.value !== 'string' || !password.value) return;
    ipcRenderer.send(CH.submit, {
      documentId,
      username: typeof username.value === 'string' ? username.value : '',
      password: password.value,
      trusted: true,
    });
  }, true);

  ipcRenderer.send(CH.documentRequest, {});
})();
`;
