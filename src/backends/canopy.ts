export interface CanopyClass { id: string; name: string; teacher?: string; period?: number; gradePercent?: number | null; grade?: string | null }
export interface CanopyTask { id: string; title: string; dueDate: string; completed: boolean; classId: string | null; priority: string }
export interface CanopyAssignment { id: string; classId: string; className: string | null; title: string; dueDate: string; completed: boolean; flags?: unknown; scorePercent?: number | null }
export interface CanopyUpcoming { today: string; overdue: { assignments: CanopyAssignment[]; tasks: CanopyTask[] }; assignments: CanopyAssignment[]; tasks: CanopyTask[]; exams: { id: string; title: string; date: string; classId: string }[] }
export interface GradeSnap { classId: string; gradePercent: number | null; letter: string | null; semester: string; capturedAt: string }

/**
 * Canopy API client. Two tokens on purpose: reads use a read-only token (used by ingestion paths that touch
 * untrusted text), and only the approved-action layer holds the read/write token.
 */
export class CanopyClient {
  base: string; readToken: string; writeToken: string; fetchImpl: typeof fetch;
  constructor(base: string, readToken: string, writeToken: string, fetchImpl: typeof fetch = fetch) {
    this.base = base; this.readToken = readToken; this.writeToken = writeToken; this.fetchImpl = fetchImpl;
  }
  private async call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.base + '/api/v1' + path, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({})) as T & { error?: string };
    if (!res.ok) throw new Error(`canopy ${method} ${path}: ${res.status} ${data.error ?? ''}`);
    return data;
  }
  private classCache?: { at: number; v: CanopyClass[] };
  async classes(): Promise<CanopyClass[]> {
    if (this.classCache && Date.now() - this.classCache.at < 600000) return this.classCache.v;
    const v = (await this.call<{ classes: CanopyClass[] }>(this.readToken, 'GET', '/classes')).classes;
    this.classCache = { at: Date.now(), v };
    return v;
  }
  /** Best fuzzy match of a spoken class name ("bio", "AP Calc") to a Canopy class. */
  async resolveClass(hint: string): Promise<CanopyClass | undefined> {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    const h = norm(hint); if (!h.length) return undefined;
    let best: { c: CanopyClass; score: number } | undefined;
    for (const c of await this.classes()) {
      const n = norm(c.name);
      let score = 0;
      for (const w of h) for (const x of n) { if (x === w) score += 2; else if (x.startsWith(w) || w.startsWith(x)) score += w.length >= 3 ? 1 : 0; }
      if (score > 0 && (!best || score > best.score)) best = { c, score };
    }
    return best?.c;
  }
  upcoming(days = 3): Promise<CanopyUpcoming> { return this.call(this.readToken, 'GET', `/upcoming?days=${days}`); }
  async gradeHistory(limit = 300): Promise<GradeSnap[]> { return (await this.call<{ history: GradeSnap[] }>(this.readToken, 'GET', `/grade-history?limit=${limit}`)).history; }
  async tasks(completed?: boolean): Promise<CanopyTask[]> {
    return (await this.call<{ tasks: CanopyTask[] }>(this.readToken, 'GET', `/tasks?limit=500${completed === undefined ? '' : `&completed=${completed}`}`)).tasks;
  }
  async createTask(t: { title: string; description?: string; dueDate?: string; priority?: string; classId?: string; category?: string }): Promise<CanopyTask> {
    return (await this.call<{ task: CanopyTask }>(this.writeToken, 'POST', '/tasks', t)).task;
  }
  async patchTask(id: string, f: Record<string, unknown>): Promise<CanopyTask> {
    return (await this.call<{ task: CanopyTask }>(this.writeToken, 'PATCH', `/tasks/${id}`, f)).task;
  }
}
