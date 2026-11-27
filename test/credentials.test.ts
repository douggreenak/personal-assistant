import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { makeCtx } from './helpers.ts';
import { saveCredential, getCredential, listCredentials, deleteCredential, credentialLog } from '../src/credentials.ts';
import { createHttp } from '../src/http.ts';

const mk = () => makeCtx([], { env: { ASSISTANT_DATA: mkdtempSync(join(tmpdir(), 'cred-')), ASSISTANT_TOKEN: 'x'.repeat(20) } });

test('credentials: saved encrypted, read back, updates keep omitted fields, every access is logged without the value', () => {
  const { ctx } = mk();
  saveCredential(ctx, 'GITHUB_PAT', { secret: 'ghp_supersecretvalue', service: 'GitHub', username: 'doug' }, 'agent-a');
  const raw = ctx.db.prepare('SELECT secret FROM credentials').get() as { secret: string };
  assert.ok(raw.secret.startsWith('v1.') && !raw.secret.includes('supersecret'));
  saveCredential(ctx, 'GITHUB_PAT', { secret: 'ghp_rotated' }, 'agent-b');
  const c = getCredential(ctx, 'GITHUB_PAT', 'agent-c')!;
  assert.equal(c.secret, 'ghp_rotated'); assert.equal(c.service, 'GitHub'); assert.equal(c.createdBy, 'agent-a'); assert.equal(c.updatedBy, 'agent-b');
  assert.deepEqual(listCredentials(ctx).map((x) => Object.keys(x).includes('secret')), [false]);
  assert.equal(listCredentials(ctx, 'nomatch').length, 0);
  assert.deepEqual(credentialLog(ctx).map((l) => `${l.agent}:${l.action}`).reverse(), ['agent-a:create', 'agent-b:update', 'agent-c:read']);
  assert.ok(!JSON.stringify(credentialLog(ctx)).includes('ghp_'));
  assert.equal(deleteCredential(ctx, 'GITHUB_PAT', 'agent-a'), true); assert.equal(getCredential(ctx, 'GITHUB_PAT', 'a'), null);
});

test('credentials: bad names/empty secrets refused; a value moved to another name will not decrypt', () => {
  const { ctx } = mk();
  assert.throws(() => saveCredential(ctx, 'lower', { secret: 'x' }, 'a'), /UPPER_SNAKE/);
  assert.throws(() => saveCredential(ctx, 'OK_NAME', { secret: '  ' }, 'a'), /secret value/);
  saveCredential(ctx, 'ONE_KEY', { secret: 'aaa' }, 'a'); saveCredential(ctx, 'TWO_KEY', { secret: 'bbb' }, 'a');
  ctx.db.prepare("UPDATE credentials SET secret = (SELECT secret FROM credentials WHERE name = 'ONE_KEY') WHERE name = 'TWO_KEY'").run();
  assert.throws(() => getCredential(ctx, 'TWO_KEY', 'a'), /decrypt/);
});

test('credentials: HTTP API needs the full token, never lists values, records the agent header', async () => {
  const { ctx } = mk(); const srv = createHttp(ctx, { wake() {} }); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`; const h = { authorization: `Bearer ${ctx.cfg.token}`, 'content-type': 'application/json', 'x-agent': 'claude-session-7' };
  try {
    assert.equal((await fetch(`${base}/credentials`)).status, 401);
    assert.equal((await fetch(`${base}/credentials/AWS_KEY`, { method: 'PUT', headers: h, body: JSON.stringify({ secret: 'AKIAxyz', service: 'AWS' }) })).status, 200);
    const list = await (await fetch(`${base}/credentials`, { headers: h })).text(); assert.ok(list.includes('AWS_KEY') && !list.includes('AKIAxyz'));
    const got = await (await fetch(`${base}/credentials/AWS_KEY`, { headers: h })).json() as { credential: { secret: string } }; assert.equal(got.credential.secret, 'AKIAxyz');
    assert.equal((await fetch(`${base}/credentials/aws`, { method: 'PUT', headers: h, body: '{"secret":"x"}' })).status === 200, false);
    assert.equal((await fetch(`${base}/credentials/MISSING_ONE`, { headers: h })).status, 404);
    assert.ok(credentialLog(ctx).every((l) => l.agent === 'claude-session-7'));
    assert.equal((await fetch(`${base}/credentials/AWS_KEY`, { method: 'DELETE', headers: h })).status, 200);
  } finally { srv.close(); }
  assert.ok(readFileSync(join(ctx.cfg.dataDir, 'credentials.key'), 'utf8').length === 64);
});
