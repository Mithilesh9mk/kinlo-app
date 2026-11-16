// Pure-JS QR encoder core. Deliberately NOT 'qrcode' (its index pulls in the
// node/canvas renderers): lib/core/qrcode only needs ./utils, bit-buffer,
// bit-matrix, segments (+ dijkstrajs), and the other pure table/maths modules,
// and uses TextEncoder (present in Hermes) rather than Buffer.
import QRCode from 'qrcode/lib/core/qrcode';

/** Returns the QR modules as rows of booleans (true = dark), no quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  // The core encodes byte data with `new TextEncoder()`. Hermes ships one, but
  // this runs inside an OTA on an already-built APK, so do not depend on it.
  const g = globalThis as any;
  if (typeof g.TextEncoder === 'undefined') {
    g.TextEncoder = class {
      encode(s: string): Uint8Array {
        const utf8 = unescape(encodeURIComponent(s));
        const out = new Uint8Array(utf8.length);
        for (let i = 0; i < utf8.length; i++) out[i] = utf8.charCodeAt(i);
        return out;
      }
    };
  }
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size: number = qr.modules.size;
  const data: ArrayLike<number> = qr.modules.data;
  const rows: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = new Array(size);
    for (let c = 0; c < size; c++) row[c] = !!data[r * size + c];
    rows.push(row);
  }
  return rows;
}
