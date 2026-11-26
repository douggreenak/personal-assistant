import type { Ctx } from './ctx.ts';
import { kvGet, kvSet } from './db.ts';

/**
 * The Mac app is built by GitHub Actions and published as a release asset. This module asks GitHub which release is
 * newest (cached for 10 minutes) and streams its zip, so the web UI's download button and the app's own update check
 * always see the same "latest" — and a private repo works too (set GITHUB_TOKEN).
 */
export interface MacRelease { available: boolean; repo: string; version?: string; tag?: string; name?: string; publishedAt?: string; notes?: string; size?: number; assetName?: string; assetApiUrl?: string; releaseUrl?: string; error?: string }

const TAG_PREFIX = 'mac-v';
const ASSET = /^Assistant-Mac.*\.zip$/;
let cache: { at: number; repo: string; value: MacRelease } | null = null;
export const resetMacReleaseCache = (): void => { cache = null; };

const headers = (ctx: Ctx, accept = 'application/vnd.github+json'): Record<string, string> => ({
  accept, 'user-agent': 'assistant-server', 'x-github-api-version': '2022-11-28',
  ...(ctx.cfg.github.token ? { authorization: `Bearer ${ctx.cfg.github.token}` } : {}),
});

export async function latestMacRelease(ctx: Ctx, fetchImpl: typeof fetch = fetch, force = false): Promise<MacRelease> {
  const repo = ctx.cfg.github.repo;
  if (!force && cache && cache.repo === repo && Date.now() - cache.at < 10 * 60_000) return cache.value;
  let value: MacRelease;
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`GITHUB_REPO "${repo}" must look like owner/name.`);
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers: headers(ctx), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(r.status === 404 ? `No access to ${repo} (private repo? set GITHUB_TOKEN).` : `GitHub answered HTTP ${r.status}.`);
    const releases = await r.json() as { tag_name: string; name: string | null; draft: boolean; prerelease: boolean; published_at: string; body: string | null; html_url: string; assets: { name: string; size: number; url: string }[] }[];
    const rel = releases.find((x) => !x.draft && !x.prerelease && x.tag_name.startsWith(TAG_PREFIX) && x.assets.some((a) => ASSET.test(a.name)));
    if (!rel) value = { available: false, repo, error: 'No Mac app has been released yet.' };
    else {
      const asset = rel.assets.find((a) => ASSET.test(a.name))!;
      value = { available: true, repo, version: rel.tag_name.slice(TAG_PREFIX.length), tag: rel.tag_name, name: rel.name ?? rel.tag_name, publishedAt: rel.published_at, notes: (rel.body ?? '').slice(0, 2000),
        size: asset.size, assetName: asset.name, assetApiUrl: asset.url, releaseUrl: rel.html_url };
    }
  } catch (e) {
    if (cache && cache.repo === repo) return { ...cache.value, error: `Showing the last known release (${(e as Error).message})` };   // GitHub hiccup: keep serving what we had
    return { available: false, repo, error: (e as Error).message };
  }
  cache = { at: Date.now(), repo, value };
  return value;
}

/** The public view: never exposes the asset API URL. */
export const publicRelease = ({ assetApiUrl: _drop, ...rest }: MacRelease) => rest;

/** Opens the release zip on GitHub. Returns the response so the HTTP layer can stream it. */
export async function openMacDownload(ctx: Ctx, fetchImpl: typeof fetch = fetch): Promise<{ rel: MacRelease; res: Response } | null> {
  const rel = await latestMacRelease(ctx, fetchImpl);
  if (!rel.available || !rel.assetApiUrl) return null;
  const res = await fetchImpl(rel.assetApiUrl, { headers: headers(ctx, 'application/octet-stream'), redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok || !res.body) throw new Error(`GitHub answered HTTP ${res.status} for the download.`);
  return { rel, res };
}

// ---- connected Macs ----------------------------------------------------------------------------------------------
// Each Mac app reports in once a minute ("heartbeat"). That's how the web UI lists them, knows which are out of date,
// and asks one to update itself: the request waits in the registry and is handed back on the app's next heartbeat.
export interface MacClient { id: string; name: string; version: string; os: string; firstSeen: string; lastSeen: string; updateRequestedAt?: string; updateError?: string }
const CLIENTS_KEY = 'macapp.clients';
const ONLINE_MS = 3 * 60_000, FORGET_MS = 90 * 86_400_000;

const readClients = (ctx: Ctx): Record<string, MacClient> => { try { return JSON.parse(kvGet(ctx.db, CLIENTS_KEY) ?? '{}'); } catch { return {}; } };
const writeClients = (ctx: Ctx, c: Record<string, MacClient>): void => kvSet(ctx.db, CLIENTS_KEY, JSON.stringify(c));

/** Numeric dotted-version compare: 1.10.0 > 1.9.2. Anything non-numeric counts as 0. */
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => v.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

const clean = (v: unknown, max: number): string => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

export interface Heartbeat { id?: unknown; name?: unknown; version?: unknown; os?: unknown; updateError?: unknown }

/** Records a check-in and returns what the app should do next. Throws on a bad id. */
export function macHeartbeat(ctx: Ctx, b: Heartbeat, latest: MacRelease): { updateRequested: boolean; latest: { available: boolean; version?: string } } {
  const id = clean(b.id, 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new Error('id (8-64 chars, letters, digits and dashes) is required.');
  const all = readClients(ctx), now = new Date().toISOString();
  for (const [k, c] of Object.entries(all)) if (Date.now() - Date.parse(c.lastSeen) > FORGET_MS) delete all[k];
  const prev = all[id];
  const c: MacClient = { id, name: clean(b.name, 80) || prev?.name || 'Mac', version: clean(b.version, 32) || '0', os: clean(b.os, 60), firstSeen: prev?.firstSeen ?? now, lastSeen: now, updateRequestedAt: prev?.updateRequestedAt, updateError: prev?.updateError };
  const err = clean(b.updateError, 300);
  if (err) { c.updateError = err; delete c.updateRequestedAt; }                                  // the update failed: stop asking, show why
  else if (c.updateRequestedAt && latest.available && latest.version && compareVersions(c.version, latest.version) >= 0) { delete c.updateRequestedAt; delete c.updateError; }   // done
  else if (prev && c.version !== prev.version) delete c.updateError;
  all[id] = c; writeClients(ctx, all);
  return { updateRequested: !!c.updateRequestedAt && latest.available && !!latest.version && compareVersions(c.version, latest.version) < 0, latest: { available: latest.available, version: latest.version } };
}

export function listMacClients(ctx: Ctx, latest: MacRelease) {
  return Object.values(readClients(ctx)).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).map((c) => ({
    ...c, online: Date.now() - Date.parse(c.lastSeen) < ONLINE_MS,
    updateAvailable: latest.available && !!latest.version && compareVersions(c.version, latest.version) < 0,
    updatePending: !!c.updateRequestedAt,
  }));
}

/** Asks one Mac (or, with id "all", every Mac that is out of date) to update on its next check-in. Returns how many were asked. */
export function requestMacUpdate(ctx: Ctx, id: string, latest: MacRelease): number {
  if (!latest.available || !latest.version) throw new Error('No Mac app has been released yet.');
  const all = readClients(ctx); let n = 0;
  for (const c of Object.values(all)) {
    if ((id !== 'all' && c.id !== id) || compareVersions(c.version, latest.version) >= 0) continue;
    c.updateRequestedAt = new Date().toISOString(); delete c.updateError; n++;
  }
  if (id !== 'all' && !all[id]) throw new Error('No such Mac.');
  writeClients(ctx, all); return n;
}

export function forgetMacClient(ctx: Ctx, id: string): boolean {
  const all = readClients(ctx); if (!all[id]) return false;
  delete all[id]; writeClients(ctx, all); return true;
}
