const FLAGS_OVERRIDE = 'globalThis.__appifact_flags_override={';

/** Turn on the editor's in-progress page sequence when this host serves the editor page. */
export function enablePresentationCreationSequence(html: string): string {
  if (!html.includes(FLAGS_OVERRIDE) || html.includes('appifact_creation_sequence:')) return html;
  return html.replace(FLAGS_OVERRIDE, `${FLAGS_OVERRIDE}appifact_creation_sequence:true,`);
}

/**
 * Runs in the presentation shell. The shell only relays authoring activity to
 * some frames, so the same value is also delivered straight to the editor frame
 * after that relay, and again when the editor asks.
 */
export function presentationAuthoringActivityScript(working: boolean): string {
  const value = working ? 'true' : 'false';
  return `(() => {
    const page = window;
    const state = page.__klausAuthoringActivity ?? (page.__klausAuthoringActivity = { working: false, installed: false });
    state.working = ${value};
    const publish = () => {
      const active = state.working === true;
      page.postMessage({ __frame_chrome: true, cmd: "claude_activity", working: active }, page.location.origin);
      setTimeout(() => {
        if (state.working !== active) return;
        for (const frame of page.document.querySelectorAll("iframe")) {
          try { frame.contentWindow?.postMessage({ __frame_claude_activity: true, working: active }, "*"); } catch {}
        }
      }, 0);
    };
    if (!state.installed) {
      state.installed = true;
      page.addEventListener("message", (event) => {
        const data = event.data;
        if (!data || data.__frame_claude_activity_ask !== true) return;
        setTimeout(publish, 0);
      });
      page.document.addEventListener("frame-content-mounted", publish);
      page.document.addEventListener("frame-content-settled", publish);
    }
    publish();
  })()`;
}
