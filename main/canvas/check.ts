export interface CanvasDiagnostic { line?: number; message: string }

/** Strip comments while keeping line offsets and quoted import specifiers intact. */
function uncomment(source: string): string {
  return source.replace(/(['"`])(?:\\[\s\S]|(?!\1)[^\\])*?\1|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, token => token.startsWith('/') ? token.replace(/[^\r\n]/g, ' ') : token);
}

export function sdkExports(source: string): Set<string> {
  const names = new Set<string>();
  const code = uncomment(source);
  for (const match of code.matchAll(/\bexport\s+(?:type\s+)?\{([^}]+)\}/g)) for (const item of match[1]!.split(',')) {
    const name = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).at(-1)?.trim();
    if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
  }
  for (const match of code.matchAll(/\bexport\s+(?:declare\s+)?(?:const|let|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]!);
  return names;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i += 1) {
    let diagonal = row[0]!; row[0] = i + 1;
    for (let j = 0; j < b.length; j += 1) { const next = row[j + 1]!; row[j + 1] = a[i] === b[j] ? diagonal : 1 + Math.min(diagonal, row[j]!, next); diagonal = next; }
  }
  return row[b.length]!;
}

export function checkCanvas(source: string, exports: Set<string>, inCanvases: boolean): CanvasDiagnostic[] {
  const code = uncomment(source);
  const diagnostics: CanvasDiagnostic[] = [];
  if (!/\bexport\s+default\b/.test(code)) diagnostics.push({ message: 'no default export: a canvas must export default its top-level React component' });
  const line = (index: number): number => code.slice(0, index).split('\n').length;
  for (const match of code.matchAll(/\bimport\s+(?:([\s\S]*?)\s+from\s*)?(['"])([^'"\r\n]+)\2/g)) {
    const specifier = match[3]!;
    const clause = (match[1] ?? '').trim().replace(/^type\s+/, '');
    if (!['klaus/canvas', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime'].includes(specifier)) {
      const reason = specifier.startsWith('.') ? 'relative imports are not resolvable; a canvas is one self-contained file' : specifier.startsWith('node:') ? 'Node built-ins are not available' : 'npm packages are not available';
      diagnostics.push({ line: line(match.index!), message: `cannot import from '${specifier}': ${reason}. Import from 'klaus/canvas'.` });
    } else if (specifier === 'klaus/canvas') {
      const named = /\{([^}]+)\}/.exec(clause);
      if (clause && (!named || clause.slice(0, named.index).replace(/[,\s]/g, ''))) diagnostics.push({ line: line(match.index!), message: "'klaus/canvas' has no default export; use a named import" });
      for (const part of named?.[1]?.split(',') ?? []) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
        if (!name || exports.has(name)) continue;
        const nearest = [...exports].map(candidate => ({ candidate, distance: distance(name, candidate) })).filter(item => item.distance <= (name.length < 4 ? 1 : name.length < 9 ? 2 : 3)).sort((a,b) => a.distance - b.distance || a.candidate.length - b.candidate.length)[0];
        diagnostics.push({ line: line(match.index!), message: `'${name}' is not exported by 'klaus/canvas'${nearest ? `; did you mean '${nearest.candidate}'?` : ''}` });
      }
    }
  }
  // This is a static authoring check, not a JS sandbox. CSP and the restricted
  // page bridge remain authoritative when evaluated code uses computed names.
  const executable = code.replace(/(['"`])(?:\\[\s\S]|(?!\1)[^\\])*?\1/g, token => token.replace(/[^\r\n]/g, ' '));
  const forbidden: Array<[RegExp, string]> = [
    [/\b(?:fetch\s*\(|XMLHttpRequest\b)/g, 'network calls are not available in a canvas; embed the data inline'],
    [/\bimport\s*\(/g, 'dynamic import is not available in a canvas'],
    [/\brequire\s*\(/g, "require is not available in a canvas; import from 'klaus/canvas'"],
    [/\b(?:localStorage|sessionStorage)\b/g, 'browser storage is not available in a canvas; use useCanvasState'],
  ];
  for (const [pattern, description] of forbidden) for (const match of executable.matchAll(pattern)) diagnostics.push({ line: line(match.index!), message: description });
  if (!inCanvases) diagnostics.push({ message: 'note: this file is outside canvases; use that location only when editing an existing canvas named by the user' });
  return diagnostics;
}
