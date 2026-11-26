import { statSync } from 'node:fs';
import { execFile } from 'node:child_process';

/** Thin wrapper over the tmux CLI. Its own server (a dedicated socket), arguments always passed as arrays (no shell). */
export interface Tmux {
  available(): Promise<boolean>;
  has(name: string): Promise<boolean>;
  list(): Promise<string[]>;
  start(name: string, cwd: string, argv: string[], env?: Record<string, string>): Promise<void>;
  kill(name: string): Promise<void>;
  capture(name: string, scrollback?: number): Promise<string>;
  literal(name: string, text: string): Promise<void>;
  keys(name: string, keys: string[]): Promise<void>;
  paste(name: string, text: string): Promise<void>;
}

/** The keys the web UI may press (nothing else is passed to tmux as a key name). */
export const ALLOWED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right', 'Space', 'BSpace', 'C-c', 'C-d', 'C-l', 'C-o', 'C-t', 'C-r', 'y', 'n', ...'0123456789']);

const T = (n: string) => (n.startsWith('%') ? n : n + ':');   // a pane id (%3) is used as is; a session name needs the trailing colon
export interface PaneInfo { session: string; pane: string; command: string; cwd: string; window: string }
export function makeTmux(bin: string, socket: string): Tmux & { panes(): Promise<PaneInfo[]> } {
  const run = (args: string[], input?: string): Promise<string> => new Promise((resolve, reject) => {
    const p = execFile(bin, [socket.startsWith('/') ? '-S' : '-L', socket, ...args], { timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().slice(0, 300)));
      resolve(stdout);
    });
    if (input !== undefined) { p.stdin?.on('error', () => {}); p.stdin?.end(input); }
  });
  const noServer = (e: Error) => /no server running|no sessions|error connecting|can't find session/i.test(e.message);
  return {
    // A path socket means "the tmux server running on the host": it must already exist (we never start a server of our own there, or sessions would run inside the container).
    available: () => new Promise((r) => execFile(bin, ['-V'], { timeout: 5000 }, (e) => {
      if (e) return r(false); if (!socket.startsWith('/')) return r(true);
      try { if (!statSync(socket).isSocket()) return r(false); } catch { return r(false); }
      run(['list-sessions']).then(() => r(true), (er: Error) => r(/no sessions/i.test(er.message)));   // the host's server must answer (a dead one leaves a stale socket file)
    })),
    has: (name) => (name.startsWith('%') ? run(['display-message', '-p', '-t', name, '#{pane_id}']).then((o) => o.trim() === name, () => false) : run(['has-session', '-t', '=' + name]).then(() => true, () => false)),
    panes: () => run(['list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{window_name}']).then((o) => o.split('\n').filter(Boolean).map((l) => { const [session, pane, command, cwd, window] = l.split('\t'); return { session, pane, command, cwd, window }; }), (e) => { if (noServer(e)) return []; throw e; }),
    list: () => run(['list-sessions', '-F', '#{session_name}']).then((o) => o.split('\n').filter(Boolean), (e) => { if (noServer(e)) return []; throw e; }),
    start: async (name, cwd, argv, env = {}) => {
      const e = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      await run(['new-session', '-d', '-s', name, '-x', '140', '-y', '45', '-c', cwd, ...e, '--', ...argv]);
      await run(['set-option', '-t', name, 'history-limit', '20000']).catch(() => {});
    },
    kill: (name) => run(['kill-session', '-t', '=' + name]).then(() => {}, (e) => { if (!noServer(e)) throw e; }),
    capture: (name, scrollback = 0) => run(['capture-pane', '-p', '-t', T(name), ...(scrollback ? ['-S', `-${scrollback}`] : [])]),
    literal: (name, text) => run(['send-keys', '-t', T(name), '-l', '--', text]).then(() => {}),
    keys: (name, keys) => run(['send-keys', '-t', T(name), ...keys]).then(() => {}),
    paste: async (name, text) => { await run(['load-buffer', '-b', 'cc-in', '-'], text); await run(['paste-buffer', '-p', '-d', '-b', 'cc-in', '-t', T(name)]); },
  };
}
