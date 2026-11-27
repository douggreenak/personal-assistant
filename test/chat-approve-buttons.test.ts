import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './helpers.ts';
import { ChatBot, parseChatClick } from '../src/google/chat.ts';
import { listApprovals, createApproval } from '../src/approvals.ts';
import { kvSet } from '../src/db.ts';

const click = (id: number, decision: string, shape: 'addon' | 'classic') => shape === 'addon'
  ? { commonEventObject: { hostApp: 'CHAT', invokedFunction: 'approval', parameters: { id: String(id), decision } }, chat: { user: { name: 'users/1', email: 'me@example.com', type: 'HUMAN' }, buttonClickedPayload: { space: { name: 'spaces/dm' }, message: { name: 'spaces/dm/messages/9' } } } }
  : { type: 'CARD_CLICKED', action: { actionMethodName: 'approval', parameters: [{ key: 'id', value: String(id) }, { key: 'decision', value: decision }] }, user: { name: 'users/1', email: 'me@example.com', type: 'HUMAN' }, space: { name: 'spaces/dm' }, message: { name: 'spaces/dm/messages/9' } };

test('chat: both click event shapes are understood; other events are not clicks', () => {
  for (const shape of ['addon', 'classic'] as const) { const c = parseChatClick(click(8, 'approve', shape)); assert.equal(c?.id, 8); assert.equal(c?.approve, true); assert.equal(c?.space, 'spaces/dm'); }
  assert.equal(parseChatClick(click(8, 'reject', 'addon'))?.approve, false);
  assert.equal(parseChatClick({ chat: { messagePayload: { message: { text: 'hi' } } } }), null);
  assert.equal(parseChatClick(click(8, 'explode', 'addon')), null);
});

test('chat: approval notices carry buttons, and tapping Approve decides it', async () => {
  process.env.CHAT_BUTTONS = '1';
  const { ctx } = makeCtx([], { env: { CHAT_ALLOWED_USERS: 'me@example.com' } });
  const sent: { url: string; method: string; body: any }[] = [];   // eslint-disable-line @typescript-eslint/no-explicit-any
  const fakeFetch = (async (url: string, init?: { method?: string; body?: string }) => { sent.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined }); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  const bot = new ChatBot(ctx, { token: async () => 't' }, fakeFetch);
  kvSet(ctx.db, 'chat.space', 'spaces/dm');
  const id = createApproval(ctx, { kind: 'connector', summary: 'Do a thing', reason: '', payload: {} });
  await bot.send(`Approval #${id} needs your OK: Do a thing`, { approvalId: id });
  delete process.env.CHAT_BUTTONS;
  const card = sent[0].body.cardsV2[0].card.sections[0].widgets;
  assert.equal(card[1].buttonList.buttons.length, 2);
  assert.equal(card[1].buttonList.buttons[0].onClick.action.parameters[0].value, String(id));
  await bot.handleEvent(click(id, 'reject', 'addon'));
  assert.equal(listApprovals(ctx, 'rejected').some((a) => a.id === id), true);
  const patch = sent.find((s) => s.method === 'PATCH'); assert.ok(patch, 'the card is replaced by the outcome');
  assert.match(patch!.body.cardsV2[0].card.sections[0].widgets[0].textParagraph.text, /Rejected/);
  assert.equal(JSON.stringify(patch!.body).includes('buttonList'), false);
});

test('chat: a button from someone who is not allowed does nothing', async () => {
  const { ctx } = makeCtx([], { env: { CHAT_ALLOWED_USERS: 'someone@else.com' } });
  const id = createApproval(ctx, { kind: 'connector', summary: 's', reason: '', payload: {} });
  const bot = new ChatBot(ctx, { token: async () => 't' }, (async () => new Response('{}')) as unknown as typeof fetch);
  await bot.handleEvent(click(id, 'approve', 'classic'));
  assert.equal(listApprovals(ctx, 'pending').some((a) => a.id === id), true);
});
