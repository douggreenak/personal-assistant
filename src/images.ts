import type { LlmImage } from './llm.ts';

export const MAX_IMAGES = 5, MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export interface Upload { name: string; mediaType: string; data: Buffer }

/** The real type comes from the file's first bytes — never from what the sender claims. */
export function sniffImage(b: Buffer): string | null {
  if (b.length > 12 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Validates the `images: [{name, data}]` list of a request body (data = base64, optionally a data: URL). */
export function parseUploads(raw: unknown): Upload[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('images must be a list.');
  if (raw.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per message.`);
  return raw.map((x, i) => {
    const o = (x ?? {}) as { name?: unknown; data?: unknown };
    const b64 = String(o.data ?? '').replace(/^data:[^,]*,/, '');
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new Error(`Image ${i + 1} is not valid.`);
    const data = Buffer.from(b64, 'base64');
    if (data.length > MAX_IMAGE_BYTES) throw new Error(`Image ${i + 1} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    const mediaType = sniffImage(data); if (!mediaType) throw new Error(`Image ${i + 1} is not a PNG, JPEG, GIF or WebP picture.`);
    return { name: String(o.name ?? `image-${i + 1}`).replace(/[^\w .()-]/g, '_').slice(0, 120), mediaType, data };
  });
}
export const toLlmImages = (u: Upload[]): LlmImage[] => u.map((i) => ({ mediaType: i.mediaType, data: i.data.toString('base64') }));

// ---------- keeping picture cost down ----------
// Every picture the model reads costs tokens in proportion to its pixels, so nothing goes to the model at full size, and nothing but
// a still picture ever does: videos, PDFs and other files are dropped (sniffImage only knows PNG/JPEG/GIF/WebP). Pictures that arrive
// with someone else's message (email…) are also stripped of logos, signatures, banners and tracking pixels.
export const MAX_SIDE = 1280;            // longest edge after shrinking (the model downsizes past ~1568px anyway, so extra pixels are pure cost)
export const KEEP_AS_IS_BYTES = 300 * 1024;
export const MAX_INBOUND_IMAGES = 3;     // per message from other people

/** Width × height from the file header, no decoding. */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  try {
    const t = sniffImage(b);
    if (t === 'image/png') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (t === 'image/gif') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (t === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1]; if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    }
    if (t === 'image/webp') {
      const k = b.toString('latin1', 12, 16);
      if (k === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (k === 'VP8L') { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
      if (k === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    }
  } catch { /* truncated file */ }
  return null;
}

const LOGO_NAME = /logo|banner|signature|sig[-_ ]?\d|spacer|pixel|tracking|beacon|footer|badge|sprite|divider|separator|facebook|linkedin|twitter|instagram|youtube|social|avatar|emoji|icon|brand|disclaimer|^image\d{3}\.(png|jpe?g|gif)$/i;
/** Company logos and mail furniture: named like one, tiny, tiny in bytes, or a long thin strip. */
export function looksDecorative(u: { name: string; data: Buffer }): boolean {
  if (LOGO_NAME.test(u.name)) return true;
  const s = imageSize(u.data); if (!s) return false;
  const big = Math.max(s.w, s.h), small = Math.min(s.w, s.h);
  if (big <= 260 || (u.data.length < 8 * 1024 && big < 600)) return true;      // icon/logo sized
  if (small > 0 && big / small >= 5) return true;                              // banner or divider
  return false;
}

import { spawn } from 'node:child_process';
/** Re-encodes as a JPEG no larger than MAX_SIDE on its longest edge (first frame only for GIFs) using ffmpeg. Null if ffmpeg is unavailable or fails. */
function shrinkWithFfmpeg(data: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let p; try { p = spawn(process.env.FFMPEG_BIN || 'ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale='min(${MAX_SIDE},iw)':'min(${MAX_SIDE},ih)':force_original_aspect_ratio=decrease:flags=lanczos`, '-q:v', '5', '-f', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] }); } catch { resolve(null); return; }
    const out: Buffer[] = []; let done = false;
    const end = (v: Buffer | null) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { p.kill('SIGKILL'); end(null); }, 15_000);
    p.stdout.on('data', (c: Buffer) => out.push(c)); p.on('error', () => end(null));
    p.on('close', (code) => end(code === 0 && out.length ? Buffer.concat(out) : null));
    p.stdin.on('error', () => { /* ffmpeg exited early */ }); p.stdin.end(data);
  });
}

export interface PrepareOpts { dropLogos?: boolean; maxImages?: number }
/** Makes pictures cheap to read: drops non-pictures (and, with dropLogos, logos/signatures/banners), shrinks the rest. Never throws. */
export async function prepareImages(list: Upload[], opts: PrepareOpts = {}): Promise<Upload[]> {
  const out: Upload[] = [];
  for (const u of list) {
    if (out.length >= (opts.maxImages ?? MAX_IMAGES)) break;
    const type = sniffImage(u.data); if (!type) continue;                       // videos, PDFs, anything that is not a still picture
    if (opts.dropLogos && looksDecorative(u)) continue;
    const s = imageSize(u.data);
    const small = s && Math.max(s.w, s.h) <= MAX_SIDE && u.data.length <= KEEP_AS_IS_BYTES && type !== 'image/gif';
    if (small) { out.push({ ...u, mediaType: type }); continue; }
    const jpg = await shrinkWithFfmpeg(u.data);
    if (jpg && jpg.length < u.data.length) out.push({ name: u.name.replace(/\.\w+$/, '') + '.jpg', mediaType: 'image/jpeg', data: jpg });
    else if (!jpg && u.data.length <= 2 * KEEP_AS_IS_BYTES && type !== 'image/gif') out.push({ ...u, mediaType: type });   // cannot shrink: only a modest original is allowed through
    else if (jpg) out.push({ name: u.name, mediaType: type, data: u.data });
  }
  return out;
}
