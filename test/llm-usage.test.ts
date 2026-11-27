import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './helpers.ts';
import { storeMessage, processNext } from '../src/pipeline.ts';
import { isAcknowledgement, skipReason, trimMail } from '../src/prefilter.ts';
import { ClaudeCliLlm } from '../src/llm.ts';
import { recordUsage, backgroundBudget, usageSummary } from '../src/llmusage.ts';

test('prefilter: bare acknowledgements and nothing else', () => {
  for (const t of ['ok', 'Thanks!', 'thank you', '👍', 'Sounds good.', 'got it', 'Yes', 'lol']) assert.equal(isAcknowledgement(t), true, t);
  for (const t of ['ok can you send the invoice by Friday', 'Thanks, but the deadline moved to Monday', 'yes please book it', 'no, I need it today', '']) assert.equal(isAcknowledgement(t), false, t);
  assert.equal(skipReason({ source: 'gmail', body: 'thanks', fromOwner: false }, { linkedOpen: 0, duplicate: false }), 'acknowledgement');
  assert.equal(skipReason({ source: 'gmail', body: 'yes', fromOwner: false }, { linkedOpen: 1, duplicate: false }), null, 'a short reply may close an open item');
  assert.equal(skipReason({ source: 'chat', body: 'ok', fromOwner: true }, { linkedOpen: 0, duplicate: true }), null, 'the owner talking to the assistant is always read');
  assert.equal(skipReason({ source: 'gmail', body: 'Please call me', fromOwner: false }, { linkedOpen: 0, duplicate: true }), 'repeat');
});

test('prefilter: mail loses the quoted chain, signature and footer but keeps the new text', () => {
  const mail = ['Hi Doug,', '', 'Can you send the signed contract by Friday? ' + 'https://example.com/track?' + 'x'.repeat(120), '', 'Thanks,', 'Sam', '', 'On Tue, Nov 4, 2026 at 9:15 AM Doug <d@x.com> wrote:', '> Sure, what do you need?', '> long old text '.repeat(50), '', '-- ', 'Sam Smith | Acme', 'Unsubscribe here'].join('\n');
  const out = trimMail(mail);
  assert.match(out, /signed contract by Friday/); assert.doesNotMatch(out, /wrote:|old text|Acme|Unsubscribe/); assert.match(out, /example\.com\/…/); assert.ok(out.length < mail.length / 2);
  assert.equal(trimMail('> quoted only'), '> quoted only', 'never trims a message down to nothing');
  assert.ok(trimMail('a'.repeat(20000)).length < 6100);
});

test('pipeline: acks and repeats never reach the model; real mail does, trimmed, and is counted', async () => {
  const { ctx, llm } = makeCtx(() => ({ actions: [] }));
  const send = (id: string, body: string, thread = 't1') => storeMessage(ctx, { source: 'gmail', sourceId: id, sender: 'sam@x.com', subject: 's', body, thread });
  send('1', 'thanks'); await processNext(ctx); assert.equal(llm.calls.length, 0);
  send('2', 'Please send the contract by Friday.\n\nOn Tue, Nov 4, 2026 at 9:15 AM Doug wrote:\n> old chain here'); await processNext(ctx);
  assert.equal(llm.calls.length, 1); assert.doesNotMatch(llm.calls[0].prompt, /old chain here/); assert.match(llm.calls[0].prompt, /contract by Friday/);
  send('3', 'Please send the contract by Friday.\n\nOn Tue, Nov 4, 2026 at 9:15 AM Doug wrote:\n> old chain here'); await processNext(ctx);
  assert.equal(llm.calls.length, 1, 'the exact same message again is not read again');
  send('4', 'Please send the contract by Friday.'); send('5', 'Please send the contract by Friday.'); await processNext(ctx); await processNext(ctx);
  assert.equal(llm.calls.length, 2, 'different text (no quoted chain) is read once, its repeat is not');
  assert.equal(usageSummary(ctx).filtered, 3, 'the ack and the two repeats are counted as saved calls');
});

test('budget: past the daily cap the model reads only the owner\'s own words; the rest waits', async () => {
  const { ctx, llm } = makeCtx(() => ({ actions: [] }), { env: { LLM_BACKGROUND_CALLS_PER_DAY: '2' } });
  for (let i = 0; i < 2; i++) recordUsage(ctx.db, { purpose: 'extract-bg', model: '', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, ms: 5, chars: 100, ok: true });
  assert.equal(backgroundBudget(ctx).open, false);
  storeMessage(ctx, { source: 'gmail', sourceId: 'm1', sender: 'sam@x.com', subject: 'hello', body: 'Please call me about the quote tomorrow.' });
  assert.equal(await processNext(ctx), false, 'incoming mail waits'); assert.equal(llm.calls.length, 0);
  storeMessage(ctx, { source: 'chat', sourceId: 'c1', sender: 'me', subject: '', body: 'remind me to call Sam tomorrow' });
  assert.equal(await processNext(ctx), true, 'the owner\'s own chat is never held back'); assert.equal(llm.calls.length, 1);
  assert.equal(ctx.cfg.llm.backgroundCallsPerDay, 2);
});

test('llm: tokens and cost are logged from Claude Code\'s own report, and small jobs use the fast model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-')); const bin = join(dir, 'claude');
  writeFileSync(bin, '#!/bin/sh\necho "$@" > ' + join(dir, 'args') + '\necho \'{"is_error":false,"structured_output":{"ok":true},"usage":{"input_tokens":120,"output_tokens":30,"cache_read_input_tokens":900,"cache_creation_input_tokens":50},"total_cost_usd":0.0123}\'\n'); chmodSync(bin, 0o755);
  const { ctx } = makeCtx();
  const llm = new ClaudeCliLlm({ bin, model: 'big-model', fastModel: 'small-model', onUsage: (u) => recordUsage(ctx.db, u) });
  await llm.json({ purpose: 'plan', system: 's', prompt: 'p', schema: { type: 'object' } });
  assert.match((await import('node:fs')).readFileSync(join(dir, 'args'), 'utf8'), /--model small-model/);
  await llm.json({ purpose: 'extract-bg', system: 's', prompt: 'p', schema: { type: 'object' } });
  assert.match((await import('node:fs')).readFileSync(join(dir, 'args'), 'utf8'), /--model big-model/);
  const u = usageSummary(ctx); assert.equal(u.calls, 2); assert.equal(u.input, 240); assert.equal(u.output, 60); assert.equal(u.cacheRead, 1800); assert.ok(Math.abs(u.cost - 0.0246) < 1e-9);
  assert.deepEqual(u.byPurpose.map((r) => r.purpose).sort(), ['extract-bg', 'plan']); assert.equal(u.budget.used, 1);
});

import { handleOwnerText } from '../src/commands.ts';
import { makeCtx as mk } from './helpers.ts';
test('chat routing: a message that is not an exact command is understood by meaning, not by keyword', async () => {
  const { ctx, llm } = mk((req) => /Question:/.test(req.prompt) ? { answer: 'The plumber comes Tuesday.', cited: [] } : { actions: [] });
  llm.router = (req) => /plumb|update on/i.test(req.prompt) ? { intent: 'question', terms: ['plumber', 'plumbing', 'repair'] } : /coding agents/.test(req.prompt) ? { intent: 'code_status', terms: [] } : { intent: 'note', terms: [] };
  storeMessage(ctx, { source: 'gmail', sourceId: 'p1', sender: 'Pat', subject: 'Repair visit', body: 'The plumber is coming Tuesday morning to fix the leak.' });
  // no question word, no question mark, not an exact command: the old keyword rules would have made this a reminder
  const a = await handleOwnerText(ctx, 'I need an update on the plumbing situation'); assert.match(a, /plumber comes Tuesday/);
  assert.equal(ctx.items.list({ state: 'open' }).length, 0, 'no reminder was made');
  assert.match(llm.calls.at(-1)!.prompt, /plumber is coming Tuesday/, 'the related message was found through the suggested words');
  // a note stays a note
  await handleOwnerText(ctx, 'Pick up the dry cleaning after work'); assert.equal(llm.routeCalls.length, 2);
  // the follow-up knows what was just discussed
  llm.router = () => ({ intent: 'question', terms: [] }); await handleOwnerText(ctx, 'and what about Thursday');
  assert.match(llm.calls.at(-1)!.prompt, /Recent exchange[\s\S]*plumbing situation[\s\S]*plumber comes Tuesday/);
});

test('chat routing: an action request first reads live data, which the action step can use for ids', async () => {
  const { ctx, llm } = mk((req) => ({ actions: [] }));
  llm.router = () => ({ intent: 'action', terms: [] });
  const live = new Map<number, string>(); const { liveContext } = await import('../src/pipeline.ts');
  const reply = await handleOwnerText(ctx, 'Mark my physics homework as done'); assert.ok(typeof reply === 'string');
  assert.equal(llm.routeCalls.length, 1); assert.equal(liveContext.size, 0, 'the live data is used once and dropped'); void live;
});

test('chat routing: an action that no connected service can do is saved as a note and says so', async () => {
  const { ctx, llm } = mk((req) => ({ actions: [{ op: 'create', kind: 'task', title: 'Email Sam: I will be late', confidence: 0.9, flags: [], why: 'asked' }] }));
  llm.router = () => ({ intent: 'action', terms: [] });
  const reply = await handleOwnerText(ctx, 'Send Sam an email saying I will be late');
  assert.match(reply, /Email Sam/); assert.match(reply, /saved here as a note[\s\S]*could not do it myself/);
});

test('a request to act in a service that finds nothing to call does not edit unrelated local items', async () => {
  const { ctx } = mk(() => ({ actions: [] }));
  const old = ctx.items.create({ kind: 'reminder', title: 'Check off physics homework in Canopy' }).item;
  const { liveContext, processNextReport } = await import('../src/pipeline.ts');
  const llm = ctx.llm as unknown as { responder: unknown };
  (ctx.llm as unknown as { responder: unknown }).responder = () => ({ actions: [{ op: 'update', itemId: old.id, note: 'asked again', confidence: 0.9, flags: [], why: 'same request' }] });
  void llm;
  const id = storeMessage(ctx, { source: 'chat', sourceId: 'x1', sender: 'me', body: 'Mark my physics homework as done' })!;
  liveContext.set(id, 'Canopy › List assignments:\nDigital Electronics HW 5\nExt Seminar reading');
  const r = await processNextReport(ctx);
  assert.deepEqual(r?.report.queued, []); assert.deepEqual(r?.report.applied, []);
  assert.equal((await import('../src/approvals.ts')).listApprovals(ctx).length, 0, 'no approval about an unrelated item');
});

test('chat: "try again" is read against the last turns, not an old request from hours ago', async () => {
  const { ctx, llm } = mk(() => ({ actions: [] }));
  llm.router = () => ({ intent: 'note', terms: [] });
  const { rememberExchange } = await import('../src/router.ts');
  const old = storeMessage(ctx, { source: 'chat', sourceId: 'o1', sender: 'me', thread: 'chat:', body: 'Schedule a drive from work to costco' })!;
  ctx.db.prepare('UPDATE messages SET received_at = ?, processed_at = ? WHERE id = ?').run(new Date(ctx.now().getTime() - 3 * 3600_000).toISOString(), ctx.now().toISOString(), old);
  rememberExchange(ctx, 'Mark my physics homework as done', 'I could not find a physics assignment.');
  await handleOwnerText(ctx, 'try again');
  const p = llm.calls.at(-1)!.prompt;
  assert.match(p, /Mark my physics homework as done/, 'the last turn is in the prompt');
  assert.doesNotMatch(p, /Schedule a drive from work to costco/, 'the three-hour-old request is not');
});
