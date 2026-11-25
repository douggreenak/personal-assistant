export interface NotifyOpts { urgent?: boolean; approvalId?: number; itemId?: string }
export interface Notifier { send(text: string, opts?: NotifyOpts): Promise<void> }

export class MemoryNotifier implements Notifier {
  sent: { text: string; opts?: NotifyOpts }[] = [];
  async send(text: string, opts?: NotifyOpts): Promise<void> { this.sent.push({ text, opts }); }
}
export class MultiNotifier implements Notifier {
  targets: Notifier[];
  constructor(targets: Notifier[]) { this.targets = targets; }
  async send(text: string, opts?: NotifyOpts): Promise<void> {
    await Promise.all(this.targets.map((t) => t.send(text, opts).catch((e) => console.error('notify failed:', (e as Error).message))));
  }
}
export class ConsoleNotifier implements Notifier {
  async send(text: string): Promise<void> { console.log('[notify]', text); }
}
/** Push to a self-hosted (or ntfy.sh) topic; reaches iPhone and Apple Watch through the ntfy app. */
export class NtfyNotifier implements Notifier {
  url: string; topic: string; fetchImpl: typeof fetch;
  constructor(url: string, topic: string, fetchImpl: typeof fetch = fetch) { this.url = url; this.topic = topic; this.fetchImpl = fetchImpl; }
  async send(text: string, opts?: NotifyOpts): Promise<void> {
    const res = await this.fetchImpl(`${this.url}/${encodeURIComponent(this.topic)}`, {
      method: 'POST', body: text, headers: { priority: opts?.urgent ? 'high' : 'default', title: 'Assistant' }, signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}`);
  }
}
