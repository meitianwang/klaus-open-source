export function nativeBuildTarget(argv, platform = process.platform, hostArch = process.arch, rustHost) {
  const options = new Set(['--debug', '--credential-fixtures', '--whatsapp-fixtures']);
  let arch = hostArch;
  let explicit = false;
  for (const option of argv) {
    if (option.startsWith('--arch=')) {
      if (explicit) throw new Error('Duplicate native architecture');
      explicit = true; arch = option.slice(7);
    } else if (!options.has(option)) throw new Error(`Unknown native build option: ${option}`);
  }
  if (platform === 'darwin' && !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported macOS native architecture');
  if (platform !== 'darwin' && arch !== hostArch) throw new Error('Native cross-architecture builds are supported only on macOS');
  const triple = platform === 'darwin' ? `${arch === 'x64' ? 'x86_64' : 'aarch64'}-apple-darwin`
    : platform === 'win32' && arch === 'x64' ? 'x86_64-pc-windows-msvc' : undefined;
  return { platform, arch, triple, cross: triple && rustHost ? triple !== rustHost : arch !== hostArch };
}
