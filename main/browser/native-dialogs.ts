import { randomUUID } from 'node:crypto';
import { BrowserError, object, type BrowserObject } from './types';
import type { PageDebugger } from './cdp';

export interface NativeDialogPage {
  handle: number;
  cdp: PageDebugger;
}

/** The public shape surfaced to the manager; no host preload is involved. */
export interface NativeJavaScriptDialog {
  id: string;
  type: string;
  message: string;
  defaultPrompt?: string;
  url: string;
}

interface BoundDialog extends NativeJavaScriptDialog {
  answerPending: boolean;
  answered: boolean;
}

interface DialogBinding {
  handle: number;
  cdp: PageDebugger;
  active: boolean;
  dialog: BoundDialog | null;
  unsubscribe: () => void;
}

function publicDialog(dialog: BoundDialog): NativeJavaScriptDialog {
  return {
    id: dialog.id,
    type: dialog.type,
    message: dialog.message,
    ...(dialog.defaultPrompt === undefined ? {} : { defaultPrompt: dialog.defaultPrompt }),
    url: dialog.url,
  };
}

/**
 * Observes Page.javascriptDialogOpening/Closed through the page debugger. The
 * native browser keeps ownership of its real dialog UI; this class only keeps
 * the state needed to answer through Page.handleJavaScriptDialog. Resource
 * permission requests are a different CDP surface and are deliberately not
 * handled here.
 */
export class NativeDialogs {
  private readonly bindings = new Map<number, DialogBinding>();

  bind(page: NativeDialogPage): void {
    if (!page || !Number.isSafeInteger(page.handle) || page.handle <= 0) {
      throw new BrowserError('invalid_request', 'page.handle must be a positive integer.');
    }
    if (!page.cdp || typeof page.cdp.onEvent !== 'function' || typeof page.cdp.command !== 'function') {
      throw new BrowserError('invalid_request', 'page.cdp must be a PageDebugger.');
    }
    this.release(page.handle);
    const binding: DialogBinding = {
      handle: page.handle,
      cdp: page.cdp,
      active: true,
      dialog: null,
      unsubscribe: () => {},
    };
    binding.unsubscribe = page.cdp.onEvent((method, params, frame) => {
      // Page dialog events belong to the root page. A released/rebound handle
      // must ignore any queued event from its old listener.
      if (!binding.active || this.bindings.get(binding.handle) !== binding || frame !== undefined) return;
      if (method === 'Page.javascriptDialogOpening') this.opening(binding, params);
      else if (method === 'Page.javascriptDialogClosed') this.closed(binding);
    });
    this.bindings.set(page.handle, binding);
  }

  release(handle: number): void {
    const binding = this.bindings.get(handle);
    if (!binding) return;
    binding.active = false;
    binding.dialog = null;
    binding.unsubscribe();
    this.bindings.delete(handle);
  }

  state(page: NativeDialogPage): NativeJavaScriptDialog | null {
    if (!page || !Number.isSafeInteger(page.handle)) return null;
    const binding = this.bindings.get(page.handle);
    return binding?.active && binding.dialog ? publicDialog(binding.dialog) : null;
  }

  /**
   * Answer the current dialog. Passing an id from an older dialog is rejected;
   * omitting it targets whatever dialog is current on the bound page.
   */
  async answer(page: NativeDialogPage, accept: boolean, text?: string, id?: string): Promise<void> {
    const binding = page && Number.isSafeInteger(page.handle) ? this.bindings.get(page.handle) : undefined;
    if (!binding?.active) throw new BrowserError('not_found', 'The browser page is not bound.');
    const dialog = binding.dialog;
    if (!dialog) throw new BrowserError('not_found', 'No JavaScript dialog is open.');
    if (typeof accept !== 'boolean') throw new BrowserError('invalid_request', 'accept must be a boolean.');
    if (id !== undefined && (typeof id !== 'string' || id !== dialog.id)) {
      throw new BrowserError('stale_dialog', 'The dialog id is no longer active.');
    }
    if (text !== undefined && typeof text !== 'string') throw new BrowserError('invalid_request', 'text must be a string.');
    if (dialog.answerPending) throw new BrowserError('unavailable', 'The dialog answer is already in progress.');
    if (dialog.answered) throw new BrowserError('stale_dialog', 'The dialog has already been answered.');

    const promptText = dialog.type === 'prompt' && accept ? text : undefined;
    dialog.answerPending = true;
    try {
      await binding.cdp.command('Page.handleJavaScriptDialog', {
        accept,
        ...(promptText === undefined ? {} : { promptText }),
      });
      dialog.answered = true;
    } finally {
      dialog.answerPending = false;
    }
  }

  dispose(): void {
    for (const handle of [...this.bindings.keys()]) this.release(handle);
    this.bindings.clear();
  }

  private opening(binding: DialogBinding, params: BrowserObject): void {
    const data = object(params);
    binding.dialog = {
      id: randomUUID(),
      type: typeof data.type === 'string' ? data.type : 'alert',
      message: typeof data.message === 'string' ? data.message : '',
      ...(typeof data.defaultPrompt === 'string' ? { defaultPrompt: data.defaultPrompt } : {}),
      url: typeof data.url === 'string' ? data.url : '',
      answerPending: false,
      answered: false,
    };
  }

  private closed(binding: DialogBinding): void {
    // CDP's Closed event has no dialog id. Ordered page events are the only
    // correlation available; released bindings are already ignored above.
    binding.dialog = null;
  }
}
