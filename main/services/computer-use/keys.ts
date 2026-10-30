const modifiers: Record<string, string> = {
  super: 'super', meta: 'meta', cmd: 'cmd', command: 'command', controlormeta: 'controlormeta',
  ctrl: 'ctrl', control: 'control', alt: 'alt', option: 'option', shift: 'shift',
  super_l: 'super_l', super_r: 'super_r', meta_l: 'meta_l', meta_r: 'meta_r',
  control_l: 'control_l', control_r: 'control_r', alt_l: 'alt_l', alt_r: 'alt_r', shift_l: 'shift_l', shift_r: 'shift_r',
};
const aliases: Record<string, string> = {
  page_up: 'pageup', prior: 'pageup', page_down: 'pagedown', next: 'pagedown',
  arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  kp_home: 'home', kp_end: 'end', kp_left: 'left', kp_right: 'right',
  kp_up: 'up', kp_down: 'down', kp_prior: 'pageup', kp_next: 'pagedown',
  kp_page_up: 'pageup', kp_page_down: 'pagedown', kp_delete: 'delete', kp_space: 'space', kp_tab: 'tab',
  kp_f1: 'f1', kp_f2: 'f2', kp_f3: 'f3', kp_f4: 'f4',
  exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
  apostrophe: "'", quoteright: "'", parenleft: '(', parenright: ')', asterisk: '*', plus: 'plus',
  comma: ',', minus: '-', period: '.', slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=',
  greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']',
  asciicircum: '^', underscore: '_', grave: '`', quoteleft: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
};

/** Normalize the documented keysym names before either platform receives input. */
export function normalizeKeyChord(specification: string): string {
  const parts = specification.split('+').map(part => part.trim());
  let key = parts.pop()!;
  if (key === '' && parts.at(-1) === '') { parts.pop(); key = 'plus'; }
  const normalized = parts.map(part => modifiers[part.toLowerCase()]);
  if (normalized.some(part => part === undefined)) throw new Error('Unsupported Computer Use key combination');
  if (/^[A-Z]$/.test(key) && !normalized.some(part => part === 'shift' || part === 'shift_l' || part === 'shift_r')) normalized.push('shift');
  const lower = key.toLowerCase();
  const final = modifiers[lower] ?? aliases[lower] ?? lower.replace(/^kp(?=[0-9]$)/, 'kp_');
  if (!modifiers[final] && final !== 'plus' && !/^[\x21-\x7e]$/.test(final)
    && !/^(?:space|return|enter|tab|escape|esc|backspace|delete|forwarddelete|home|end|pageup|pagedown|left|right|up|down|clear|help|caps_lock|f(?:[1-9]|1[0-9]|20)|kp_(?:[0-9]|enter|equal|multiply|add|subtract|decimal|divide))$/.test(final)) {
    throw new Error('Unsupported Computer Use key combination');
  }
  return [...new Set(normalized), final].join('+');
}
