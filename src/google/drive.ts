import type { Ctx } from '../ctx.ts';
import { indexDocument, isUnchanged } from '../index/indexer.ts';
import { gjson, type TokenSource } from './auth.ts';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const API = 'https://www.googleapis.com/drive/v3';
const TEXTY = /^(text\/|application\/(json|xml))/;
interface DFile { id: string; name: string; mimeType: string; modifiedTime: string; size?: string }

/** Indexes Google Docs/Sheets (exported as text/CSV) and plain-text files under the configured Drive folders. */
export async function indexDrive(ctx: Ctx, auth: TokenSource, fetchImpl: typeof fetch = fetch): Promise<number> {
  let indexed = 0; const seen = new Set<string>();
  const text = async (url: string): Promise<string> => {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${await auth.token(SCOPES)}` }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`drive ${res.status}`);
    return (await res.text()).slice(0, 2_000_000);
  };
  async function walk(folder: string, depth: number): Promise<void> {
    if (depth > 6 || seen.has(folder)) return; seen.add(folder);
    let page = '';
    do {
      const q = encodeURIComponent(`'${folder}' in parents and trashed = false`);
      const r = await gjson<{ files?: DFile[]; nextPageToken?: string }>(auth, SCOPES, `${API}/files?q=${q}&pageSize=200&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size)${page ? `&pageToken=${page}` : ''}`, {}, fetchImpl);
      for (const f of r.files ?? []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') { await walk(f.id, depth + 1); continue; }
        const key = `drive:${f.id}:${f.name}`;
        if (isUnchanged(ctx.db, key, f.modifiedTime)) continue;
        try {
          let body: string | null = null;
          if (f.mimeType === 'application/vnd.google-apps.document') body = await text(`${API}/files/${f.id}/export?mimeType=text/plain`);
          else if (f.mimeType === 'application/vnd.google-apps.spreadsheet') body = await text(`${API}/files/${f.id}/export?mimeType=text/csv`);
          else if (TEXTY.test(f.mimeType) && Number(f.size ?? 0) < 2_000_000) body = await text(`${API}/files/${f.id}?alt=media`);
          if (body !== null) { indexDocument(ctx.db, key, f.modifiedTime, body); indexed++; }
        } catch (e) { console.warn(`[drive] skip ${f.name}: ${(e as Error).message}`); }
      }
      page = r.nextPageToken ?? '';
    } while (page);
  }
  for (const id of ctx.cfg.driveFolderIds) await walk(id, 0);
  return indexed;
}
