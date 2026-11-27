import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeFrom, consentUrl, exchangeCode, REDIRECT } from '../src/google/connect.ts';

test('google connect: the code is found in the pasted address, query, or bare code; Google errors are explained', () => {
  assert.equal(codeFrom('http://localhost:1/?code=4%2F0AbCdEf&scope=x'), '4/0AbCdEf');
  assert.equal(codeFrom('  http://localhost:1/?state=s&code=4%2F0AbCdEf123 \n'), '4/0AbCdEf123');
  assert.equal(codeFrom('?code=4%2F0AbCdEf123'), '4/0AbCdEf123');
  assert.equal(codeFrom('4/0AbCdEfGhIjKl'), '4/0AbCdEfGhIjKl');
  assert.throws(() => codeFrom('http://localhost:1/?error=access_denied'), /denied/);
  assert.throws(() => codeFrom('http://localhost:1/'), /no \?code=/);
  assert.throws(() => codeFrom('hello'), /does not look like/);
  assert.throws(() => codeFrom('   '), /Paste/);
  const u = new URL(consentUrl('cid')); assert.equal(u.searchParams.get('client_id'), 'cid'); assert.equal(u.searchParams.get('redirect_uri'), REDIRECT); assert.equal(u.searchParams.get('access_type'), 'offline'); assert.match(u.searchParams.get('scope')!, /gmail\.readonly/);
});

test('google connect: the code is traded for a refresh token; bad codes and bad clients get readable errors', async () => {
  let sent = '';
  const ok = (async (_u: unknown, init: { body: URLSearchParams }) => { sent = init.body.toString(); return new Response(JSON.stringify({ refresh_token: '1//rt', access_token: 'a' }), { status: 200 }); }) as unknown as typeof fetch;
  assert.equal(await exchangeCode('cid', 'sec', 'http://localhost:1/?code=4%2Fabc123def456', ok), '1//rt');
  assert.match(sent, /grant_type=authorization_code/); assert.match(sent, /client_id=cid/); assert.match(sent, /code=4%2Fabc123def456/);
  const bad = (err: string) => (async () => new Response(JSON.stringify({ error: err }), { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(exchangeCode('cid', 'sec', '?code=4%2Fabc123def456', bad('invalid_grant')), /already used or has expired/);
  await assert.rejects(exchangeCode('cid', 'sec', '?code=4%2Fabc123def456', bad('invalid_client')), /client ID/);
  await assert.rejects(exchangeCode('', 'sec', '?code=x', ok), /Save the OAuth client/);
});
