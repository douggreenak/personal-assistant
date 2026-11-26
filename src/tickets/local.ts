import type { Db } from './db.ts';
import { TicketService, type Emit } from './tickets.ts';
import type { RemotePipeline, RemoteTicket, TicketingBackend } from '../backends/ticketing.ts';

/** The ticket tracker, built in: the assistant calls it directly (no separate server, token or webhook).
 *  Changes made through `service` by someone else (the Tickets tab) are reported to `onChange`; the assistant's own calls are not echoed back. */
export class LocalTicketing implements TicketingBackend {
  service: TicketService; onChange: Emit = () => {}; private mine = 0;
  constructor(db: Db) { this.service = new TicketService(db, (type, payload) => { if (!this.mine) this.onChange(type, payload); }); }
  private own<T>(fn: () => T): T { this.mine++; try { return fn(); } finally { this.mine--; } }
  async defaultPipeline(): Promise<RemotePipeline> { const all = this.service.listPipelines(); return all.find((p) => p.isDefault) ?? all[0]; }
  async create(t: { title: string; description?: string; priority?: string; dueAt?: string | null; requester?: string; externalRef: string }): Promise<RemoteTicket> {
    return this.own(() => this.service.createTicket({ ...t, source: 'assistant', dueAt: t.dueAt ?? undefined }, 'assistant').ticket);
  }
  async setStage(id: string | number, stageId: string): Promise<RemoteTicket> { return this.own(() => this.service.setStage(Number(id), stageId, 'assistant')); }
  async patch(id: string | number, fields: Record<string, unknown>): Promise<RemoteTicket> { return this.own(() => this.service.updateTicket(Number(id), fields, 'assistant')); }
  async comment(id: string | number, body: string): Promise<void> { this.own(() => this.service.addComment(Number(id), body, 'assistant')); }
  async get(id: string | number): Promise<RemoteTicket> { return this.service.getTicket(Number(id)); }
  async listOpen(): Promise<RemoteTicket[]> { return this.service.listTickets({ status: 'open', limit: 500 }); }
}
