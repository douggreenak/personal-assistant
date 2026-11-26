import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './helpers.ts';
import { applySetup, GUIDES } from '../src/setup.ts';
import { readOverrides } from '../src/settings.ts';

test('setup: pasted text for a connection is turned into settings (labelled lines, bare values, links, key files)', () => {
  const { ctx } = makeCtx([], { env: { ASSISTANT_DATA: mkdtempSync(join(tmpdir(), 'assistant-setup-')) } });   // never the real data folder
  assert.ok(ctx.cfg.dataDir.startsWith(tmpdir()));
  const o = () => readOverrides(ctx.cfg.dataDir);
  let r = applySetup(ctx, 'canopy', 'Canopy URL: https://canopy.example.com\nread token: abcdefghijklmnop1234\nwrite: zzzzzzzzzzzzzzzzzzzz');
  assert.deepEqual(r.missing, []); assert.equal(o().CANOPY_URL, 'https://canopy.example.com'); assert.equal(o().CANOPY_READ_TOKEN, 'abcdefghijklmnop1234'); assert.equal(o().CANOPY_WRITE_TOKEN, 'zzzzzzzzzzzzzzzzzzzz');
  applySetup(ctx, 'drive', 'https://drive.google.com/drive/folders/1AbCdEfGhIjK?usp=sharing\n1ZzYyXxWwVv'); assert.equal(o().DRIVE_FOLDER_IDS, '1AbCdEfGhIjK,1ZzYyXxWwVv');
  applySetup(ctx, 'ntfy', 'NTFY_URL=https://ntfy.sh\nassistant-7f3k9'); assert.equal(o().NTFY_TOPIC, 'assistant-7f3k9');
  applySetup(ctx, 'ingest', 'generate'); assert.ok(o().INGEST_TOKEN.length >= 32);
  applySetup(ctx, 'gmail', 'client id: 123-abc.apps.googleusercontent.com\nGOCSPX-secretsecretsecret\n1//0gRefreshTokenRefreshTokenRefresh'); assert.equal(o().GMAIL_ENABLED, '1'); assert.match(o().GOOGLE_REFRESH_TOKEN, /^1\/\//);
  const chat = applySetup(ctx, 'chat', JSON.stringify({ type: 'service_account', client_email: 'a@b.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' }) + '\nprojects/p/subscriptions/s\nusers/12345');
  assert.deepEqual(chat.missing, []); assert.equal(o().CHAT_PUBSUB_SUBSCRIPTION, 'projects/p/subscriptions/s'); assert.equal(o().CHAT_ALLOWED_USERS, 'users/12345'); assert.ok(o().GOOGLE_SERVICE_ACCOUNT_FILE);
  assert.throws(() => applySetup(ctx, 'canopy', 'hello there'), /couldn't find/); assert.throws(() => applySetup(ctx, 'canopy', ''), /Paste/); assert.throws(() => applySetup(ctx, 'nope', 'x'), /Unknown/);
  assert.ok(GUIDES.every((g) => g.steps.length && g.fields.length));
});
