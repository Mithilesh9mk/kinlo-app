import jsQR from 'jsqr';
import { decode as decodeJpeg } from 'jpeg-js';
import { qrMatrix } from './qrMatrix';

/**
 * Pure-JS helpers behind lib/qrImage.ts (no Expo imports, so they can be
 * exercised from Node): QR -> PNG bytes, base64 -> bytes, JPEG bytes -> QR text.
 */

const QUIET_MODULES = 4;

// ---- PNG encoding (1-bit greyscale, stored/uncompressed deflate) ----

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  let i = 0;
  while (i < bytes.length) {
    const end = Math.min(i + 3800, bytes.length); // keeps b below 2^32 between mods
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function put32(out: Uint8Array, pos: number, v: number) {
  out[pos] = (v >>> 24) & 0xff;
  out[pos + 1] = (v >>> 16) & 0xff;
  out[pos + 2] = (v >>> 8) & 0xff;
  out[pos + 3] = v & 0xff;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  put32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  put32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** QR for `text` as PNG bytes, about `targetPx` wide, with a 4-module white quiet zone. */
export function buildQrPng(text: string, targetPx = 600): Uint8Array {
  const matrix = qrMatrix(text);
  const modules = matrix.length;
  const total = modules + QUIET_MODULES * 2;
  const cell = Math.max(1, Math.floor(targetPx / total));
  const w = total * cell;
  const rowBytes = Math.ceil(w / 8);

  // Raw scanlines: filter byte 0 + packed bits (1 = white, 0 = black).
  const raw = new Uint8Array((rowBytes + 1) * w);
  for (let y = 0; y < w; y++) {
    const base = y * (rowBytes + 1);
    raw[base] = 0;
    const my = Math.floor(y / cell) - QUIET_MODULES;
    const row = my >= 0 && my < modules ? matrix[my] : null;
    for (let x = 0; x < w; x++) {
      const mx = Math.floor(x / cell) - QUIET_MODULES;
      const dark = row !== null && mx >= 0 && mx < modules && row[mx];
      if (!dark) raw[base + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  // zlib stream of stored blocks.
  const BLOCK = 65535;
  const blocks = Math.max(1, Math.ceil(raw.length / BLOCK));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let p = 0;
  z[p++] = 0x78;
  z[p++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const start = i * BLOCK;
    const len = Math.min(BLOCK, raw.length - start);
    z[p++] = i === blocks - 1 ? 1 : 0;
    z[p++] = len & 0xff;
    z[p++] = (len >> 8) & 0xff;
    z[p++] = ~len & 0xff;
    z[p++] = (~len >> 8) & 0xff;
    z.set(raw.subarray(start, start + len), p);
    p += len;
  }
  put32(z, p, adler32(raw));

  const ihdr = new Uint8Array(13);
  put32(ihdr, 0, w);
  put32(ihdr, 4, w);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // greyscale
  // compression, filter, interlace = 0

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', z),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

// ---- base64 -> bytes (no atob/Buffer dependency) ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let b64Lookup: Int16Array | null = null;

export function base64ToBytes(b64: string): Uint8Array {
  if (!b64Lookup) {
    b64Lookup = new Int16Array(128).fill(-1);
    for (let i = 0; i < 64; i++) b64Lookup[B64.charCodeAt(i)] = i;
    b64Lookup['-'.charCodeAt(0)] = 62;
    b64Lookup['_'.charCodeAt(0)] = 63;
  }
  const clean = b64.replace(/^data:[^,]*,/, '').replace(/[\s=]+/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const v = code < 128 ? b64Lookup[code] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

// ---- JPEG bytes -> QR text ----

/** Decodes a JPEG and returns the first QR code's text, or null. Throws only on undecodable JPEG. */
export function scanJpegBytes(jpeg: Uint8Array): string | null {
  const img = decodeJpeg(jpeg, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
  return scanRgba(img.data, img.width, img.height);
}

export function scanRgba(data: Uint8Array, width: number, height: number): string | null {
  const clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, width * height * 4);
  const result = jsQR(clamped, width, height, { inversionAttempts: 'attemptBoth' });
  return result ? result.data : null;
}
