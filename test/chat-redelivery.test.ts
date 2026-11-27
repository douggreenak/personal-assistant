import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './helpers.ts';
import { ChatBot } from '../src/google/chat.ts';

const event = (name: string) => ({ chat: { user: { name: 'users/1', email: 'me@example.com', type: 'HUMAN' }, messagePayload: { space: { name: 'spaces/dm', spaceType: 'DIRECT_MESSAGE' }, message: { name, text: 'open' } } } });

test('chat: a message is acknowledged before it is handled, and never answered twice (slow replies used to be re-delivered forever)', async () => {
  const { ctx } = makeCtx([], { env: { CHAT_PUBSUB_SUBSCRIPTION: 'projects/p/subscriptions/s', CHAT_ALLOWED_USERS: 'me@example.com' } });
  const calls: string[] = []; let posted = 0;
  const fakeFetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes('oauth2') || u.includes('token')) return new Response(JSON.stringify({ access_token: 'x', expires_in: 3600 }), { status: 200 });
    if (u.endsWith(':pull')) { calls.push('pull'); return new Response(JSON.stringify({ receivedMessages: [{ ackId: 'a1', message: { messageId: 'm1', data: Buffer.from(JSON.stringify(event('spaces/dm/messages/1'))).toString('base64') } }] }), { status: 200 }); }
    if (u.endsWith(':acknowledge')) { calls.push('ack'); return new Response('{}', { status: 200 }); }
    if (u.includes('chat.googleapis.com')) { calls.push('post'); posted++; return new Response('{}', { status: 200 }); }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const bot = new ChatBot(ctx, { token: async () => 't' }, fakeFetch);
  await bot.pullOnce();
  assert.deepEqual(calls.slice(0, 2), ['pull', 'ack']); assert.ok(calls.indexOf('ack') < calls.indexOf('post'), 'acked before the reply');
  await bot.pullOnce();                                           // Pub/Sub delivers the very same message again (new ack id, same message id)
  await new ChatBot(ctx, { token: async () => 't' }, fakeFetch).pullOnce();   // and again after a restart (fresh memory)
  assert.equal(posted, 1, 'answered exactly once');
});
