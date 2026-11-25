/** Keeps the last few hundred console lines in memory so the web UI can show them. */
export interface LogLine { at: string; level: 'info' | 'error'; text: string }
const buf: LogLine[] = [];
const MAX = 500;
export function captureLogs(): void {
  for (const [fn, level] of [['log', 'info'], ['error', 'error'], ['warn', 'error']] as const) {
    const orig = console[fn].bind(console);
    console[fn] = (...args: unknown[]) => {
      buf.push({ at: new Date().toISOString(), level, text: args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a))).join(' ').slice(0, 2000) });
      if (buf.length > MAX) buf.shift();
      orig(...args);
    };
  }
}
export const getLogs = (limit = 200): LogLine[] => buf.slice(-limit);
