import type { Ctx } from './ctx.ts';
import { storeMessage } from './pipeline.ts';

/** Sends audio to an OpenAI-compatible transcription endpoint (e.g. a local faster-whisper server). */
export async function transcribe(url: string, audio: Uint8Array, filename: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const model = process.env.TRANSCRIBE_MODEL ?? 'Systran/faster-whisper-small';
  const send = () => {
    const form = new FormData();
    form.set('file', new Blob([audio as BlobPart]), filename); form.set('model', model); form.set('response_format', 'json');
    return fetchImpl(url, { method: 'POST', body: form, signal: AbortSignal.timeout(300000) });
  };
  let res = await send();
  if (res.status === 404) {
    // speaches only serves models that were downloaded first; do that once, automatically, then retry.
    const dl = await fetchImpl(`${new URL(url).origin}/v1/models/${model}`, { method: 'POST', signal: AbortSignal.timeout(600000) });
    if (!dl.ok) throw new Error(`transcription model "${model}" is not installed and could not be downloaded (HTTP ${dl.status})`);
    res = await send();
  }
  if (!res.ok) throw new Error(`transcription ${res.status}`);
  const j = await res.json() as { text?: string };
  return (j.text ?? '').trim();
}

/**
 * Handles one uploaded recording. `captureId` is generated on the phone, so a retry after a flaky
 * upload (very common offline-first) never creates duplicates: a known id is acknowledged immediately.
 */
export async function ingestVoice(ctx: Ctx, a: { captureId: string; audio: Uint8Array; filename: string; recordedAt?: string; fetchImpl?: typeof fetch }): Promise<{ duplicate: boolean; text: string; messageId: number | null }> {
  const known = ctx.db.prepare("SELECT id, body FROM messages WHERE source = 'voice' AND source_id = ?").get(a.captureId) as { id: number; body: string } | undefined;
  if (known) return { duplicate: true, text: known.body, messageId: known.id };
  if (!ctx.cfg.transcribeUrl) throw new Error('TRANSCRIBE_URL is not configured');
  const text = await transcribe(ctx.cfg.transcribeUrl, a.audio, a.filename, a.fetchImpl);
  const messageId = storeMessage(ctx, { source: 'voice', sourceId: a.captureId, sender: 'me', body: text, receivedAt: a.recordedAt });
  return { duplicate: false, text, messageId };
}
