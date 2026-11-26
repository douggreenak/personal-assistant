import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/tickets/db.ts';
import { TicketService } from '../src/tickets/tickets.ts';

const svc = (emit?: (t: string, p: unknown) => void) => new TicketService(openDb(':memory:'), emit);

test('default IT pipeline has the six package-tracking stages', () => {
  const [p] = svc().listPipelines();
  assert.deepEqual(p.stages.map((s) => s.label), ['Reported', 'Diagnosing', 'Waiting on parts', 'Fix applied', 'Verified', 'Closed']);
});

test('create starts at the first stage; moving to the last closes, leaving reopens', () => {
  const events: string[] = [];
  const s = svc((t) => events.push(t));
  const { ticket } = s.createTicket({ title: 'Encoder dropping frames' });
  assert.equal(ticket.stageId, 'reported');
  assert.equal(ticket.open, true);
  assert.equal(s.setStage(ticket.id, 'closed').open, false);
  assert.ok(s.getTicket(ticket.id).closedAt);
  assert.equal(s.setStage(ticket.id, 'diagnosing').open, true);
  assert.equal(s.getTicket(ticket.id).closedAt, null);
  assert.deepEqual(events, ['ticket.created', 'ticket.stage_changed', 'ticket.closed', 'ticket.stage_changed', 'ticket.reopened']);
});

test('createTicket is idempotent per source + externalRef', () => {
  const s = svc();
  const a = s.createTicket({ title: 'x', source: 'assistant', externalRef: 'msg-1' });
  const b = s.createTicket({ title: 'x again', source: 'assistant', externalRef: 'msg-1' });
  assert.equal(a.created, true); assert.equal(b.created, false);
  assert.equal(a.ticket.id, b.ticket.id);
  assert.equal(s.createTicket({ title: 'x', source: 'other', externalRef: 'msg-1' }).created, true);
});

test('validation rejects bad input', () => {
  const s = svc();
  assert.throws(() => s.createTicket({}), /title is required/);
  assert.throws(() => s.createTicket({ title: 'x', priority: 'now' }), /priority/);
  assert.throws(() => s.createTicket({ title: 'x', pipelineId: 'nope' }), /Pipeline not found/);
  const { ticket } = s.createTicket({ title: 'x' });
  assert.throws(() => s.setStage(ticket.id, 'bogus'), /stage must be one of/);
  assert.throws(() => s.updateTicket(ticket.id, { dueAt: 'tomorrow-ish' }), /dueAt/);
});

test('updates are diffed into the timeline; no-op updates add nothing', () => {
  const s = svc();
  const { ticket } = s.createTicket({ title: 'x' });
  s.updateTicket(ticket.id, { priority: 'urgent' });
  s.updateTicket(ticket.id, { priority: 'urgent' });
  s.addComment(ticket.id, 'ordered cables', 'sam');
  const ev = s.listEvents(ticket.id);
  assert.deepEqual(ev.map((e) => e.type), ['created', 'updated', 'comment']);
  assert.deepEqual((ev[1].data.changes as Record<string, unknown>).priority, { from: 'normal', to: 'urgent' });
});

test('list filters and ordering (urgent first, open by default, search)', () => {
  const s = svc();
  s.createTicket({ title: 'low thing', priority: 'low' });
  s.createTicket({ title: 'SDI cables', priority: 'urgent', description: 'order' });
  const c = s.createTicket({ title: 'done thing' }).ticket; s.setStage(c.id, 'closed');
  assert.deepEqual(s.listTickets({}).map((t) => t.title), ['SDI cables', 'low thing']);
  assert.deepEqual(s.listTickets({ status: 'closed' }).map((t) => t.title), ['done thing']);
  assert.equal(s.listTickets({ status: 'all' }).length, 3);
  assert.deepEqual(s.listTickets({ q: 'sdi' }).map((t) => t.title), ['SDI cables']);
  assert.equal(s.listTickets({ q: '100%' }).length, 0);
});

test('custom pipelines: stage in use cannot be removed; changing the last stage recomputes closed', () => {
  const s = svc();
  s.createPipeline({ id: 'simple', name: 'Simple', stages: [{ id: 'todo', label: 'To do' }, { id: 'doing', label: 'Doing' }, { id: 'done', label: 'Done' }] });
  const { ticket } = s.createTicket({ title: 't', pipelineId: 'simple', stageId: 'done' });
  assert.equal(ticket.open, false);
  assert.throws(() => s.updatePipeline('simple', { stages: [{ id: 'todo', label: 'a' }, { id: 'doing', label: 'b' }] }), /still in stage/);
  s.updatePipeline('simple', { stages: [{ id: 'todo', label: 'a' }, { id: 'done', label: 'b' }, { id: 'archived', label: 'c' }] });
  assert.equal(s.getTicket(ticket.id).open, true);
  assert.throws(() => s.createPipeline({ id: 'bad', name: 'Bad', stages: [{ id: 'A B', label: 'x' }, { id: 'y', label: 'y' }] }), /stage id/);
});

