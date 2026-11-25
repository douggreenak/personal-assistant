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
