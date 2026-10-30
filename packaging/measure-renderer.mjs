/** Serialized into only the runner's isolated packaged renderer through the public Inspector. */
export async function installRendererProbe() {
  const state = window.__klausMeasurement = { events: [], permissions: [], terminals: {}, unsubscribers: [] };
  const record = event => {
    state.events.push({ type: event.type, sessionId: event.sessionId, turnId: event.turnId, toolName: event.toolName, toolCallId: event.toolCallId,
      terminal: event.terminal, error: event.error, isError: event.isError, text: String(event.text || '').slice(0, 2048), preview: JSON.stringify(event).slice(0, 2048) });
    if (state.events.length > 2048) state.events.shift();
  };
  state.unsubscribers.push(await window.__KLAUS_DESKTOP__.event.listen('ipc:chat:event:batch', event => { for (const item of event.payload.args[0]) record(item); }));
  state.unsubscribers.push(await window.__KLAUS_DESKTOP__.event.listen('ipc:permission:request', event => {
    if (state.permissions.length >= 16) throw new Error('Too many fixture permission requests');
    state.permissions.push(event.payload.args[0]);
  }));
  state.unsubscribers.push(await window.__KLAUS_DESKTOP__.event.listen('ipc:terminal:data', event => {
    const row = event.payload.args[0];
    const terminal = state.terminals[row.id] ??= { id: row.id, sequence: 0, rows: 0, phase: 'prompt', tail: '', errors: [] };
    const fail = message => { if (terminal.errors.length < 16) terminal.errors.push(message); };
    if (row.sequence <= terminal.sequence) fail('Non-increasing terminal sequence');
    terminal.sequence = row.sequence;
    terminal.tail += row.data;
    for (let end; (end = terminal.tail.indexOf('\n')) >= 0;) {
      const line = terminal.tail.slice(0, end).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
      terminal.tail = terminal.tail.slice(end + 1);
      if (line.includes('KLAUS_PERF_BEGIN')) { terminal.phase = 'payload'; continue; }
      if (line.includes('KLAUS_PERF_END')) { terminal.phase = 'ended'; terminal.endedAt = performance.timeOrigin + performance.now(); continue; }
      if (terminal.phase === 'payload') {
        if (line !== 'KPM' + String(terminal.rows).padStart(6, '0') + ':' + 'X'.repeat(244)) fail('Missing or changed PTY payload row ' + terminal.rows);
        terminal.rows++;
      }
    }
    if (terminal.tail.length > 131072) { fail('Unbounded terminal line'); terminal.tail = ''; }
  }));
  state.unsubscribers.push(await window.__KLAUS_DESKTOP__.event.listen('ipc:terminal:exit', event => {
    const row = event.payload.args[0], terminal = state.terminals[row.id] ??= { id: row.id, rows: 0, errors: [] };
    terminal.exit = row; terminal.exitedAt = performance.timeOrigin + performance.now();
  }));
  return true;
}

export async function prepareInputProbe(kind) {
  const target = kind === 'scroll' ? document.scrollingElement : document.getElementById('input');
  if (!target) throw new Error('No measurement input target');
  if (kind === 'input') {
    target.textContent = ''; target.focus(); target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  } else {
    if (window.__klausMeasurementScrollSettled) await window.__klausMeasurementScrollSettled;
    if (target.scrollTop + 120 >= target.scrollHeight - target.clientHeight) throw new Error('Controlled document has no remaining scroll range');
    // Native wheel animation may continue after the second frame. Wait for its real
    // scrollend before arming another input; programmatic resets can race the compositor.
    window.__klausMeasurementScrollSettled = new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); resolve(performance.timeOrigin + performance.now()); };
      const timer = setTimeout(() => { document.removeEventListener('scrollend', finish); reject(new Error('Native scrolling did not reach scrollend')); }, 3000);
      document.addEventListener('scrollend', finish, { once: true });
    });
    window.__klausMeasurementScrollSettled.catch(() => undefined);
  }
  const beforeValue = kind === 'scroll' ? target.scrollTop : target.textContent;
  window.__klausMeasurementPaint = new Promise((resolve, reject) => {
    const eventName = kind === 'scroll' ? 'scroll' : 'input', source = kind === 'scroll' ? document : target;
    const timer = setTimeout(() => { source.removeEventListener(eventName, receive); reject(new Error('No native input event reached the renderer')); }, 3000);
    const receive = () => {
      source.removeEventListener(eventName, receive);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve({ paintAtMs: performance.timeOrigin + performance.now(), beforeValue, value: kind === 'scroll' ? target.scrollTop : target.textContent });
      }));
    };
    source.addEventListener(eventName, receive, { once: true });
  });
  // The Inspector observes the original rejected Promise; suppress only a premature browser warning.
  window.__klausMeasurementPaint.catch(() => undefined);
  return true;
}

export const INSTALL_RENDERER_PROBE = `(${installRendererProbe.toString()})()`;
export const PREPARE_INPUT_PROBE = kind => `(${prepareInputProbe.toString()})(${JSON.stringify(kind)})`;
