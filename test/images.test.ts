import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { prepareImages, imageSize, looksDecorative, MAX_SIDE } from '../src/images.ts';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const make = (w: number, h: number, fmt: 'png' | 'mjpeg'): Buffer => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}`, '-frames:v', '1', '-f', fmt === 'png' ? 'image2' : 'mjpeg', ...(fmt === 'png' ? ['-c:v', 'png'] : []), 'pipe:1'], { maxBuffer: 1 << 27 });

test('images: big pictures are downscaled, logos and non-pictures are dropped for mail', { skip: !hasFfmpeg }, async () => {
  const photo = make(4000, 3000, 'png');
  assert.deepEqual(imageSize(photo), { w: 4000, h: 3000 });
  const [out] = await prepareImages([{ name: 'whiteboard.png', mediaType: 'image/png', data: photo }]);
  const s = imageSize(out.data)!; assert.equal(out.mediaType, 'image/jpeg'); assert.ok(Math.max(s.w, s.h) <= MAX_SIDE); assert.ok(out.data.length < photo.length / 4);

  const logo = make(180, 60, 'png');
  assert.ok(looksDecorative({ name: 'x.png', data: logo }));
  const mail = await prepareImages([
    { name: 'company-logo.png', mediaType: 'image/png', data: photo },
    { name: 'tiny.png', mediaType: 'image/png', data: logo },
    { name: 'clip.mp4', mediaType: 'video/mp4', data: Buffer.from('....ftypisom' + 'x'.repeat(5000)) },
    { name: 'scan.png', mediaType: 'image/png', data: photo }], { dropLogos: true });
  assert.deepEqual(mail.map((m) => m.name), ['scan.jpg']);
});
