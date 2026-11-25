import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, join } from 'node:path';
import type { Db } from '../db.ts';

const run = promisify(execFile);
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.log', '.json', '.eml', '.tsv', '.yaml', '.yml', '.html', '.htm', '.xml', '.rtf']);
const MAX_BYTES = 5 * 1024 * 1024;

export function chunkText(text: string, size = 1500, overlap = 200): string[] {
  const t = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!t) return [];
  const out: string[] = [];
  for (let i = 0; i < t.length; i += size - overlap) { out.push(t.slice(i, i + size)); if (i + size >= t.length) break; }
  return out;
}

/** Replaces all indexed chunks for `path` (idempotent; cheap delete by rowid). */
export function indexDocument(db: Db, path: string, mtime: string, text: string): number {
  const old = db.prepare('SELECT fts_rowid FROM doc_rows WHERE path = ?').all(path) as { fts_rowid: number }[];
  for (const o of old) db.prepare('DELETE FROM search WHERE rowid = ?').run(o.fts_rowid);
  db.prepare('DELETE FROM doc_rows WHERE path = ?').run(path);
  const chunks = chunkText(text);
  chunks.forEach((c, i) => {
    const r = db.prepare("INSERT INTO search (kind, ref, title, body) VALUES ('doc', ?, ?, ?)").run(`${path}#${i}`, path, c);
    db.prepare('INSERT INTO doc_rows (path, fts_rowid) VALUES (?,?)').run(path, Number(r.lastInsertRowid));
  });
  db.prepare('INSERT INTO docs (path, mtime, chunks) VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, chunks = excluded.chunks').run(path, mtime, chunks.length);
  return chunks.length;
}
export const isUnchanged = (db: Db, path: string, mtime: string): boolean =>
  (db.prepare('SELECT mtime FROM docs WHERE path = ?').get(path) as { mtime: string } | undefined)?.mtime === mtime;

async function extractText(file: string): Promise<string | null> {
  const ext = extname(file).toLowerCase();
  if (TEXT_EXT.has(ext)) return stripMarkup((await readFile(file, 'utf8')), ext);
  try {
    if (ext === '.pdf') return (await run('pdftotext', ['-q', file, '-'], { maxBuffer: 20e6, timeout: 60000 })).stdout;
    if (ext === '.docx') return stripMarkup((await run('unzip', ['-p', file, 'word/document.xml'], { maxBuffer: 20e6, timeout: 30000 })).stdout, '.xml');
  } catch { /* tool not installed or file unreadable: skip silently */ }
  return null;
}
const stripMarkup = (s: string, ext: string): string => (['.html', '.htm', '.xml'].includes(ext) ? s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ') : s);

/** Walks `roots` (e.g. a mounted SMB share), indexing new/changed files. Returns counts. */
export async function indexPaths(db: Db, roots: string[], opts: { maxFiles?: number } = {}): Promise<{ indexed: number; skipped: number }> {
  let indexed = 0, skipped = 0; let budget = opts.maxFiles ?? 5000;
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (budget <= 0) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.isFile()) continue;
      const st = await stat(full).catch(() => null);
      if (!st || st.size > MAX_BYTES || st.size === 0) { skipped++; continue; }
      const mtime = String(Math.floor(st.mtimeMs));
      if (isUnchanged(db, full, mtime)) continue;
      budget--;
      const text = await extractText(full).catch(() => null);
      if (text === null) { skipped++; continue; }
      indexDocument(db, full, mtime, text); indexed++;
    }
  }
  for (const r of roots) await walk(r);
  return { indexed, skipped };
}
