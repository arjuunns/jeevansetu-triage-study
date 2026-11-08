import QRCode from 'qrcode';

/**
 * Phase 11 — QR code generation. Encodes a shareable referral verification URL
 * (or compact payload) so receiving staff can scan to pull the referral.
 */
export async function generateQrPng(data: string): Promise<Buffer> {
  return QRCode.toBuffer(data, { type: 'png', errorCorrectionLevel: 'M', width: 256, margin: 1 });
}

export async function generateQrDataUrl(data: string): Promise<string> {
  return QRCode.toDataURL(data, { errorCorrectionLevel: 'M', width: 256, margin: 1 });
}
