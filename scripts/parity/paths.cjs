const { existsSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

function binaryPath() {
  const name = process.platform === 'win32' ? 'klaus-agent-stdio.exe' : 'klaus-agent-stdio';
  const path = process.env.KLAUS_PARITY_ENGINE || resolve(__dirname, '../../resources/bin', `${process.platform}-${process.arch}`, name);
  if (!existsSync(path)) throw new Error('Build the pinned engine first, or set KLAUS_PARITY_ENGINE to its binary');
  return path;
}
function outputRoot() {
  const root = resolve(__dirname, '../../dist/parity');
  mkdirSync(root, { recursive: true });
  return root;
}
module.exports = { binaryPath, outputRoot };
