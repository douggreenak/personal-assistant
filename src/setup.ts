import { randomBytes } from 'node:crypto';
import type { Ctx } from './ctx.ts';
import { saveSettings } from './settings.ts';
import { saveServiceAccount } from './admin.ts';

/** What each built-in connection needs, in plain words: where to go, what to do, and which values to paste. */
export interface SetupField { key: string; label: string; hint: string; secret?: boolean; optional?: boolean; aliases?: string[] }
export interface SetupGuide { id: string; name: string; summary: string; steps: string[]; fields: SetupField[]; note?: string }

export const GUIDES: SetupGuide[] = [
  { id: 'canopy', name: 'Canopy', summary: 'Your school planner: classes, assignments and grades.',
    steps: ['Open Canopy and go to its settings → API access.', 'Create a read-only token (needed) and, if you want the assistant to add tasks, a read/write token.', 'Copy Canopy\'s address (the URL you open it at).'],
    fields: [{ key: 'CANOPY_URL', label: 'Canopy URL', hint: 'https://…', aliases: ['url', 'address', 'host'] }, { key: 'CANOPY_READ_TOKEN', label: 'Read-only token', hint: 'required', secret: true, aliases: ['read', 'readtoken', 'token'] }, { key: 'CANOPY_WRITE_TOKEN', label: 'Read/write token', hint: 'optional, lets it add tasks', secret: true, optional: true, aliases: ['write', 'writetoken'] }] },
  { id: 'whisper', name: 'Speech-to-text', summary: 'Turns voice notes into text.',
    steps: ['The bundled "whisper" container already provides this. Its address inside Docker is http://whisper:8000/v1/audio/transcriptions.', 'If you run your own OpenAI-compatible transcription server, paste its /v1/audio/transcriptions URL instead.'],
    fields: [{ key: 'TRANSCRIBE_URL', label: 'Transcription URL', hint: 'http://whisper:8000/v1/audio/transcriptions', aliases: ['url', 'address'] }] },
  { id: 'gmail', name: 'Gmail', summary: 'Reads your mail (and mail you send) so it can find things you need to do.',
    steps: ['Go to console.cloud.google.com → APIs & Services → Credentials, and create an "OAuth client ID" (Desktop app). Enable the Gmail API for the project.', 'Copy the client ID and client secret.', 'Get a refresh token by running `npm run google-auth` on the server (docs/google-setup.md walks through it) and paste what it prints.', 'Saving turns "Read Gmail" on.'],
    fields: [{ key: 'GOOGLE_CLIENT_ID', label: 'OAuth client ID', hint: '…apps.googleusercontent.com', aliases: ['clientid', 'client'] }, { key: 'GOOGLE_CLIENT_SECRET', label: 'OAuth client secret', hint: 'GOCSPX-…', secret: true, aliases: ['clientsecret', 'secret'] }, { key: 'GOOGLE_REFRESH_TOKEN', label: 'Refresh token', hint: '1//…', secret: true, aliases: ['refreshtoken', 'refresh', 'token'] }] },
  { id: 'chat', name: 'Google Chat bot', summary: 'Lets you message the assistant from Google Chat.',
    steps: ['In Google Cloud, create a service account, download its JSON key, and enable the Google Chat API and Pub/Sub.', 'Create a Pub/Sub topic + subscription for the Chat app and copy the subscription name (projects/…/subscriptions/…).', 'Paste the whole service-account JSON file contents here, plus the subscription line.', 'Also add your Chat user id (users/123…) as "Allowed users" — only these people may command the assistant.'],
    fields: [{ key: 'GOOGLE_SERVICE_ACCOUNT_FILE', label: 'Service account JSON', hint: 'paste the whole file', aliases: ['serviceaccount', 'json'] }, { key: 'CHAT_PUBSUB_SUBSCRIPTION', label: 'Pub/Sub subscription', hint: 'projects/…/subscriptions/…', aliases: ['subscription', 'pubsub'] }, { key: 'CHAT_ALLOWED_USERS', label: 'Allowed users', hint: 'users/123…', aliases: ['allowed', 'users', 'user'] }, { key: 'CHAT_NOTIFY_SPACE', label: 'Notify space', hint: 'optional: spaces/…', optional: true, aliases: ['space', 'notify'] }] },
  { id: 'drive', name: 'Google Drive index', summary: 'Indexes chosen Drive folders so questions can cite your documents.',
    steps: ['Needs the Gmail/Google sign-in above first (same Google credentials).', 'Open the folder in Google Drive and copy its link (or just the id after /folders/).', 'Paste one link or id per line.'],
    fields: [{ key: 'DRIVE_FOLDER_IDS', label: 'Folder links or ids', hint: 'one per line', aliases: ['folders', 'folder', 'ids'] }] },
  { id: 'ntfy', name: 'Phone push (ntfy)', summary: 'Sends reminders and nags to your phone.',
    steps: ['Install the free ntfy app on your phone (or use ntfy.sh).', 'Subscribe to a hard-to-guess topic name, e.g. assistant-7f3k9.', 'Paste the server (https://ntfy.sh unless you host your own) and the topic.'],
    fields: [{ key: 'NTFY_URL', label: 'ntfy server', hint: 'https://ntfy.sh', aliases: ['url', 'server'] }, { key: 'NTFY_TOPIC', label: 'Topic', hint: 'assistant-7f3k9', aliases: ['topic'] }] },
  { id: 'files', name: 'File index', summary: 'Indexes folders on the server so you can ask questions about your documents.',
    steps: ['Pick the folders (as seen inside the container — your mounted folders) and paste one path per line, e.g. /notes.', 'Mount extra folders in docker-compose.yml if they are not visible yet.'],
    fields: [{ key: 'INDEX_PATHS', label: 'Folder paths', hint: 'one per line', aliases: ['paths', 'path', 'folders'] }] },
  { id: 'ingest', name: 'Device ingest token', summary: 'The send-only password used by the Mac app and phone shortcuts.',
    steps: ['Paste a long random token (16+ characters), or write "generate" and one is made for you.', 'Use the same token in the Mac app / shortcut.'],
    fields: [{ key: 'INGEST_TOKEN', label: 'Token', hint: 'or: generate', secret: true, aliases: ['token', 'ingest'] }] },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const URL_RE = /^https?:\/\/\S+$/i;

export interface SetupResult { saved: string[]; missing: string[]; ignored: string[]; restart: boolean }

/** Reads whatever the owner pasted ("Label: value" / KEY=value lines, a JSON key file, or bare values) and stores it as settings. */
export function applySetup(ctx: Ctx, id: string, textIn: string): SetupResult {
  const g = GUIDES.find((x) => x.id === id); if (!g) throw new Error('Unknown connection.');
  const text = String(textIn ?? '').trim(); if (!text) throw new Error('Paste the information first.');
  const values = new Map<string, string>(); const ignored: string[] = [];
  const set = (f: SetupField, v: string) => { const t = v.trim().replace(/^["']|["']$/g, ''); if (t) values.set(f.key, t); };
  let body = text;
  if (id === 'chat') {   // a pasted service-account key file
    const m = /\{[\s\S]*"private_key"[\s\S]*\}/.exec(text);
    if (m) { const path = saveServiceAccount(ctx, m[0]); values.set('GOOGLE_SERVICE_ACCOUNT_FILE', path); body = text.replace(m[0], ''); }
  }
  const aliasOf = (k: string) => { const n = norm(k); return g.fields.find((f) => norm(f.key) === n || norm(f.label) === n || f.aliases?.some((a) => norm(a) === n)); };
  const loose: string[] = [];
  let cur: SetupField | undefined;
  for (const raw of body.split('\n')) {
    const line = raw.trim(); if (!line) continue;
    const m = /^([A-Za-z][A-Za-z0-9_ ./()-]{0,40}?)\s*[:=]\s*(.*)$/.exec(line);
    const hit = m && !URL_RE.test(line) ? aliasOf(m[1]) : undefined;
    if (hit) { cur = hit; if (m![2].trim()) set(hit, m![2]); continue; }
    if (m && URL_RE.test(m[2].trim()) && aliasOf(m[1])) { set(aliasOf(m[1])!, m[2]); continue; }
    if (cur && (cur.key === 'DRIVE_FOLDER_IDS' || cur.key === 'INDEX_PATHS')) { values.set(cur.key, [values.get(cur.key), line].filter(Boolean).join('\n')); continue; }
    loose.push(line);
  }
  // Lines without a label: match them by what they look like.
  const open = () => g.fields.filter((f) => !values.has(f.key));
  for (const l of loose) {
    const urlF = open().find((f) => /URL$/.test(f.key) || f.key === 'CHAT_PUBSUB_SUBSCRIPTION' && false);
    if (URL_RE.test(l) && urlF) { set(urlF, l); continue; }
    if (/^projects\/[^/]+\/subscriptions\//.test(l)) { const f = g.fields.find((x) => x.key === 'CHAT_PUBSUB_SUBSCRIPTION'); if (f) { set(f, l); continue; } }
    if (/^users\/\d+/.test(l)) { const f = g.fields.find((x) => x.key === 'CHAT_ALLOWED_USERS'); if (f) { set(f, [values.get(f.key), l].filter(Boolean).join(',')); continue; } }
    if (/^spaces\/\S+$/.test(l)) { const f = g.fields.find((x) => x.key === 'CHAT_NOTIFY_SPACE'); if (f) { set(f, l); continue; } }
    if (/apps\.googleusercontent\.com$/.test(l)) { const f = g.fields.find((x) => x.key === 'GOOGLE_CLIENT_ID'); if (f) { set(f, l); continue; } }
    if (/^GOCSPX-/.test(l)) { const f = g.fields.find((x) => x.key === 'GOOGLE_CLIENT_SECRET'); if (f) { set(f, l); continue; } }
    if (/^1\/\/\S{20,}$/.test(l)) { const f = g.fields.find((x) => x.key === 'GOOGLE_REFRESH_TOKEN'); if (f) { set(f, l); continue; } }
    if (g.id === 'drive' || g.id === 'files') { const f = g.fields[0]; values.set(f.key, [values.get(f.key), l].filter(Boolean).join('\n')); continue; }
    const first = open().find((f) => f.secret) ?? open()[0];
    if (/^\S{12,}$/.test(l) && first?.secret) { set(first, l); continue; }
    if (open().length === 1 && g.fields.length === 1) { set(open()[0], l); continue; }
    if (g.id === 'ntfy' && /^[\w-]{3,60}$/.test(l)) { const f = g.fields.find((x) => x.key === 'NTFY_TOPIC'); if (f && !values.has(f.key)) { set(f, l); continue; } }
    ignored.push(l.slice(0, 60));
  }
  // Tidy values.
  const out: Record<string, string> = {};
  for (const [k, v] of values) {
    if (k === 'DRIVE_FOLDER_IDS') out[k] = [...new Set(v.split(/[\n,\s]+/).map((x) => /\/folders\/([\w-]+)/.exec(x)?.[1] ?? /[?&]id=([\w-]+)/.exec(x)?.[1] ?? x).filter(Boolean))].join(',');
    else if (k === 'INDEX_PATHS' || k === 'CHAT_ALLOWED_USERS') out[k] = v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).join(',');
    else out[k] = v;
  }
  if (g.id === 'ingest' && (out.INGEST_TOKEN?.toLowerCase() === 'generate' || /^generate$/i.test(text))) out.INGEST_TOKEN = randomBytes(24).toString('hex');
  if (g.id === 'ingest' && out.INGEST_TOKEN && out.INGEST_TOKEN.length < 16) throw new Error('The token should be at least 16 characters.');
  if (g.id === 'gmail' && Object.keys(out).length) out.GMAIL_ENABLED = '1';
  if (g.id === 'chat' && out.CHAT_ALLOWED_USERS === undefined) { /* keep existing */ }
  if (!Object.keys(out).length) throw new Error(`I couldn't find any of the values I need (${g.fields.filter((f) => !f.optional).map((f) => f.label).join(', ')}). Put each on its own line like "${g.fields[0].label}: …".`);
  const changed = saveSettings(ctx.cfg.dataDir, out);
  const labelOf = (k: string) => g.fields.find((f) => f.key === k)?.label ?? k;
  return { saved: changed.map(labelOf), missing: g.fields.filter((f) => !f.optional && !(f.key in out)).map((f) => f.label), ignored, restart: true };
}
