export interface Stage { id: string; label: string }
export interface RemoteTicket { id: number; title: string; stageId: string; stageLabel: string; open: boolean; priority: string }
export interface RemotePipeline { id: string; name: string; stages: Stage[]; isDefault: boolean }

/** Thin client for the standalone Ticketing app's HTTP API. */
export class TicketingClient {
  base: string; token: string; fetchImpl: typeof fetch;
  constructor(base: string, token: string, fetchImpl: typeof fetch = fetch) { this.base = base; this.token = token; this.fetchImpl = fetchImpl; }
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.base + path, {
      method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', 'x-actor': 'assistant' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({})) as T & { error?: string };
    if (!res.ok) throw new Error(`ticketing ${method} ${path}: ${res.status} ${data.error ?? ''}`);
    return data;
  }
  private pipelineCache?: { at: number; p: RemotePipeline };
  async defaultPipeline(): Promise<RemotePipeline> {
    if (this.pipelineCache && Date.now() - this.pipelineCache.at < 300000) return this.pipelineCache.p;
    const { pipelines } = await this.call<{ pipelines: RemotePipeline[] }>('GET', '/api/pipelines');
    const p = pipelines.find((x) => x.isDefault) ?? pipelines[0];
    this.pipelineCache = { at: Date.now(), p };
    return p;
  }
  async create(t: { title: string; description?: string; priority?: string; dueAt?: string | null; requester?: string; externalRef: string }): Promise<RemoteTicket> {
    const { ticket } = await this.call<{ ticket: RemoteTicket }>('POST', '/api/tickets', { ...t, source: 'assistant', dueAt: t.dueAt ?? undefined });
    return ticket;
  }
  async setStage(id: string | number, stageId: string): Promise<RemoteTicket> {
    return (await this.call<{ ticket: RemoteTicket }>('POST', `/api/tickets/${id}/stage`, { stageId })).ticket;
  }
  async patch(id: string | number, fields: Record<string, unknown>): Promise<RemoteTicket> {
    return (await this.call<{ ticket: RemoteTicket }>('PATCH', `/api/tickets/${id}`, fields)).ticket;
  }
  async comment(id: string | number, body: string): Promise<void> { await this.call('POST', `/api/tickets/${id}/comments`, { body }); }
  async get(id: string | number): Promise<RemoteTicket> { return (await this.call<{ ticket: RemoteTicket }>('GET', `/api/tickets/${id}`)).ticket; }
  async listOpen(): Promise<RemoteTicket[]> { return (await this.call<{ tickets: RemoteTicket[] }>('GET', '/api/tickets?status=open&limit=500')).tickets; }
}
