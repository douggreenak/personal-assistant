import type { Ctx } from './ctx.ts';

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
