/**
 * Image intake (§56-§57): never trust the filename or the declared type. Sniff the magic bytes, bound size and
 * dimensions, and strip metadata segments (EXIF/XMP/GPS, text chunks) before anything leaves the server.
 * Images are processed in memory and discarded after the read; they are never written to storage.
 */
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';
export interface ImageCheck { ok: true; mime: ImageMime; width: number; height: number; bytes: Uint8Array }
export type ImageError = 'empty' | 'too_large' | 'unsupported' | 'malformed' | 'too_small' | 'too_big_dimensions';

export const IMAGE_LIMITS = { maxBytes: 6 * 1024 * 1024, minSide: 200, maxSide: 8000 };

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

export function sniff(b: Uint8Array): ImageMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

function pngDims(b: Uint8Array) { return b.length >= 24 && String.fromCharCode(...b.slice(12, 16)) === 'IHDR' ? { w: u32be(b, 16), h: u32be(b, 20) } : null; }
function jpegDims(b: Uint8Array) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = u16be(b, i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: u16be(b, i + 5), w: u16be(b, i + 7) };
    i += 2 + len;
  }
  return null;
}
function webpDims(b: Uint8Array) {
  const chunk = String.fromCharCode(...b.slice(12, 16));
  if (chunk === 'VP8X' && b.length >= 30) return { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 };
  if (chunk === 'VP8 ' && b.length >= 30) return { w: (b[26]! | (b[27]! << 8)) & 0x3fff, h: (b[28]! | (b[29]! << 8)) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25) { const v = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
  return null;
}

/** Drops JPEG APP1..APP15 (EXIF, XMP, GPS…) and COM segments; keeps APP0 (JFIF) and image data. */
export function stripJpeg(b: Uint8Array): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return b;
    const marker = b[i + 1]!;
    if (marker === 0xda) { for (let k = i; k < b.length; k++) out.push(b[k]!); return Uint8Array.from(out); }
    const len = u16be(b, i + 2);
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) for (let k = i; k < i + 2 + len && k < b.length; k++) out.push(b[k]!);
    i += 2 + len;
  }
  return b;
}
/** Drops PNG text/metadata chunks (tEXt, zTXt, iTXt, eXIf, tIME). */
export function stripPng(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.slice(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = String.fromCharCode(...b.slice(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > b.length) return b;
    if (!['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) parts.push(b.slice(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function checkImage(bytes: Uint8Array): ImageCheck | { ok: false; error: ImageError } {
  if (!bytes.length) return { ok: false, error: 'empty' };
  if (bytes.length > IMAGE_LIMITS.maxBytes) return { ok: false, error: 'too_large' };
  const mime = sniff(bytes);
  if (!mime) return { ok: false, error: 'unsupported' };
  const dims = mime === 'image/png' ? pngDims(bytes) : mime === 'image/jpeg' ? jpegDims(bytes) : webpDims(bytes);
  if (!dims || !dims.w || !dims.h) return { ok: false, error: 'malformed' };
  if (Math.min(dims.w, dims.h) < IMAGE_LIMITS.minSide) return { ok: false, error: 'too_small' };
  if (Math.max(dims.w, dims.h) > IMAGE_LIMITS.maxSide) return { ok: false, error: 'too_big_dimensions' };
  const clean = mime === 'image/jpeg' ? stripJpeg(bytes) : mime === 'image/png' ? stripPng(bytes) : bytes;
  return { ok: true, mime, width: dims.w, height: dims.h, bytes: clean };
}

export const IMAGE_ERROR_TEXT: Record<ImageError, string> = {
  empty: 'No llegó ninguna imagen. Intenta de nuevo.',
  too_large: 'La imagen es muy pesada. Prueba con una captura de pantalla.',
  unsupported: 'Solo puedo leer fotos o capturas (JPG, PNG o WebP).',
  malformed: 'No pude abrir esa imagen. Prueba con otra captura.',
  too_small: 'La imagen es muy pequeña para leerla bien.',
  too_big_dimensions: 'La imagen es demasiado grande. Prueba con una captura de pantalla.',
};

/**
 * Idempotency key of one camera read: SHA-256 over the already-stripped image bytes (order-sensitive). It is a
 * one-way fingerprint — the image cannot be rebuilt from it — used only to avoid reading (and charging) the same
 * photos twice after a double tap or "Reintentar". Web Crypto: works in Node and edge runtimes.
 */
export async function imageReadKey(images: readonly Uint8Array[]): Promise<string> {
  const parts: Uint8Array[] = [];
  for (const b of images) { parts.push(new TextEncoder().encode(`${b.length}:`)); parts.push(b); }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  const digest = await crypto.subtle.digest('SHA-256', all);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}
/** A repeated read of the same photos within this window reuses the first proposal. PROPUESTO. */
export const READ_REUSE_MINUTES = 10;
