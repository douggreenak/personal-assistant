export interface Stage { id: string; label: string }
export interface RemoteTicket { id: number; title: string; stageId: string; stageLabel: string; open: boolean; priority: string }
export interface RemotePipeline { id: string; name: string; stages: Stage[]; isDefault: boolean }

/** What the assistant needs from a ticket tracker. The built-in one (src/tickets) implements it in-process. */
export interface TicketingBackend {
  defaultPipeline(): Promise<RemotePipeline>;
  create(t: { title: string; description?: string; priority?: string; dueAt?: string | null; requester?: string; externalRef: string }): Promise<RemoteTicket>;
  setStage(id: string | number, stageId: string): Promise<RemoteTicket>;
  patch(id: string | number, fields: Record<string, unknown>): Promise<RemoteTicket>;
  comment(id: string | number, body: string): Promise<void>;
  get(id: string | number): Promise<RemoteTicket>;
  listOpen(): Promise<RemoteTicket[]>;
}
