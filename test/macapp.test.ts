// Mac app download: release lookup against a fake GitHub, caching, auth, and streaming the zip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { makeCtx } from './helpers.ts';
import { createHttp } from '../src/http.ts';
import { latestMacRelease, resetMacReleaseCache } from '../src/macapp.ts';

const TOKEN = 'a'.repeat(32);
const ZIP = Buffer.from('PK-fake-zip-bytes');
const release = (tag: string, extra: object = {}) => ({ tag_name: tag, name: tag, draft: false, prerelease: false, published_at: '2026-11-01T00:00:00Z', body: 'notes', html_url: `https://github.com/o/r/releases/tag/${tag}`,
  assets: [{ name: 'Assistant-Mac.zip', size: ZIP.length, url: 'https://api.github.com/repos/o/r/releases/assets/1' }], ...extra });

function fakeGithub(releases: object[], opts: { fail?: number } = {}) {
  const calls: { url: string; auth?: string }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: h.authorization });
    if (opts.fail) return new Response('nope', { status: opts.fail });
    if (url.includes('/releases/assets/')) return new Response(ZIP, { status: 200 });
    return new Response(JSON.stringify(releases), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

async function boot(gh: ReturnType<typeof fakeGithub>, env: Record<string, string> = {}) {
  resetMacReleaseCache();
  const dir = mkdtempSync(join(tmpdir(), 'assistant-mac-'));
  const made = makeCtx([], { env: { ASSISTANT_TOKEN: TOKEN, ASSISTANT_DATA: dir, GITHUB_REPO: 'o/r', ...env } });
  const server = createHttp(made.ctx, { wake: () => {}, fetchImpl: gh.impl });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...made, base, close: () => server.close(), get: (p: string, auth = true) => fetch(base + p, { headers: auth ? { authorization: 'Bearer ' + TOKEN } : {} }) };
}

test('latest: picks the newest mac-v release with the zip, ignores drafts, prereleases and other tags', async () => {
  const gh = fakeGithub([release('mac-v9.9.9', { draft: true }), release('mac-v2.0.0-beta', { prerelease: true }), release('v5.0.0'), release('mac-v1.2.0'), release('mac-v1.1.0')]);
  const s = await boot(gh);
  try {
    const r = await s.get('/app/mac/latest'); assert.equal(r.status, 200);
    const { release: rel } = await r.json() as any;
    assert.equal(rel.available, true); assert.equal(rel.version, '1.2.0'); assert.equal(rel.size, ZIP.length);
    assert.ok(!('assetApiUrl' in rel), 'GitHub API URL is not exposed');
    await s.get('/app/mac/latest'); assert.equal(gh.calls.length, 1, 'second call is served from the cache');
  } finally { s.close(); }
});

test('latest: no release yet, and GitHub errors, are reported without throwing', async () => {
  let s = await boot(fakeGithub([release('v1.0.0')]));
  try { const j = await (await s.get('/app/mac/latest')).json() as any; assert.equal(j.release.available, false); assert.match(j.release.error, /No Mac app/); } finally { s.close(); }
  s = await boot(fakeGithub([], { fail: 404 }));
  try { const j = await (await s.get('/app/mac/latest')).json() as any; assert.equal(j.release.available, false); assert.match(j.release.error, /private/); } finally { s.close(); }
  s = await boot(fakeGithub([]), { GITHUB_REPO: 'not a repo' });
  try { const j = await (await s.get('/app/mac/latest')).json() as any; assert.match(j.release.error, /owner\/name/); } finally { s.close(); }
});

test('latest: a GitHub outage after a good lookup keeps serving the last known release', async () => {
  const ok = fakeGithub([release('mac-v1.0.0')]); const s = await boot(ok);
  try {
    const first = await latestMacRelease(s.ctx, ok.impl, true); assert.equal(first.version, '1.0.0');
    const down = await latestMacRelease(s.ctx, fakeGithub([], { fail: 503 }).impl, true);
    assert.equal(down.available, true); assert.equal(down.version, '1.0.0'); assert.match(down.error!, /last known/);
  } finally { s.close(); }
});

test('download: requires the token, streams the zip with attachment headers, sends GITHUB_TOKEN to GitHub only', async () => {
  const gh = fakeGithub([release('mac-v1.0.0')]); const s = await boot(gh, { GITHUB_TOKEN: 'ghp_secret' });
  try {
    assert.equal((await s.get('/app/mac/download', false)).status, 401);
    assert.equal((await s.get('/app/mac/latest', false)).status, 401);
    const r = await s.get('/app/mac/download'); assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip'); assert.match(r.headers.get('content-disposition')!, /attachment; filename="Assistant-Mac.zip"/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), ZIP);
    assert.ok(gh.calls.every((c) => c.auth === 'Bearer ghp_secret' && c.url.startsWith('https://api.github.com/')));
  } finally { s.close(); }
});

test('download: 404 when nothing is released, 502 when GitHub refuses the asset', async () => {
  let s = await boot(fakeGithub([]));
  try { assert.equal((await s.get('/app/mac/download')).status, 404); } finally { s.close(); }
  const base = fakeGithub([release('mac-v1.0.0')]);
  const flaky = { calls: base.calls, impl: (async (u: string | URL | Request, i?: RequestInit) => String(u).includes('/assets/') ? new Response('', { status: 500 }) : base.impl(u, i)) as typeof fetch };
  s = await boot(flaky);
  try { assert.equal((await s.get('/app/mac/download')).status, 502); } finally { s.close(); }
});

// ---- connected Macs: check-ins, version comparison, update requests ----
const ID = 'mac-aaaa-1111';
const post = (s: Awaited<ReturnType<typeof boot>>, p: string, body: object = {}, token = TOKEN) =>
  fetch(s.base + p, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('heartbeat: registers a Mac, lists it online with an update notice, and the web UI can ask it to update', async () => {
  const s = await boot(fakeGithub([release('mac-v1.10.0')]));
  try {
    let j = await (await post(s, '/app/mac/heartbeat', { id: ID, name: 'Studio Mac', version: '1.9.2', os: 'macOS 15' })).json() as any;
    assert.deepEqual(j, { updateRequested: false, latest: { available: true, version: '1.10.0' } });
    const list = async () => (await (await s.get('/app/mac/clients')).json() as any).clients;
    let [c] = await list();
    assert.equal(c.name, 'Studio Mac'); assert.equal(c.online, true); assert.equal(c.updateAvailable, true, '1.9.2 < 1.10.0 numerically'); assert.equal(c.updatePending, false);
    assert.equal((await (await post(s, `/app/mac/clients/${ID}/update`)).json() as any).asked, 1);
    assert.equal((await list())[0].updatePending, true);
    j = await (await post(s, '/app/mac/heartbeat', { id: ID, version: '1.9.2' })).json() as any; assert.equal(j.updateRequested, true, 'handed to the app on its next check-in');
    j = await (await post(s, '/app/mac/heartbeat', { id: ID, version: '1.10.0' })).json() as any; assert.equal(j.updateRequested, false);
    [c] = await list(); assert.equal(c.updatePending, false); assert.equal(c.updateAvailable, false); assert.equal(c.name, 'Studio Mac', 'name is kept when a check-in omits it');
  } finally { s.close(); }
});

test('heartbeat: a failed update is reported and not retried; "all" only asks Macs that are behind; forget removes one', async () => {
  const s = await boot(fakeGithub([release('mac-v2.0.0')]));
  try {
    await post(s, '/app/mac/heartbeat', { id: ID, version: '1.0.0' });
    await post(s, '/app/mac/heartbeat', { id: 'mac-bbbb-2222', version: '2.0.0' });
    assert.equal((await (await post(s, '/app/mac/clients/all/update')).json() as any).asked, 1);
    const j = await (await post(s, '/app/mac/heartbeat', { id: ID, version: '1.0.0', updateError: 'Not allowed to write to /Applications' })).json() as any;
    assert.equal(j.updateRequested, false);
    const clients = (await (await s.get('/app/mac/clients')).json() as any).clients;
    const c = clients.find((x: any) => x.id === ID); assert.match(c.updateError, /Not allowed/); assert.equal(c.updatePending, false);
    assert.equal((await post(s, '/app/mac/clients/nope-nope-nope/update')).status, 409);
    assert.equal((await fetch(s.base + `/app/mac/clients/${ID}`, { method: 'DELETE', headers: { authorization: 'Bearer ' + TOKEN } })).status, 200);
    assert.equal((await (await s.get('/app/mac/clients')).json() as any).clients.length, 1);
  } finally { s.close(); }
});

test('heartbeat: validates the id, needs a token, and the ingest-only token may check in and download but not list or update', async () => {
  const ING = 'i'.repeat(32);
  const s = await boot(fakeGithub([release('mac-v1.0.0')]), { INGEST_TOKEN: ING });
  try {
    assert.equal((await post(s, '/app/mac/heartbeat', { id: 'x' })).status, 400);
    assert.equal((await post(s, '/app/mac/heartbeat', { id: ID }, 'wrong-token-wrong-token')).status, 401);
    assert.equal((await post(s, '/app/mac/heartbeat', { id: ID, version: '1.0.0' }, ING)).status, 200);
    assert.equal((await fetch(s.base + '/app/mac/download', { headers: { authorization: 'Bearer ' + ING } })).status, 200);
    assert.equal((await fetch(s.base + '/app/mac/clients', { headers: { authorization: 'Bearer ' + ING } })).status, 401);
    assert.equal((await post(s, `/app/mac/clients/${ID}/update`, {}, ING)).status, 401);
  } finally { s.close(); }
});
