interface QrEncoder {
  toDataURL(text: string, options: { width: number; margin: number; errorCorrectionLevel: 'M' }): Promise<string>;
}

export async function qrPngDataUrl(text: string): Promise<string> {
  if (!text || Buffer.byteLength(text, 'utf8') > 4_096) throw new Error('Invalid pairing QR payload');
  const encoder = require('qrcode') as QrEncoder;
  return encoder.toDataURL(text, { width: 280, margin: 2, errorCorrectionLevel: 'M' });
}
